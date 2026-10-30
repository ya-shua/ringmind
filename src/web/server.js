/**
 * 环形的心 · 面板服务
 *
 * 零依赖，只用 node:http。跑起来的规矩跟这个项目一致：
 *   - 一个 .db 文件 = 一个记忆库
 *   - 令牌写在 data/token.txt，第一次启动自动生成
 *   - 只监听 127.0.0.1，外面连不进来
 *
 * 用法：
 *   node src/web/server.js                    默认 ./data/memory.db
 *   node src/web/server.js --db ./data/x.db --port 5173
 */

import http from "node:http";
import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { Ringmind } from "../index.js";
import { ensureToken, verifyToken, makeSessionCookie, readToken, rotateToken } from "./auth.js";
import { checkForUpdate, applyUpdate, restartPanel, localVersion } from "./update.js";
import { CUSTOM_PREFIX, PRESETS, MODES, RINGS, RING_ORDER } from "../core/rings.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// ── token 用量账本 ────────────────────────────────────────
// 数据来自 qq-bridge 的 state/token-usage.jsonl，一行一次调用。
// 默认找项目 data/token-usage.jsonl；data-location.json 里给了 tokenUsageFile 就用那个。
const DEFAULT_TOKEN_LEDGER = resolve(HERE, "../../data/token-usage.jsonl");

