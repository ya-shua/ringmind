/**
 * 环形的心 · 自动入库（把聊天消息写进闲聊圈）
 *
 * 为什么单独一个文件：
 * ────────────────
 * 「一条消息算不算同一段对话」这个判断，以前只活在 server/ingest-server.mjs 里，
 * 结果只要入口换成别的（海螺走 MCP 的 ring_ingest、bridge 走自己的路），
 * 合并规则就不见了 —— 一次语音合成一条记忆，54 条工具回执把库塞满。
 *
 * 所以规则搬到这里，**所有自动入库的入口都调这一个函数**：
 *   server/ingest-server.mjs（HTTP）· mcp/server.mjs 的 ring_ingest（MCP）
 *
 * 注意：她主动记的（ring_remember）不走这里。她说"记住这个"就是一条，
 * 不该被合并成一段。
 *
 * 判据（五条，缺一条就不是同一段对话）
 * ────────────────────────────────────
 *   ① 同一个聊天       slot 里带 convKey（private:1234 / group:5678）
 *   ② 同一个发言方     slot 末位是 0/1，她和别人各自成段，不混进同一条
 *   ③ 时间不回溯       at 比上一句早 → 宁可新开一条，否则补录历史顺序全乱
 *   ④ 间隔 ≤ gapMs     默认 90 秒：停了一会儿就是换话题了
 *   ⑤ 本段 ≤ mergeWindowMs  默认 5 分钟，从首句算：聊再久也不能无限长
 *
 * 前三版的历史：v1.3.0 只有 ⑤ 和不回溯（一段闲聊拼成 814 字）；
 * v1.4.0 加 ④，同一天最长降到 145 字。
 */

import { remember, autoSplit } from "./remember.js";

export const INGEST_DEFAULTS = {
  ring: "ring4",
  gapMs: 90_000, // 相邻两条隔超过这么久就断
  mergeWindowMs: 300_000, // 一段对话最长多久（从第一条算起）
};

/**
 * 一条消息入库
 *
 * @param {import("../store/db.js").Store} store
 * @param {object} config
 * @param {object} msg
 * @param {string} msg.content            这条消息的正文（别人的语音就是「[语音]」占位）
 * @param {"private"|"group"} [msg.source]
 * @param {"user"|"self"} [msg.speaker]   self = 她自己说的（存活时间 ×3）
 * @param {number} [msg.at]               真实发生时间（毫秒）
 * @param {string[]} [msg.points]         拆好的点；不传就按标点自动切
 * @param {string} [msg.note]             批注（语音转写、存疑内容）
 * @param {boolean} [msg.noteSuspect]     note 是"可能不准"的（转写）
 * @param {string} [msg.messageId]        来源消息 id —— 幂等用，重复投递不再写
 * @param {string} [msg.convKey]          哪个聊天（默认取 source，够用了）
 * @param {string} [msg.ring]
 * @param {boolean} [msg.skipVault]       默认 true：原文由调用方逐条进总库
 * @returns {{action:"new"|"append"|"duplicate", id:string, content:string}}
 */
export function ingestMessage(store, config, msg = {}) {
  const text = String(msg.content ?? "").trim();
  if (!text) throw new Error("content 不能为空");

  const at = Number(msg.at ?? Date.now());
  if (!Number.isFinite(at) || at <= 0) throw new Error(`发生时间不对: ${msg.at}`);

  const speaker = msg.speaker === "self" ? "self" : "user";
  const source = msg.source === "group" ? "group" : "private";
  const ring = msg.ring ?? INGEST_DEFAULTS.ring;
  const gapMs = Number(config?.ingest?.gapMs ?? INGEST_DEFAULTS.gapMs);
  const mergeWindowMs = Number(config?.ingest?.mergeWindowMs ?? INGEST_DEFAULTS.mergeWindowMs);

  // ── 幂等：同一条消息重复投递，返回原来那条，不再写 ──
  // 不做文本去重：连发十次「在吗」是十件事，不是同一件。
  // 查 seen_messages（不是 memories.message_id）—— 合并进来的那句不单独占一行，
  // 只看 memories 的话它重发时会被再并一遍。
  if (msg.messageId) {
    const seen = store.seenMessage(msg.messageId);
    if (seen) {
      const mem = store.getMemory(seen.memory_id);
      return { action: "duplicate", id: seen.memory_id, content: mem?.content ?? "" };
    }
  }

  // ── ①② 槽位：同一个聊天 + 同一个发言方 ──
  const slot = (msg.convKey || source) + "|" + (speaker === "self" ? "1" : "0");
  const prev = store.getConvState(slot);

  // ── ③④⑤ 时间三条 ──
  const sameConvo =
    !!prev &&
    at >= prev.last_ts && // ③ 不回溯
    at - prev.last_ts <= gapMs && // ④ 间隔
    at - prev.first_ts <= mergeWindowMs; // ⑤ 本段总长

  if (sameConvo) {
    const mem = store.getMemory(prev.memory_id);
    if (mem) {
      const extraPoints = Array.isArray(msg.points) && msg.points.length
        ? msg.points.map((p) => String(p).trim()).filter(Boolean)
        : autoSplit(text);
      const updated = store.appendToMemory(prev.memory_id, text, extraPoints);
      if (msg.note) store.appendMemoryNote(prev.memory_id, msg.note, msg.noteSuspect);
      store.setConvState(slot, prev.memory_id, prev.first_ts, at);
      store.markSeen(msg.messageId, prev.memory_id, at);
      return { action: "append", id: prev.memory_id, content: updated?.content ?? mem.content };
    }
    // 游标指着的记忆没了（被清理/换库）→ 当新的一条处理，别硬往里塞
  }

  const mem = remember(store, config, {
    content: text,
    ring,
    source,
    speaker,
    at,
    points: msg.points,
    note: msg.note,
    noteSuspect: msg.noteSuspect,
    messageId: msg.messageId,
    // 原文由调用方逐条进总库；工具产出连总库都不进
    skipVault: msg.skipVault !== false,
  });
  store.setConvState(slot, mem.id, at, at);
  store.markSeen(msg.messageId, mem.id, at);
  return { action: "new", id: mem.id, content: mem.content };
}

/** 面板/调试用：现在这段对话的窗口配置长什么样 */
export function ingestWindowOf(config) {
  return {
    gapMs: Number(config?.ingest?.gapMs ?? INGEST_DEFAULTS.gapMs),
    mergeWindowMs: Number(config?.ingest?.mergeWindowMs ?? INGEST_DEFAULTS.mergeWindowMs),
  };
}