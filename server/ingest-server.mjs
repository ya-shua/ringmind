#!/usr/bin/env node
/**
 * 环形的心 · 通用入库服务（ingest-server）
 *
 * 给"不是 qq-bridge 的机器人框架"用的一条通路。
 *
 * 为什么要它
 * ─────────
 * 环心本体只是 npm 包：它不知道 QQ 消息长什么样，也不该知道。
 * 以前只有 qq-bridge 的 ring-ingest 会往里写，换个框架（AstrBot / NapCat 直连 /
 * 自研 Python 机器人）记忆库就空着 —— 工具都在，但一条数据没有。
 *
 * 这个服务把"写入"这件事抽成一个 HTTP 接口：谁的框架都行，POST 过来就能记。
 * **它不改环心本体一行代码**，只 import 它。
 *
 * 链路
 * ────
 *   机器人框架 ──POST /ingest──► 本服务 ──► memory.db
 *                                          ├─ vault   每条原文，永不合并
 *                                          └─ ring4   同一段对话合并成一条
 *
 * 起法
 * ────
 *   node server/ingest-server.mjs                    # 默认 127.0.0.1:5188
 *   node server/ingest-server.mjs --port 5188
 *   RING_DB=/path/to/memory.db node server/ingest-server.mjs
 *
 * 配置
 * ────
 *   同目录的 ingest.json（可选，没有就用默认值）：
 *   {
 *     "owners": ["1234567890"],        // 谁是主人，进了库会加【管理员】前缀
 *     "mergeWindowMs": 300000,         // 一段对话最长多久（从第一条算起，默认 5 分钟）
 *     "gapMs": 90000,                  // 相邻两条隔超过这么久就断（默认 90 秒）
 *     "maxChars": 600,                 // 单条封顶
 *     "port": 5188,
 *     "host": "127.0.0.1"
 *   }
 *
 * 请求
 * ────
 *   POST /ingest   Content-Type: application/json
 *   {
 *     "text":   "今天中午吃的面不错",     // 必填
 *     "umo":    "aiocqhttp:private:1234567890",  // 可选，AstrBot 的 UMO
 *     "uid":    "1234567890",           // 可选，发送者 QQ 号（判主人用）
 *     "key":    "private:1234567890",   // 可选，老格式（umo 没有时用）
 *     "sender": "某人",                  // 可选，昵称
 *     "isSelf": false,                  // 可选，这条是不是"她自己说的"
 *     "ts":     1761926400000           // 可选，真实时间（毫秒），默认现在
 *   }
 *
 *   GET /health   → { ok, vault, memories, buffered }
 *
 * 三件它自己不决定的事
 * ────────────────────
 *   1. 掉圈 —— 它不跑衰减。衰减由 MCP 壳（mcp/server.mjs）在启动时补跑，
 *      或者面板上手动点。这个服务只负责"记下来"。
 *   2. 内容 —— 一个字不改，只截断超长（maxChars）。
 *   3. 该不该记 —— 收到了就记。要不要过滤是框架那边的事。
 */

import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ringmind } from "../src/index.js";
import { autoSplit } from "../src/core/remember.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/* ───────────────────────── 配置 ───────────────────────── */

const DEFAULTS = {
  owners: [],            // 主人 QQ 号：写库时补【管理员】
  mergeWindowMs: 300_000, // 一段对话最长 5 分钟（从第一条算起）
  gapMs: 90_000,          // 相邻两条隔超过 90 秒就断（换话题了）
  maxChars: 600,
  port: 5188,
  host: "127.0.0.1",
};

function loadConfig() {
  const cfg = { ...DEFAULTS };
  const file = join(HERE, "ingest.json");
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      for (const k of Object.keys(DEFAULTS)) {
        if (j[k] !== undefined) cfg[k] = j[k];
      }
    } catch (e) {
      console.warn("[ring-ingest] ingest.json 读不了，用默认配置：" + e.message);
    }
  }
  // 环境变量优先于文件
  if (process.env.RING_OWNERS) {
    cfg.owners = process.env.RING_OWNERS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.RING_MERGE_WINDOW_MS) {
    cfg.mergeWindowMs = Number(process.env.RING_MERGE_WINDOW_MS) || cfg.mergeWindowMs;
  }
  if (process.env.RING_GAP_MS) {
    cfg.gapMs = Number(process.env.RING_GAP_MS) || cfg.gapMs;
  }
  return cfg;
}

const CFG = loadConfig();

/** 库路径：环境变量 > data/memory.db */
const DB_PATH = (() => {
  if (process.env.RING_DB) return process.env.RING_DB;
  try {
    const loc = JSON.parse(readFileSync(join(ROOT, "data-location.json"), "utf8"));
    if (loc?.dbPath) return resolve(loc.dbPath);
  } catch { /* 没这个文件就用默认 */ }
  return join(ROOT, "data", "memory.db");
})();

/* ───────────────────────── 解析一条消息 ───────────────────────── */

