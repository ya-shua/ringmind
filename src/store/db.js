/**
 * 环形的心 · 存储层
 *
 * 直接用 Node 24 内置的 node:sqlite，零依赖。
 * 一个记忆库 = 一个 .db 文件，可以直接复制、备份、换设备。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, metaSeed, SCHEMA_VERSION, migrate } from "./schema.js";

export class Store {
  /** @param {DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * 打开或创建一个记忆库
   * @param {string} path 文件路径；传 ":memory:" 用于测试
   * @param {string} [name] 库名
   */
  static open(path = ":memory:", name) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseSync(path);
    // 这个库不只一个进程在用：MCP（DSH spawn）、qq-bridge 的自动入库、面板。
    // WAL 让读写不互斥，但 busy_timeout 默认是 0 —— 两边同时写会立刻抛
    // SQLITE_BUSY 而不是等一等，表现就是"偶尔记不上"。等 5 秒足够。
    if (path !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
    }
    db.exec(SCHEMA_SQL);
    const store = new Store(db);
    store._migrate();
    store._seedMeta(name);

    // 早先建的库没写过这两项，补上，不然面板上库名是空的
    if (name && !store.getMeta("name")) store.setMeta("name", name);
    if (!store.getMeta("created_at")) {
      const row = db.prepare("SELECT MIN(created_at) AS t FROM memories").get();
      store.setMeta("created_at", String(row?.t || Date.now()));
    }

    return store;
  }

  /** 结构升级：老库补字段、补默认值 */
  _migrate() {
    const cur = Number(this.getMeta("schema_version") ?? 0);
    if (!cur) {
      // 空库，建表语句已经是最新的
      this.setMeta("schema_version", String(SCHEMA_VERSION));
      return;
    }
    if (cur < SCHEMA_VERSION) {
      migrate(this.db, cur);
      this.setMeta("schema_version", String(SCHEMA_VERSION));
    }
  }

  _seedMeta(name) {
    const has = this.getMeta("schema_version");
    if (has) return;
    const now = Date.now();
    for (const [k, v] of metaSeed(name)) this.setMeta(k, v);
    this.setMeta("updated_at", String(now));
  }

  /**
   * 把一批用量记录存进来（按 天+provider+模型 覆盖）
   *
   * 同步是幂等的：同一天同一家同一个模型跑几次都只会更新那一行，
   * 所以可以每次打开面板都同步一遍，不会重复计账。
   */
  upsertTokenUsage(rows = []) {
    if (!rows.length) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO token_usage(day, provider, model, hit, miss, write, output, calls, cost, synced_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, provider, model) DO UPDATE SET
         hit = excluded.hit, miss = excluded.miss, write = excluded.write,
         output = excluded.output, calls = excluded.calls, cost = excluded.cost,
         synced_at = excluded.synced_at`
    );
    const now = Date.now();
    let n = 0;
    for (const r of rows) {
      try {
        stmt.run(
          String(r.day),
          String(r.provider),
          String(r.model),
          Number(r.hit) || 0,
          Number(r.miss) || 0,
          Number(r.write) || 0,
          Number(r.output) || 0,
          Number(r.calls) || 0,
          Number(r.cost) || 0,
          now
        );
        n++;
      } catch {
        // 一条坏数据不该让整批同步失败
      }
    }
    return n;
  }

  /** 读用量记录，按天升序 */
  readTokenUsage(hours = 0) {
    const cutoffDay = hours > 0
      ? new Date(Date.now() - hours * 3600_000 + 8 * 3600_000).toISOString().slice(0, 10)
      : null;
    const sql = cutoffDay
      ? "SELECT * FROM token_usage WHERE day >= ? ORDER BY day ASC"
      : "SELECT * FROM token_usage ORDER BY day ASC";
    const stmt = this.db.prepare(sql);
    return cutoffDay ? stmt.all(cutoffDay) : stmt.all();
  }

  /** 用量表里有多少行、覆盖到哪天 */
  tokenUsageRange() {
    const r = this.db
      .prepare("SELECT count(*) AS n, MIN(day) AS first, MAX(day) AS last FROM token_usage")
      .get();
    return { rows: r?.n || 0, first: r?.first || null, last: r?.last || null };
  }

  close() {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }

  // ── 元信息 ──────────────────────────────────────────────

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }

  setMeta(key, value) {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  /** 读取整份配置（JSON 存在 meta.config 里） */
  getConfig() {
    const raw = this.getMeta("config");
    return raw ? JSON.parse(raw) : null;
  }

  saveConfig(config) {
    this.setMeta("config", JSON.stringify(config));
    this.setMeta("updated_at", String(Date.now()));
  }

  get schemaVersion() {
    return Number(this.getMeta("schema_version") ?? SCHEMA_VERSION);
  }

  // ── 记忆 ────────────────────────────────────────────────

  insertMemory(m) {
    this.db
      .prepare(
        `INSERT INTO memories
           (id, created_at, ring_entered_at, born_load, ring, source, speaker, content, emotion, hits, pinned, note, import_batch, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.createdAt ?? Date.now(),
        m.ringEnteredAt ?? m.createdAt ?? Date.now(),
        m.bornLoad ?? 0,
        m.ring,
        m.source ?? "private",
        m.speaker ?? "user",
        m.content ?? "",
        m.emotion ?? 0,
        m.hits ?? 0,
        m.pinned ? 1 : 0,
        m.note ?? null,
        m.importBatch ?? null,
        m.updatedAt ?? Date.now()
      );
    return this.getMemory(m.id);
  }

  getMemory(id) {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!row) return null;
    return { ...row, points: this.listPoints(id) };
  }

  listByRing(ring, limit = 100000) {
    return this.db
      .prepare("SELECT * FROM memories WHERE ring = ? ORDER BY created_at ASC LIMIT ?")
      .all(ring, limit);
  }

  /** 某一圈里最早的若干条（降级时用） */
  oldestInRing(ring, n) {
    return this.db
      .prepare("SELECT * FROM memories WHERE ring = ? ORDER BY created_at ASC LIMIT ?")
      .all(ring, n);
  }

  countByRing(ring) {
    return this.db.prepare("SELECT count(*) AS c FROM memories WHERE ring = ?").get(ring).c;
  }

  countByRingAndSource(ring, source) {
    return this.db
      .prepare("SELECT count(*) AS c FROM memories WHERE ring = ? AND source = ?")
      .get(ring, source).c;
  }

  /**
   * 换圈。**进圈时间一并归零** —— 一圈的倒计时从进这圈那天算起。
   * @param {string} id
   * @param {string} ring 目标圈
   * @param {number} [at] 换圈时刻（测试里要能指定）
   */
  moveRing(id, ring, at = Date.now()) {
    this.db
      .prepare("UPDATE memories SET ring = ?, ring_entered_at = ?, updated_at = ? WHERE id = ?")
      .run(ring, at, at, id);
  }

  /** 重置进圈时间（钉住 / 升圈 / 手动挪动时用） */
  touchRing(id, at = Date.now()) {
    this.db
      .prepare("UPDATE memories SET ring_entered_at = ?, updated_at = ? WHERE id = ?")
      .run(at, at, id);
  }

  bumpHits(id) {
    this.db.prepare("UPDATE memories SET hits = hits + 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  deleteMemory(id) {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  // ── 点 ──────────────────────────────────────────────────

  insertPoint(memoryId, text, weight = null) {
    const r = this.db
      .prepare("INSERT INTO points(memory_id, text, weight, visible, buffered) VALUES(?, ?, ?, 1, 0)")
      .run(memoryId, text, weight);
    return Number(r.lastInsertRowid);
  }

  listPoints(memoryId) {
    return this.db
      .prepare("SELECT * FROM points WHERE memory_id = ? ORDER BY weight IS NULL, weight ASC, id ASC")
      .all(memoryId);
  }

  /** 当前"看得见"的点 */
  visiblePoints(memoryId) {
    return this.db
      .prepare("SELECT * FROM points WHERE memory_id = ? AND visible = 1 ORDER BY weight IS NULL, weight ASC, id ASC")
      .all(memoryId);
  }

  /** 缓冲圈里还能捞回来的点 */
  bufferedPoints(memoryId) {
    return this.db
      .prepare("SELECT * FROM points WHERE memory_id = ? AND buffered = 1 AND visible = 0 ORDER BY weight IS NULL, weight ASC, id ASC")
      .all(memoryId);
  }

  setPointVisible(pointId, visible) {
    this.db.prepare("UPDATE points SET visible = ? WHERE id = ?").run(visible ? 1 : 0, pointId);
  }

  setPointBuffered(pointId, buffered) {
    this.db.prepare("UPDATE points SET buffered = ? WHERE id = ?").run(buffered ? 1 : 0, pointId);
  }

  // ── 检索 ────────────────────────────────────────────────

  /** 按钩子精确找（快，走索引） */
  findByPoint(text, rings = null) {
    const sql = rings
      ? `SELECT DISTINCT m.* FROM memories m JOIN points p ON p.memory_id = m.id
         WHERE p.text = ? AND m.ring IN (${rings.map(() => "?").join(",")})`
      : `SELECT DISTINCT m.* FROM memories m JOIN points p ON p.memory_id = m.id WHERE p.text = ?`;
    const args = rings ? [text, ...rings] : [text];
    return this.db.prepare(sql).all(...args);
  }

  /** 按内容模糊找（慢一点，但 5 万条也就几毫秒） */
  findByContent(keyword, limit = 50) {
    return this.db
      .prepare("SELECT * FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?")
      .all(`%${keyword}%`, limit);
  }

  /** 按时间范围找 */
  findByTime(from, to) {
    return this.db
      .prepare("SELECT * FROM memories WHERE created_at BETWEEN ? AND ? ORDER BY created_at ASC")
      .all(from, to);
  }

  /** 全局消息计数（给 bornLoad 用） */
  totalMessages() {
    return this.db.prepare("SELECT count(*) AS c FROM vault").get().c;
  }

  // ── 总库 ────────────────────────────────────────────────

  addVault({ ts, source, speaker, text, meta = null }) {
    return this.db
      .prepare("INSERT INTO vault(ts, source, speaker, text, meta) VALUES(?, ?, ?, ?, ?)")
      .run(ts ?? Date.now(), source ?? null, speaker ?? null, text, meta ? JSON.stringify(meta) : null);
  }

  searchVault(keyword, limit = 50) {
    return this.db
      .prepare("SELECT * FROM vault WHERE text LIKE ? ORDER BY ts DESC LIMIT ?")
      .all(`%${keyword}%`, limit);
  }

  /** 总库按时间倒着取一批（记忆海画幻影用，只读） */
  listVault(limit = 400) {
    return this.db.prepare("SELECT * FROM vault ORDER BY ts DESC LIMIT ?").all(limit);
  }

  vaultCount() {
    return this.db.prepare("SELECT count(*) AS c FROM vault").get().c;
  }

  /** 总库满了就删最老的 */
  trimVault(cap) {
    if (!cap || cap <= 0) return 0;
    const total = this.vaultCount();
    if (total <= cap) return 0;
    const r = this.db
      .prepare("DELETE FROM vault WHERE id IN (SELECT id FROM vault ORDER BY id ASC LIMIT ?)")
      .run(total - cap);
    return Number(r.changes);
  }

  // ── 操作日志 ────────────────────────────────────────────

  logOp(kind, payload) {
    this.db
      .prepare("INSERT INTO ops(ts, kind, payload) VALUES(?, ?, ?)")
      .run(Date.now(), kind, JSON.stringify(payload ?? null));
  }

  recentOps(limit = 50) {
    return this.db.prepare("SELECT * FROM ops ORDER BY id DESC LIMIT ?").all(limit);
  }

  // ── 表情 ────────────────────────────────────────────────

  addSticker({ stickerId, meaning, desc, usedAt, context }) {
    return this.db
      .prepare("INSERT INTO stickers(sticker_id, meaning, desc, used_at, context) VALUES(?, ?, ?, ?, ?)")
      .run(stickerId, meaning ?? null, desc ?? null, usedAt ?? Date.now(), context ?? null);
  }

  listStickers(limit = 100) {
    return this.db.prepare("SELECT * FROM stickers ORDER BY used_at DESC LIMIT ?").all(limit);
  }
}