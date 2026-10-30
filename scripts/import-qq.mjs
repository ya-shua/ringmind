/**
 * QQ 聊天记录 → 环形的心 导入器
 * ============================================================================
 * 数据来源：qq-bridge 的 state/social-v2.json
 *   —— 每次会话保留最近 100 条完整正文（带时间、发送者、是否她自己说的）。
 *      这是目前唯一能拿到完整正文的地方，更早的消息已经没了。
 *
 * 用法：
 *   node scripts/import-qq.mjs --list
 *       只列出有哪些对话可以选择，不写任何东西。
 *
 *   node scripts/import-qq.mjs --pick group:123456789,private:123456789
 *       导入指定的对话（会先问你确认）。
 *
 *   node scripts/import-qq.mjs --pick all
 *       全部导。
 *
 *   node scripts/import-qq.mjs --pick ... --yes
 *       跳过确认（脚本里用）。
 *
 *   node scripts/import-qq.mjs --pick ... --dry
 *       只看会发生什么，不真写库。
 *
 * 导入规则（和自动入库保持一套）：
 *   ① 逐条原文 → 总库 vault，ts 用消息本身的真实时间
 *   ② 同一段对话（间隔 < 5 分钟）合并成一条 → 闲聊圈
 *   ③ 她自己的话不进总库（总库存的是"发生过什么"，不是她说了什么）
 *   ④ createdAt = 真实历史时间（保住顺序）；ringEnteredAt = 现在（从现在才开始淡）
 *      —— 不然导三年前的数据，进来当天就该掉光了
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 项目根目录：默认就是这个脚本的上一级；换位置了用 RING_ROOT 指定
const ROOT = process.env.RING_ROOT || path.resolve(HERE, "..");
// 记忆库文件：默认放项目的 data/ 下
const DB = process.env.RING_DB || path.join(ROOT, "data", "import.db");

/** 同一段对话的合并窗口（毫秒） */
const MERGE_WINDOW = 5 * 60_000;
/** 单条合并后最多带多少字 */
const MAX_CHARS = 800;
/** 每个会话最多能拿到多少条 */
const PER_SESSION_CAP = 100;

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};

// 聊天记录从哪读：--social <路径> > QQ_SOCIAL > 项目 data/social-v2.json
const SOCIAL = val("--social") || process.env.QQ_SOCIAL || path.join(ROOT, "data", "social-v2.json");

function die(msg) {
  console.error("\n✗ " + msg + "\n");
  process.exit(1);
}

// ─────────────────────────────── 读数据 ───────────────────────────────

function loadConversations() {
  if (!fs.existsSync(SOCIAL)) die(`找不到 ${SOCIAL}\n  qq-bridge 还没产生会话数据。`);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(SOCIAL, "utf8"));
  } catch (e) {
    die(`读 ${SOCIAL} 失败：${e.message}`);
  }
  const convs = j.conversations || {};
  const out = [];
  for (const [key, st] of Object.entries(convs)) {
    const msgs = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && Number(m.time) > 0)
      .map((m) => ({
        time: Number(m.time),
        sender: String(m.sender || "").trim() || "未知",
        text: String(m.text || m.plain || "").trim(),
        isSelf: !!m.isSelf,
        userId: m.userId ? String(m.userId) : "",
      }))
      .filter((m) => m.text)
      .sort((a, b) => a.time - b.time);

    if (!msgs.length) continue;

    const names = new Map();
    for (const m of msgs) names.set(m.sender, (names.get(m.sender) || 0) + 1);
    const speakers = [...names.entries()].sort((a, b) => b[1] - a[1]);

    out.push({
      key,
      msgs,
      source: key.startsWith("group:") ? "group" : "private",
      id: key.split(":")[1] || "",
      speakers,
      first: msgs[0].time,
      last: msgs[msgs.length - 1].time,
      selfCount: msgs.filter((m) => m.isSelf).length,
      theOther: speakers.find(([n]) => n !== "我" && n !== "我自己")?.[0] || key,
    });
  }
  out.sort((a, b) => b.last - a.last);
  return out;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hoursBetween(a, b) {
  return ((b - a) / 3600_000).toFixed(1);
}

