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
import { copyFileSync, createReadStream, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { Ringmind } from "../index.js";
import { ensureToken, verifyToken, makeSessionCookie, readToken, rotateToken } from "./auth.js";
import { checkForUpdate, applyUpdate, restartPanel, localVersion } from "./update.js";
import { healGateway, saveGatewayConfig } from "./gateway.js";
import { openAstrbot, findAstrbotDb } from "./usage-sources.js";
import { probeQce, readQceToken, lookupPeer, listFriends, listGroups, listRecentContacts, startRoamingExport, startLocalExport, getTask, cancelTask, listTasks, downloadResult, parseExport, startInstall, installState, findLauncher, qqRunning, launchQce } from "./qq-import.js";
import { readPersonaConfig, writePersonaConfig, askBatch, chunk, BATCH_SIZE } from "./persona.js";
import { CUSTOM_PREFIX, PRESETS, MODES, RINGS, RING_ORDER, metaMemoryDefaultOf, vaultAccessibleDefaultOf } from "../core/rings.js";
import { buildSeaScene } from "./sea.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// ── token 用量账本 ────────────────────────────────────────
// 数据来自 qq-bridge 的 state/token-usage.jsonl，一行一次调用。
// 默认找项目 data/token-usage.jsonl；data-location.json 里给了 tokenUsageFile 就用那个。
const DEFAULT_TOKEN_LEDGER = resolve(HERE, "../../data/token-usage.jsonl");

// 元 / 百万 token（空闲时段单价）。peakX2 = 高峰 ×2 是 DeepSeek 的计价规则，
// 别家模型别乱乘。想加别的牌子/改价，在 data/token-prices.json 里按同样格式覆盖。
const TOKEN_PRICES = {
  "deepseek-flash": { label: "DeepSeek-V4.1-Flash", cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4, peakX2: true },
  "deepseek-v4-flash": { label: "DeepSeek-V4.1-Flash", cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4, peakX2: true },
  "deepseek-v4-flash-vision-exp": { label: "DeepSeek-V4.1-Flash", cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4, peakX2: true },
  "deepseek-v4-pro": { label: "DeepSeek-V4-Pro", cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5, peakX2: true },
  "deepseek-pro": { label: "DeepSeek-V4-Pro", cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5, peakX2: true },
};
const FALLBACK_PRICE = TOKEN_PRICES["deepseek-flash"];

// 本机时区（分钟偏移，东八区 = +480）：按天分账、高峰判断都用它。
// 以前写死东八区，装到别的时区「按天」会错一天；现在跟着系统时钟走。
const TZ_OFFSET_MIN = -new Date().getTimezoneOffset();
const TZ_OFFSET_STR = (() => {
  const sign = TZ_OFFSET_MIN < 0 ? "-" : "+";
  const abs = Math.abs(TZ_OFFSET_MIN);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
})();

// 可选的自定义价目：data/token-prices.json（data/ 不入库，每台机器自己填）。
// 格式 { "模型名": { label, cacheHit, cacheMiss, cacheWrite, output, peakX2 } }，
// 按模型名覆盖内置价目（Kimi / Claude / GLM 想按真价算就填这里）；
// 没这个文件就用内置的 DeepSeek 价，没登场的模型仍走兜底价（深色标注的话看前端）。
try {
  const over = JSON.parse(readFileSync(resolve(HERE, "../../data/token-prices.json"), "utf8"));
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === "object") TOKEN_PRICES[k] = { peakX2: false, ...v };
  }
} catch { /* 没有自定义价目就用内置的 */ }

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

/** 本机时区里是不是高峰（工作日 9-12、14-18，法定节假日除外）——
 *  以前写死北京时间，装到别的时区「按天」会错一天；现在跟着系统时钟走 */