/**
 * 占位词：有些框架拿不到昵称，会塞一个"私聊""群聊"这类词进来。
 * 那不是人名，拼进前缀就变成「私聊：私聊：我还以为你要上天了」。
 * 认出来就当没有名字，不补前缀。
 */
const PLACEHOLDERS = new Set([
  "私聊", "群聊", "私信", "群消息", "私聊消息", "群聊消息",
  "未知", "unknown", "private", "group", "user", "self", "",
]);

function isPlaceholder(name) {
  const s = String(name ?? "").trim();
  return PLACEHOLDERS.has(s) || PLACEHOLDERS.has(s.toLowerCase());
}

/**
 * 从各种框架的字段里凑出：谁说的、在哪说的、是不是自己说的
 *
 * 认这三种来源（有哪个用哪个，优先级从上到下）：
 *   uid + umo    AstrBot：umo = "aiocqhttp:private:1234567890"
 *   key          qq-bridge：key = "private:1234567890"
 *   sender      只有昵称，那就只能当"不知道是谁"
 */
function parseMessage(body, cfg = CFG) {
  const text = String(body.text ?? "").trim();
  if (!text) return { error: "text 不能为空" };

  const isSelf = body.isSelf === true || body.isSelf === "true";

  // 1) 会话类型 + 会话 ID
  let kind = null;   // "private" | "group"
  let convId = null; // 群号或 QQ 号

  // 两个来源只认一个：umo 解析成功就整份用 umo，不拿 key 去补它的残缺，
  // 否则一半来自 AstrBot、一半来自旧字段，拼出来的会话 ID 会张冠李戴。
  const umo = String(body.umo ?? "").trim();
  if (umo) {
    // aiocqhttp:private:1234567890 / aiocqhttp:group:111222333
    for (const p of umo.split(":")) {
      if (p === "private" || p === "group") kind = p;
      else if (/^\d+$/.test(p)) convId = p;
    }
  }

  if (!kind || !convId) {
    kind = null;
    convId = null;
    const key = String(body.key ?? "").trim();
    // private:1234567890 / group:111222333
    const m = key.match(/^(private|group):(\d+)$/i);
    if (m) {
      kind = m[1].toLowerCase();
      convId = m[2];
    }
  }

  // 2) 发送者 QQ（判主人用）
  let uid = String(body.uid ?? "").trim();
  if (!uid && convId && (kind === "private" || isSelf)) uid = convId;
  if (!uid && kind === "private") uid = convId ?? "";

  // 3) 昵称
  let sender = String(body.sender ?? "").trim();
  if (isPlaceholder(sender)) sender = "";

  // 4) 主人？
  const isOwner = !!uid && (cfg.owners ?? []).includes(uid);

  // 5) 时间
  let ts = Number(body.ts);
  if (!Number.isFinite(ts) || ts <= 0) ts = Date.now();
  if (ts < 1e12) ts *= 1000; // 传了秒级时间戳就换到毫秒

  return {
    text: text.length > cfg.maxChars ? text.slice(0, cfg.maxChars) + "…" : text,
    kind: kind ?? "private",
    convId: convId ?? "unknown",
    uid,
    sender,
    isOwner,
    isSelf,
    ts,
    // 谁来指代"这一条属于哪段对话"——合并窗口按它分组
    convKey: `${kind ?? "private"}:${convId ?? "unknown"}`,
  };
}

/* ───────────────────────── 写库 ───────────────────────── */

/** 库是懒打开的：只 import 本文件（比如跑测试）时不该建出一个 .db 来 */
let _db = null;
function getDb() {
  if (!_db) _db = new Ringmind(DB_PATH);
  return _db;
}

/** 每段对话的最后一条 ring4 记忆 + 它的时间，用于合并 */
const mergeState = new Map(); // convKey + "|" + (self?1:0) → { memoryId, lastTs, firstTs }

/** 格式化成总库里的一行：2026/10/31 22:38｜私聊：【管理员】某人：正文 */
function vaultLine(msg) {
  const d = new Date(msg.ts);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  const where = msg.kind === "group" ? "群聊" : "私聊";
  // 昵称是占位词时 msg.sender 已经是空串，这里就不补，免得出现「私聊：私聊：」
  const who = msg.sender ? (msg.isOwner ? `【管理员】${msg.sender}` : msg.sender) + "：" : "";
  const tag = msg.isSelf ? "（她）" : "";
  return `${stamp}｜${where}：${tag}${who}${msg.text}`;
}

