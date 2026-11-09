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

// 身份以仓库根的 metadata.json 为准 —— 别在测试里再抄一遍版本号
const META = JSON.parse(readFileSync(new URL("../metadata.json", import.meta.url), "utf8"));
const META_VERSION = String(META.version);

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

test("登录后打开主页，直接是记忆海", async () => {
  const s = await boot();

  // 没登录：/ 是登录页
  const before = await (await fetch(s.url + "/")).text();
  assert.ok(before.includes("api/login"), "没登录先给登录页");

  // 登录过：/ 就是记忆海（主页）
  const { cookie } = await login(s.url, s.token);
  const home = await fetch(s.url + "/", { headers: { cookie } });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes("记忆海"), "主页该是记忆海");
  assert.ok(html.includes("api/sea"), "记忆海要读真实数据");

  // 退出之后回到登录页，不会再看到海
  await fetch(s.url + "/api/logout", { headers: { cookie } });
  const after = await (await fetch(s.url + "/")).text();
  assert.ok(after.includes("api/login"), "退出后主页回到登录页");

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

/* ── 对接契约 ──────────────────────────────────────────────
 * 宿主靠这两个端点判断"对面是谁、怎么接、接的对不对"，
 * 所以形状本身要锁住：字段少了 / 多了绝对路径或令牌，这里先红。
 */

test("manifest：免登录可读，形状对，且不泄漏路径和令牌", async () => {
  const s = await boot();
  try {
    const r = await fetch(s.url + "/api/manifest");
    assert.equal(r.status, 200, "manifest 是给外部宿主发现用的，不该要登录");

    const text = await r.text();
    const j = JSON.parse(text);

    assert.equal(j.ok, true);
    assert.equal(j.metadata.id, "ring", "id 要和 metadata.json 一致");
    assert.equal(j.metadata.version, META_VERSION, "版本以 metadata.json 为准");

    assert.ok(Array.isArray(j.capabilities) && j.capabilities.length >= 3, "能力至少 3 条");
    for (const c of j.capabilities) {
      assert.ok(c.name, "每条能力都要有名字");
      assert.ok(["mcp", "http", "file"].includes(c.kind), "kind 只能是 mcp/http/file，实际 " + c.kind);
      assert.ok(typeof c.how === "string" && c.how.length > 0, "每条能力都要说怎么调");
    }

    assert.equal(j.runtime.port, s.port, "端口要报真实端口");
    assert.equal(j.runtime.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(j.runtime.started_at)), "started_at 要是能解析的时间");
    assert.match(j.runtime.db, /^sqlite\//, "只写 sqlite/文件名");

    assert.ok(!text.includes(s.dir), "不能带出数据目录的绝对路径");
    assert.ok(!text.includes(s.token), "不能带出登录令牌");
    assert.equal(j.data, undefined, "manifest 不该塞面板数据那一整块");
    assert.ok(!text.includes("consolePassword"), "manifest 不能带控制台密码");
    assert.ok(!text.toLowerCase().includes("sk-"), "manifest 不能带 key");
  } finally {
    await s.done();
  }
});

test("health：免登录只回最小身份，登录后字段一个没少（含 id/version）", async () => {
  const s = await boot();
  try {
    // ① 不带任何凭证 —— 体检脚本 / 别的宿主就是这么打的
    const open = await fetch(s.url + "/api/health");
    assert.equal(open.status, 200, "探活口不该先要令牌");

    const text = await open.text();
    const o = JSON.parse(text);
    assert.deepEqual(Object.keys(o).sort(), ["id", "ok", "uptime_s", "version"], "免登录只给最小身份");
    assert.equal(o.ok, true);
    assert.equal(o.id, "ring");
    assert.equal(o.version, META_VERSION, "版本以 metadata.json 为准");
    assert.ok(Number.isInteger(o.uptime_s) && o.uptime_s >= 0, "uptime_s 是秒数");

    // 探活面里一个秘密都不许有
    for (const bad of ["token", "password", "sk-"]) {
      assert.ok(!text.toLowerCase().includes(bad), "免 token 的 health 不能出现 " + bad);
    }

    // ② 登录之后：还是原来那份数据，一个字段都没少
    const { cookie } = await login(s.url, s.token);
    const r = await fetch(s.url + "/api/health", { headers: { cookie } });
    assert.equal(r.status, 200);

    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.id, "ring");
    assert.equal(j.version, META_VERSION);

    // 面板在轮询这一页：server / db / onebot 一个都不能少
    for (const k of ["server", "db", "onebot", "others"]) {
      assert.ok(j.data?.[k], "原有字段 data." + k + " 不能丢");
    }
    assert.equal(j.data.server.ok, true);
    assert.equal(j.data.server.token, s.token, "登录后要给明文令牌，面板靠它登录");
    assert.ok(Number.isInteger(j.data.server.port));
  } finally {
    await s.done();
  }
});