// ─────────────────────────────── 列表 ───────────────────────────────

function printList(convs) {
  console.log("\n══════════ 可以导入的对话 ══════════\n");
  if (!convs.length) {
    console.log("  没有可导的对话。\n");
    return;
  }
  let total = 0;
  for (const c of convs) {
    total += c.msgs.length;
    const kind = c.source === "group" ? "群聊" : "私聊";
    console.log(`  ${c.key}`);
    console.log(`    类型：${kind}    对方：${c.theOther}`);
    console.log(`    条数：${c.msgs.length}    其中她自己：${c.selfCount}`);
    console.log(`    范围：${fmtTime(c.first)} → ${fmtTime(c.last)}（跨 ${hoursBetween(c.first, c.last)} 小时）`);
    console.log("");
  }
  console.log(`  合计 ${total} 条。\n`);
  console.log("  ⚠ 上限说明：qq-bridge 每个对话只留最近 100 条完整消息，");
  console.log("    更早的已经不在本地了，导不出来。\n");
  console.log("  用法：加 --pick <key1>,<key2> 导入选中的；--pick all 全导。\n");
}

// ─────────────────────────────── 合并 ───────────────────────────────

/** 把一段消息按时间窗口切成若干段 */
function segment(msgs) {
  const segs = [];
  let cur = [];
  for (const m of msgs) {
    if (m.isSelf) {
      // 她自己的话不进总库，但保留在上下文里让合并文本读起来连贯
      if (cur.length) cur.push(m);
      continue;
    }
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gap = m.time - prev.time;
      if (gap > MERGE_WINDOW) {
        segs.push(cur);
        cur = [];
      }
    }
    cur.push(m);
  }
  if (cur.length) segs.push(cur);
  return segs
    .map((s) => {
      const real = s.filter((m) => !m.isSelf);
      const mine = s.filter((m) => m.isSelf);
      if (!real.length && !mine.length) return null;
      const all = s.map((m) => m.time).sort((a, b) => a - b);
      return {
        msgs: s,
        real,
        mine,
        from: all[0],
        to: all[all.length - 1],
        // 分开拼：对方一段、她自己一段。顺序靠时间戳保，不靠拼接顺序。
        userBody: real.map((m) => `${m.sender}：${m.text}`).join(" / "),
        selfBody: mine.map((m) => `我：${m.text}`).join(" / "),
      };
    })
    .filter(Boolean);
}

function spanOf(from, to) {
  const a = fmtTime(from);
  const b = fmtTime(to);
  return a === b ? a : `${a}–${b}`;
}

// ─────────────────────────────── 确认 ───────────────────────────────

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(String(ans || "").trim().toLowerCase());
    });
  });
}

// ─────────────────────────────── 主流程 ───────────────────────────────