function isPeakHour(ms) {
  const d = new Date(ms + TZ_OFFSET_MIN * 60_000); // 转成本机时区看
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
  // 高峰 ×2 是 DeepSeek 的计价规则（p.peakX2），别家模型不乘
  const mult = p.peakX2 && isPeakHour(ms) ? 2 : 1;
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

/**
 * QQ 机器人的用量账本：qq-bridge 的 state/token-usage.jsonl
 *
 * 这才是「大肥鱼在 QQ 里说话花掉的 token」—— 每一行带 key（group:xxx /
 * private:xxx）、turn、model，能按会话分账。
 *
 * 注意别跟 DSH 自己的账本搞混：~/.dsh/dsh-usage/usage-ledger.json 是
 * **DeepSeek Harness 本体**（也就是你跟 coding agent 对话）的用量，
 * 结构上也只按 provider/model 折叠，压根没有会话维度。两个混在一起会
 * 把几十亿 token 算成 QQ 的，所以这里默认只认 qq-bridge 的。
 */
function qqLedgerCandidates() {
  const list = [];
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const docs = join(home, "Documents");
  const homeCn = join(home, "文档");

  // qq-bridge 可能落在这些位置
  const roots = [
    join(homeCn, "deepseek-harness", "default-workspace"),
    join(docs, "deepseek-harness", "default-workspace"),
    join(home, ".dsh", "default-workspace"),
    // 装在别的盘、或者路径不按上面几条来的：在 data-location.json 里写 tokenUsageFile，
    // 那一条优先。别在代码里写死绝对路径 —— 那既是隐私，换台机器也失效
  ];
  for (const r of roots) {
    list.push(join(r, "qq-bridge", "state", "token-usage.jsonl"));
  }
  // 项目根往上找一圈（有些人把 qq-bridge 和 ring 放一起）
  list.push(resolve(HERE, "../../qq-bridge/state/token-usage.jsonl"));
  list.push(resolve(HERE, "../../../qq-bridge/state/token-usage.jsonl"));

  return list.filter((p) => {
    try { return existsSync(p); } catch { return false; }
  });
}

/** 找到真正该用的账本：先看 data-location.json 指定的，再看 qq-bridge */
/** 读 data-location.json 里的 usage 配置（可选；不写就全靠自动探测） */
function usageCfg() {
  try {
    const locFile = join(HERE, "..", "..", "data-location.json");
    if (!existsSync(locFile)) return null;
    const loc = JSON.parse(readFileSync(locFile, "utf8"));
    return loc && typeof loc.usage === "object" ? loc.usage : null;
  } catch {
    return null;
  }
}

function findUsageLedger() {
  try {
    const locFile = join(HERE, "..", "..", "data-location.json");
    if (existsSync(locFile)) {
      const loc = JSON.parse(readFileSync(locFile, "utf8"));
      const p = loc && typeof loc.tokenUsageFile === "string" ? loc.tokenUsageFile.trim() : "";
      if (p && existsSync(p)) return { path: p, kind: "指定" };
    }
  } catch {
    /* 读不到就往下探 */
  }
  // 装了 AstrBot 的机器：它的 provider_stats 里就有用量，比 jsonl 直接
  const ab = findAstrbotDb(usageCfg()?.astrbotDb);
  if (ab) return { path: ab, kind: "astrbot" };

  const qq = qqLedgerCandidates();
  if (qq.length) return { path: qq[0], kind: "qq-bridge" };

  // 老位置：项目里的 data/token-usage.jsonl
  if (existsSync(DEFAULT_TOKEN_LEDGER)) return { path: DEFAULT_TOKEN_LEDGER, kind: "项目data" };

  // DSH 总账（~/.dsh/dsh-usage/usage-ledger.json）是「coding agent 跟人聊天」花的，
  // 跟大肥鱼在 QQ 里的消耗完全是两笔账。默认不碰它 —— 以前拿它兜底，结果把
  // 几十亿 token 算成了 QQ 的。真要看得显式开：data-location.json 里 usage.dsh = true。
  if (usageCfg()?.dsh === true) {
    const d = dshLedgerPath();
    if (d) return { path: d, kind: "dsh-harness" };
  }

  return { path: null, kind: null };
}

/**
 * DSH 自己的用量账本：~/.dsh/dsh-usage/usage-ledger.json
 *
 * 结构和老的 jsonl 不一样，它是「按天 → 按 provider → 按模型」三层嵌套：
 *   { version:1, days:{ "2026-10-07": { "deepseek-account": { "deepseek-flash": {
 *       inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, calls, cost } } } } }
 *
 * 这里把它摊平成和 jsonl 一样的记录，后面的聚合逻辑就不用改。
 */
function dshLedgerPath() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    if (!home) return null;
    const p = join(home, ".dsh", "dsh-usage", "usage-ledger.json");
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function readDshLedger(filePath, hours = 0) {
  const j = JSON.parse(readFileSync(filePath, "utf8"));
  const days = (j && typeof j === "object" && j.days) || {};
  const out = [];
  const cutoff = hours > 0 ? Date.now() - hours * 3600_000 : 0;

  for (const [day, providers] of Object.entries(days)) {
    if (!providers || typeof providers !== "object") continue;
    // 一天算一条：取当天中午 12 点（本机时区）当代表时刻，避免时区把日期挪走
    const ms = new Date(day + "T12:00:00" + TZ_OFFSET_STR).getTime();
    if (!Number.isFinite(ms)) continue;
    if (hours > 0 && ms < cutoff) continue;

    for (const [provider, models] of Object.entries(providers)) {
      if (!models || typeof models !== "object") continue;
      for (const [model, m] of Object.entries(models)) {
        if (!m || typeof m !== "object") continue;
        const b = {
          cacheHit: Number(m.cacheReadTokens) || 0,
          cacheMiss: Number(m.inputTokens) || 0,
          cacheWrite: Number(m.cacheWriteTokens) || 0,
          output: Number(m.outputTokens) || 0,
        };
        if (b.cacheHit + b.cacheMiss + b.output === 0) continue;
        out.push({
          t: ms,
          model,
          key: String(provider || "(未知)"),
          cost: Number(m.cost) || 0,   // 用它自己算好的钱，别重复计
          calls: Number(m.calls) || 0,
          b,
        });
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * 把 DSH 账本同步进库。
 *
 * 为什么要存库：DSH 的账本是**一个 JSON 文件整体重写**的，机器崩一下、
 * 谁手滑删一下，历史就没了。存进 SQLite 后每次同步都是幂等覆盖，
 * 账本哪天真丢了，库里的历史还在。
 *
 * 注意 cost：0 要原样存 —— 那是「这家的免费额度」，不是「没算」。
 */
async function syncDshToDb(store) {
  try {
    if (!store || typeof store.upsertTokenUsage !== "function") return { ok: false, reason: "库不支持" };
    const found = findUsageLedger();
    if (!found.path) return { ok: false, reason: "没有找到用量来源" };

    // AstrBot 路线：直接读它的 provider_stats。字段是它自己的，交给 usage-sources 去认
    if (found.kind === "astrbot") {
      const ab = await openAstrbot(found.path);
      if (!ab.ok) return { ok: false, reason: "AstrBot 库读不了：" + ab.reason };
      const bucket = new Map();
      for (const r of ab.rows) {
        const id = r.day + "\u0000" + r.provider + "\u0000" + r.model;
        const g = bucket.get(id) || {
          day: r.day, provider: r.provider, model: r.model,
          hit: 0, miss: 0, write: 0, output: 0, calls: 0, cost: 0,
        };
        g.hit += r.cacheHit;
        g.miss += r.cacheMiss;
        g.output += r.output;
        g.calls += 1;
        g.cost += costOf(
          r.model,
          { cacheHit: r.cacheHit, cacheMiss: r.cacheMiss, cacheWrite: 0, output: r.output },
          r.ms
        );
        bucket.set(id, g);
      }
      const n2 = store.upsertTokenUsage([...bucket.values()]);
      return { ok: true, synced: n2, from: found.path, kind: "astrbot", table: ab.table };
    }

    // DSH 那种三层嵌套的另算
    let recs;
    if (/\.json$/i.test(found.path) && !/\.jsonl$/i.test(found.path)) {
      recs = readDshLedger(found.path, 0);
    } else {
      recs = [];
      for (const line of String(readFileSync(found.path, "utf8")).split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const r = JSON.parse(s);
          if (r.retry > 0) continue; // 重试是重发，别重复计
          // k:"base" 是**累计快照**（每个 session 一个递增序列），
          // k:"turn" 才是每次调用的增量。把快照也加进去会重复计算 5~6 倍，
          // 3.7 亿这个吓人的数字就是这么来的 —— 真实只有 6800 万。
          if (r.k === "base") continue;
          recs.push(r);
        } catch {
          /* 坏行跳过 */
        }
      }
    }

    // 先按 (天, 来源, 模型) 聚合：同一天同一家同一模型只留一行，避免覆盖丢数
    const bucket = new Map();
    for (const r of recs) {
      const b = r.b || {};
      const hit = b.cacheHit || 0;
      const miss = b.cacheMiss || 0;
      const wr = b.cacheWrite || 0;
      const out = b.output || 0;
      if (hit + miss + out + wr === 0) continue;
      const ms = r.t || 0;
      if (!ms) continue;
      const day = new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
      // 分组键用**会话**（group:xxx / private:xxx），别用 provider ——
      // 拿 provider 当键会把所有群聊私聊糊成一坨「deep」。
      const session = String(r.key || r.provider || "(未知)");
      const model = String(r.model || "(未知)");
      const id = day + "\u0000" + session + "\u0000" + model;
      const g = bucket.get(id) || { day, provider: session, model, hit: 0, miss: 0, write: 0, output: 0, calls: 0, cost: 0 };
      g.hit += hit;
      g.miss += miss;
      g.write += wr;
      g.output += out;
      g.calls += 1;
      // 钱在这里就算好再存 —— qq-bridge 的账本不带 cost，
      // 存个 0 进去，读出来会被当成「真实花费 0」，白丢一笔钱。
      g.cost += Number(r.cost) > 0 ? Number(r.cost) : costOf(model, b, ms);
      bucket.set(id, g);
    }

    const rows = [...bucket.values()];
    const n = store.upsertTokenUsage(rows);
    return { ok: true, synced: n, from: found.path, kind: found.kind };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/** 把库里的用量记录转成和账本一样的记录格式，好复用同一套聚合 */
function dbTokenRecords(store, hours = 0) {
  try {
    if (!store || typeof store.readTokenUsage !== "function") return null;
    const rows = store.readTokenUsage(hours);
    if (!rows || !rows.length) return null;
    return rows.map((r) => ({
      t: new Date(r.day + "T12:00:00" + TZ_OFFSET_STR).getTime(),
      model: r.model,
      key: r.provider,
      cost: Number(r.cost) || 0,
      calls: Number(r.calls) || 0,
      b: {
        cacheHit: Number(r.hit) || 0,
        cacheMiss: Number(r.miss) || 0,
        cacheWrite: Number(r.write) || 0,
        output: Number(r.output) || 0,
      },
    }));
  } catch {
    return null;
  }
}

/** 读整个账本，聚合出总账 + 按会话分组。hours > 0 时只算最近这么多小时 */
function readTokenLedger(ledgerPath, hours = 0) {
  // 没指定就自己找：**优先 QQ 的账本**，DSH 的总账只当最后备选
  let ledgerKind = "指定";
  if (!ledgerPath || !existsSync(ledgerPath)) {
    const found = findUsageLedger();
    ledgerPath = found.path;
    ledgerKind = found.kind;
  }
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return {
      ok: false,
      error: "找不到 QQ 的用量账本 —— 没找到 qq-bridge/state/token-usage.jsonl。\n在 data-location.json 里加 \"tokenUsageFile\" 指过去也行。",
      records: 0,
      triedDsh: dshLedgerPath(),
    };
  }

  // 外部数据库（AstrBot 等）：正常流程是先同步进库、再从库读，走不到这儿。
  // 真走到这儿说明库还空着，别拿二进制当文本读，直接说没接入。
  if (/\.(db|sqlite|sqlite3)$/i.test(ledgerPath)) {
    return {
      ok: false,
      error: "用量来自外部数据库，但还没同步进记忆库 —— 刷新一下再试；一直这样就是读不出来。",
      records: 0,
      ledger: ledgerPath,
      ledgerKind: ledgerKind,
    };
  }

  const isDsh = /\.json$/i.test(ledgerPath) && !/\.jsonl$/i.test(ledgerPath);
  const records = [];
  try {
    if (isDsh) {
      records.push(...readDshLedger(ledgerPath, 0)); // 全量读，时间窗交给聚合截
    } else {
      for (const line of String(readFileSync(ledgerPath, "utf8")).split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const r = JSON.parse(s);
          if (r.k === "base") continue; // 累计快照，见 syncDshToDb 的说明
          records.push(r);
        } catch {
          /* 一行坏了不算数 */
        }
      }
    }
  } catch (e) {
    return { ok: false, error: "账本读不了：" + (e?.message || e), records: 0, ledger: ledgerPath };
  }

  const out = aggregateTokenRecords(records, hours, ledgerPath);
  out.ledgerKind = ledgerKind;
  return out;
}

/**
 * 把一堆用量记录聚合成总账。
 *
 * 三个来源（SQLite / DSH 的 JSON / 老的 jsonl）共用这一个函数，
 * 免得三套算法算出三个不同的数。
 */
function aggregateTokenRecords(records, hours = 0, ledgerLabel = "") {
  const totals = { cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, cost: 0, calls: 0, turns: 0 };
  const byKey = new Map();
  const byDay = new Map();
  let recCount = 0;
  let firstAt = null;
  let lastAt = null;
  const cutoff = hours > 0 ? Date.now() - hours * 3600_000 : 0;

  for (const rec of records) {
    const b = rec.b || {};
    const hit = b.cacheHit || 0;
    const miss = b.cacheMiss || 0;
    const out = b.output || 0;
    if (hit + miss + out === 0) continue; // base 那种空记录

    const ms = rec.t || 0;
    // 时间窗口：只要最近 hours 小时
    if (hours > 0 && (!ms || ms < cutoff)) continue;
    // 账本自己算过钱就用它的 —— 注意 cost === 0 是「这家的免费额度」，
    // 不是「没算过」。以前写成 rec.cost > 0 就把免费的重算成钱了，白算出上百块。
    // 有 cost 就用（0 也算真值 —— 那是免费额度）；
    // 但没有 cost、或者 cost 是 0 却有几百亿 token，那就是没算过，按表估。
    const rawCost = rec.cost;
    const hasOwnCost = rawCost !== undefined && rawCost !== null && Number.isFinite(Number(rawCost));
    const cost = hasOwnCost && Number(rawCost) > 0 ? Number(rawCost) : costOf(rec.model, b, ms);
    recCount++;
    if (!firstAt || ms < firstAt) firstAt = ms;
    if (!lastAt || ms > lastAt) lastAt = ms;

    totals.cacheHit += hit;
    totals.cacheMiss += miss;
    totals.cacheWrite += b.cacheWrite || 0;
    totals.output += out;
    totals.cost += cost;
    totals.calls += Number.isFinite(Number(rec.calls)) ? Number(rec.calls) : 1;

    const key = rec.key || "(未知)";
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        // DSH 账本里的 key 是 provider 名（deep / dps / deepseek-account），不是会话
        kind: key.startsWith("group:") ? "群聊" : key.startsWith("private:") ? "私聊" : "来源",
        id: key.includes(":") ? key.split(":")[1] || "" : "",
        cacheHit: 0, cacheMiss: 0, output: 0, cost: 0, calls: 0, turns: new Set(), hasTurn: false, lastAt: 0,
      };
      byKey.set(key, g);
    }
    g.cacheHit += hit;
    g.cacheMiss += miss;
    g.output += out;
    g.cost += cost;
    g.calls += Number.isFinite(Number(rec.calls)) ? Number(rec.calls) : 1;
    if (rec.k === "turn") {
      g.turns.add(rec.turn ?? 0);
      g.hasTurn = true;
    }
    if (ms > g.lastAt) g.lastAt = ms;

    // 按天（北京时间）
    const dstr = new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
    let dd = byDay.get(dstr);
    if (!dd) {
      dd = { date: dstr, cacheHit: 0, cacheMiss: 0, output: 0, cost: 0, calls: 0 };
      byDay.set(dstr, dd);
    }
    // 和 totals / sessions 用同一个口径 —— 库里的行是聚合值，
    // 每行可能代表几百次调用，这里写 dd.calls++ 会让「按天」少算两个数量级
    const recCalls = Number.isFinite(Number(rec.calls)) ? Number(rec.calls) : 1;
    dd.cacheHit += hit;
    dd.cacheMiss += miss;
    dd.output += out;
    dd.cost += cost;
    dd.calls += recCalls;
  }

  const sessions = [...byKey.values()]
    // 没有 turn 信息时给 null，别拿 0 冒充「聊了 0 轮」
    .map((g) => ({ ...g, turns: g.hasTurn ? g.turns.size : null }))
    .sort((a, b) => b.cost - a.cost);

  const inputTotal = totals.cacheHit + totals.cacheMiss;

  return {
    ok: true,
    ledger: ledgerLabel,
    hours,
    records: recCount,
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
  // consoleUrl / consolePassword 是 SnowLuma 控制台（WebUI）的登录信息。
  // 控制台不放行 OneBot 的 accessToken，只能用这个密码 —— 存一次，之后自动读。
  //
  // gatewayDir 是 SnowLuma 主目录（可选）。填了它，换 QQ 号之后面板能自己去
  // config/onebot_*.json 里找出新 token，不用手改（见 gateway.js）。
  const def = {
    url: "http://127.0.0.1:3000",
    token: "",
    consoleUrl: "http://127.0.0.1:5099",
    consolePassword: "",
    gatewayDir: "",
  };

  if (existsSync(ONEBOT_FILE)) {
    try {
      const j = JSON.parse(readFileSync(ONEBOT_FILE, "utf8"));
      return { ...def, ...(j && typeof j === "object" ? j : {}) };
    } catch {
      // 文件在，但读坏了（写到一半断电、手工编辑漏逗号…）。
      //
      // ⚠️ 这里**绝对不能**退回去拿库里的老值顶上 —— 那会：
      //   ① 把用户刚填的 gatewayDir / 控制台密码冲掉；
      //   ② 把很久以前那个号的 token "复活"，于是面板莫名其妙又 401 了。
      //   只标记一下，让上层照实报「配置文件读不了」，不替人做决定。
      return { ...def, __corrupt: true };
    }
  }

  // 文件**真的不存在**（老版本升级上来的）：从当前库的 meta 里搬一次。
  // 搬完就把 meta 清掉 —— 凭证只该有一个来源，留着就是隐患。
  try {
    const raw = dbRef && dbRef.store ? dbRef.store.getMeta("onebot") : null;
    if (raw) {
      const j = { ...def, ...JSON.parse(raw) };
      writeFileSync(ONEBOT_FILE, JSON.stringify(j, null, 2) + "\n", "utf8");
      try { dbRef.store.setMeta("onebot", ""); } catch {}
      return j;
    }
  } catch {}
  return def;
}

function writeOnebot(cfg) {
  const out = {
    url: String((cfg && cfg.url) || "http://127.0.0.1:3000").trim() || "http://127.0.0.1:3000",
    token: String((cfg && cfg.token) || "").trim(),
    consoleUrl: String((cfg && cfg.consoleUrl) || "http://127.0.0.1:5099").trim() || "http://127.0.0.1:5099",
    consolePassword: String((cfg && cfg.consolePassword) || ""),
    // SnowLuma 主目录：填了才能换号自愈；不填就只是报错，和以前一样
    gatewayDir: String((cfg && cfg.gatewayDir) || "").trim(),
  };
  try {
    writeFileSync(ONEBOT_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  } catch {}
  return out;
}

/**
 * SnowLuma 控制台地址：不问用户，自己问出来。
 *
 * 两条路：
 *   1. 用存着的密码登进控制台，读 /api/system/settings 的 listeningPort
 *      —— 这是**权威值**，端口被挤到 5100 也能拿到对的
 *   2. 登不进去（没密码/密码错了/控制台没开），就退回到 OneBot 同一个主机 + 默认 5099
 *
 * 登录有频率限制，所以结果缓存 60 秒，别每次 health 都去敲它。
 */
let consoleProbe = { at: 0, url: "", auto: false, port: null };

function defaultConsoleUrl(onebotUrl) {
  try {
    const u = new URL(onebotUrl || "http://127.0.0.1:3000");
    const h = u.hostname === "0.0.0.0" ? "127.0.0.1" : u.hostname;
    return u.protocol + "//" + h + ":5099";
  } catch {
    return "http://127.0.0.1:5099";
  }
}

async function resolveConsoleUrl(ob) {
  const seed = ob.consoleUrl || defaultConsoleUrl(ob.url);
  const pw = ob.consolePassword || "";

  // 60 秒内问过就不再问
  if (consoleProbe.url && Date.now() - consoleProbe.at < 60000) return consoleProbe;

  // 没密码就只能猜默认端口
  if (!pw) {
    consoleProbe = { at: Date.now(), url: seed, auto: false, port: null };
    return consoleProbe;
  }

  try {
    const lg = await fetch(seed.replace(/\/+$/, "") + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
      signal: AbortSignal.timeout(4000),
    });
    const lj = await lg.json().catch(() => ({}));
    if (!lj || !lj.success || !lj.token) {
      consoleProbe = { at: Date.now(), url: seed, auto: false, port: null };
      return consoleProbe;
    }

    const st = await fetch(seed.replace(/\/+$/, "") + "/api/system/settings", {
      headers: { Authorization: "Bearer " + lj.token },
      signal: AbortSignal.timeout(4000),
    });
    const sj = await st.json().catch(() => ({}));
    const port = Number(sj?.listeningPort || sj?.settings?.webuiPort);
    let host = String(sj?.settings?.webuiHost || "127.0.0.1").trim() || "127.0.0.1";
    if (host === "0.0.0.0" || host === "::" || host === "") host = "127.0.0.1";

    if (Number.isFinite(port) && port > 0) {
      // 用同一个协议（tls 开了就 https）
      let proto = "http:";
      try { proto = new URL(seed).protocol; } catch {}
      consoleProbe = { at: Date.now(), url: proto + "//" + host + ":" + port, auto: true, port };
      return consoleProbe;
    }
    consoleProbe = { at: Date.now(), url: seed, auto: false, port: null };
    return consoleProbe;
  } catch {
    consoleProbe = { at: Date.now(), url: seed, auto: false, port: null };
    return consoleProbe;
  }
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

/**
 * 会话落盘用的文件。null = 还没确定数据目录（测试环境可能一直 null）。
 *
 * 为什么要落盘：sessions 原来是纯内存 Map，面板一重启（改代码、更新、
 * 崩溃重拉）所有人的登录态就全没了 —— 浏览器里 cookie 还在发，
 * 但服务端不认识了，preview.html 第一个请求就 401，被踢回登录页，
 * 看起来像"令牌登不进去"。写一份到数据目录就不会了。
 */
let SESSION_FILE = null;

/** 从文件里捞回来（过期的直接扔） */
function loadSessions() {
  if (!SESSION_FILE) return;
  try {
    const arr = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    for (const s of arr) {
      if (s && typeof s.sid === "string" && Number(s.expiresAt) > now) {
        sessions.set(s.sid, { expiresAt: Number(s.expiresAt) });
      }
    }
  } catch {
    // 没文件、文件坏了、权限不够 —— 都当空的重来，不影响启动
  }
}

/** 写回去（写不了也不该影响登录本身） */
function saveSessions() {
  if (!SESSION_FILE) return;
  try {
    const arr = [...sessions.entries()].map(([sid, v]) => ({ sid, expiresAt: v.expiresAt }));
    writeFileSync(SESSION_FILE, JSON.stringify(arr), "utf8");
  } catch {
    // 只读盘、目录被删之类：会话就退化成内存态，能登能用，只是重启会掉
  }
}

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
    saveSessions();
    return null;
  }
  return sid;
}

/** 挡掉路径穿越：只允许 web 目录下的文件 */
function safeJoin(base, urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const full = resolve(base, clean);
  // 必须带分隔符比前缀，不然 src\web 会放过兄弟目录 src\web-anything
  const root = resolve(base);
  return full === root || full.startsWith(root + sep) ? full : null;
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

  // 会话文件跟着数据目录走 —— 换库/搬目录时会话也跟着搬家
  SESSION_FILE = join(data, "sessions.json");
  loadSessions();
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

  // 后台人格导入任务。放在请求处理函数外面 —— 要不每个请求都会把它重置成 null，
  // 发起任务的那个请求看得见，轮询进度的请求永远是"空闲"。
  // 任务对象本身就是状态，拷贝出去就是进度。
  let personaJob = null;
  const personaStatus = () =>
    personaJob
      ? { ...personaJob, stop: undefined, running: !personaJob.done }
      : {
          running: false, done: true, phase: "idle",
          batch: 0, batchTotal: 0, remembered: 0, skipped: 0,
          tokens: 0, error: null, chatName: "", startedAt: 0, finishedAt: 0,
        };

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
      saveSessions();
      res.setHeader("set-cookie", cookie);
      return json(res, 200, { ok: true });
    }

    if (url === "/api/logout") {
      const sid = sessionOf(req);
      if (sid) sessions.delete(sid);
      saveSessions();
      res.setHeader("set-cookie", "ringmind_session=; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    // ── 登录页背景：她看得见的圈里飘过的句子（免认证）───────
    // 登录页在验证令牌之前就要把背景画出来，所以这个接口不能要 session。
    // 只取 core/ring1/ring2/ring3 —— 就是她本来就看得见的那些。
    // 闲聊圈、模糊圈、回忆圈、总库的内容一个字都不会从这儿出去。
    if (method === "GET" && url.split("?")[0] === "/api/login-backdrop") {
      let want = 12;
      try {
        want = Math.min(Math.max(Number(new URL(url, "http://x").searchParams.get("n")) || 12, 1), 24);
      } catch {}
      try {
        const pool = [];
        for (const ring of ["core", "ring1", "ring2", "ring3"]) {
          let list = [];
          try {
            list = db.byRing(ring, 40) || [];
          } catch {}
          for (const m of list) {
            const text = String(m.content || "").replace(/\s+/g, " ").trim();
            if (!text) continue;
            // 登录页是背景，不给人读文章 —— 太长的截一刀。
            // 18 字 × 12px ≈ 216px，配合 left 最多 93% 也不会顶出右边界。
            pool.push(text.length > 18 ? text.slice(0, 18) + "…" : text);
          }
        }
        // 洗牌：每次打开登录页，飘的句子不一样
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }
        const items = pool.slice(0, want);
        return json(res, 200, {
          ok: true,
          data: { items, source: items.length ? "library" : "default" },
        });
      } catch {
        // 库读不到（没建库、文件坏了）不该让登录页打不开
        return json(res, 200, { ok: true, data: { items: [], source: "default" } });
      }
    }

    // 版本号：这一条**故意放在登录之前** —— 登录页自己也要显示版本，
    // 而那时候手里还没有会话。它只吐一个纯数字，没什么可保护的。
    if (method === "GET" && url === "/api/version") {
      return json(res, 200, { ok: true, version: localVersion() });
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
            // 这个模式下元记忆「默认」该不该开，前端拿它来提示
            metaMemoryDefault: metaMemoryDefaultOf(cfg.mode),
            vaultAccessible: Boolean(cfg.vaultAccessible),
            vaultAccessibleDefault: vaultAccessibleDefaultOf(cfg.mode),
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

      // ── QQ 聊天记录导入 ────────────────────────────────
      // 我们不碰 QQ 的加密库。QCE 注入进 QQ，让 QQ 自己把消息交出来，
      // 这里只负责问它要、拿回来、送进记忆库。
      // 全部只读探测：QCE 没装、没跑、令牌不对，都返回状态而不是报错。
      if (method === "GET" && url === "/api/qq-import/probe") {
        try {
          const r = await probeQce();
          return json(res, 200, { ok: true, data: r });
        } catch (e) {
          return json(res, 200, {
            ok: true,
            data: { state: "error", error: e?.message || String(e) },
          });
        }
      }

      // 列会话（给导入向导 ① 用）：最近会话在前（真正聊过的，含非好友单聊和群聊），
      // 再补上没聊过的好友 —— 合并去重。本地导出两种都支持。
      if (method === "GET" && (url === "/api/qq-import/contacts" || url === "/api/qq-import/friends" || url === "/api/qq-import/groups")) {
        try {
          const token = readQceToken();
          if (!token) {
            return json(res, 200, { ok: false, error: "QCE 还没就绪", state: "no-token" });
          }
          if (url === "/api/qq-import/contacts") {
            const [rec, fr] = await Promise.all([
              listRecentContacts(token).catch(() => ({ ok: false, list: [] })),
              listFriends(token).catch(() => ({ ok: false, list: [] })),
            ]);
            const seen = new Map();
            const out = [];
            for (const c of rec.list || []) {
              const key = c.chatType + ":" + c.uid;
              if (!c.uid || seen.has(key)) continue;
              seen.set(key, true);
              out.push({ ...c, recent: true });
            }
            for (const f of fr.list || []) {
              const key = "1:" + f.uid;
              if (!f.uid || seen.has(key)) continue;
              seen.set(key, true);
              out.push({ uid: f.uid, uin: f.uin, name: f.name, remark: f.remark, chatType: 1, kind: "friend", recent: false });
            }
            return json(res, 200, { ok: true, data: { total: out.length, list: out } });
          }
          const r = url.endsWith("friends") ? await listFriends(token) : await listGroups(token);
          return json(res, 200, r.ok ? { ok: true, data: { total: r.total, list: r.list } } : { ok: false, error: r.error });
        } catch (e) {
          return json(res, 200, { ok: false, error: e?.message || String(e) });
        }
      }

      // QCE 装到项目下的 vendor/qce（vendor/ 已在 .gitignore 里）
      const QCE_DIR = resolve(HERE, "../../vendor/qce");

      // 「哪些号算她」—— 换过号就填多个，老号说的话仍然算她的。
      // 存 meta 而不是写文件：它跟这个记忆库绑定，换库就该换一套。
      const readQqBots = () => {
        try {
          const raw = db?.store?.getMeta("qq_bots");
          if (!raw) return [];
          const j = JSON.parse(raw);
          return Array.isArray(j) ? j.map(String).filter(Boolean) : [];
        } catch {
          return [];
        }
      };
      const writeQqBots = (list) => {
        const clean = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))];
        try {
          db.store.setMeta("qq_bots", JSON.stringify(clean));
        } catch {}
        return clean;
      };

      if (method === "GET" && url === "/api/qq-import/config") {
        return json(res, 200, { ok: true, data: { bots: readQqBots() } });
      }

      if (method === "POST" && url === "/api/qq-import/config") {
        try {
          const body = await readBody(req, 1024 * 1024);
          const bots = writeQqBots(body?.bots);
          return json(res, 200, { ok: true, data: { bots } });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 建一个导出任务。start / end 都按 Unix 秒传（界面给的是日期）。
      // mode: 缺省走漫游（QQ 服务器），'local' 走本机 QQ 数据库 ——
      // 会话没开漫游、或漫游记录不在服务器上时（漫游报业务码 -2），本机这条路照样有货。
      if (method === "POST" && url === "/api/qq-import/export") {
        try {
          const token = readQceToken();
          if (!token) return json(res, 200, { ok: false, error: "QCE 还没就绪" });

          const body = await readBody(req, 4 * 1024 * 1024);
          const peerUid = String(body.peerUid || "");
          const start = Number(body.start || 0);
          const end = Number(body.end || 0);
          if (!peerUid) return json(res, 400, { ok: false, error: "没选会话" });
          if (!start || !end || end <= start) return json(res, 400, { ok: false, error: "时间范围不对" });

          const common = {
            token,
            peerUid,
            chatType: Math.max(1, Math.min(2, Number(body.chatType || 1))),
            sessionName: String(body.name || ""),
            start,
            end,
          };
          // 群聊没有漫游一说，直接走本机导出
          const r =
            body.mode === "local" || common.chatType === 2
              ? await startLocalExport(common)
              : await startRoamingExport({
                  ...common,
                  maxMessages: Math.min(200000, Math.max(1000, Number(body.maxMessages || 100000))),
                });
          return json(res, 200, r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 列出 QCE 里已经导好的任务 —— 用户在它自己界面导完，面板靠这个找回来
      if (method === "GET" && url === "/api/qq-import/tasks") {
        try {
          const token = await readQceToken();
          if (!token) return json(res, 200, { ok: false, error: "没读到 QCE 的令牌" });
          const { tasks } = await listTasks(token, 60);
          return json(res, 200, { ok: true, data: { tasks } });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message || "读不到任务列表" });
        }
      }

      // 查任务进度（注意：必须是 /task?，不能匹配到 /tasks）
      if (method === "GET" && url.startsWith("/api/qq-import/task?")) {
        try {
          const token = readQceToken();
          if (!token) return json(res, 200, { ok: false, error: "QCE 还没就绪" });
          const id = new URL(url, "http://x").searchParams.get("id") || "";
          if (!id) return json(res, 400, { ok: false, error: "缺少任务 id" });
          const r = await getTask(id, token);
          return json(res, 200, r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error });
        } catch (e) {
          return json(res, 200, { ok: false, error: e?.message || String(e) });
        }
      }

      // 解析一个已经导出的 JSON 文件（只看结构，先不写库）
      if (method === "POST" && url === "/api/qq-import/parse") {
        try {
          const body = await readBody(req, 64 * 1024 * 1024);
          // QCE 给的是 Windows "扩展长度路径"（\\?\D:\...），Node 的 fs 不认这个前缀
          const path = String(body.file || "").replace(/^\\\\\?\\/, "");
          if (!path || !existsSync(path)) return json(res, 404, { ok: false, error: "文件不在了：" + path });
          const st = statSync(path, { throwIfNoEntry: false });
          if (!st || !st.isFile()) return json(res, 400, { ok: false, error: "这不是一个能读的文件：" + path });
          // 整个文件要 readFileSync 进内存再 JSON.parse —— 太大的直接拒掉，别把面板带走
          if (st.size > 256 * 1024 * 1024) {
            return json(res, 400, { ok: false, error: "文件太大（" + Math.round(st.size / 1048576) + " MB），上限 256 MB" });
          }
          const raw = JSON.parse(readFileSync(path, "utf8"));
          const parsed = parseExport(raw, body.bots ?? readQqBots());
          return json(res, 200, {
            ok: true,
            data: {
              chatName: parsed.chatName,
              selfUin: parsed.selfUin,
              peerUin: parsed.peerUin,
              bots: parsed.bots,
              total: parsed.total,
              kept: parsed.kept,
              preview: parsed.messages.slice(0, 5).map((m) => ({ who: m.who, text: m.text, ts: m.ts })),
            },
          });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 把导出结果真正写进记忆库。
      //
      // 两种模式：
      //   bulk     不读不判断，每条都按现有规则塞进 ring4
      //   persona  让她读完整段再决定 —— 需要先接上她的人格，现在还没做
      //
      // 进度写进记忆库目录下的 qq-import-queue.json，断了能接着来。
      if (method === "POST" && url === "/api/qq-import/absorb") {
        try {
          const body = await readBody(req, 8 * 1024 * 1024);
          const mode = String(body.mode || "bulk");

          // 三种来路：面板选到的本地路径 / QCE 给的一条下载链接 / 两者都没有
          let path = String(body.file || body.filePath || "").replace(/^\\\\\?\\/, "");
          let tmpFile = null;

          if (!path && body.downloadUrl) {
            const token = readQceToken();
            if (!token) return json(res, 200, { ok: false, error: "读不到 QCE 的令牌（它启动了没有？）" });
            const d = await downloadResult(String(body.downloadUrl), token);
            if (!d.ok || !d.buf) {
              return json(res, 200, { ok: false, error: "下载 QCE 的文件失败：" + (d.error || "未知原因") });
            }
            const safe = String(body.taskId || "qce").replace(/[^\w.-]/g, "").slice(0, 40) || "qce";
            tmpFile = join(tmpdir(), `ringmind-qce-${Date.now()}-${safe}.json`);
            await writeFile(tmpFile, d.buf);
            path = tmpFile;
          }

          if (!path || !existsSync(path)) return json(res, 404, { ok: false, error: "文件不在了：" + path });
          const st0 = statSync(path, { throwIfNoEntry: false });
          if (!st0 || !st0.isFile()) return json(res, 400, { ok: false, error: "这不是一个能读的文件：" + path });
          if (st0.size > 256 * 1024 * 1024) {
            return json(res, 400, { ok: false, error: "文件太大（" + Math.round(st0.size / 1048576) + " MB），上限 256 MB" });
          }

          if (mode === "persona") {
            return json(res, 200, {
              ok: false,
              error: "人格筛选走单独的任务接口：/api/qq-import/absorb-persona",
            });
          }

          const raw = JSON.parse(readFileSync(path, "utf8"));
          const parsed = parseExport(raw, readQqBots());
          if (!parsed.messages.length) {
            return json(res, 200, { ok: true, data: { added: 0, skipped: 0, note: "这条会话没有可入库的文本" } });
          }

          // 去重：同一个 message id 只进一次。存在记忆库旁边，跟库走。
          const qPath = join(data, "qq-import-queue.json");
          let q = { imported: {}, batches: {}, lastRun: null };
          try {
            if (existsSync(qPath)) q = { ...q, ...JSON.parse(readFileSync(qPath, "utf8")) };
          } catch {}
          if (!q.imported || typeof q.imported !== "object") q.imported = {};
          if (!q.batches || typeof q.batches !== "object") q.batches = {};

          let added = 0;
          let skipped = 0;
          // 从现在开始淡：历史消息带真实发生时间，但不因为"太老"一进来就掉圈
          const now = Date.now();
          // 批次标记：这一run写进去的每一条都带着它，撤回时整批删
          const batchId = "b" + now.toString(36) + Math.random().toString(36).slice(2, 6);
          const batchKeys = [];

          for (const m of parsed.messages) {
            const key = m.id || parsed.peerUin + "|" + m.ts + "|" + m.text.slice(0, 40);
            if (q.imported[key]) {
              skipped++;
              continue;
            }
            try {
              db.remember({
                content: m.text,
                ring: "ring4",
                // memories.source 只认 private / group
                source: parsed.chatType === "group" ? "group" : "private",
                // speaker 只分两种：她说的 / 不是她说的
                speaker: m.who === "self" ? "self" : "user",
                at: m.ts || now,
                ringEnteredAt: now,
                importBatch: batchId,
                // 原文逐条进总库由 remember 自己写，这里不重复
                skipVault: false,
              });
              q.imported[key] = m.ts || now;
              batchKeys.push(key);
              added++;
            } catch {
              skipped++;
            }
          }

          if (added > 0) {
            q.batches[batchId] = { at: now, chat: parsed.chatName, mode: "bulk", added, skipped, keys: batchKeys };
          }
          q.lastRun = { at: now, mode, chat: parsed.chatName, added, skipped, file: path };
          try {
            await writeFile(qPath, JSON.stringify(q, null, 2), "utf8");
          } catch {}

          const st = db.todayStats();
          // 临时下载的文件用完就删，别在 %TEMP% 里堆
          if (tmpFile) {
            try {
              unlink(tmpFile);
            } catch {
              /* 删不掉算了 */
            }
          }
          return json(res, 200, {
            ok: true,
            data: {
              added,
              skipped,
              queue: qPath,
              chatName: parsed.chatName,
              memories: Number(st.memories || 0),
              points: Number(st.points || 0),
            },
          });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // ── 人格筛选：让她自己读对话、挑值得记的事 ─────────
      // persona.js 只负责"问她"和"解析回答"，这里把
      // 导出文件 → 分批 → 问她 → 写库 串成一个后台任务。
      // 一批最多 60 条、一次调用最长两分钟，所以绝不挂在 HTTP 请求上：
      // 发起后立刻返回，进度走 /api/qq-import/persona-status 轮询。

      if (method === "GET" && url === "/api/persona-config") {
        const cfg = readPersonaConfig(data);
        return json(res, 200, {
          ok: true,
          data: {
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            persona: cfg.persona,
            enabled: cfg.enabled,
            hasKey: Boolean(cfg.apiKey),
            // 钥匙不给原文，给个能认出来的影子就够了
            keyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 4) + "…" + cfg.apiKey.slice(-4) : "",
          },
        });
      }

      if (method === "POST" && url === "/api/persona-config") {
        try {
          const body = await readBody(req, 1024 * 1024);
          const patch = {};
          if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl.trim();
          if (typeof body.model === "string") patch.model = body.model.trim();
          if (typeof body.persona === "string") patch.persona = body.persona;
          if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
          // 钥匙留空 = 保持原样；填了才换 —— 界面上每次回显都拿不到原文
          if (typeof body.apiKey === "string" && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
          const cfg = writePersonaConfig(data, patch);
          return json(res, 200, {
            ok: true,
            data: { hasKey: Boolean(cfg.apiKey), baseUrl: cfg.baseUrl, model: cfg.model },
          });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 试一句：不碰库，只验证钥匙、地址、人格提示词通不通
      if (method === "POST" && url === "/api/persona-test") {
        try {
          const cfg = readPersonaConfig(data);
          const r = await askBatch(
            cfg,
            [
              { who: "user", ts: Date.now(), text: "今天下午我们去了海边，风特别大，帽子都吹跑了。" },
              { who: "self", ts: Date.now(), text: "好呀，那下次带上夹子。" },
            ],
            "试一句"
          );
          return json(res, 200, r.ok ? { ok: true, data: { items: r.items, usage: r.usage } } : { ok: false, error: r.error });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 后台跑的人格导入任务：同一时间只允许一个（personaJob 在上面声明）

      if (method === "GET" && url === "/api/qq-import/persona-status") {
        return json(res, 200, { ok: true, data: personaStatus() });
      }

      if (method === "POST" && url === "/api/qq-import/persona-stop") {
        if (personaJob && !personaJob.done) personaJob.stop = true; // 这批读完就收手
        return json(res, 200, { ok: true, data: personaStatus() });
      }

      if (method === "POST" && url === "/api/qq-import/absorb-persona") {
        try {
          if (personaJob && !personaJob.done) {
            return json(res, 400, { ok: false, error: "她还在读上一段 —— 等读完，或先点停止" });
          }
          const body = await readBody(req, 8 * 1024 * 1024);
          // 来路跟全量计入完全一样：本地路径 / QCE 下载链接
          let path = String(body.file || body.filePath || "").replace(/^\\\\\?\\/, "");
          let tmpFile = null;
          if (!path && body.downloadUrl) {
            const token = readQceToken();
            if (!token) return json(res, 200, { ok: false, error: "读不到 QCE 的令牌（它启动了没有？）" });
            const d = await downloadResult(String(body.downloadUrl), token);
            if (!d.ok || !d.buf) {
              return json(res, 200, { ok: false, error: "下载 QCE 的文件失败：" + (d.error || "未知原因") });
            }
            const safe = String(body.taskId || "qce").replace(/[^\w.-]/g, "").slice(0, 40) || "qce";
            tmpFile = join(tmpdir(), `ringmind-qce-${Date.now()}-${safe}.json`);
            await writeFile(tmpFile, d.buf);
            path = tmpFile;
          }
          if (!path || !existsSync(path)) return json(res, 404, { ok: false, error: "文件不在了：" + path });
          const stP = statSync(path, { throwIfNoEntry: false });
          if (!stP || !stP.isFile()) return json(res, 400, { ok: false, error: "这不是一个能读的文件：" + path });
          if (stP.size > 256 * 1024 * 1024) {
            return json(res, 400, { ok: false, error: "文件太大（" + Math.round(stP.size / 1048576) + " MB），上限 256 MB" });
          }

          const cfg = readPersonaConfig(data);
          if (!cfg.apiKey) {
            return json(res, 400, { ok: false, error: "还没给她配 API Key —— 在「她的人格」卡里填好再试" });
          }

          const raw = JSON.parse(readFileSync(path, "utf8"));
          const parsed = parseExport(raw, readQqBots());
          if (tmpFile) {
            try { await unlink(tmpFile); } catch { /* 删不掉算了 */ }
          }
          if (!parsed.messages.length) {
            return json(res, 200, { ok: false, error: "这条会话没有可读的文本" });
          }

          const batches = chunk(parsed.messages, BATCH_SIZE);
          // 去重跟全量共用一个队列文件，人格提炼的记忆用 "P|" 前缀的钥匙
          const qPath = join(data, "qq-import-queue.json");
          let q = { imported: {}, batches: {}, lastRun: null };
          try {
            if (existsSync(qPath)) q = { ...q, ...JSON.parse(readFileSync(qPath, "utf8")) };
          } catch {}
          if (!q.imported || typeof q.imported !== "object") q.imported = {};
          if (!q.batches || typeof q.batches !== "object") q.batches = {};

          const now = Date.now();
          const batchId = "b" + now.toString(36) + Math.random().toString(36).slice(2, 6);
          const batchKeys = [];

          personaJob = {
            phase: "reading",
            done: false,
            stop: false,
            batch: 0,
            batchTotal: batches.length,
            remembered: 0,
            skipped: 0,
            tokens: 0,
            error: null,
            chatName: parsed.chatName,
            startedAt: now,
            finishedAt: 0,
          };

          const job = personaJob;
          (async () => {
            for (let i = 0; i < batches.length; i++) {
              if (job.stop) { job.phase = "stopped"; break; }
              job.batch = i + 1;
              const r = await askBatch(cfg, batches[i], parsed.chatName);
              if (!r.ok) {
                job.phase = "error";
                job.error = `第 ${i + 1}/${batches.length} 批没读成：${r.error}`;
                break;
              }
              job.tokens += Number(r.usage?.total_tokens || 0);
              // 提炼出来的事发生在这批消息的时间段里，取最晚的一条当发生时间
              const at =
                batches[i].reduce((m, x) => Math.max(m, Number(x.ts) || 0), 0) || Date.now();
              for (const it of r.items) {
                const key =
                  "P|" +
                  createHash("sha1").update(String(it.remember).replace(/\s+/g, "")).digest("hex").slice(0, 16);
                if (q.imported[key]) { job.skipped++; continue; }
                try {
                  db.remember({
                    content: it.remember,
                    ring: it.ring,
                    source: parsed.chatType === "group" ? "group" : "private",
                    speaker: "self", // 记忆是她以自己的视角写的
                    emotion: it.emotion,
                    at,
                    ringEnteredAt: Date.now(),
                    importBatch: batchId,
                    skipVault: false,
                  });
                  q.imported[key] = at;
                  batchKeys.push(key);
                  job.remembered++;
                } catch { job.skipped++; }
              }
              // 每批落一次盘：断了重跑，已经写进库的会自动跳过
              try {
                writeFileSync(qPath, JSON.stringify(q, null, 2), "utf8");
              } catch {}
            }
            if (job.phase === "reading") job.phase = "done";
            // 批次记录：撤回时按这个整批删
            if (job.remembered > 0) {
              q.batches[batchId] = {
                at: now, chat: parsed.chatName, mode: "persona",
                added: job.remembered, skipped: job.skipped, keys: batchKeys,
              };
            }
            try { writeFileSync(qPath, JSON.stringify(q, null, 2), "utf8"); } catch {}
            job.done = true;
            job.finishedAt = Date.now();
          })();

          return json(res, 200, {
            ok: true,
            data: { batches: batches.length, messages: parsed.messages.length, chatName: parsed.chatName },
          });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // ── 导入历史 / 撤回 ─────────────────────────────
      // 每一次面板导入都打了批次标（memories.import_batch），撤回就是整批删。
      // 更早没打标的导入（v4 之前），按"同一次 run 的 ring_entered_at 完全相同、
      // 且消息时间远早于落库时间"这个特征认出来，同样能撤。

      if (method === "GET" && url === "/api/qq-import/batches") {
        try {
          const qPath = join(data, "qq-import-queue.json");
          let q = { imported: {}, batches: {} };
          try {
            if (existsSync(qPath)) q = { ...q, ...JSON.parse(readFileSync(qPath, "utf8")) };
          } catch {}
          const out = [];
          for (const [id, b] of Object.entries(q.batches || {})) {
            // 库里还剩几条算几条 —— decay 或手动删过就不虚报
            const c = db.store.db.prepare("SELECT count(*) AS c FROM memories WHERE import_batch = ?").get(id).c;
            if (c > 0) out.push({ id, tagged: true, at: b.at, chat: b.chat || "", mode: b.mode || "bulk", count: c });
          }
          const legacy = db.store.db
            .prepare(
              `SELECT ring_entered_at AS re, count(*) AS c, max(created_at) AS mx
               FROM memories WHERE import_batch IS NULL AND ring = 'ring4'
               GROUP BY ring_entered_at HAVING c >= 2`
            )
            .all();
          for (const r of legacy) {
            // 消息时间比落库时间早 6 小时以上，才像"导历史记录"；
            // qq-bridge 实时入库的 created_at ≈ ring_entered_at，不会误伤
            if (r.re - r.mx > 6 * 3600 * 1000) {
              out.push({
                id: "legacy:" + r.re,
                tagged: false,
                at: r.re,
                chat: "",
                mode: "bulk · 按落库时间识别",
                count: r.c,
              });
            }
          }
          out.sort((a, b) => b.at - a.at);
          return json(res, 200, { ok: true, data: { batches: out.slice(0, 50) } });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      if (method === "POST" && url === "/api/qq-import/import-undo") {
        try {
          const body = await readBody(req);
          const id = String(body.id || "");
          if (!id) return json(res, 400, { ok: false, error: "没说撤哪一批" });

          const qPath = join(data, "qq-import-queue.json");
          let q = { imported: {}, batches: {} };
          try {
            if (existsSync(qPath)) q = { ...q, ...JSON.parse(readFileSync(qPath, "utf8")) };
          } catch {}
          if (!q.imported || typeof q.imported !== "object") q.imported = {};
          if (!q.batches || typeof q.batches !== "object") q.batches = {};

          let where;
          let keys = [];
          if (id.startsWith("legacy:")) {
            const ts = Number(id.slice(7));
            if (!Number.isFinite(ts)) return json(res, 400, { ok: false, error: "批次号不对" });
            where = `import_batch IS NULL AND ring_entered_at = ${ts}`;
          } else {
            const b = q.batches[id];
            if (!b) return json(res, 404, { ok: false, error: "清单里没有这一批了" });
            where = `import_batch = '${id.replace(/'/g, "''")}'`;
            keys = b.keys || [];
          }

          const ids = db.store.db.prepare(`SELECT id FROM memories WHERE ${where}`).all().map((r) => r.id);
          if (!ids.length) return json(res, 404, { ok: false, error: "这批记忆已经不在库里了" });

          // 总库里的原文一起清（meta 里存着 memoryId）
          const delVault = db.store.db.prepare(
            "DELETE FROM vault WHERE meta LIKE '%' || ? || '%'"
          );
          for (const mid of ids) delVault.run(`"memoryId":"${mid}"`);
          const p = db.store.db
            .prepare(`DELETE FROM points WHERE memory_id IN (SELECT id FROM memories WHERE ${where})`)
            .run();
          const m = db.store.db.prepare(`DELETE FROM memories WHERE ${where}`).run();
          try { db.store.logOp("import-undo", { removed: m.changes, batch: id }); } catch {}

          // 去重钥匙一并清掉 —— 撤了就该能重导
          for (const k of keys) delete q.imported[k];
          if (!id.startsWith("legacy:")) delete q.batches[id];
          try { writeFileSync(qPath, JSON.stringify(q, null, 2), "utf8"); } catch {}

          return json(res, 200, { ok: true, data: { removed: m.changes, points: p.changes } });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // ── 缓冲区：导出的文件先落到这儿，看不看、导不导、什么时候导，都由人决定 ──
      // 文件放在 <数据目录>/imports/ 下 —— 跟着库走（换库就换一片缓冲区），
      // 数据目录不在 web 静态目录里，面板外部拿不到。
      const stashDir = () => join(data, "imports");
      const stashMetaPath = () => join(stashDir(), "stash.json");

      function readStash() {
        try {
          const j = JSON.parse(readFileSync(stashMetaPath(), "utf8"));
          return Array.isArray(j) ? j : [];
        } catch {
          return [];
        }
      }
      function writeStash(list) {
        mkdirSync(stashDir(), { recursive: true });
        writeFileSync(stashMetaPath(), JSON.stringify(list, null, 2), "utf8");
      }

      if (method === "GET" && url === "/api/qq-import/stash") {
        return json(res, 200, { ok: true, data: { list: readStash() } });
      }

      if (method === "DELETE" && url.startsWith("/api/qq-import/stash?")) {
        const id = new URL(url, "http://x").searchParams.get("id") || "";
        const list = readStash();
        const hit = list.find((s) => s.id === id);
        if (!hit) return json(res, 404, { ok: false, error: "缓冲区里没有这个文件了" });
        try { unlinkSync(hit.file); } catch { /* 文件不在就算了 */ }
        writeStash(list.filter((s) => s.id !== id));
        return json(res, 200, { ok: true, data: { removed: id } });
      }

      if (method === "POST" && url === "/api/qq-import/stash") {
        try {
          const body = await readBody(req, 8 * 1024 * 1024);
          // 来路跟导入完全一样：QCE 下载链接 / 本地路径
          let path = String(body.file || body.filePath || "").replace(/^\\\\\?\\/, "");
          let tmpFile = null;
          if (!path && body.downloadUrl) {
            const token = readQceToken();
            if (!token) return json(res, 200, { ok: false, error: "读不到 QCE 的令牌（它启动了没有？）" });
            const d = await downloadResult(String(body.downloadUrl), token);
            if (!d.ok || !d.buf) {
              return json(res, 200, { ok: false, error: "下载 QCE 的文件失败：" + (d.error || "未知原因") });
            }
            const safe = String(body.taskId || "qce").replace(/[^\w.-]/g, "").slice(0, 40) || "qce";
            tmpFile = join(tmpdir(), `ringmind-qce-${Date.now()}-${safe}.json`);
            await writeFile(tmpFile, d.buf);
            path = tmpFile;
          }
          if (!path || !existsSync(path)) return json(res, 404, { ok: false, error: "文件不在了：" + path });
          const stS = statSync(path, { throwIfNoEntry: false });
          if (!stS || !stS.isFile()) return json(res, 400, { ok: false, error: "这不是一个能读的文件：" + path });
          if (stS.size > 256 * 1024 * 1024) {
            return json(res, 400, { ok: false, error: "文件太大（" + Math.round(stS.size / 1048576) + " MB），上限 256 MB" });
          }

          // 同一个 QCE 任务别重复堆：已经在缓冲区就原样返回
          const list = readStash();
          if (body.taskId) {
            const dup = list.find((s) => s.taskId && s.taskId === String(body.taskId));
            if (dup) {
              if (tmpFile) { try { await unlink(tmpFile); } catch {} }
              return json(res, 200, { ok: true, data: { ...dup, dup: true } });
            }
          }

          // 先解析出摘要（会话名、条数、时间段），列表就不用每次重新读大文件
          const raw = JSON.parse(readFileSync(path, "utf8"));
          const parsed = parseExport(raw, readQqBots());
          if (!parsed.messages.length) {
            if (tmpFile) { try { await unlink(tmpFile); } catch {} }
            return json(res, 200, { ok: false, error: "这份导出里没有可读的文本，不收了" });
          }
          const tss = parsed.messages.map((m) => Number(m.ts) || 0).filter(Boolean);

          mkdirSync(stashDir(), { recursive: true });
          const id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
          const file = join(stashDir(), id + ".json");
          // 先落进缓冲区，再清临时文件 —— 顺序别反
          copyFileSync(path, file);
          if (tmpFile) { try { await unlink(tmpFile); } catch {} }

          const entry = {
            id,
            taskId: body.taskId ? String(body.taskId) : "",
            chatName: parsed.chatName,
            chatType: parsed.chatType,
            peerUin: parsed.peerUin,
            messages: parsed.total,
            kept: parsed.kept,
            minTs: tss.length ? Math.min(...tss) : 0,
            maxTs: tss.length ? Math.max(...tss) : 0,
            bytes: stS.size,
            file,
            savedAt: Date.now(),
          };
          list.unshift(entry);
          writeStash(list);
          return json(res, 200, { ok: true, data: entry });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message || String(e) });
        }
      }

      // 开始下载并解压。这是"程序自动下一个第三方 exe"的动作，
      // 界面那边必须先弹确认；这里只认"确认过了"的请求。
      if (method === "POST" && url === "/api/qq-import/install") {
        try {
          const started = startInstall(QCE_DIR);
          return json(res, 200, {
            ok: true,
            data: { started, state: installState(), dir: QCE_DIR },
          });
        } catch (e) {
          return json(res, 200, { ok: false, error: e?.message || String(e) });
        }
      }

      // 轮询安装进度
      if (method === "GET" && url === "/api/qq-import/install-status") {
        const launcher = existsSync(QCE_DIR) ? findLauncher(QCE_DIR) : null;
        return json(res, 200, {
          ok: true,
          data: {
            ...installState(),
            dir: QCE_DIR,
            installed: Boolean(launcher),
            launcher,
            qq: await qqRunning(),
          },
        });
      }

      // 启动 napiLoader.bat。会拉起一个带注入的 QQ，所以先确认 QQ 是退出的。
      if (method === "POST" && url === "/api/qq-import/launch") {
        try {
          const launcher = findLauncher(QCE_DIR);
          if (!launcher) {
            return json(res, 200, { ok: false, error: "还没装，先点下载" });
          }
          const r = await launchQce(launcher);
          return json(res, 200, r.ok ? { ok: true, data: { launcher } } : { ok: false, error: r.error });
        } catch (e) {
          return json(res, 200, { ok: false, error: e?.message || String(e) });
        }
      }

      if (method === "POST" && url === "/api/pick-folder") {
        // 用 PowerShell + WinForms，配一个 TopMost 的隐形父窗体。
        // 以前用 VBScript 的 Shell.Application.BrowseForFolder(0, ...)，第一个参数是父窗口句柄，
        // 传 0 就没有父窗口 —— 对话框会被浏览器盖在后面，用户以为点了没反应。
        // 给它一个 TopMost 的隐形窗体当 owner，它就会顶在最前面。
        if (process.platform !== "win32") {
          return json(res, 400, { ok: false, error: "非 Windows 还不支持" });
        }
        try {
          const { randomBytes } = await import("node:crypto");
          const { tmpdir } = await import("node:os");
          const { execFile } = await import("node:child_process");

          const tag = randomBytes(4).toString("hex");
          const psPath = join(tmpdir(), `ringmind_pick_${tag}.ps1`);
          const outPath = join(tmpdir(), `ringmind_pick_${tag}.txt`);

          const ps = [
            "Add-Type -AssemblyName System.Windows.Forms",
            "$form = New-Object System.Windows.Forms.Form",
            "$form.TopMost = $true",
            "$form.ShowInTaskbar = $false",
            "$form.FormBorderStyle = 'None'",
            "$form.StartPosition = 'CenterScreen'",
            "$form.Width = 1",
            "$form.Height = 1",
            "$form.Opacity = 0",
            "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
            '$dlg.Description = "选一个文件夹放记忆库"',
            "$dlg.ShowNewFolderButton = $true",
            "$r = $dlg.ShowDialog($form)",
            "$form.Dispose()",
            "if ($r -eq [System.Windows.Forms.DialogResult]::OK) {",
            `  [System.IO.File]::WriteAllText("${outPath}", $dlg.SelectedPath, [System.Text.Encoding]::UTF8)`,
            "}",
          ].join("\r\n");

          // UTF-8 带 BOM，PowerShell 才按 UTF-8 读中文
          await writeFile(psPath, "\uFEFF" + ps, "utf8");

          await new Promise((ok, fail) => {
            execFile(
              "powershell.exe",
              ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", psPath],
              { timeout: 180000 },
              (err) => {
                try { unlink(psPath); } catch { /* 删不掉算了 */ }
                if (err) return fail(err);
                ok();
              }
            );
          });

          let p = null;
          if (existsSync(outPath)) {
            p = readFileSync(outPath, "utf8").replace(/^\uFEFF/, "").trim() || null;
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
            // OneBot 11 的 HTTP API 要 POST。之前这里漏了 method，走成 GET ——
            // /get_login_info 有些实现能容忍，/get_status 就不一定了：
            // 回一坨不是 OneBot 的东西，data.online 读不到，面板就一律显示「离线」。
            const r = await fetch(u.replace(/\/+$/, "") + path, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(tk ? { Authorization: "Bearer " + tk } : {}),
              },
              body: "{}",
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
        let onebot = await probe(ob.url, ob.token);
        // 探测不通（最常见：换了 QQ 号，token 还是旧的 → 401）就先试着自愈。
        // 只在失败时动手，正常路径不付任何代价；节流在 gateway.js 里。
        let healed = null;
        const bad = !onebot.reachable || onebot.status !== 200;
        if (bad && ob.gatewayDir) {
          healed = await healGateway(ob);
          if (healed) {
            const wrote = saveGatewayConfig(ONEBOT_FILE, ob, healed);
            ob = { ...ob, url: healed.url, token: healed.token };
            onebot = await probe(ob.url, ob.token);
            if (wrote) {
              console.log(
                `[网关自愈] 已切换到账号 ${healed.uin}，并写回 onebot.json`
              );
            }
          }
        }
        // 控制台地址：能从 SnowLuma 嘴里问出来就问，问不到再退回默认
        const con = await resolveConsoleUrl(ob);

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
              token: readToken(data) || token, // 明文：这行就是给人复制去登录的
              tokenHash: (() => {
                const v = readToken(data) || token;
                return v ? createHash("sha256").update(v).digest("hex").slice(0, 12) : null;
              })(),
            },
            db: { ok: dbOk, path: dbFile, name: basename(dbFile, extname(dbFile)), bytes, lastWrite, memories: st2.memories, points: st2.points },
            onebot: {
              url: ob.url,
              token: maskToken(ob.token),
              configured: Boolean(ob.token || process.env.ONEBOT_URL),
              reachable: onebot.reachable,
              authorized: onebot.status === 200,
              status: onebot.status ?? null,
              error: onebot.error || null,
              // 三个来源，谁先给出确定答案就用谁：
              //   ① get_status 说 online=true     → 在线
              //   ② get_login_info 拿到 user_id   → 在线（离线时这接口拿不到号）
              //   ③ 两个都没拿到                  → null（前端显示「有响应」）
              online: gw?.online === true ? true : (qq && qq.userId ? true : (gw?.online ?? null)),
              uptime: gw?.uptime ?? null,
              app: ver?.app || null,
              version: ver?.version || null,
              // SnowLuma 控制台（WebUI）：地址自动解析，密码是存的
              consoleUrl: con.url,
              consoleAuto: con.auto,      // true = 端口是从 SnowLuma 自己嘴里问出来的
              consolePort: con.port,
              consolePassword: ob.consolePassword || "",
              // 换号自愈：gatewayDir 没配就永远 false
              gatewayDir: ob.gatewayDir || "",
              healed: healed ? { uin: healed.uin, changed: healed.changed } : null,
              // 配置文件读不了：不拿库里的老值顶替，照实说
              configCorrupt: Boolean(ob.__corrupt),
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
          consoleUrl: "consoleUrl" in body
            ? (String(body.consoleUrl || "").trim() || prev.consoleUrl)
            : prev.consoleUrl,
          consolePassword: "consolePassword" in body
            ? String(body.consolePassword || "")
            : prev.consolePassword,
          // 没传就保留：这个字段一丢，换号自愈就悄悄失效了
          gatewayDir: "gatewayDir" in body
            ? String(body.gatewayDir || "").trim()
            : (prev.gatewayDir || ""),
        };
        return json(res, 200, { ok: true, data: writeOnebot(cfg) });
      }

      // SnowLuma 控制台密码存一次：收到就写进 onebot.json，顺便试登一次看看对不对
      if (method === "POST" && url === "/api/console") {
        const body = await readBody(req);
        const prev = readOnebot(db);
        const pw = String(body.password || "");
        const cu = String(body.url || "").trim() || prev.consoleUrl || "http://127.0.0.1:5099";
        // 只改地址：直接把地址落盘，不碰密码
        if (!pw) {
          if (!String(body.url || "").trim()) {
            return json(res, 400, { ok: false, error: "密码和地址至少给一个" });
          }
          const only = { ...prev, consoleUrl: cu };
          writeOnebot(only);
          return json(res, 200, { ok: true, data: { url: cu, verified: null } });
        }

        let verified = null;
        try {
          const r = await fetch(cu.replace(/\/+$/, "") + "/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pw }),
            signal: AbortSignal.timeout(4000),
          });
          verified = r.status === 200;
        } catch { verified = null; }

        const cfg = { ...prev, consoleUrl: cu, consolePassword: pw };
        writeOnebot(cfg);
        return json(res, 200, { ok: true, data: { url: cu, verified } });
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
          return json(res, 200, { ok: true, data: db.decay({ via: "api" }) });
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
        const hours = Math.max(
          0,
          Math.min(24 * 90, Number(new URL(url, "http://x").searchParams.get("hours")) || 0)
        );

        // 每次请求先把 QQ 账本同步进库（幂等，同一行覆盖）
        const sync = await syncDshToDb(db.store);

        // 优先读库：账本哪天丢了历史还在
        const fromDb = dbTokenRecords(db.store, hours);
        if (fromDb && fromDb.length) {
          const data = aggregateTokenRecords(fromDb, hours, "库（已从 QQ 账本同步）");
          data.sync = sync;
          data.range = db.store.tokenUsageRange?.() || null;
          data.source = "库";
          return json(res, 200, { ok: true, data });
        }

        // 库还空：直接读账本
        const found = findUsageLedger();
        const data = readTokenLedger(found.path, hours);
        data.sync = sync;
        data.source = found.kind || "账本直读";
        return json(res, 200, { ok: true, data });
      }

      if (method === "GET" && url === "/api/decay-preview") {
        return json(res, 200, { ok: true, data: { plan: db.planDecay() } });
      }

      // 更新日志：每次降级任务真跑过都留一条（含"跑了但一条没动"）。
      // ?limit= 默认 50，最多 200。
      if (method === "GET" && url.split("?")[0] === "/api/decay-log") {
        const q = new URL(url, "http://x").searchParams;
        const want = Number(q.get("limit"));
        const limit = Number.isFinite(want) && want > 0 ? Math.min(200, Math.floor(want)) : 50;

        const rows = db.store.db
          .prepare("SELECT ts, payload FROM ops WHERE kind = 'decay' ORDER BY ts DESC LIMIT ?")
          .all(limit)
          .map((r) => {
            let p = {};
            try {
              p = JSON.parse(r.payload || "{}");
            } catch {
              /* 老记录解析不了就当空 */
            }
            return {
              at: r.ts,
              applied: p.applied ?? 0,
              forgotten: p.forgotten ?? 0,
              softened: p.softened ?? 0,
              via: p.via ?? null,
            };
          });

        // 旧版本有个盲点：跑了但一条没动就不写 ops，只留了 .decay-state.json。
        // 它比最后一条 ops 新，就补一行「只知道跑了、不知道动了几条」，别让面板误报「今天还没跑」。
        let stateAt = 0;
        try {
          stateAt = Number(JSON.parse(readFileSync(resolve(HERE, "../../mcp/.decay-state.json"), "utf8")).lastDecayAt) || 0;
        } catch {
          /* 没这个文件就算了 */
        }
        if (stateAt && (!rows.length || stateAt > rows[0].at)) {
          rows.unshift({
            at: stateAt,
            applied: null,
            forgotten: null,
            softened: null,
            via: "mcp-start",
            estimated: true,
          });
        }

        const lastAt = rows.length ? rows[0].at : null;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        return json(res, 200, {
          ok: true,
          data: {
            runs: rows,
            lastAt,
            /** 距上次运行多少毫秒；从没跑过就是 null */
            sinceLast: lastAt ? Date.now() - lastAt : null,
            /** 今天还没跑过 = 该跑的没跑（插件不另设定时器，接入时补） */
            overdue: lastAt ? lastAt < todayStart.getTime() : true,
          },
        });
      }

      // 记忆海：整座库画成三维星海的数据。vault=1 才带总库幻影（总库可能很大，默认不画）
      if (method === "GET" && url.split("?")[0] === "/api/sea") {
        const q = new URL(url, "http://x").searchParams;
        const scene = buildSeaScene(db.store, db.getConfig(), {
          now: Date.now(),
          vault: q.get("vault") === "1",
          vaultMax: Number.isFinite(Number(q.get("vaultMax"))) && Number(q.get("vaultMax")) > 0 ? Number(q.get("vaultMax")) : undefined,
        });
        return json(res, 200, { ok: true, data: scene });
      }

      return json(res, 404, { ok: false, error: "没这个接口" });
    }

    // ── 静态文件 ──────────────────────────────────────
    if (url === "/" || url.startsWith("/?")) {
      // 主页 = 记忆海。登录过直接看海，没登录先给登录页
      if (sessionOf(req) && (await serveFile(res, join(HERE, "sea.html")))) return;
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