// 元 / 百万 token（空闲时段单价；高峰 = ×2）
const TOKEN_PRICES = {
  "deepseek-flash": { label: "DeepSeek-V4.1-Flash", cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  "deepseek-v4-flash": { label: "DeepSeek-V4.1-Flash", cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  "deepseek-v4-flash-vision-exp": { label: "DeepSeek-V4.1-Flash", cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  "deepseek-v4-pro": { label: "DeepSeek-V4-Pro", cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
  "deepseek-pro": { label: "DeepSeek-V4-Pro", cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
};
const FALLBACK_PRICE = TOKEN_PRICES["deepseek-flash"];

// 法定节假日不算高峰（照 qq-bridge 的 CN_HOLIDAYS 口径）
const CN_HOLIDAYS = new Set([
  // 2026 元旦
  "2026-01-01", "2026-01-02", "2026-01-03",
  // 2026 春节
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  // 2026 清明
  "2026-04-04", "2026-04-05", "2026-04-06",
  // 2026 劳动节
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  // 2026 端午
  "2026-06-19", "2026-06-20", "2026-06-21",
  // 2026 中秋
  "2026-09-25", "2026-09-26", "2026-09-27",
  // 2026 国庆
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  "2026-10-05", "2026-10-06", "2026-10-07",
  // 2027 元旦
  "2027-01-01", "2027-01-02", "2027-01-03",
]);

/** 北京时间是不是高峰（工作日 9-12、14-18，节假日除外） */
function isPeakHour(ms) {
  const d = new Date(ms + 8 * 3600_000); // 转成北京时间看
  const wd = d.getUTCDay(); // 0=周日
  if (wd === 0 || wd === 6) return false;
  const date = d.toISOString().slice(0, 10);
  if (CN_HOLIDAYS.has(date)) return false; // 放假日不算高峰
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 算一次调用的钱（元） */
function costOf(model, b, ms) {
  const p = TOKEN_PRICES[model] || FALLBACK_PRICE;
  const mult = isPeakHour(ms) ? 2 : 1;
  const M = 1e6;
  // cacheWrite 缺省时按未命中价计（DeepSeek 目前不单独报，恒为 0，留着将来用）
  const writeRate = p.cacheWrite ?? p.cacheMiss;
  return (
    ((b.cacheHit || 0) * p.cacheHit * mult +
      (b.cacheMiss || 0) * p.cacheMiss * mult +
      (b.cacheWrite || 0) * writeRate * mult +
      (b.output || 0) * p.output * mult) /
    M
  );
}

/** 读整个账本，聚合出总账 + 按会话分组。hours > 0 时只算最近这么多小时 */
function readTokenLedger(ledgerPath, hours = 0) {
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return { ok: false, error: "找不到用量账本：" + ledgerPath, records: 0 };
  }

  const totals = { cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, cost: 0, calls: 0, turns: 0 };
  const byKey = new Map();
  const byDay = new Map();
  let records = 0;
  let firstAt = null;
  let lastAt = null;
  const cutoff = hours > 0 ? Date.now() - hours * 3600_000 : 0;

  const text = readFileSync(ledgerPath, "utf8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      continue;
    }
    const b = rec.b || {};
    const hit = b.cacheHit || 0;
    const miss = b.cacheMiss || 0;
    const out = b.output || 0;
    if (hit + miss + out === 0) continue; // base 那种空记录

    const ms = rec.t || 0;
    // 时间窗口：只要最近 hours 小时
    if (hours > 0 && (!ms || ms < cutoff)) continue;
    const cost = costOf(rec.model, b, ms);
    records++;
    if (!firstAt || ms < firstAt) firstAt = ms;
    if (!lastAt || ms > lastAt) lastAt = ms;

    totals.cacheHit += hit;
    totals.cacheMiss += miss;
    totals.cacheWrite += b.cacheWrite || 0;
    totals.output += out;
    totals.cost += cost;
    totals.calls++;

    const key = rec.key || "(未知)";
    let g = byKey.get(key);
    if (!g) {
      g = { key, kind: key.startsWith("group:") ? "群聊" : "私聊", id: key.split(":")[1] || "", cacheHit: 0, cacheMiss: 0, output: 0, cost: 0, calls: 0, turns: new Set(), lastAt: 0 };
      byKey.set(key, g);
    }
    g.cacheHit += hit;
    g.cacheMiss += miss;
    g.output += out;
    g.cost += cost;
    g.calls++;
    if (rec.k === "turn") g.turns.add(rec.turn ?? 0);
    if (ms > g.lastAt) g.lastAt = ms;

    // 按天（北京时间）
    const dstr = new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
    let dd = byDay.get(dstr);
    if (!dd) {
      dd = { date: dstr, cacheHit: 0, cacheMiss: 0, output: 0, cost: 0, calls: 0 };
      byDay.set(dstr, dd);
    }
    dd.cacheHit += hit;
    dd.cacheMiss += miss;
    dd.output += out;
    dd.cost += cost;
    dd.calls++;
  }

  const sessions = [...byKey.values()]
    .map((g) => ({ ...g, turns: g.turns.size }))
    .sort((a, b) => b.cost - a.cost);

  const inputTotal = totals.cacheHit + totals.cacheMiss;

  return {
    ok: true,
    ledger: ledgerPath,
    hours,
    records,
    firstAt,
    lastAt,
    totals: {
      ...totals,
      input: inputTotal,
      tokens: inputTotal + totals.output,
      hitRate: inputTotal ? totals.cacheHit / inputTotal : 0,
      perCall: totals.calls ? (inputTotal + totals.output) / totals.calls : 0,
    },
    sessions,
    days: [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
    prices: TOKEN_PRICES,
  };
}


/**
 * 记住数据目录到底搬去哪了
 *
 * 放在程序根目录（不是数据目录里），因为数据目录一搬，
 * 写在自己里面的指针也会跟着搬走，下次启动就找不着了。
 */
const LOCATION_FILE = resolve(HERE, "../../data-location.json");

/**
 * OneBot 网关地址和令牌：存在项目根 onebot.json，**不跟着记忆库走**。
 *
 * 切库只该换记忆，QQ 号和网关配置跟库没关系。
 * 老版本把它存在库的 meta 里，所以第一次读不到文件时从库里搬一份出来。
 */
const ONEBOT_FILE = resolve(HERE, "../../onebot.json");

function readOnebot(dbRef) {
  const def = { url: "http://127.0.0.1:3000", token: "" };
  try {
    if (existsSync(ONEBOT_FILE)) {
      const j = JSON.parse(readFileSync(ONEBOT_FILE, "utf8"));
      return { ...def, ...(j && typeof j === "object" ? j : {}) };
    }
  } catch {}
  // 第一次：从当前库的 meta 里搬出来（老版本存在那儿）
  try {
    const raw = dbRef && dbRef.store ? dbRef.store.getMeta("onebot") : null;
    if (raw) {
      const j = { ...def, ...JSON.parse(raw) };
      writeFileSync(ONEBOT_FILE, JSON.stringify(j, null, 2) + "\n", "utf8");
      return j;
    }
  } catch {}
  return def;
}

function writeOnebot(cfg) {
  const out = {
    url: String((cfg && cfg.url) || "http://127.0.0.1:3000").trim() || "http://127.0.0.1:3000",
    token: String((cfg && cfg.token) || "").trim(),
  };
  try {
    writeFileSync(ONEBOT_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  } catch {}
  return out;
}

function readLocation() {
  try {
    if (!existsSync(LOCATION_FILE)) return null;
    const j = JSON.parse(readFileSync(LOCATION_FILE, "utf8"));
    return j && typeof j.dataDir === "string" ? j : null;
  } catch {
    return null;
  }
}

function writeLocation(payload) {
  try {
    return writeFile(LOCATION_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch {
    return Promise.resolve();
  }
}

/** 算一个文件的 SHA256，用来确认复制过去的是同一份字节 */
function fileHash(p) {
  const h = createHash("sha256");
  return new Promise((ok, fail) => {
    const s = createReadStream(p);
    s.on("data", (c) => h.update(c));
    s.on("end", () => ok(h.digest("hex")));
    s.on("error", fail);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** 登录后的会话：sessionId → { expiresAt } */
const sessions = new Map();

function parseArgs(argv) {
  // data 默认 null：不传就去看 data-location.json 记的位置，再退回 ./data
  const out = { db: null, data: null, port: 5173, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--data") out.data = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]) || 5173;
    else if (a === "--host") out.host = argv[++i];
  }
  return out;
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0;
    let dead = false;
    const chunks = [];

    req.on("data", (c) => {
      if (dead) return;
      size += c.length;
      if (size > limit) {
        // 别 destroy：留着连接，让上层能回一句"太大了"，而不是把进程带走
        dead = true;
        chunks.length = 0;
        const mb = limit >= 1024 * 1024 ? Math.round(limit / 1024 / 1024) + " MB" : Math.round(limit / 1024) + " KB";
        fail(new Error("请求体太大，上限 " + mb));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return ok({});
      try {
        ok(JSON.parse(raw));
      } catch {
        ok({});
      }
    });
    req.on("error", fail);
  });
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionOf(req) {
  const sid = parseCookies(req.headers.cookie).ringmind_session;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return sid;
}

/** 挡掉路径穿越：只允许 web 目录下的文件 */
function safeJoin(base, urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const full = resolve(base, clean);
  return full.startsWith(resolve(base)) ? full : null;
}

async function serveFile(res, filePath) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "content-length": buf.length,
      "cache-control": "no-store",
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * 起服务
 * @param {object} opts
 * @param {string} opts.dataDir 数据目录（令牌、库文件都在这儿）
 * @param {string} [opts.dbPath]
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 */
/** 令牌打码：留头 4 尾 4，中间用点 —— 一眼能对上是哪一串，又看不全 */
function maskToken(tk) {
  const s = String(tk || "");
  if (!s) return "";
  if (s.length <= 10) return s.slice(0, 2) + "···" + s.slice(-2);
  return s.slice(0, 4) + "···" + s.slice(-4);
}

export async function createServer({ dataDir, dbPath, port = 5173, host = "127.0.0.1" } = {}) {
  let data = resolve(dataDir || "./data");
  let dbFile = resolve(dbPath || join(data, "memory.db"));

  const tk0 = ensureToken(data);
  const token = tk0.token;
  const created = tk0.created;
  let tokenPath = tk0.path;
  let db = new Ringmind(dbFile, basename(dbFile, extname(dbFile)));
  const startedAt = Date.now();

  /**
   * 把整个数据目录搬到新位置
   *
   * 顺序：先把 WAL 合并回主库 → 关库 → 复制 → 用新文件真开一遍核对条数
   * → 条数对得上才切过去。任何一步不对就删掉复制过去的、把旧库重新打开，
   * 原来那份数据一点不动。
   *
   * 搬的是「数据目录里的全部文件」——库、令牌、别的存档都在里面，
   * 所以换完之后登录态、配置、记忆全都跟着走。
   */
  async function moveDataTo(toDirRaw) {
    const raw = String(toDirRaw || "").trim();
    if (!raw) throw new Error("没选文件夹");

    const toDir = resolve(raw);
    if (!existsSync(toDir)) throw new Error("目标文件夹不存在：" + toDir);
    if (!(await stat(toDir)).isDirectory()) throw new Error("选中的不是文件夹");

    const cur = resolve(data);
    const low = (p) => resolve(p).toLowerCase();
    if (low(toDir) === low(cur)) throw new Error("已经就放在这个位置了");
    if (low(toDir).startsWith(low(cur) + sep)) throw new Error("不能搬到自己的子文件夹里");

    const dbName = basename(dbFile);
    const targetDb = join(toDir, dbName);
    if (existsSync(targetDb)) {
      throw new Error("那个文件夹里已经有 " + dbName + " 了，换一个地方");
    }

    // 搬之前把该记的都记下来：条数、schema、模式、总库、库名
    // 搬完逐项对上，只要有一项不对就当没搬
    const beforeSt = db.todayStats();
    const beforeOv = db.overview();
    const want = {
      memories: Number(beforeSt.memories || 0),
      points: Number(beforeSt.points || 0),
      pinned: Number(beforeSt.pinned || 0),
      schemaVersion: beforeOv.schemaVersion,
      mode: beforeOv.mode,
      preset: beforeOv.preset,
      vault: Number(beforeOv.vault || 0),
      name: beforeOv.name,
    };

    // WAL 里可能压着一堆没并回去的数据，先合并，再关连接
    try {
      db.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* 关不关得动都继续，close 时还会再并一次 */
    }
    db.close();

    const copied = [];
    const reopenOld = () => {
      try {
        db = new Ringmind(dbFile, basename(dbFile, extname(dbFile)));
      } catch {
        /* 起不来的话服务就废了，但至少数据还在盘上 */
      }
    };
    const undo = async () => {
      for (const p of copied) {
        try {
          await unlink(p);
        } catch {
          /* 删不掉就算了，反正没切过去 */
        }
      }
      reopenOld();
    };

    // 复制整个目录；-wal / -shm / -journal 是 sqlite 的临时文件，已经并进主库了，不搬
    // 每个文件复制前先算哈希，复制后逐个对，确保字节一模一样
    const manifest = [];
    try {
      const entries = await readdir(cur, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (/\.db-(wal|shm|journal)$/i.test(e.name)) continue;
        const src = join(cur, e.name);
        const info = await stat(src);
        manifest.push({
          name: e.name,
          src,
          dst: join(toDir, e.name),
          size: info.size,
          hash: await fileHash(src),
        });
      }
      for (const m of manifest) {
        await copyFile(m.src, m.dst);
        copied.push(m.dst);
      }
    } catch (e) {
      await undo();
      throw new Error("复制到新位置时出错：" + (e?.message || e));
    }

    // 逐个文件核对：大小 + SHA256 都要一致
    for (const m of manifest) {
      try {
        const info = await stat(m.dst);
        if (info.size !== m.size) {
          throw new Error(m.name + " 大小对不上（原 " + m.size + " / 新 " + info.size + "）");
        }
        const h2 = await fileHash(m.dst);
        if (h2 !== m.hash) {
          throw new Error(m.name + " 内容对不上（哈希不一致）");
        }
      } catch (e) {
        await undo();
        throw new Error("完整性校验没过：" + (e?.message || e));
      }
    }

    // 用新位置的文件真开一遍，逐项核对；有一项不对就当没搬
    let afterSt;
    let afterOv;
    try {
      const probe = new Ringmind(targetDb, basename(targetDb, extname(targetDb)));
      afterSt = probe.todayStats();
      afterOv = probe.overview();
      probe.close();
    } catch (e) {
      await undo();
      throw new Error("新位置的文件打不开：" + (e?.message || e));
    }

    const got = {
      memories: Number(afterSt.memories || 0),
      points: Number(afterSt.points || 0),
      pinned: Number(afterSt.pinned || 0),
      schemaVersion: afterOv.schemaVersion,
      mode: afterOv.mode,
      preset: afterOv.preset,
      vault: Number(afterOv.vault || 0),
      name: afterOv.name,
    };
    const LABEL = {
      memories: "记忆条数",
      points: "点总数",
      pinned: "钉住条数",
      schemaVersion: "schema 版本",
      mode: "记忆模式",
      preset: "场景档",
      vault: "总库条数",
      name: "库名",
    };
    const bad = Object.keys(want).filter((k) => want[k] !== got[k]);
    if (bad.length) {
      await undo();
      throw new Error(
        "核对没过，已放弃搬家：" +
          bad.map((k) => LABEL[k] + "（原 " + want[k] + " / 新 " + got[k] + "）").join("；")
      );
    }

    // 到这里完整性全过了，才真正切：先切内存里的路径，再确认新库能正常读
    const from = { dataDir: cur, dbPath: dbFile };
    const fromFiles = manifest.map((m) => m.src);
    try {
      data = toDir;
      dbFile = targetDb;
      db = new Ringmind(dbFile, basename(dbFile, extname(dbFile)));
      tokenPath = ensureToken(data, { silent: true }).path;
      const sanity = db.todayStats();
      if (Number(sanity.memories || 0) !== want.memories) {
        throw new Error("切过去之后读出来的条数不对");
      }
    } catch (e) {
      // 切失败：路径退回去，旧库重新打开（旧文件还在盘上）
      data = from.dataDir;
      dbFile = from.dbPath;
      await undo();
      throw new Error("切换失败，已退回原位置：" + (e?.message || e));
    }

    await writeLocation({ dataDir: data, dbPath: dbFile, movedAt: Date.now() });

    // 完整性确认过，才删原位置的东西
    const removed = [];
    const kept = [];
    for (const p of fromFiles) {
      try {
        await unlink(p);
        removed.push(basename(p));
      } catch (e) {
        kept.push({ name: basename(p), error: e?.message || String(e) });
      }
    }

    return {
      from: from.dataDir,
      fromDb: from.dbPath,
      to: data,
      dbPath: dbFile,
      files: copied.length,
      memories: got.memories,
      points: got.points,
      verified: Object.keys(want).length,
      removed,
      kept,
    };
  }

  // ── 记忆库清单 ──────────────────────────────
  // 一个记忆 = 一个目录：<上级>\<库名>\<库名>.db，彼此隔离、同级。
  const LIBS_FILE = resolve(HERE, "../../libraries.json");

  function readLibs() {
    try {
      if (!existsSync(LIBS_FILE)) return [];
      const j = JSON.parse(readFileSync(LIBS_FILE, "utf8"));
      return Array.isArray(j.libs) ? j.libs.filter((x) => x && typeof x.db === "string" && x.db) : [];
    } catch {
      return [];
    }
  }

  function writeLibs(libs) {
    const clean = libs
      .filter((x) => x && typeof x.db === "string" && x.db)
      .map((x) => ({
        name: String(x.name || basename(x.db, extname(x.db))),
        dir: String(x.dir || dirname(x.db)),
        db: String(x.db),
      }));
    try {
      writeFileSync(LIBS_FILE, JSON.stringify({ libs: clean }, null, 2) + "\n", "utf8");
    } catch {
      /* 清单写不了不影响当前会话 */
    }
    return clean;
  }

  /** 把当前正在用的库补进清单（首次运行、手动搬过库都靠这个） */
  function syncCurrentLib() {
    const libs = readLibs();
    const cur = resolve(dbFile).toLowerCase();
    const hit = libs.find((x) => resolve(x.db).toLowerCase() === cur);
    if (hit) {
      hit.name = basename(dbFile, extname(dbFile));
      hit.dir = dirname(dbFile);
      return writeLibs(libs);
    }
    libs.push({ name: basename(dbFile, extname(dbFile)), dir: dirname(dbFile), db: dbFile });
    return writeLibs(libs);
  }

  /** 试着打开一个库读条数；打不开返回 null */
  async function probeDb(p) {
    try {
      const probe = new Ringmind(p, basename(p, extname(p)));
      const st = probe.todayStats();
      const schema = Number(probe.store.getMeta("schema_version") ?? 0);
      const born = probe.store.getMeta("created_at");
      probe.close();
      return {
        memories: Number(st.memories || 0),
        points: Number(st.points || 0),
        schema,
        born: born || null,
      };
    } catch {
      return null;
    }
  }

  /** 去掉不能当文件夹名用的字符 */
  const cleanDbName = (raw) =>
    String(raw || "")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\.db$/i, "")
      .trim();

  /**
   * 删掉一个库（整个文件夹）。三道闸：
   *   1) 正在用的那个库不许删
   *   2) 唯一一个库不许删（前端拦）
   *   3) 只在「文件夹里就这一个 .db」时才删整个目录
   */
  async function deleteLibrary(nameRaw, dbPathRaw) {
    const name = cleanDbName(nameRaw);
    if (!name) throw new Error("没给库名");

    const libs = readLibs();
    const target = dbPathRaw ? resolve(String(dbPathRaw)) : null;
    const lib = libs.find(
      (x) =>
        (target && resolve(x.db).toLowerCase() === target.toLowerCase()) ||
        cleanDbName(x.name) === name
    );
    if (!lib) throw new Error("清单里没有这个库");

    const dbAbs = resolve(lib.db);
    if (dbAbs.toLowerCase() === resolve(dbFile).toLowerCase()) {
      throw new Error("这是正在用的库，先切到别的库再删");
    }
    if (!existsSync(dbAbs)) throw new Error("库文件已经不在了");

    const dir = dirname(dbAbs);
    const stem = basename(dbAbs, extname(dbAbs));

    const siblings = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".db"));
    if (siblings.length > 1) {
      throw new Error("这个文件夹里还有 " + siblings.length + " 个 .db，不敢动，请手动处理");
    }

    // 用户不需要自动备份：想留底请先用「导出备份」。
    // 摘清单
    writeLibs(libs.filter((x) => resolve(x.db).toLowerCase() !== dbAbs.toLowerCase()));

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      throw new Error("删文件夹失败：" + (e && e.message ? e.message : e));
    }

    return { name: lib.name, db: dbAbs };
  }

  /** 清单 + 每个库的实时状态 */
  async function listDatabases() {
    const cur = resolve(dbFile).toLowerCase();
    const libs = syncCurrentLib();
    const out = [];
    for (const l of libs) {
      const info = await stat(l.db).catch(() => null);
      const st = info ? await probeDb(l.db) : null;
      out.push({
        name: l.name,
        file: basename(l.db),
        dir: l.dir,
        path: l.db,
        exists: !!info,
        bytes: info ? info.size : 0,
        current: resolve(l.db).toLowerCase() === cur,
        memories: st ? st.memories : null,
        points: st ? st.points : null,
      });
    }
    out.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.name.localeCompare(b.name));
    return { dir: data, parent: dirname(data), current: dbFile, list: out };
  }

  /**
   * 新建一个空库，放在自己的目录里，不切换。
   *
   * 目录规则：<上级>\<库名>\<库名>.db
   * 上级默认取当前库所在目录的上一级 —— 这样所有记忆平级，
   * 各自一个目录，互不打扰。
   */
  async function newDatabase(nameRaw, parentDirRaw) {
    const name = cleanDbName(nameRaw);
    if (!name) throw new Error("给新库起个名字");
    if (name.length > 40) throw new Error("名字太长了，40 个字以内");

    const parent = String(parentDirRaw || "").trim()
      ? resolve(String(parentDirRaw).trim())
      : dirname(data);

    const targetDir = join(parent, name);
    const targetDb = join(targetDir, name + ".db");

    if (existsSync(targetDb)) throw new Error("已经有「" + targetDb + "」了，换个名字");

    try {
      await mkdir(targetDir, { recursive: true });
    } catch (e) {
      throw new Error("目录建不出来：" + (e?.message || e));
    }

    try {
      const fresh = new Ringmind(targetDb, name);
      fresh.close();
    } catch (e) {
      try {
        await unlink(targetDb);
      } catch {
        /* 没建出来就算了 */
      }
      throw new Error("库文件建不出来：" + (e?.message || e));
    }

    // 令牌带过去：同一个令牌，切过去不用重新登录
    try {
      if (!existsSync(join(targetDir, "token.txt"))) {
        const curTok = readToken(data);
        if (curTok) await writeFile(join(targetDir, "token.txt"), curTok + "\n", "utf8");
      }
    } catch {
      /* 带不过去就让 ensureToken 自己生成，大不了重新登录 */
    }

    const libs = readLibs();
    if (!libs.some((x) => resolve(x.db).toLowerCase() === resolve(targetDb).toLowerCase())) {
      libs.push({ name, dir: targetDir, db: targetDb });
      writeLibs(libs);
    }

    const st = await probeDb(targetDb);
    return {
      name,
      dir: targetDir,
      dbPath: targetDb,
      memories: st ? st.memories : 0,
      points: st ? st.points : 0,
      switched: false,
    };
  }

  /** 切到清单里另一个库；整个数据目录跟着换 */
  async function switchDatabase(dbPathRaw) {
    const raw = String(dbPathRaw || "").trim();
    if (!raw) throw new Error("没选库");
    const target = resolve(raw);
    if (!existsSync(target)) throw new Error("找不到这个库：" + target);
    if (target.toLowerCase() === resolve(dbFile).toLowerCase()) {
      throw new Error("已经在这个库上了");
    }

    const st0 = await probeDb(target);
    if (!st0) throw new Error("这个库打不开：" + target);

    const targetDir = dirname(target);
    const fromDb = dbFile;
    const fromDir = data;
    const fromName = basename(fromDb, extname(fromDb));

    try {
      db.close();

      // 目标目录没令牌就把当前的带过去
      if (!existsSync(join(targetDir, "token.txt"))) {
        const curTok = readToken(data);
        if (curTok) await writeFile(join(targetDir, "token.txt"), curTok + "\n", "utf8");
      }

      data = targetDir;
      dbFile = target;
      db = new Ringmind(target, basename(target, extname(target)));
      tokenPath = ensureToken(data, { silent: true }).path;
      await writeLocation({ dataDir: data, dbPath: dbFile, movedAt: Date.now() });
    } catch (e) {
      data = fromDir;
      dbFile = fromDb;
      try {
        db = new Ringmind(fromDb, fromName);
      } catch {
        /* 起不来只能认了 */
      }
      throw new Error("切换失败，已退回：" + (e?.message || e));
    }

    syncCurrentLib();
    const st = db.todayStats();
    return {
      from: fromDb,
      dbPath: dbFile,
      name: basename(dbFile, extname(dbFile)),
      memories: Number(st.memories || 0),
      points: Number(st.points || 0),
    };
  }


  // ── 自定义方案 ──────────────────────────────
  /** 基于当前生效值，新建一个自己的方案（内置三档不受影响） */
  function createPreset(nameRaw) {
    const cfg = db.getConfig();
    const name = String(nameRaw || "").trim();
    if (!name) throw new Error("给这个方案起个名字");
    if (name.length > 40) throw new Error("名字太长了，40 个字以内");

    const custom = cfg.customPresets || {};
    if (Object.values(custom).some((v) => v.label === name)) {
      throw new Error("已经有一个叫「" + name + "」的方案了");
    }

    // 拿当前生效的那套值做底稿
    const rings = {};
    for (const id of RING_ORDER) {
      const cur = cfg.rings?.[id] || {};
      rings[id] = { days: cur.days === undefined ? null : cur.days, cap: cur.cap === undefined ? null : cur.cap };
    }

    const key = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const id = CUSTOM_PREFIX + key;
    const base = PRESETS[cfg.preset];

    db.replaceConfig({
      ...cfg,
      preset: id,
      rings,
      customPresets: {
        ...custom,
        [key]: { label: name, perDay: base ? base.perDay : 50, rings },
      },
    });

    return { id, key, label: name, rings, preset: id };
  }

  /** 给自己的方案改名 */
  function renamePreset(idRaw, nameRaw) {
    const cfg = db.getConfig();
    const id = String(idRaw || "");
    const key = id.startsWith(CUSTOM_PREFIX) ? id.slice(CUSTOM_PREFIX.length) : "";
    const custom = cfg.customPresets || {};
    if (!key || !custom[key]) throw new Error("只能改自己建的方案");

    const name = String(nameRaw || "").trim();
    if (!name) throw new Error("名字不能空");
    if (name.length > 40) throw new Error("名字太长了，40 个字以内");
    if (Object.entries(custom).some(([k, v]) => k !== key && v.label === name)) {
      throw new Error("已经有一个叫「" + name + "」的方案了");
    }

    db.replaceConfig({
      ...cfg,
      customPresets: { ...custom, [key]: { ...custom[key], label: name } },
    });
    return { id, label: name };
  }

  /** 删掉自己的方案；删的正好是当前用的就退回混合 */
  function deletePreset(idRaw) {
    const cfg = db.getConfig();
    const id = String(idRaw || "");
    const key = id.startsWith(CUSTOM_PREFIX) ? id.slice(CUSTOM_PREFIX.length) : "";
    const custom = { ...(cfg.customPresets || {}) };
    if (!key || !custom[key]) throw new Error("只能删自己建的方案");

    delete custom[key];

    const next = { ...cfg, customPresets: custom };
    if (cfg.preset === id) {
      next.preset = "mixed";
      next.rings = Object.fromEntries(
        RING_ORDER.map((rid) => [
          rid,
          {
            days: PRESETS.mixed.rings[rid]?.days ?? RINGS[rid].days,
            cap: PRESETS.mixed.rings[rid]?.cap ?? RINGS[rid].cap,
          },
        ])
      );
    }
    const out = db.replaceConfig(next);
    return { id, preset: out.preset };
  }

  // ── 备份 / 恢复 ──────────────────────────────
  /**
   * 生成一份一致的快照
   *
   * 直接复制 .db 会漏掉还在 WAL 里的最新数据；VACUUM INTO 是 SQLite
   * 自己把整库重写成一份干净文件，所以拿到的永远是完整的那一刻。
   */
  async function snapshotTo(targetPath) {
    await unlink(targetPath).catch(() => {});
    const esc = String(targetPath).replace(/'/g, "''");
    db.store.db.exec(`VACUUM INTO '${esc}'`);
    return targetPath;
  }

  /** 时间戳，用来给备份文件起名 */
  function stampNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes())
    );
  }

  const server = http.createServer(async (req, res) => {
   try {
    const url = req.url || "/";
    const method = req.method || "GET";

    // ── 登录 ──────────────────────────────────────────
    if (method === "POST" && url === "/api/login") {
      const body = await readBody(req);
      if (!verifyToken(data, body.token)) {
        return json(res, 401, { ok: false, error: "令牌不对" });
      }
      const cookie = makeSessionCookie();
      const sid = cookie.split(";")[0].split("=")[1];
      sessions.set(sid, { expiresAt: Date.now() + 86400000 });
      res.setHeader("set-cookie", cookie);
      return json(res, 200, { ok: true });
    }

    if (url === "/api/logout") {
      const sid = sessionOf(req);
      if (sid) sessions.delete(sid);
      res.setHeader("set-cookie", "ringmind_session=; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    // ── 以下都要登录 ───────────────────────────────────
    if (url.startsWith("/api/")) {
      if (!sessionOf(req)) return json(res, 401, { ok: false, error: "没登录" });

      if (method === "GET" && url === "/api/overview") {
        return json(res, 200, { ok: true, data: db.overview() });
      }

      if (method === "GET" && url.startsWith("/api/ring/")) {
        const id = decodeURIComponent(url.slice("/api/ring/".length).split("?")[0]);
        const limit = Number(new URL(url, "http://x").searchParams.get("limit")) || 50;
        try {
          return json(res, 200, { ok: true, data: db.byRing(id, limit) });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }

      if (method === "GET" && url === "/api/modes") {
        // 直接把四种模式的真实数值摊出来，面板那张对比表不再写死
        const out = Object.values(MODES).map((m) => ({
          id: m.id,
          label: m.label,
          desc: m.desc,
          fade: m.fade,
          vaultAccessible: m.vaultAccessible,
          visible: m.visible ?? null,
          buffer: m.buffer ?? null,
        }));
        return json(res, 200, { ok: true, data: out });
      }

      if (method === "GET" && url === "/api/recent") {
        return json(res, 200, { ok: true, data: db.recent(8) });
      }

      if (method === "GET" && url === "/api/stats") {
        let bytes = null;
        try {
          bytes = (await stat(dbFile)).size;
        } catch {}
        return json(res, 200, {
          ok: true,
          data: { ...db.todayStats(), bytes, dbPath: dbFile },
        });
      }

      if (method === "GET" && url === "/api/config") {
        const cfg = db.getConfig();
        return json(res, 200, {
          ok: true,
          data: {
            mode: cfg.mode,
            preset: cfg.preset,
            rings: cfg.rings,
            customRatios: cfg.customRatios,
            quota: cfg.quota,
            selfSpeechWeight: cfg.selfSpeechWeight,
            metaMemory: cfg.metaMemory,
            promote: cfg.promote,
            compaction: cfg.compaction,
          },
        });
      }

      if (method === "GET" && url === "/api/preset") {
        const cfg = db.getConfig();
        const custom = Object.entries(cfg.customPresets || {}).map(([key, v]) => ({
          id: CUSTOM_PREFIX + key,
          key,
          label: v.label,
          perDay: v.perDay,
          rings: v.rings,
          locked: false,
        }));

        return json(res, 200, {
          ok: true,
          data: {
            current: cfg.preset,
            builtin: Object.values(PRESETS).map((p) => ({
              id: p.id,
              label: p.label,
              desc: p.desc,
              perDay: p.perDay,
              rings: p.rings,
              locked: true,
            })),
            custom,
            info: db.presetInfo(),
          },
        });
      }

      // 建一个自己的方案（以当前生效值为底稿）
      if (method === "POST" && url === "/api/preset-new") {
        const body = await readBody(req);
        try {
          return json(res, 200, { ok: true, data: createPreset(body.name) });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 给自己的方案改名
      if (method === "POST" && url === "/api/preset-rename") {
        const body = await readBody(req);
        try {
          return json(res, 200, { ok: true, data: renamePreset(body.id, body.name) });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 删掉自己的方案
      if (method === "POST" && url === "/api/preset-delete") {
        const body = await readBody(req);
        try {
          return json(res, 200, { ok: true, data: deletePreset(body.id) });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      if (method === "POST" && url === "/api/preset") {
        const body = await readBody(req);
        try {
          const cfg = db.setPreset(body.preset);
          return json(res, 200, { ok: true, data: { preset: cfg.preset, rings: cfg.rings } });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }

      if (method === "POST" && url === "/api/config") {
        const body = await readBody(req);
        try {
          const cfg = db.updateConfig(body);
          return json(res, 200, { ok: true, data: cfg });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }

      if (method === "POST" && url === "/api/mode") {
        const body = await readBody(req);
        if (!MODES[body.mode]) return json(res, 400, { ok: false, error: "没这个模式" });
        const cfg = db.setMode(body.mode);
        return json(res, 200, { ok: true, data: { mode: cfg.mode } });
      }

      // 把整个数据目录搬到新位置（库 + 令牌 + 其他存档一起走）
      if (method === "POST" && url === "/api/move-data") {
        const body = await readBody(req);
        try {
          const r = await moveDataTo(body.dir);
          return json(res, 200, { ok: true, data: r });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 记忆库清单
      // 导出一份备份，直接当文件下载
      if (method === "GET" && url === "/api/backup/export") {
        try {
          const name = basename(dbFile, extname(dbFile));
          const stamp = stampNow();
          const tmp = join(tmpdir(), "ringmind-" + stamp + "-" + Math.random().toString(36).slice(2, 6) + ".db");

          await snapshotTo(tmp);
          const buf = await readFile(tmp);
          await unlink(tmp).catch(() => {});

          const fileName = name + "-" + stamp + ".db";
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(buf.length),
            "Content-Disposition":
              'attachment; filename="ringmind-backup.db"; filename*=UTF-8\'\'' + encodeURIComponent(fileName),
            "Cache-Control": "no-store",
          });
          return res.end(buf);
        } catch (e) {
          return json(res, 500, { ok: false, error: e?.message || String(e) });
        }
      }

      // 用备份整个替换当前库
      if (method === "POST" && url === "/api/backup/restore") {
        let body;
        let tmp = null;
        try {
          // 一个 60 MB 的库转成 base64 大约 80 MB，留点余量
          body = await readBody(req, 100 * 1024 * 1024);
        } catch (e) {
          return json(res, 413, { ok: false, error: e?.message || "文件太大" });
        }
        try {
          const raw = String(body.data || "");
          if (!raw) throw new Error("没收到文件内容");

          const buf = Buffer.from(raw, "base64");
          if (buf.length < 1024) throw new Error("这个文件太小了，不像是记忆库");
          if (buf.subarray(0, 15).toString("latin1") !== "SQLite format 3") {
            throw new Error("这不是记忆库文件（.db）");
          }

          // 先落到临时文件验一遍
          tmp = join(tmpdir(), "ringmind-restore-" + Date.now() + ".db");
          await writeFile(tmp, buf);
          const probe = await probeDb(tmp);
          if (!probe || !probe.schema) {
            throw new Error("这个库打不开，可能已损坏，或者不是本程序的库");
          }
          if (probe.schema > 999) {
            throw new Error("这个库的结构版本读不懂");
          }

          // 当前库先自动留一份，出事还能找回
          const nm = basename(dbFile, extname(dbFile));
          const keep = join(data, nm + ".恢复前-" + stampNow() + ".db");
          await snapshotTo(keep);

          // 关库 → 换文件 → 重开
          db.close();
          await copyFile(tmp, dbFile);
          await unlink(dbFile + "-wal").catch(() => {});
          await unlink(dbFile + "-shm").catch(() => {});

          try {
            db = new Ringmind(dbFile, nm);
          } catch (e) {
            // 装不上就退回刚才那份
            await copyFile(keep, dbFile).catch(() => {});
            await unlink(dbFile + "-wal").catch(() => {});
            await unlink(dbFile + "-shm").catch(() => {});
            db = new Ringmind(dbFile, nm);
            throw new Error("这份备份装不上（" + (e?.message || e) + "），已经还原成原来的库");
          }

          await writeLocation({ dataDir: data, dbPath: dbFile, movedAt: Date.now() });
          await syncCurrentLib();

          const st = db.todayStats();
          return json(res, 200, {
            ok: true,
            data: {
              memories: Number(st.memories || 0),
              points: Number(st.points || 0),
              backup: keep,
              name: nm,
            },
          });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        } finally {
          if (tmp) await unlink(tmp).catch(() => {});
        }
      }

      if (method === "GET" && url === "/api/databases") {
        const info = await listDatabases();
        return json(res, 200, { ok: true, data: info });
      }

      // 新建一个空库（不切换）
      if (method === "POST" && url === "/api/new-db") {
        const body = await readBody(req);
        try {
          const r = await newDatabase(body.name, body.parentDir);
          return json(res, 200, { ok: true, data: r });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 切到另一个已有的库（传完整 .db 路径）
      if (method === "POST" && url === "/api/switch-db") {
        const body = await readBody(req);
        try {
          const r = await switchDatabase(body.path || body.name);
          return json(res, 200, { ok: true, data: r });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 删掉一个库（整个文件夹）。要输入库名确认，且自动备份。
      if (method === "POST" && url === "/api/library-delete") {
        const body = await readBody(req);
        try {
          const r = await deleteLibrary(body.name, body.db);
          return json(res, 200, { ok: true, data: r });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      if (method === "POST" && url === "/api/pick-folder") {
        // VBScript → Shell.Application.BrowseForFolder
        // PowerShell 的 WinForms FolderBrowserDialog 需要交互桌面（后台进程弹不出），
        // 换用系统 COM 组件，wscript.exe 自带消息泵，不依赖窗口站。
        if (process.platform !== "win32") {
          return json(res, 400, { ok: false, error: "非 Windows 还不支持" });
        }
        try {
          const { randomBytes } = await import("node:crypto");
          const { tmpdir } = await import("node:os");
          const { execFile } = await import("node:child_process");

          const tag = randomBytes(4).toString("hex");
          const vbsPath = join(tmpdir(), `ringmind_pick_${tag}.vbs`);
          const outPath = join(tmpdir(), `ringmind_pick_${tag}.txt`);

          const vbs = [
            'Set objShell = CreateObject("Shell.Application")',
            'Set objFolder = objShell.BrowseForFolder(0, "选一个文件夹放记忆库", 0, 0)',
            "If Not objFolder Is Nothing Then",
            "  Set objFSO = CreateObject(\"Scripting.FileSystemObject\")",
            `  Set objFile = objFSO.CreateTextFile("${outPath}", True, True)`,
            "  objFile.Write objFolder.Self.Path",
            "  objFile.Close",
            "End If",
          ].join("\r\n");

          // wscript 对 UTF-8 无 BOM 的 .vbs 会按系统 ANSI(GBK) 解析，中文在解析阶段就烂了；
          // 必须写成 UTF-16 LE + BOM，它才认（\uFEFF 在 utf16le 下就是 FF FE）
          await writeFile(vbsPath, "\uFEFF" + vbs, "utf16le");

          await new Promise((ok, fail) => {
            execFile("wscript.exe", [vbsPath], { timeout: 180000 }, (err) => {
              try { unlink(vbsPath); } catch { /* 删不掉算了 */ }
              if (err) return fail(err);
              ok();
            });
          });

          let p = null;
          if (existsSync(outPath)) {
            p = readFileSync(outPath, "utf16le").trim() || null;
            try { unlink(outPath); } catch { /* 删不掉算了 */ }
          }
          return json(res, 200, { ok: true, data: { path: p } });
        } catch {
          return json(res, 200, { ok: true, data: { path: null } });
        }
      }

      if (method === "GET" && url === "/api/health") {
        // 这一页是给"外部连得上没有"用的：
        //   OneBot 网关 / QQ 账号 / 记忆库 / 别的服务
        // OneBot 的地址和 token 存在 meta 里，面板上填一次就行
        let ob = readOnebot(db);
        if (process.env.ONEBOT_URL) ob.url = process.env.ONEBOT_URL;
        if (process.env.ONEBOT_TOKEN) ob.token = process.env.ONEBOT_TOKEN;

        const probe = async (u, tk, path = "/get_login_info", ms = 2500) => {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), ms);
          try {
            const r = await fetch(u.replace(/\/+$/, "") + path, {
              headers: tk ? { Authorization: "Bearer " + tk } : {},
              signal: ctl.signal,
            });
            const b = await r.json().catch(() => ({}));
            return { reachable: true, status: r.status, body: b };
          } catch (e) {
            return { reachable: false, error: e.name === "AbortError" ? "超时" : e.message };
          } finally {
            clearTimeout(t);
          }
        };

        // 记忆库：本地 SQLite，读一次证明活着
        let dbOk = false;
        let bytes = 0;
        let lastWrite = null;
        try {
          const st = await stat(dbFile);
          bytes = st.size;
          lastWrite = Math.round(st.mtimeMs);
          db.store.countByRing("core");
          dbOk = true;
        } catch {}

        const st2 = db.todayStats();
        const onebot = await probe(ob.url, ob.token);

        let qq = null;
        if (onebot.reachable && onebot.status === 200 && onebot.body?.status === "ok") {
          const d = onebot.body.data || {};
          qq = { userId: String(d.user_id ?? ""), nickname: d.nickname || "" };
        }

        // 网关自己的运行态和版本（拿不到就算了，不影响主判断）
        let gw = null;
        let ver = null;
        if (onebot.reachable && onebot.status === 200) {
          const s = await probe(ob.url, ob.token, "/get_status", 1500);
          if (s.reachable && s.status === 200 && s.body?.status === "ok") {
            gw = { online: Boolean(s.body.data?.online), good: Boolean(s.body.data?.good), uptime: s.body.data?.time ?? null };
          }
          const v = await probe(ob.url, ob.token, "/get_version_info", 1500);
          if (v.reachable && v.status === 200 && v.body?.status === "ok") {
            ver = { app: v.body.data?.app_name || "", version: v.body.data?.app_version || "" };
          }
        }

        return json(res, 200, {
          ok: true,
          data: {
            server: {
              ok: true,
              runningSec: Math.floor((Date.now() - startedAt) / 1000),
              host,
              port,
              url: `http://${host}:${port}`,
              node: process.version,
              pid: process.pid,
              token: maskToken(readToken(data) || token),
              tokenHash: (() => {
                const v = readToken(data) || token;
                return v ? createHash("sha256").update(v).digest("hex").slice(0, 12) : null;
              })(),
            },
            db: { ok: dbOk, path: dbFile, bytes, lastWrite, memories: st2.memories, points: st2.points },
            onebot: {
              url: ob.url,
              token: maskToken(ob.token),
              configured: Boolean(ob.token || process.env.ONEBOT_URL),
              reachable: onebot.reachable,
              authorized: onebot.status === 200,
              status: onebot.status ?? null,
              error: onebot.error || null,
              online: gw?.online ?? null,
              uptime: gw?.uptime ?? null,
              app: ver?.app || null,
              version: ver?.version || null,
            },
            qq,
            others: [
              { name: "视觉服务", ok: false, note: "面板不调它" },
              { name: "浏览器桥", ok: false, note: "还没接" },
            ],
          },
        });
      }

      if (method === "POST" && url === "/api/panel-token") {
        // 改面板自己的登录令牌：写 token.txt，写完全局生效，当前会话作废需重登
        try {
          const body = await readBody(req);
          const want = String(body.token || "").trim();
          if (want && want.length < 8) {
            return json(res, 400, { ok: false, error: "令牌太短了，至少 8 位" });
          }
          const next = rotateToken(data, want || undefined);
          return json(res, 200, { ok: true, data: { token: maskToken(next) } });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }

      if (method === "POST" && url === "/api/onebot") {
        const body = await readBody(req);
        // 只传了地址就保留原来的令牌，免得改个地址把令牌冲掉
        const prev = readOnebot(db);
        const cfg = {
          url: String(body.url || "").trim() || prev.url || "http://127.0.0.1:3000",
          token: "token" in body ? String(body.token || "").trim() : prev.token,
        };
        return json(res, 200, { ok: true, data: writeOnebot(cfg) });
      }

      // ── 在线更新 ───────────────────────────────
      // 只动代码，不动数据（data/、libraries.json 这些都在 .gitignore 里）。
      // 更新完自己重启；前端会轮询 /api/health 等它回来。
      if (method === "GET" && url === "/api/update-check") {
        const r = await checkForUpdate().catch((e) => ({ ok: false, error: e?.message || String(e) }));
        return json(res, 200, { ok: true, data: r, version: localVersion() });
      }

      if (method === "POST" && url === "/api/update") {
        const r = await applyUpdate().catch((e) => ({ ok: false, error: e?.message || String(e) }));
        if (!r.ok) return json(res, 400, { ok: false, error: r.error || "更新失败", data: r });
        const rs = await restartPanel({ port }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
        return json(res, 200, { ok: true, data: { ...r, restart: rs } });
      }

      if (method === "GET" && url.startsWith("/api/search")) {
        const u = new URL(url, "http://x");
        const q = u.searchParams.get("q") || "";
        const limit = Number(u.searchParams.get("limit")) || 30;
        const ring = u.searchParams.get("ring") || null;
        try {
          return json(res, 200, { ok: true, data: db.search(q, { limit, ring }) });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }

      if (method === "POST" && url === "/api/decay") {
        try {
          return json(res, 200, { ok: true, data: db.decay() });
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }

      if (method === "GET" && url === "/api/backup") {
        try {
          const s = await stat(dbFile);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": s.size,
            "content-disposition": 'attachment; filename="ringmind-backup.db"',
            "cache-control": "no-store",
          });
          const { createReadStream } = await import("node:fs");
          createReadStream(dbFile).pipe(res);
          return;
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }

      if (method === "GET" && url.split("?")[0] === "/api/token-usage") {
        // 账本路径：data-location.json 里有就用，否则用默认
        let ledgerPath = DEFAULT_TOKEN_LEDGER;
        try {
          const locFile = join(HERE, "..", "..", "data-location.json");
          if (existsSync(locFile)) {
            const loc = JSON.parse(readFileSync(locFile, "utf8"));
            if (loc && typeof loc.tokenUsageFile === "string" && loc.tokenUsageFile.trim()) {
              ledgerPath = loc.tokenUsageFile;
            }
          }
        } catch {
          // 读不到就用默认
        }
        const hours = Math.max(
          0,
          Math.min(24 * 90, Number(new URL(url, "http://x").searchParams.get("hours")) || 0)
        );
        return json(res, 200, { ok: true, data: readTokenLedger(ledgerPath, hours) });
      }

      if (method === "GET" && url === "/api/decay-preview") {
        return json(res, 200, { ok: true, data: { plan: db.planDecay() } });
      }

      return json(res, 404, { ok: false, error: "没这个接口" });
    }

    // ── 静态文件 ──────────────────────────────────────
    if (url === "/" || url.startsWith("/?")) {
      if (await serveFile(res, join(HERE, "login.html"))) return;
    }

    const file = safeJoin(HERE, url);
    if (file && (await serveFile(res, file))) return;

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("没有这个页面");
   } catch (e) {
    // 兜底：一个请求出错不该让整个面板下线
    console.error("[请求出错]", req.method, req.url, e?.message || e);
    try {
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: e?.message || String(e) });
      } else {
        res.end();
      }
    } catch {
      /* 连接已经断了，随它去 */
    }
   }
  });

  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, ok);
  });

  const actual = server.address().port;

  return {
    server,
    db,
    port: actual,
    url: `http://${host}:${actual}`,
    dbPath: dbFile,
    token: readToken(data) || token,
    tokenPath,
    tokenCreated: created,
    sessions,
    close() {
      server.close();
      db.close();
    },
  };
}

// 直接跑才启动
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));

  // 没显式给 --data 就看 data-location.json 记的位置（面板里搬过家就靠它）
  let dataDir = args.data;
  let dbPath = args.db;
  let fromMemo = false;
  if (!dataDir) {
    const loc = readLocation();
    if (loc?.dataDir && existsSync(loc.dataDir)) {
      dataDir = loc.dataDir;
      // 记着的那个 .db 文件也要用上，否则默认库名一变就指到别的文件去了
      if (!dbPath && loc.dbPath && existsSync(loc.dbPath)) dbPath = loc.dbPath;
      fromMemo = true;
    }
  }

  createServer({ dataDir, dbPath, port: args.port, host: args.host })
    .then((s) => {
      console.log("");
      console.log("  环形的心 · 面板");
      console.log("  ───────────────────────────────────────");
      console.log("  地址:  " + s.url);
      console.log("  令牌:  " + s.token);
      if (s.tokenCreated) console.log("         （刚生成的，也写进了 " + s.tokenPath + "）");
      console.log("  库:    " + s.dbPath);
      if (fromMemo) console.log("         （位置来自 data-location.json）");
      console.log("");
      console.log("  Ctrl+C 退出。");
      console.log("");
    })
    .catch((e) => {
      console.error("起不来：" + (e?.stack || e));
      process.exit(1);
    });
}