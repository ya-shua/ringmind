import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAstrbot, findAstrbotDb } from "../src/web/usage-sources.js";

/* ── 造一个假的 AstrBot 库 ─────────────────────────────── */

function makeAstrbotDb(rows) {
  const dir = mkdtempSync(join(tmpdir(), "astrbot-"));
  const dbPath = join(dir, "data.db");

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE provider_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      agent_type TEXT,
      status TEXT,
      umo TEXT,
      conversation_id TEXT,
      provider_id TEXT,
      provider_model TEXT,
      token_input_other INTEGER DEFAULT 0,
      token_input_cached INTEGER DEFAULT 0,
      token_output INTEGER DEFAULT 0,
      start_time REAL,
      end_time REAL,
      time_to_first_token REAL
    )
  `);

  const ins = db.prepare(`
    INSERT INTO provider_stats
      (created_at, status, umo, provider_model, token_input_other, token_input_cached,
       token_output, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    ins.run(
      r.created_at ?? "2026-10-26 06:23:25.432181",
      r.status ?? "success",
      r.umo ?? "大肥鱼:FriendMessage:FB038E2281A047A3B1CF1797723A8BFD",
      r.provider_model ?? "deepseek-ai/DeepSeek-V4.1-Flash",
      r.token_input_other ?? 0,
      r.token_input_cached ?? 0,
      r.token_output ?? 0,
      r.start_time ?? 1792995804.169896,
      r.end_time ?? 1792995804.3997798
    );
  }

  db.close();
  return { dir, dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("用量来源 · AstrBot", () => {
  test("认得 provider_stats 的列", async () => {
    const { dbPath, cleanup } = makeAstrbotDb([
      { token_input_other: 1200, token_input_cached: 300, token_output: 400 },
    ]);
    const r = await openAstrbot(dbPath);
    cleanup();

    assert.equal(r.ok, true, r.reason);
    assert.equal(r.table, "provider_stats");
    assert.ok(r.cols.includes("token_output"));
  });

  test("时间按 UTC 解，本地是 +8", async () => {
    // 1792995804.169896 = 2026-10-26T06:23:24Z = 本地 14:23:24
    const { dbPath, cleanup } = makeAstrbotDb([
      { token_input_other: 100, token_output: 50, start_time: 1792995804.169896 },
    ]);
    const r = await openAstrbot(dbPath);
    cleanup();

    assert.equal(r.ok, true);
    const row = r.rows[0];
    const local = new Date(row.ms);
    assert.equal(local.getHours(), 14, "本地应是 14 点");
    assert.equal(row.day, "2026-10-26");
  });

  test("created_at 是 UTC 文本，不按本地时间解", async () => {
    // 只有 created_at，没有 start_time 时用它
    const { dbPath, cleanup } = makeAstrbotDb([
      {
        created_at: "2026-10-26 06:23:25.432181",
        start_time: null,
        token_input_other: 10,
        token_output: 5,
      },
    ]);
    const r = await openAstrbot(dbPath);
    cleanup();

    assert.equal(r.ok, true);
    assert.equal(new Date(r.rows[0].ms).getHours(), 14, "06:23 UTC 应该变成 14:23 本地");
  });

  test("输入按命中/未命中分开", async () => {
    const { dbPath, cleanup } = makeAstrbotDb([
      { token_input_other: 1200, token_input_cached: 300, token_output: 400 },
    ]);
    const r = await openAstrbot(dbPath);
    cleanup();

    const row = r.rows[0];
    assert.equal(row.cacheMiss, 1200);
    assert.equal(row.cacheHit, 300);
    assert.equal(row.output, 400);
  });

  test("skips status=error 的调用", async () => {
    const { dbPath, cleanup } = makeAstrbotDb([
      { status: "success", token_input_other: 100, token_output: 50 },
      { status: "error", token_input_other: 0, token_output: 0 },
      { status: "success", token_input_other: 200, token_output: 80 },
    ]);
    const r = await openAstrbot(dbPath);
    cleanup();

    assert.equal(r.rows.length, 2, "error 那条不算");
    const total = r.rows.reduce((n, x) => n + x.cacheMiss, 0);
    assert.equal(total, 300);
  });

  test("全 0 token 的行也跳过（没真花 token）", async () => {
    const { dbPath, cleanup } = makeAstrbotDb([
      { status: "success", token_input_other: 0, token_input_cached: 0, token_output: 0 },
      { status: "success", token_input_other: 10, token_output: 5 },
    ]);
    const r = await openAstrbot(dbPath);
    cleanup();

    assert.equal(r.rows.length, 1);
  });

  test("umo 折成会话键：私聊 / 群聊", async () => {
    const { dbPath, cleanup } = makeAstrbotDb([
      {
        umo: "大肥鱼:FriendMessage:FB038E2281A047A3",
        token_input_other: 10,
        token_output: 5,
      },
      {
        umo: "大肥鱼:GroupMessage:9A1B2C3D4E5F6A7B",
        token_input_other: 10,
        token_output: 5,
      },
    ]);
    const r = await openAstrbot(dbPath);
    cleanup();

    const keys = r.rows.map((x) => x.provider);
    assert.ok(keys[0].startsWith("private:"), keys[0]);
    assert.ok(keys[1].startsWith("group:"), keys[1]);
  });

  test("库不存在时老实返回，不抛", async () => {
    const r = await openAstrbot("D:/definitely/not/here.db");
    assert.equal(r.ok, false);
    assert.match(r.reason, /库不在/);
  });

  test("空库（没有 provider_stats）也不炸", async () => {
    const dir = mkdtempSync(join(tmpdir(), "empty-"));
    const p = join(dir, "data.db");
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE other (x INTEGER)");
    db.close();

    const r = await openAstrbot(p);
    rmSync(dir, { recursive: true, force: true });

    assert.equal(r.ok, false);
    assert.match(r.reason, /没有像用量表的表|认不出来/);
  });

  test("findAstrbotDb 找不到就回 null", () => {
    assert.equal(findAstrbotDb(), null);
  });

  test("findAstrbotDb 优先用手写路径", () => {
    const { dbPath, cleanup } = makeAstrbotDb([]);
    const found = findAstrbotDb(dbPath);
    cleanup();
    assert.equal(found.replace(/\\/g, "/"), dbPath.replace(/\\/g, "/"));
  });
});