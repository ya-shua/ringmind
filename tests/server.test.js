/**
 * 面板服务 · 测试
 *
 * 只测"这层壳"，不测记忆库本身（那是 core.test.js 的活）。
 * 重点是不出错的口子：令牌、会话、路径穿越。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../src/web/server.js";

/** 每个测试一个临时目录 + 一个随机端口 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "ringmind-web-"));
  const s = await createServer({ dataDir: dir, port: 0 });
  return {
    ...s,
    dir,
    async done() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function login(base, token) {
  const r = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const cookie = r.headers.get("set-cookie");
  return { status: r.status, cookie: cookie ? cookie.split(";")[0] : null, body: await r.json() };
}

test("第一次启动会生成令牌，并且写进 token.txt", async () => {
  const s = await boot();
  assert.ok(s.token && s.token.length >= 12, "该有一串够长的令牌");
  assert.equal(readFileSync(join(s.dir, "token.txt"), "utf8").trim(), s.token, "令牌文件里是同一串");
  await s.done();
});

test("令牌不对就 401，对的才放行", async () => {
  const s = await boot();

  const bad = await login(s.url, "这不是令牌啦");
  assert.equal(bad.status, 401, "错的令牌要拒");
  assert.equal(bad.cookie, null, "拒的时候不能发 cookie");

  const good = await login(s.url, s.token);
  assert.equal(good.status, 200);
  assert.ok(good.cookie && good.cookie.startsWith("ringmind_session="), "要发会话 cookie");

  await s.done();
});

test("没登录碰不到数据接口", async () => {
  const s = await boot();

  for (const path of ["/api/overview", "/api/preset", "/api/decay-preview"]) {
    const r = await fetch(s.url + path);
    assert.equal(r.status, 401, path + " 该被挡住");
  }

  await s.done();
});

test("登录之后能读到真实的总览", async () => {
  const s = await boot();
  const { cookie } = await login(s.url, s.token);

  const r = await fetch(s.url + "/api/overview", { headers: { cookie } });
  assert.equal(r.status, 200);

  const { data } = await r.json();
  assert.equal(data.preset, "mixed", "默认是混合档");
  assert.ok(Array.isArray(data.rings) && data.rings.length === 7, "七个圈都要在");
  assert.equal(data.mode, "forget");

  await s.done();
});

test("会话能被换成另一档，而且存住了", async () => {
  const s = await boot();
  const { cookie } = await login(s.url, s.token);

  const r = await fetch(s.url + "/api/preset", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ preset: "group" }),
  });
  assert.equal(r.status, 200);

  const after = await fetch(s.url + "/api/overview", { headers: { cookie } }).then((x) => x.json());
  assert.equal(after.data.preset, "group", "换完就该是群聊档");

  await s.done();
});

test("会话退出之后就真的进不去了", async () => {
  const s = await boot();
  const { cookie } = await login(s.url, s.token);

  await fetch(s.url + "/api/logout", { headers: { cookie } });

  const r = await fetch(s.url + "/api/overview", { headers: { cookie } });
  assert.equal(r.status, 401, "退出后旧 cookie 要失效");

  await s.done();
});

test("路径穿越拿不到外面的文件", async () => {
  const s = await boot();

  for (const evil of ["/../package.json", "/../../package.json", "/..%2fpackage.json"]) {
    const r = await fetch(s.url + evil);
    assert.ok(r.status === 404 || r.status === 400, evil + " 该被挡住，实际 " + r.status);
    const text = await r.text();
    assert.ok(!text.includes('"name": "ringmind"'), evil + " 不该吐出 package.json");
  }

  await s.done();
});

test("登录页和面板页都能打开", async () => {
  const s = await boot();

  const login_ = await fetch(s.url + "/");
  assert.equal(login_.status, 200);
  const html = await login_.text();
  assert.ok(html.includes("api/login"), "登录页要真的调接口");

  const panel = await fetch(s.url + "/preview.html");
  assert.equal(panel.status, 200);
  assert.ok((await panel.text()).includes("api/overview"), "面板要读真实数据");

  await s.done();
});

test("会话真的没了就进不去（不会自己偷偷恢复）", async () => {
  const s = await boot();
  const { cookie } = await login(s.url, s.token);

  // 模拟服务端会话丢了（重启）
  s.sessions.clear();

  const dead = await fetch(s.url + "/api/overview", { headers: { cookie } });
  assert.equal(dead.status, 401, "会话没了就该 401，得重新输令牌");

  await s.done();
});

test("两次启动用的是同一个令牌，不会每次换", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ringmind-web-"));
  const a = await createServer({ dataDir: dir, port: 0 });
  const first = a.token;
  a.close();

  const b = await createServer({ dataDir: dir, port: 0 });
  assert.equal(b.token, first, "重启不该换令牌");
  assert.equal(b.tokenCreated, false);
  b.close();

  rmSync(dir, { recursive: true, force: true });
});