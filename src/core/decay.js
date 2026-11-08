/**
 * 环形的心 · 降级与遗忘
 *
 * 这是她"管不了"的那一半：
 *   时间到了 或 那一圈装满了 → 往外掉一圈，同时删掉一部分点
 *
 * 删点是确定性的：降级那一刻就定死，之后每次想起来的内容都一样。
 * 不然她每次说的"黄色汽车"细节都不同，就不像记忆了。
 */

import { RING_ORDER, RINGS, nextRingOf } from "./rings.js";
import { forgetOne, thinPointsForRing } from "./remember.js";

const DAY = 86400000;

/**
 * 算一轮降级计划（只读，不改数据）
 *
 * @returns {{ring:string, id:string, reason:string, to:string|null}[]}
 */
export function planDecay(store, config, now = Date.now()) {
  const plan = [];
  // selfSpeechWeight：**她自己的话存活时间是别人的 3 倍**（不是老得更快）。
  // 别人说的：ts < now - days*DAY；她自己说的：ts < now - days*selfW*DAY
  // 理由：她说出口的话带着立场和态度，比别人的闲话更该留住。
  const selfW = config.selfSpeechWeight ?? 3;

  for (const ringId of RING_ORDER) {
    if (ringId === "core") continue; // 圆心永不外出

    const cfg = config.rings?.[ringId] ?? {};
    const toRing = nextRingOf(ringId);

    // ① 时间到了
    if (cfg.days !== null && cfg.days !== undefined) {
      // 年龄从「进这一圈那天」算，不是从记忆创建那天算。
      // 不这样的话，一条圈一的老记忆掉进圈二时，圈二的 60 天早就超标了，
      // 会一口气连降四级、把缓冲圈直接跳过。
      const overdue = store.db
        .prepare(
          `SELECT id, speaker, ring_entered_at FROM memories
           WHERE ring = ?
             AND ring_entered_at < ?
             AND speaker != 'self'`
        )
        .all(ringId, now - cfg.days * DAY);

      const overdueSelf = store.db
        .prepare(
          `SELECT id, speaker, ring_entered_at FROM memories
           WHERE ring = ?
             AND ring_entered_at < ?
             AND speaker = 'self'`
        )
        .all(ringId, now - cfg.days * selfW * DAY);

      for (const m of [...overdue, ...overdueSelf]) {
        plan.push({ ring: ringId, id: m.id, reason: "time", to: toRing });
      }
    }

    // ② 装不下了
    if (cfg.cap) {
      const overflow = pickOverflow(store, ringId, cfg.cap, config.quota);
      for (const m of overflow) {
        plan.push({ ring: ringId, id: m.id, reason: "cap", to: toRing });
      }
    }
  }

  // 去重：同一条只降一次
  const seen = new Set();
  return plan.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
}

/**
 * 挑出要挤掉的记忆
 * 规则：先挤群聊（群聊有上限），再按最老的挤
 * 例外：回忆圈**随机**挤 —— 那里面已经没有"重要"可言了，
 *       按最老挤等于把早期记得的事先清光，不像人。
 */
function pickOverflow(store, ringId, cap, quota) {
  const total = store.countByRing(ringId);
  if (total <= cap) return [];

  const need = total - cap;

  // 回忆圈：随机挤
  if (ringId === "recall") {
    return store.db
      .prepare("SELECT id FROM memories WHERE ring = ? ORDER BY RANDOM() LIMIT ?")
      .all(ringId, need);
  }

  // 群聊配额：群聊记忆最多占一个圈的 60%，超了优先挤掉群聊的，给私聊留 40%。
  // **2026-10-29 确认：这个值保持原样，不调。**（见 docs/设计确认-2026-10-29.md 第六节）
  const groupCap = Math.floor(cap * (quota?.group ?? 0.6));
  const groupCount = store.countByRingAndSource(ringId, "group");

  const picked = [];
  const pickedIds = new Set();

  // ① 群聊超了就优先挤群聊。
  // 挤谁：先看被提起过几次（hits 越少越该走），同样少再看最后动过的时间，
  // 都没动过才看创建时间。**这是"最久没被提及"的真实含义**：
  // 一条天天被提起的老记忆不该因为创建得早就先走。
  if (groupCount > groupCap) {
    const n = Math.min(need, groupCount - groupCap);
    const rows = store.db
      .prepare(
        `SELECT id FROM memories WHERE ring = ? AND source = 'group'
         ORDER BY hits ASC, updated_at ASC, created_at ASC LIMIT ?`
      )
      .all(ringId, n);
    for (const r of rows) {
      picked.push(r);
      pickedIds.add(r.id);
    }
  }

  // ② 还不够就按"最久没被提及"走。
  // hits 少 = 没人提过 → 先走；hits 相同再看多久没动过；最后才看创建时间。
  // 跟"时间闸门"配合：时间闸门管的是多久没进过这一圈，这里管的是被提起的频率。
  if (picked.length < need) {
    const rest = need - picked.length;
    const rows = store.db
      .prepare(
        `SELECT id FROM memories WHERE ring = ?
         ORDER BY hits ASC, updated_at ASC, created_at ASC LIMIT ?`
      )
      .all(ringId, rest + picked.length);
    for (const r of rows) {
      if (picked.length >= need) break;
      if (pickedIds.has(r.id)) continue;
      picked.push(r);
      pickedIds.add(r.id);
    }
  }

  return picked;
}

