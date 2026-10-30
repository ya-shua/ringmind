/**
 * 环形的心 · 记忆海（数据层）
 *
 * 把整座库画成一片三维星海：每颗星是一条记忆，圈是同心球壳。
 * 跟 3d-memory-sea 的差别在这里 —— 那边是自由散点，这边位置本身就是设计：
 *
 *   1. 圈就是轨道。core 在圆心，一二三圈往外一层层排，
 *      闲聊 / 模糊 / 回忆圈在最外面 —— 九个位置直接画成九条轨道。
 *   2. 「往外掉」画进位置里。同一圈里，刚进来的星贴着内侧，
 *      待得越久越往壳外缘漂 —— 掉圈之前，位置先掉。
 *   3. 「越来越暗」画进亮度里。亮度取该圈在当前模式下的可见比例
 *      （走 rings.js 的 visibleRatioOf，闲聊圈按待的时间逐日变淡）。
 *      永不忘模式下整片海都会亮起来 —— 模式不是抽象配置，看得见。
 *   4. 连线 = 相似度。共享同一个钩子的两条记忆连线最粗，
 *      其次是原文用词重合（中文 bigram）。每颗星最多 6 条，不全连。
 *
 * 只读。海不改任何数据 —— 它是面板（人）的上帝视角，
 * 亮度做了下限处理，否则回忆圈在遗忘模式下你一颗星都看不见。
 *
 * 输出只有一个 JSON：sea.html 只认它，跟面板的 /api/ 一样。
 */

import { RING_ORDER, RINGS, MODES, visibleRatioOf, bufferRatioOf } from "../core/rings.js";

const DAY = 86400000;

/** 每条轨道的半径范围 [内缘, 外缘]（世界单位，跟渲染端约定好的） */
export const SEA_ORBITS = {
  core:   [52, 68],  // 心体半径约 17、光晕 30 多：圆心的星再往外挂一档，心和星之间留出实打实的暗隙
  ring1:  [84, 136],
  ring2:  [164, 216],
  ring3:  [244, 296],
  ring4:  [324, 376],
  ring5:  [410, 470],
  recall: [490, 600],
  vault:  [640, 760],
};

/** 面板同款配色（preview.html :root 里的 --c-*） */
export const SEA_COLORS = {
  core:   "#ffd479",
  ring1:  "#ffa079",
  ring2:  "#ff7fa8",
  ring3:  "#b98cff",
  ring4:  "#6fa8ff",
  ring5:  "#4a7fd4",
  recall: "#2f5488",
  vault:  "#8ba4c9",
};

/** 图例短名 */
const SHORT = { core: "圆心", ring1: "一圈", ring2: "二圈", ring3: "三圈", ring4: "闲聊", ring5: "模糊", recall: "回忆", vault: "总库" };

/** 她看得见的圈（提示词、文案里不出 ring4/ring5/recall 的名字，这条规矩海也遵守：只在「她看不见」这个标记里体现） */
const SHE_SEES = new Set(["core", "ring1", "ring2", "ring3"]);

/** 亮度下限：面板是人的上帝视角，全黑就没法看了 */
const ALPHA_FLOOR = 0.35;

/** 相似度连线的参数（跟 3d-memory-sea 的 maxNeighbors/minEdgeScore 同名同义） */
const MAX_NEIGHBORS = 6;
const MIN_EDGE_SCORE = 0.17;
const MAX_EDGES = 4000;
/** 一个 bigram 出现在超过这么多条记忆里就不再拉连线（「今天」「哈哈」这种词） */
const POSTING_LIMIT = 240;

// ── 确定性随机：同一条记忆，每次重建都在同一个位置 ──────────

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 均匀球面方向（Marsaglia） */
function sphereDir(rng) {
  const u = rng() * 2 - 1;
  const t = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - u * u));
  return { x: r * Math.cos(t), y: u, z: r * Math.sin(t) };
}

// ── 文本相似度：中文 bigram + 钩子精确命中 ─────────────────

