/**
 * 网关自愈的测试。
 *
 * 全部走本地假网关（node:http），不碰真 SnowLuma、不碰网络。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readGatewayAccounts,
  healGateway,
  saveGatewayConfig,
  resetHealCooldownForTest,
} from "../src/web/gateway.js";

/** 造一个 SnowLuma 主目录：config/onebot_<uin>.json */
function makeGatewayDir(accounts) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  for (const a of accounts) {
    writeFileSync(
      join(dir, "config", `onebot_${a.uin}.json`),
      JSON.stringify({
        mode: "snapshot",
        networks: {
          httpServers: [{ name: "http-default", accessToken: a.http, host: "127.0.0.1", port: a.port ?? 3000 }],
          wsServers: [{ name: "ws-default", accessToken: a.ws ?? a.http, host: "127.0.0.1", port: 3001 }],
        },
      })
    );
  }
  return dir;
}

/** 起一个假网关：只认一个 token，别的回 401。 */
function startFakeGateway(validToken, uin, nickname = "大肥鱼") {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (auth !== validToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "failed", retcode: 1401, wording: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: Number(uin), nickname } }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("① 读出所有账号，备份文件不算", () => {
  const dir = makeGatewayDir([
    { uin: "111", http: "tok-a", ws: "ws-a" },
    { uin: "222", http: "tok-b", ws: "ws-b" },
  ]);
  // 混进两个备份文件，不该被当成账号
  writeFileSync(join(dir, "config", "onebot_111.json.bak-20261029"), "{}");
  writeFileSync(join(dir, "config", "onebot_111.json.bak-qms"), "{}");

  const acc = readGatewayAccounts(dir);
  assert.equal(acc.length, 2, "两个正式账号，备份不算");
  assert.deepEqual(acc.map((a) => a.uin), ["111", "222"]);
  assert.equal(acc[0].http.token, "tok-a");
  assert.equal(acc[0].http.port, 3000);
});

test("② 目录不存在 / 没配 → 空数组，不抛", () => {
  assert.deepEqual(readGatewayAccounts(""), []);
  assert.deepEqual(readGatewayAccounts("/definitely/not/here"), []);
  assert.deepEqual(readGatewayAccounts(null), []);
});

test("③ 旧 token 失效 → 自己找到新号能用的那个", async () => {
  resetHealCooldownForTest();
  const server = await startFakeGateway("new-token", "222");
  const port = server.address().port;
  // 配置文件里的端口要和假网关一致，否则探测会打到别的端口上
  const dir = makeGatewayDir([
    { uin: "111", http: "old-token", port },
    { uin: "222", http: "new-token", port },
  ]);

  try {
    const healed = await healGateway(
      { url: `http://127.0.0.1:${port}`, token: "old-token", gatewayDir: dir },
      { force: true }
    );
    assert.ok(healed, "应该找到能用的");
    assert.equal(healed.token, "new-token");
    assert.equal(healed.uin, "222");
    assert.equal(healed.changed, true);
  } finally {
    server.close();
  }
});

test("④ 现有 token 本来就对 → 不折腾，changed=false", async () => {
  resetHealCooldownForTest();
  const server = await startFakeGateway("good-token", "111");
  const port = server.address().port;
  const dir = makeGatewayDir([{ uin: "111", http: "good-token", port }]);

  try {
    const healed = await healGateway(
      { url: `http://127.0.0.1:${port}`, token: "good-token", gatewayDir: dir },
      { force: true }
    );
    assert.ok(healed);
    assert.equal(healed.changed, false, "本来就是对的，不该说改过");
    assert.equal(healed.uin, "111");
  } finally {
    server.close();
  }
});

test("⑤ 一个都试不通 → 返回 null，不瞎写", async () => {
  resetHealCooldownForTest();
  const server = await startFakeGateway("right-token", "111");
  const port = server.address().port;
  const dir = makeGatewayDir([{ uin: "111", http: "no-such-token", port }]);

  try {
    const healed = await healGateway(
      { url: `http://127.0.0.1:${port}`, token: "old", gatewayDir: dir },
      { force: true }
    );
    assert.equal(healed, null);
  } finally {
    server.close();
  }
});

test("⑥ 写回时只动 url/token，控制台和目录原样保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const file = join(dir, "onebot.json");
  writeFileSync(
    file,
    JSON.stringify({
      url: "http://127.0.0.1:3000",
      token: "old",
      consoleUrl: "http://127.0.0.1:5099",
      consolePassword: "pw-keep-me",
      gatewayDir: "D:\\SnowLuma",
    })
  );

  const wrote = saveGatewayConfig(file, {}, { token: "new", url: "http://127.0.0.1:3000", changed: true });
  assert.equal(wrote, true);

  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.token, "new");
  assert.equal(after.consolePassword, "pw-keep-me", "控制台密码不能被冲掉");
  assert.equal(after.gatewayDir, "D:\\SnowLuma", "目录不能被冲掉");
  assert.equal(after.consoleUrl, "http://127.0.0.1:5099");
});

test("⑦ changed=false 时根本不写盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const file = join(dir, "onebot.json");
  writeFileSync(file, JSON.stringify({ token: "same" }));
  const before = readFileSync(file, "utf8");

  const wrote = saveGatewayConfig(file, {}, { token: "same", url: "http://x", changed: false });
  assert.equal(wrote, false);
  assert.equal(readFileSync(file, "utf8"), before, "文件一个字节都不该变");
});

test("⑧ 节流：一分钟内第二次直接返回上次结果，不再扫盘", async () => {
  resetHealCooldownForTest();
  const server = await startFakeGateway("t", "111");
  const port = server.address().port;
  const dir = makeGatewayDir([{ uin: "111", http: "t", port }]);

  try {
    const ob = { url: `http://127.0.0.1:${port}`, token: "t", gatewayDir: dir };
    const first = await healGateway(ob, { force: true });
    assert.ok(first);

    // 节流期内不应该再去扫盘/探测，直接给上次的结果
    const second = await healGateway(ob, { force: false });
    assert.ok(second, "节流期内应返回缓存结果");
    assert.equal(second.uin, "111");
  } finally {
    server.close();
  }
});