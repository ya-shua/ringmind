/**
 * 环形的心 · 想起来
 *
 * 被提醒的时候，能捞回多少，取决于两件事：
 *   1. 提示命中了几个钩子、这些钩子有多重要  → 决定捞回比例
 *   2. 那条记忆所在圈的天花板                → 圈四 90%，圈五 70%，回忆圈 0
 *
 * 天花板永远到不了 100%，所以"被提醒了也想不全"是这个系统的默认状态。
 */

import { hookWeights, maybePromote } from "./remember.js";
import { bufferRatioOf, visibleRatioOf, RINGS } from "./rings.js";

/**
 * 她想起某件事
 *
 * @param {object} store
 * @param {object} config
 * @param {string|string[]} cues 提示词，可以是几个关键词
 * @param {object} [opts]
 * @param {number} [opts.limit] 最多返回几条
 * @param {number} [opts.now] 当前时刻（测试要能控）
 * @returns {Array} 想起来的记忆
 */
export function recall(store, config, cues, { limit = 5, now = Date.now() } = {}) {
  const cueList = (Array.isArray(cues) ? cues : [cues])
    .map((c) => String(c ?? "").trim())
    .filter(Boolean);

  if (cueList.length === 0) return [];

  // 元记忆：她知不知道自己忘了。
  // 永不忘模式一个点都不会少，给「缺口」没有意义 —— 所以强制不生效，
  // 哪怕配置里 metaMemory 是开着的。
  const metaOn = !!config.metaMemory && config.mode !== "never-forget";

  // ① 找候选：钩子匹配 + 内容匹配
  const candidates = new Map();
  for (const cue of cueList) {
    for (const m of store.findByPoint(cue)) candidates.set(m.id, m);
    for (const m of store.findByContent(cue, limit * 6)) candidates.set(m.id, m);
  }

  if (candidates.size === 0) return [];

  // ② 逐条算"这次能想起多少"
  const results = [];
  for (const mem of candidates.values()) {
    const pts = store.listPoints(mem.id);
    if (pts.length === 0) {
      results.push({
        id: mem.id,
        content: mem.content,
        ring: mem.ring,
        ringLabel: RINGS[mem.ring]?.label ?? mem.ring,
        points: [],
        recovered: 0,
        hitWeight: 0,
        ceiling: bufferRatioOf(mem.ring, config) ?? 0,
      });
      continue;
    }

    // 每个点按位置有固定权重，命中哪些就把它们的权重加起来
    const weights = hookWeights(pts.length);
    let hitWeight = 0;
    let hitCount = 0;

    pts.forEach((p, i) => {
      if (cueList.some((cue) => p.text.includes(cue) || cue.includes(p.text))) {
        hitWeight += weights[i];
        hitCount++;
      }
    });

    // 内容命中但钩子没命中，给一点底
    if (hitCount === 0) {
      const contentHit = cueList.some((cue) => mem.content.includes(cue));
      if (!contentHit) continue;
      hitWeight = 0.15;
    }

    // ③ 天花板：这一圈最多能捞回多少（以原文为标尺，不叠乘）
    const ceiling = bufferRatioOf(mem.ring, config) ?? 0;
    const baseVisible = visibleRatioOf(mem.ring, config);

    // 能看到的比例 = 原本能看到的 与 命中权重 取大，但不超过天花板
    const ratio = Math.min(Math.max(baseVisible, hitWeight), Math.max(baseVisible, ceiling));

    const targetCount = Math.min(pts.length, Math.round(pts.length * ratio));

    // ④ 在已可见的基础上，把缓冲圈里的点捞回来
    const visiblePts = pts.filter((p) => p.visible);
    const missing = Math.max(0, targetCount - visiblePts.length);
    const bufferedPts = pts.filter((p) => p.buffered && !p.visible);
    const recoveredPts = bufferedPts.slice(0, missing);

    const shown = [...visiblePts, ...recoveredPts].sort((a, b) => {
      const wa = a.weight == null ? 999 : a.weight;
      const wb = b.weight == null ? 999 : b.weight;
      return wa - wb;
    });

    const item = {
      id: mem.id,
      content: mem.content,
      ring: mem.ring,
      ringLabel: RINGS[mem.ring]?.label ?? mem.ring,
      points: shown.map((p) => p.text),
      recovered: recoveredPts.length, // 这次额外想起来的
      hitWeight: Number(hitWeight.toFixed(3)),
      ceiling,
      ratio: Number(ratio.toFixed(3)),
    };

    // 元记忆：告诉她「这条原本有几个点、这次想起几个、还剩几个没想起来」。
    // 有了这个她才说得出「我总觉得有件事想不起来了」——
    // 没有它，她只知道想起了什么，不知道还缺什么。
    if (metaOn) {
      item.gap = {
        total: pts.length,
        shown: shown.length,
        missing: Math.max(0, pts.length - shown.length),
      };
    }

    results.push(item);
  }

  // ⑤ 命中最多的排前面
  results.sort((a, b) => b.hitWeight - a.hitWeight || b.recovered - a.recovered);

  const top = results.slice(0, limit);

  // 她想起这些之后，命中数 +1；圈四、圈五攒够了会不知不觉往回游一圈（D3）
  // 注意：升圈不还点 —— 已经掉掉的细节不会因为"提得多"回来
  for (const r of top) {
    if (r.recovered > 0) {
      store.bumpHits(r.id);
      const to = maybePromote(store, config, r.id, now);
      if (to) r.promotedTo = to;
    }
  }


  // ⑥ 总库：只有面板上明确打开了才翻原始存档
  //    总库存的是每条聊天的原文，翻出来等于把已经忘掉的又摊回她面前 —— 所以默认关着。
  //    只在线索够具体（≥3 字）时才翻，且按「命中几条线索」排，避免被「私聊」这种词灌满。
  //    只有「自定义」模式才真的接进来 —— 三档固定模式退回只存标记，她翻不到原文。
  if (
    config.mode === "custom" &&
    config.vaultAccessible === true &&
    typeof store.searchVault === "function"
  ) {
    const seen = new Set(top.map((r) => String(r.content ?? "").trim()));
    const hitsByRow = new Map(); // row.id -> { row, n }
    for (const cue of cueList) {
      for (const row of store.searchVault(cue, 12)) {
        const cur = hitsByRow.get(row.id) || { row, n: 0, chars: 0 };
        cur.n += 1;
        cur.chars += cue.length;
        hitsByRow.set(row.id, cur);
      }
    }
    // 线索总字数不到 3 就别翻：单靠「黄色」「私聊」这种词，翻出来的全是噪音
    const ranked = [...hitsByRow.values()]
      .filter((x) => x.chars >= 3)
      .sort((a, b) => b.n - a.n || (b.row.ts || 0) - (a.row.ts || 0));
    const extra = [];
    const cap = Math.min(3, limit);
    for (const { row } of ranked) {
      if (extra.length >= cap) break;
      const text = String(row.text ?? "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      extra.push({
        id: "vault:" + row.id,
        content: text,
        ring: "vault",
        ringLabel: "总库（原始记录）",
        points: [text],
        recovered: 0,
        hitWeight: 0,
        ceiling: 1,
        ratio: 1,
        fromVault: true,
        vaultTs: row.ts ?? null,
        vaultSpeaker: row.speaker ?? null,
        vaultSource: row.source ?? null,
      });
    }
    if (extra.length) return [...top, ...extra];
  }

  return top;
}