/** 去掉标点空白后取相邻字符对。「大汽车」→ 大汽 / 汽车 */
function bigramsOf(text) {
  const clean = String(text || "").replace(/[\s\p{P}\p{S}]+/gu, "");
  const out = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

/**
 * 建倒排索引：token → 记忆下标。
 * 钩子文本权重 3（整词命中是强信号），原文 bigram 权重 1。
 * 返回 Map<"i:j", {s, h}>：s = 共享 bigram 数，h = 共享钩子数
 */
function pairScores(stars) {
  const posting = new Map(); // token → { w, ids[] }
  for (let i = 0; i < stars.length; i++) {
    const st = stars[i];
    for (const h of st.hooks) {
      const key = "␟" + h.text;
      let e = posting.get(key);
      if (!e) posting.set(key, (e = { w: 3, ids: [] }));
      e.ids.push(i);
    }
    const seen = new Set();
    for (const g of bigramsOf(st.content)) {
      if (seen.has(g)) continue;
      seen.add(g);
      let e = posting.get(g);
      if (!e) posting.set(g, (e = { w: 1, ids: [] }));
      e.ids.push(i);
    }
  }

  const pairs = new Map();
  for (const [tok, e] of posting) {
    // 钩子是整词，不怕人多；bigram 太常见就不拉线了
    if (e.ids.length < 2 || e.ids.length > (e.w > 1 ? Infinity : POSTING_LIMIT)) continue;
    const hook = e.w > 1;
    for (let a = 0; a < e.ids.length; a++) {
      for (let b = a + 1; b < e.ids.length; b++) {
        const i = e.ids[a], j = e.ids[b];
        const key = i < j ? i + ":" + j : j + ":" + i;
        let p = pairs.get(key);
        if (!p) pairs.set(key, (p = { s: 0, h: 0 }));
        hook ? p.h++ : p.s++;
      }
    }
  }
  // token 上记不下 bigram 属于哪条记忆的词表大小，dice 在打分时用星级 bigram 数现算
  return { pairs, sizes: stars.map((st) => st._grams) };
}

function edgeScore(p, i, j, sizes) {
  const dice = (2 * p.s) / (sizes[i] + sizes[j]); // 2|A∩B| / (|A|+|B|)
  return Math.min(1, 0.42 * p.h + 0.55 * dice);
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 建一片海
 * @param {import("../store/db.js").Store} store
 * @param {object} config Ringmind 的配置（db.getConfig()）
 * @param {object} [opts]
 * @param {number} [opts.now]                          当前时刻（测试里能拨表）
 * @param {boolean} [opts.vault]                       是否把总库画成幻影（默认关，总库可能很大）
 * @param {number} [opts.vaultMax]                     幻影最多取多少条（最近者优先）
 */
export function buildSeaScene(store, config, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const wantVault = !!opts.vault;
  const vaultMax = Math.max(0, Math.min(2000, Number(opts.vaultMax) || 400));
  const mode = MODES[config?.mode] ?? MODES.forget;

  const stars = [];

  for (const ringId of RING_ORDER) {
    const rows = store.listByRing(ringId, 100000);
    const [rMin, rMax] = SEA_ORBITS[ringId];
    const days = Number(config?.rings?.[ringId]?.days ?? RINGS[ringId]?.days ?? 0) || 0;

    for (const row of rows) {
      const pts = store.listPoints(row.id); // 已按 weight 排好：1 = 最看重，NULL 靠后
      const alive = [];
      const lost = [];
      pts.forEach((p, ord) => {
        (p.visible ? alive : lost).push({ ord, text: p.text, weight: p.weight, buffered: !!p.buffered });
      });

      // 待在这圈多久了（0~1）：越老越靠外缘。升圈 / 钉住会重置进圈时间，位置自然往回跳
      const stayed = Math.max(0, now - (row.ring_entered_at || row.created_at || now));
      const progress = days > 0 ? Math.min(1, stayed / (days * DAY)) : 0;

      // 进圈那一刻的可见比例（闲聊圈会带 progress 逐日变淡，其余圈不受 progress 影响）
      const ratio = visibleRatioOf(ringId, config, progress);
      const alpha = Math.min(1, ALPHA_FLOOR + (1 - ALPHA_FLOOR) * ratio);

      const rng = mulberry32(hash32(String(row.id)));
      // 圆心的星挂在赤道面（跟轨道椭圆同平面）：绕着心转，投影距离有下限，不会叠到心上
      const dir = ringId === "core"
        ? (() => { const a = rng() * Math.PI * 2; return { x: Math.cos(a), y: 0, z: Math.sin(a) }; })()
        : sphereDir(rng);

      // 位置：壳内缘 → 外缘按待的时间线性外漂，叠一点点确定性抖动
      const jitter = (rng() - 0.5) * 12;
      let r = rMin + (rMax - rMin) * progress + jitter;
      if (ringId === "recall") r += (rng() - 0.5) * 50; // 回忆圈顺序本来就乱

      // 海是扁的：压 y 在「选方向」这一步做（压完再归一化），落位后不再缩 ——
      // 每颗星到圆心的距离严格等于 r，轨道的内外缘才言之有物
      const squash = ringId === "recall" ? 0.45 : 0.78; // 回忆圈塌得最狠
      const vy = dir.y * squash;
      const vlen = Math.hypot(dir.x, vy, dir.z) || 1;

      const nAlive = alive.length;
      const size = 2.2 + 0.85 * Math.sqrt(nAlive) + (row.pinned ? 1.8 : 0);

      stars.push({
        id: row.id,
        ring: ringId,
        short: SHORT[ringId],
        color: SEA_COLORS[ringId],
        content: row.content ?? "",
        source: row.source,
        speaker: row.speaker,
        pinned: !!row.pinned,
        hits: row.hits ?? 0,
        emotion: row.emotion ?? 0,
        createdAt: row.created_at,
        enteredAt: row.ring_entered_at || row.created_at,
        progress,
        hooks: alive.map((p) => ({ ord: p.ord, text: p.text, weight: p.weight, buffered: p.buffered })),
        lost: lost.map((p) => ({ ord: p.ord, text: p.text, buffered: p.buffered })),
        nAlive,
        nTotal: pts.length,
        size: Math.round(size * 100) / 100,
        alpha: Math.round(alpha * 1000) / 1000,
        // 渲染端用的坐标（此处就定死，前端只管转）
        x: Math.round((dir.x / vlen) * r * 100) / 100,
        y: Math.round((vy / vlen) * r * 100) / 100,
        z: Math.round((dir.z / vlen) * r * 100) / 100,
        _grams: 0,
      });
    }
  }

  // 每条记忆自己的 bigram 数（dice 的分母），顺手存给打分用
  for (const st of stars) st._grams = bigramsOf(st.content).length;

  // ── 连线：共享钩子 > 用词重合，每星最多 6 条 ──────────────
  const { pairs, sizes } = pairScores(stars);
  const deg = new Array(stars.length).fill(0);
  const candidates = [];
  for (const [key, p] of pairs) {
    const ci = key.indexOf(":");
    const i = Number(key.slice(0, ci));
    const j = Number(key.slice(ci + 1));
    const score = edgeScore(p, i, j, sizes);
    if (score >= MIN_EDGE_SCORE) candidates.push({ i, j, score });
  }
  candidates.sort((a, b) => b.score - a.score);

  const edges = [];
  for (const c of candidates) {
    if (edges.length >= MAX_EDGES) break;
    if (deg[c.i] >= MAX_NEIGHBORS || deg[c.j] >= MAX_NEIGHBORS) continue;
    deg[c.i]++;
    deg[c.j]++;
    edges.push({ a: stars[c.i].id, b: stars[c.j].id, score: Math.round(c.score * 1000) / 1000 });
  }
  for (const st of stars) delete st._grams;

  // ── 总库幻影：她的原始存档，海里只是一层几乎看不见的雾 ────
  let ghosts = [];
  let vaultCount = 0;
  try {
    vaultCount = store.vaultCount();
    if (wantVault && vaultCount > 0) {
      const rows = store.listVault(vaultMax);
      ghosts = rows.map((row) => {
        const rng = mulberry32(hash32("vault:" + row.id));
        const dir = sphereDir(rng);
        const [rMin, rMax] = SEA_ORBITS.vault;
        const r = rMin + (rMax - rMin) * rng();
        const g = 0.10 + rng() * 0.08;
        return {
          id: "v" + row.id,
          ring: "vault",
          short: SHORT.vault,
          color: SEA_COLORS.vault,
          content: row.text ?? "",
          source: row.source ?? null,
          speaker: row.speaker ?? null,
          pinned: false,
          hits: 0,
          emotion: 0,
          createdAt: row.ts,
          enteredAt: row.ts,
          progress: 0,
          hooks: [],
          lost: [],
          nAlive: 0,
          nTotal: 0,
          size: 1.5,
          alpha: Math.round(g * 1000) / 1000,
          x: Math.round(dir.x * r * 100) / 100,
          y: Math.round(dir.y * r * 100) / 100, // 总库不压扁：球壳的里外边界才干净，不会掉进回忆圈轨道
          z: Math.round(dir.z * r * 100) / 100,
        };
      });
    }
  } catch {
    /* 老库没有 vault 表也别让海沉了 */
  }

  const perRing = {};
  let alivePts = 0, totalPts = 0;
  for (const st of stars) {
    perRing[st.ring] = (perRing[st.ring] || 0) + 1;
    alivePts += st.nAlive;
    totalPts += st.nTotal;
  }

  return {
    generatedAt: now,
    mode: config?.mode ?? "forget",
    modeLabel: mode.label,
    metaMemory: !!config?.metaMemory && config?.mode !== "never-forget",
    rings: [
      ...RING_ORDER.map((id) => {
        const [rMin, rMax] = SEA_ORBITS[id];
        return {
          id,
          label: RINGS[id]?.label ?? id,
          desc: RINGS[id]?.desc ?? "",
          short: SHORT[id] ?? id,
          color: SEA_COLORS[id],
          radius: Math.round((rMin + rMax) / 2),
          days: config?.rings?.[id]?.days ?? RINGS[id]?.days ?? null,
          cap: config?.rings?.[id]?.cap ?? RINGS[id]?.cap ?? null,
          sheSees: SHE_SEES.has(id),
          visibleRatio: visibleRatioOf(id, config),
          buffer: bufferRatioOf(id, config),
          count: perRing[id] || 0,
        };
      }),
      {
        id: "vault",
        label: "数据总库",
        short: SHORT.vault,
        color: SEA_COLORS.vault,
        radius: Math.round((SEA_ORBITS.vault[0] + SEA_ORBITS.vault[1]) / 2),
        days: null,
        cap: null,
        sheSees: false,
        visibleRatio: null,
        buffer: null,
        count: vaultCount,
      },
    ],
    stats: {
      memories: stars.length,
      pointsAlive: alivePts,
      pointsTotal: totalPts,
      edges: edges.length,
      vault: vaultCount,
    },
    points: stars,
    ghosts,
    edges,
  };
}
