/**
 * 用量来源探测 + 读取。
 *
 * 这里只做一件事：**从别人的数据库里读出用量**，不假设对方是谁、字段叫什么。
 * 连上库先问它有哪些列，按名字和类型自己认，认不出就老实返回 null。
 *
 * 目前认得出两种：
 *   ① AstrBot       provider_stats 表（unicode 时间 + token_* 列）
 *   ② 约定格式      data/usage.jsonl（一行一次调用，谁都能写）
 *
 * 认不出来不算错：面板会显示「未接入用量统计」，而不是显示一堆 0。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/* ── 按名字猜列 ─────────────────────────────────────────── */

const pick = (cols, patterns, exclude = []) => {
  for (const p of patterns) {
    const hit = cols.find((c) => {
      const lc = c.toLowerCase();
      if (exclude.some((e) => lc.includes(e))) return false;
      return p.test(lc);
    });
    if (hit) return hit;
  }
  return null;
};

/**
 * 认出 provider_stats 的关键列。
 *
 * 不写死 token_input_other / token_output：别的版本可能叫 prompt_tokens、completion_tokens。
 * 按「输入类」「输出类」两组词去撞，撞到再用。
 */
function detectColumns(db, table) {
  let cols;
  try {
    cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return null;
  }
  if (!cols.length) return null;

  // 时间：优先 unix 秒的 start_time，其次 created_at 那种文本
  const timeCol = pick(cols, [/^start_time$/, /^end_time$/, /^created_at$/, /^ts$/, /^time$/, /time/]);
  // 输入：token_input_* 可能有多个（other / cached），全部加起来
  const inputCols = cols.filter((c) => /token.*input|input.*token|prompt.*token/i.test(c));
  // 输出
  const outputCol = pick(cols, [/token.*output/, /output.*token/, /completion.*token/, /^output$/]);
  // 模型
  const modelCol = pick(cols, [/^provider_model$/, /^model$/, /^provider_id$/, /model/]);
  // 状态：有就用来排除失败调用
  const statusCol = pick(cols, [/^status$/, /^state$/]);

  if (!timeCol || !outputCol || inputCols.length === 0) return null;

  return { cols, timeCol, inputCols, outputCol, modelCol, statusCol };
}

/**
 * 时间列的值 → 毫秒。
 *
 * 三种见得到的写法：
 *   1792995804.169896             unix 秒（带小数）
 *   1792995804169                 unix 毫秒
 *   '2026-10-26 06:23:25.432181'  UTC 文本（AstrBot 的 created_at 就是这种，不带时区标记）
 */
function timeToMs(v) {
  if (v == null) return NaN;
  if (typeof v === "number") {
    return v > 1e12 ? v : v * 1000;
  }
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  // 文本：没带时区的一律按 UTC 解 —— AstrBot 存的 UTC，
  // 直接 new Date('2026-10-26 06:23:25') 会被当本地时间，差 8 小时
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/** 本地日期 'YYYY-MM-DD'（按进程时区，不硬编码 +8） */
function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/** 会话键：AstrBot 的 umo 是 '大肥鱼:FriendMessage:FB03…'，太长，取最后一段 */
function sessionOf(umo) {
  if (!umo) return "(未知)";
  const parts = String(umo).split(":");
  if (parts.length >= 3) {
    const kind = /Friend/i.test(parts[1]) ? "private" : "group";
    return kind + ":" + parts[2].slice(0, 12);
  }
  return String(umo).slice(0, 24);
}

/* ── 读 AstrBot ─────────────────────────────────────────── */

/**
 * 打开 AstrBot 的库并把 provider_stats 读出来。
 * 用动态 import 是为了让老 Node（没有 node:sqlite）不至于把整页拖垮。
 */
export async function openAstrbot(dbPath, { hours = 0 } = {}) {
  if (!dbPath || !existsSync(dbPath)) return { ok: false, reason: "库不在" };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { ok: false, reason: "这个 Node 没有 node:sqlite" };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { ok: false, reason: "打不开：" + (e?.message || e) };
  }

  try {
    // 表名也是猜的：先找 provider_stats，找不到就扫所有带 token 列的表
    let table = null;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);

    if (tables.includes("provider_stats")) {
      table = "provider_stats";
    } else {
      for (const t of tables) {
        try {
          const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
          if (cols.some((c) => /token.*output/i.test(c))) {
            table = t;
            break;
          }
        } catch {
          /* 跳过读不了的表 */
        }
      }
    }
    if (!table) return { ok: false, reason: "没有像用量表的表" };

    const c = detectColumns(db, table);
    if (!c) return { ok: false, reason: "表结构认不出来（缺时间或 token 列）" };

    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const out = [];
    const cutoff = hours > 0 ? Date.now() - hours * 3600_000 : 0;

    for (const r of rows) {
      // 失败调用不要：AstrBot 出错那一行 token 全是 0，混进来会把成功率拉低
      if (c.statusCol) {
        const st = String(r[c.statusCol] ?? "").toLowerCase();
        if (st === "error" || st === "failed") continue;
      }

      const ms = timeToMs(r[c.timeCol]);
      if (!Number.isFinite(ms)) continue;
      if (hours > 0 && ms < cutoff) continue;

      // 输入分两笔：命中缓存的、没命中的。分开记，面板才好算命中率
      let cacheHit = 0;
      let cacheMiss = 0;
      for (const col of c.inputCols) {
        const n = Number(r[col]) || 0;
        if (/cach/i.test(col)) cacheHit += n;
        else cacheMiss += n;
      }
      const output = Number(r[c.outputCol]) || 0;
      if (cacheHit + cacheMiss + output === 0) continue;

      out.push({
        ms,
        day: localDay(ms),
        provider: sessionOf(r.umo ?? r[c.cols.find((x) => /umo|session/i.test(x)) || ""]),
        model: String((c.modelCol && r[c.modelCol]) || "(未知)"),
        cacheHit,
        cacheMiss,
        output,
      });
    }

    return { ok: true, table, cols: c.cols, rows: out };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  } finally {
    try {
      db.close();
    } catch {
      /* 关不掉也无所谓 */
    }
  }
}

/* ── 探测：AstrBot 的库在哪 ─────────────────────────────── */

/**
 * 找 AstrBot 的 data.db。
 *
 * 顺序：环境变量 → 配置 → 常见安装位置。
 * 找不到不报错，返回 null 就行 —— 别的机器可能压根没装。
 */
export function findAstrbotDb(explicit) {
  const cands = [];

  if (explicit) cands.push(explicit);

  for (const env of ["ASTRBOT_ROOT", "ASTRBOT_HOME", "ASTRBOT_DATA"]) {
    const v = process.env[env];
    if (v) {
      cands.push(join(v, "data", "data.db"));
      cands.push(join(v, "data.db"));
    }
  }

  const home = process.env.USERPROFILE || process.env.HOME || "";

  // Linux 上最常见的是 /opt 和用户目录；Windows 上一般在安装目录
  cands.push(
    "/opt/AstrBot/data/data.db",
    "/opt/astrbot/data/data.db",
    "/root/AstrBot/data/data.db",
    home ? join(home, "AstrBot", "data", "data.db") : "",
    home ? join(home, "astrbot", "data", "data.db") : "",
    "C:/AstrBot/data/data.db",
    "D:/AstrBot/data/data.db"
  );

  for (const p of cands) {
    if (!p) continue;
    try {
      if (existsSync(p)) return resolve(p);
    } catch {
      /* 路径非法就跳过 */
    }
  }
  return null;
}