/**
 * 执行降级
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun] 只算不写
 */
export function runDecay(store, config, { now = Date.now(), dryRun = false, via = null } = {}) {
  const plan = planDecay(store, config, now);
  if (dryRun) return { plan, applied: 0, forgotten: 0 };

  // 先让还在圈里待着的慢慢变淡，再处理到期的掉圈
  const softened = dryRun ? 0 : softenRings(store, config, now);

  let applied = 0;
  let forgotten = 0;

  for (const item of plan) {
    const mem = store.getMemory(item.id);
    if (!mem) continue;

    if (item.to) {
      demote(store, config, mem, item.to, item.reason, now);
      applied++;
    } else {
      // 已经没有下一圈了 = 真的忘了
      forgetOne(store, config, item.id);
      forgotten++;
    }
  }

  // 每次真跑都要留一条，哪怕一条都没动。
  // 只记"有变动"的那次，日志里就分不出"没跑"和"跑了没动" ——
  // 问她"上次整理是什么时候"会答不上来，而这是她最想知道的一件事。
  store.logOp("decay", { applied, forgotten, softened, at: now, ...(via ? { via } : {}) });

  return { plan, applied, forgotten, softened };
}

/**
 * 还没到期的记忆，也会随着日子一点点变淡
 *
 * 现在只有四圈 · 闲聊圈会：进圈什么都记得，每天淡一点，
 * 待满那天正好剩八成。别的圈没有 visibleEnd，不动。
 *
 * @returns {number} 这次动过几条
 */
function softenRings(store, config, now = Date.now()) {
  let touched = 0;

  for (const ring of RING_ORDER) {
    if (RINGS[ring]?.visibleEnd === undefined) continue; // 这一圈不渐变

    const days = config.rings?.[ring]?.days ?? RINGS[ring]?.days;
    if (!days || days <= 0) continue;

    const mems = store.listByRing(ring, 1_000_000);
    // 第一天满格，待满那天正好到 visibleEnd —— 所以分母是 (天数 - 1)
    // 闲聊圈 5 天：第 1 天 100%、第 2 天 95%、第 3 天 90%、第 4 天 85%、第 5 天 80%
    const span = Math.max(1, days - 1);
    for (const m of mems) {
      const enteredAt = m.ring_entered_at ?? m.created_at ?? now;
      const progress = Math.min(1, Math.max(0, (now - enteredAt) / (span * DAY)));
      if (progress <= 0) continue;
      thinPointsForRing(store, config, m.id, ring, progress);
      touched++;
    }
  }

  return touched;
}

/**
 * 把一条记忆挪到下一圈，并按新圈的比例删点
 */
function demote(store, config, mem, toRing, reason = "time", at = Date.now()) {
  const fromRing = mem.ring;
  // 换圈时把进圈时间一起重置 —— 新的一圈从现在开始倒计时
  store.moveRing(mem.id, toRing, at);

  const n = store.listPoints(mem.id).length;
  // 削点逻辑和"刚记进去那一刻"共用同一份，别两处各写一遍
  const r = thinPointsForRing(store, config, mem.id, toRing);

  store.logOp("demote", {
    id: mem.id,
    from: fromRing,
    to: toRing,
    reason,
    before: n,
    after: r.kept,
    buffered: r.buffered,
  });
}

/**
 * 看一眼每个圈现在什么状况（面板用）
 */
export function ringStats(store) {
  const out = {};
  for (const id of RING_ORDER) {
    const total = store.countByRing(id);
    const group = store.countByRingAndSource(id, "group");
    out[id] = { total, private: total - group, group };
  }
  return out;
}