/**
 * 纯搜索（给面板用，不参与"想起来"的机制）
 */
export function searchMemory(store, config, keyword, { ring = null, limit = 50 } = {}) {
  const kw = String(keyword ?? "").trim();

  // 没给关键词也能查：选了圈铺这一圈，什么都不选就铺全部，按时间倒序
  if (!kw) {
    const rows = ring
      ? store.db
          .prepare(`SELECT * FROM memories WHERE ring = ? ORDER BY created_at DESC LIMIT ?`)
          .all(ring, limit)
      : store.db
          .prepare(`SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`)
          .all(limit);
    return rows.map((m) => ({
      ...m,
      ringLabel: RINGS[m.ring]?.label ?? m.ring,
      points: store.listPoints(m.id).map((p) => ({
        text: p.text,
        visible: !!p.visible,
        buffered: !!p.buffered,
      })),
    }));
  }

  let rows;
  if (ring) {
    rows = store.db
      .prepare(
        `SELECT * FROM memories WHERE ring = ? AND content LIKE ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(ring, `%${kw}%`, limit);
  } else {
    rows = store.findByContent(kw, limit);
  }

  return rows.map((m) => ({
    ...m,
    ringLabel: RINGS[m.ring]?.label ?? m.ring,
    points: store.listPoints(m.id).map((p) => ({
      text: p.text,
      visible: !!p.visible,
      buffered: !!p.buffered,
    })),
  }));
}

/**
 * 把一条记忆完整摊开（面板里点开看）
 */
export function inspectMemory(store, config, memoryId) {
  const mem = store.getMemory(memoryId);
  if (!mem) return null;

  const pts = mem.points ?? [];
  const visible = pts.filter((p) => p.visible).length;
  const buffered = pts.filter((p) => p.buffered && !p.visible).length;

  return {
    ...mem,
    ringLabel: RINGS[mem.ring]?.label ?? mem.ring,
    totalPoints: pts.length,
    visiblePoints: visible,
    bufferedPoints: buffered,
    lostPoints: pts.length - visible - buffered,
    ceiling: bufferRatioOf(mem.ring, config) ?? 0,
  };
}