async function main() {
  const convs = loadConversations();

  if (has("--list") || !val("--pick")) {
    printList(convs);
    if (!val("--pick")) return;
  }

  const pickRaw = String(val("--pick") || "").trim();
  if (!pickRaw) return;

  let picked;
  if (pickRaw === "all") {
    picked = convs;
  } else {
    const wanted = pickRaw.split(",").map((s) => s.trim()).filter(Boolean);
    picked = convs.filter((c) => wanted.includes(c.key));
    const missing = wanted.filter((w) => !convs.some((c) => c.key === w));
    if (missing.length) {
      console.error(`\n✗ 这些 key 找不到：${missing.join("、")}`);
      console.error("  先用 --list 看看有哪些。\n");
      process.exit(1);
    }
  }
  if (!picked.length) die("没选中任何对话。");

  // 规划：每段一条记忆
  const plan = [];
  for (const c of picked) {
    for (const s of segment(c.msgs)) {
      plan.push({ conv: c, seg: s });
    }
  }

  const msgTotal = picked.reduce((n, c) => n + c.msgs.length, 0);
  // 问答分开存：一段里有多少个"有对方话"的、多少个"有她话"的
  const userRows = plan.filter((p) => p.seg.userBody).length;
  const selfRows = plan.filter((p) => p.seg.selfBody).length;
  const memRows = userRows + selfRows;

  console.log("\n══════════ 这次导入会发生什么 ══════════\n");
  for (const c of picked) {
    const segs = plan.filter((p) => p.conv.key === c.key).length;
    const ur = plan.filter((p) => p.conv.key === c.key && p.seg.userBody).length;
    const sr = plan.filter((p) => p.conv.key === c.key && p.seg.selfBody).length;
    console.log(`  ${c.key}：${c.msgs.length} 条原始消息 → ${segs} 段对话 → ${ur + sr} 条记忆`);
    console.log(`      （对方 ${ur} 条 + 她自己 ${sr} 条）`);
  }
  console.log(`\n  总库会新增 ${msgTotal} 条原文（她的话也收，标成 self）`);
  console.log(`  闲聊圈会新增 ${memRows} 条记忆 = 对方 ${userRows} 条 + 她自己 ${selfRows} 条`);
  console.log(`  ⚠ 注意：问答是分开存的，所以条数比"一段一条"多。`);
  console.log(`    为什么分开：speaker 决定掉圈速度和配额统计，`);
  console.log(`    一条里混两个人，两边都算不准。`);
  console.log(`    两条的时间戳是一样的，所以查的时候能对上。`);
  console.log(`\n  时间处理：原文用真实时间排序；衰减从现在开始算。`);
  console.log(`  也就是说——三年前的记录导进来不会当天就烂掉。\n`);

  // ── 库里已有数据 → 提醒风险 ──
  const { Ringmind } = await import(`file://${ROOT}/src/index.js`);
  const db = new Ringmind(DB, "导入");
  let existing = 0;
  try {
    // overview().rings 是每圈各自的条数，不是总数
    const ov = db.overview();
    if (Array.isArray(ov?.rings)) {
      existing = ov.rings.reduce((n, r) => n + (Number(r.total) || 0), 0);
    } else if (typeof ov?.total === "number") {
      existing = ov.total;
    }
  } catch {}
  if (existing > 0) {
    console.log("  ⚠⚠ 注意：当前库里已经有 " + existing + " 条记忆。");
    console.log("      导入的内容会和它们混在一起，事后想分开不容易。");
    console.log("      如果你是想保留一份干净的历史，建议先新建一个库再导。\n");
  }

  // ── 容量测量：这些数据塞得下吗 ──
  let caps = { ring4: 0, ring5: 0, ring4Raw: 0, ring5Raw: 0 };
  try {
    const ov = db.overview();
    for (const r of ov?.rings ?? []) {
      if (r.id === "ring4") { caps.ring4 = Number(r.cap) || 0; caps.ring4Raw = Number(r.total) || 0; }
      if (r.id === "ring5") { caps.ring5 = Number(r.cap) || 0; caps.ring5Raw = Number(r.total) || 0; }
    }
  } catch {}

  const free = Math.max(0, caps.ring4 - caps.ring4Raw) + Math.max(0, caps.ring5 - caps.ring5Raw);
  // 问答分开存，所以真正写进去的是"记忆条数"，不是"对话段数"
  const need = memRows;

  console.log(`\n  ── 容量测量 ──`);
  console.log(`  这次要放进 ${need} 条记忆`);
  console.log(`  闲聊圈：已用 ${caps.ring4Raw} / 上限 ${caps.ring4}`);
  console.log(`  模糊圈：已用 ${caps.ring5Raw} / 上限 ${caps.ring5}`);
  console.log(`  两圈合计还能装 ${free} 段`);

  const overflow = need > free;
  if (overflow) {
    console.log(`\n  ⚠ 装不下：还差 ${need - free} 段。`);
    console.log(`    超出部分会被挤出两圈、掉到回忆圈（或直接被忘掉）。\n`);
    console.log(`  两个方案：`);
    console.log(`    A. 按时间顺序来 —— 老的先落回忆圈，新的占闲聊圈。什么都不改。`);
    console.log(`    B. 扩容 —— 把闲聊圈上限从 ${caps.ring4} 加到 ${caps.ring4 + (need - free)}，全部装下。`);
    console.log(`       （改的是这个库的设置，不改原件）\n`);
  }

  // ── 选方案 ──
  let mode = String(val("--overflow") || "").trim().toLowerCase();
  if (overflow && !has("--dry") && !has("--yes") && mode !== "a" && mode !== "b") {
    const ans = await ask("  选哪个？输入 a 按时间 / b 扩容 / 其他取消： ");
    mode = ans === "b" ? "b" : ans === "a" ? "a" : "";
    if (!mode) {
      console.log("\n  已取消，什么都没写。\n");
      db.close?.();
      return;
    }
  }
  if (overflow && mode === "b" && !has("--dry")) {
    const want = caps.ring4 + (need - free);
    try {
      db.updateConfig({ rings: { ring4: { cap: want } } });
      console.log(`  ✓ 闲聊圈上限已扩到 ${want}\n`);
    } catch (e) {
      console.log(`  ⚠ 扩容失败：${e.message}（继续按时间顺序导）\n`);
      mode = "a";
    }
  }

  if (has("--dry")) {
    console.log("  （--dry：到此为止，没有写库）\n");
    db.close?.();
    return;
  }

  if (!has("--yes")) {
    const a = await ask("  确认导入？输入 y 继续，其他任意键取消： ");
    if (a !== "y" && a !== "yes") {
      console.log("\n  已取消，什么都没写。\n");
      db.close?.();
      return;
    }
  }

  // ── 真写 ──
  const now = Date.now();
  let vOk = 0, mOk = 0, fail = 0;

  console.log("\n  正在写…");

  for (const c of picked) {
    for (const m of c.msgs) {
      try {
        db.store.addVault({
          ts: m.time,            // 真实历史时间
          source: c.source,
          // 她自己的话也进总库：不然她说过什么、答应过什么，事后全查不到
          speaker: m.isSelf ? "self" : "user",
          text: m.text,
          meta: JSON.stringify({ key: c.key, sender: m.sender, imported: true }),
        });
        vOk++;
      } catch {
        fail++;
      }
    }
  }

  for (const { conv, seg } of plan) {
    const tag = `【${spanOf(seg.from, seg.to)}｜${conv.source === "group" ? "群聊" : "私聊"}】`;
    // 问答分开存：speaker 决定掉圈速度（self 保留更久）和配额统计，
    // 一条里混两个人就不准了。两条时间戳相同，靠时间就能对上。
    const rows = [];
    if (seg.userBody) rows.push({ body: seg.userBody, speaker: "user", at: seg.from });
    if (seg.selfBody) rows.push({ body: seg.selfBody, speaker: "self", at: seg.from });
    for (const r of rows) {
      try {
        db.remember({
          content: (tag + r.body).slice(0, MAX_CHARS),
          ring: "ring4",          // 别人的智能体不一定记过重要消息，所以一律按默认放闲聊圈
          source: conv.source,
          speaker: r.speaker,
          at: r.at,               // 真实发生时间：保住顺序
          ringEnteredAt: now,     // 从现在开始淡：不然一进来就过期
          skipVault: true,        // 原文上面已经逐条写进总库了
        });
        mOk++;
      } catch (e) {
        fail++;
        if (fail <= 3) console.error(`    ✗ 写记忆失败：${e?.message ?? e}`);
      }
    }
  }

  console.log(`\n  ✓ 总库写入 ${vOk} 条`);
  console.log(`  ✓ 闲聊圈写入 ${mOk} 条`);
  if (fail) console.log(`  ✗ 失败 ${fail} 条`);
  console.log("");
  db.close?.();
}

main().catch((e) => {
  console.error("\n✗ 导入出错：" + (e?.stack || e?.message || e) + "\n");
  process.exit(1);
});