function ingest(msg, database = getDb()) {
  const db = database;
  // ① 总库：一条一条，永不合并（这是"逐条原文"那条铁律）
  db.store.addVault({
    ts: msg.ts,
    source: msg.kind,
    speaker: msg.isSelf ? "self" : (msg.isOwner ? "owner" : "user"),
    text: vaultLine(msg),
    meta: { uid: msg.uid, sender: msg.sender, isOwner: msg.isOwner },
  });
  const cap = db.config?.vault?.cap;
  if (cap) db.store.trimVault(cap);

  // ② 闲聊圈：同一段对话合并成一条，不然 5 天就爆
  const slot = msg.convKey + "|" + (msg.isSelf ? "1" : "0");
  const prev = mergeState.get(slot);
  // 时间往回跳（补历史、跨天补录）不算"同一段对话"，宁可新开一条，
  // 否则一条新记忆会被塞进 5 分钟前那段里，顺序全乱。
  //
  // 两道闸一起卡（2026-11-03 定）：
  //   ① 跟上一句隔不超过 gapMs（默认 90 秒）—— 停了一会儿就是换话题了
  //   ② 距这条对话的第一句不超过 mergeWindowMs（默认 5 分钟）—— 聊再久也不能无限长
  // 只卡 ② 的话，一小时里断断续续的闲聊会被拼成一大坨（实测最长 814 字）；
  // 加上 ①，同一天闲聊最长降到 145 字。
  const withinWindow =
    prev &&
    msg.ts >= prev.lastTs &&
    msg.ts - prev.lastTs <= CFG.gapMs &&
    msg.ts - prev.firstTs <= CFG.mergeWindowMs;

  if (withinWindow) {
    // 追加到上一条：原文接上新的，再写回去
    const mem = db.store.getMemory(prev.memoryId);
    if (mem) {
      const joined = mem.content + "；" + msg.text;
      db.store.db
        .prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?")
        .run(joined, Date.now(), prev.memoryId);

      // 光改 content 不够：环心的遗忘靠删点、检索靠点匹配。
      // 不补点的话，后面接进来的话在 points 里根本不存在 ——
      // 搜的时候永远捞不出来，衰减时也删不掉那一段，成了一条"删不掉的尾巴"。
      // weight 传 null：新点自动排在最后（越晚说的越不重要），跟 remember 的规则一致。
      for (const p of autoSplit(msg.text)) {
        db.store.insertPoint(prev.memoryId, p, null);
      }

      prev.lastTs = msg.ts;
      return { action: "append", memoryId: prev.memoryId };
    }
  }

  // 新开一条
  const mem = db.remember({
    content: msg.text,
    ring: "ring4",
    source: msg.kind,
    speaker: msg.isSelf ? "self" : "user",
    at: msg.ts,
    skipVault: true, // 原文已经进总库了，别再写一遍
  });
  mergeState.set(slot, { memoryId: mem.id, lastTs: msg.ts, firstTs: msg.ts });
  return { action: "new", memoryId: mem.id };
}

/* ───────────────────────── HTTP ───────────────────────── */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体太大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  try {
    if (req.method === "GET" && path === "/health") {
      return send(res, 200, {
        ok: true,
        db: DB_PATH,
        vault: getDb().store.vaultCount(),
        memories: getDb().stats(),
        owners: CFG.owners,
        mergeWindowMs: CFG.mergeWindowMs,
        gapMs: CFG.gapMs,
      });
    }

    if (req.method === "POST" && path === "/ingest") {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { ok: false, error: "不是合法 JSON" }); }

      const msg = parseMessage(body);
      if (msg.error) return send(res, 400, { ok: false, error: msg.error });

      const r = ingest(msg);
      return send(res, 200, { ok: true, ...r, vault: getDb().store.vaultCount() });
    }

    return send(res, 404, { ok: false, error: "只有 GET /health 和 POST /ingest" });
  } catch (e) {
    console.error("[ring-ingest] 出错：" + (e?.stack ?? e));
    return send(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

/* ───────────────────────── 导出（给测试用）───────────────────────── */

export { parseMessage, vaultLine, isPlaceholder, PLACEHOLDERS, ingest, CFG as INGEST_CONFIG };

/* ───────────────────────── 启动 ───────────────────────── */

const argPort = (() => {
  const i = process.argv.indexOf("--port");
  return i > 0 ? Number(process.argv[i + 1]) : null;
})();

/** 只有"直接 node 跑这个文件"才起服务；被 import（比如测试）就不要 listen */
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  server.listen(argPort ?? CFG.port, CFG.host, () => {
    console.log("[ring-ingest] listening http://" + CFG.host + ":" + (argPort ?? CFG.port));
    console.log("  库: " + DB_PATH);
    console.log("  主人: " + (CFG.owners.length ? CFG.owners.join(", ") : "（没配，谁的都不打【管理员】）"));
    console.log("  合并窗口: " + Math.round(CFG.mergeWindowMs / 1000) + " 秒（从首句算）/ 间隔 " + Math.round(CFG.gapMs / 1000) + " 秒");
    console.log("  现有: vault=" + getDb().store.vaultCount() + "  memories=" + JSON.stringify(getDb().stats()));
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log("\n[ring-ingest] 收工");
      try { _db?.close(); } catch { }
      process.exit(0);
    });
  }
}