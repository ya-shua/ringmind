/**
 * 环形的心 · 记一件事
 *
 * 这是她唯一能主动做的事：决定记什么、放哪一圈、哪些点最要紧。
 * 她只负责"排序"，权重由系统按位置算出来，不让她填数字。
 */

import { RING_ORDER, visibleRatioOf, bufferRatioOf } from "./rings.js";

let counter = 0;

/** 生成一个不会撞车的记忆编号 */
export function newMemoryId() {
  counter = (counter + 1) % 46656;
  const t = Date.now().toString(36);
  const c = counter.toString(36).padStart(3, "0");
  return `m_${t}_${c}`;
}

/**
 * 按排序位置算权重
 *
 * 她给的是顺序（第 1 个最重要），不是数字。
 * 3 个钩子 → 50% / 33% / 17%
 *
 * @param {number} n 钩子个数
 * @returns {number[]} 权重数组，和为 1
 */
export function hookWeights(n) {
  if (n <= 0) return [];
  const total = (n * (n + 1)) / 2;
  return Array.from({ length: n }, (_, i) => (n - i) / total);
}

/**
 * 记一件事
 *
 * @param {import("../store/db.js").Store} store
 * @param {object} config
 * @param {object} input
 * @param {string} input.content        用点串起来的一句话
 * @param {string} [input.ring]         放哪一圈，默认圈四
 * @param {string[]} [input.points]     按重要性排序的点，越前越重要
 * @param {number} [input.emotion]      0..10
 * @param {"private"|"group"} [input.source]
 * @param {"user"|"self"} [input.speaker]
 * @param {boolean} [input.pinned]      她钉住的（强制进圆心）
 * @param {number} [input.at]           发生时间，默认现在
 * @param {number} [input.ringEnteredAt] 进圈时间，默认等于 at。
 *        导入历史数据时用：at 留真实历史时间（保住顺序），
 *        ringEnteredAt 给现在（从这个时刻才开始衰减）。
 * @param {string} [input.importBatch]  导入批次标记。面板导入的才标，
 *        有了它整批可撤回；日常记住的不传，保持 NULL。
 */
export function remember(store, config, input) {
  const {
    content = "",
    points = [],
    emotion = 0,
    source = "private",
    speaker = "user",
    pinned = false,
    at = Date.now(),
    ringEnteredAt,
  } = input ?? {};

  if (!content && points.length === 0) {
    throw new Error("记一件空事没意义：content 和 points 至少要有一个");
  }

  // 她拆了就用她拆的；没拆就替她按标点切成要点。
  // 只切格式，不改她的字、不替她总结 —— 内容永远是她的。
  // 切出来的顺序 = 她说的顺序，先说的重要；她以后可以重排。
  const cleanPoints = points.length
    ? points
        .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
        .map((s) => s.trim())
        .filter(Boolean)
    : autoSplit(content);

  // 钉住的只能进圆心；其余放哪圈她说了算。
  // 没说 / 不表态 → 默认落 ring4。**这不是"不要了"，是按最轻的待遇存**：
  // ring4 是接盘层，她看不见它；因为刚发生所以还完整记得（缓冲圈满格），
  // 5 天逐日淡之后才掉进 ring5 开始真忘。（2026-10-29 定，见 docs/设计确认-2026-10-29.md）
  let ring = input.ring ?? "ring4";
  if (pinned) ring = "core";
  if (!RING_ORDER.includes(ring)) {
    throw new Error(`未知的圈: ${ring}（可选 ${RING_ORDER.join(" / ")}）`);
  }

  const id = input.id ?? newMemoryId();

  const memory = store.insertMemory({
    id,
    createdAt: at,
    // 导入历史数据时：at 是真实发生时间，ringEnteredAt 是"从现在开始淡"。
    // 不传就退化成 at（正常记录就是这样）。
    ringEnteredAt: ringEnteredAt ?? at,
    bornLoad: store.totalMessages(),
    ring,
    source,
    speaker,
    content: content || cleanPoints.join("，"),
    emotion,
    pinned,
    importBatch: input?.importBatch ?? null,
  });

  // 插点：顺序即重要性，1 最重要
  cleanPoints.forEach((text, i) => {
    store.insertPoint(id, text, i + 1);
  });

  // 写总库（原始存档，她访问不到）
  // skipVault：调用方已经把逐条原文写进总库了（qq-bridge 的自动入库），
  // 这里再写一次就成了"原文 + 合并版"两份，查历史时会重复。
  if (config?.vault?.enabled !== false && !input?.skipVault) {
    store.addVault({
      ts: at,
      source,
      speaker,
      text: memory.content,
      meta: { memoryId: id, ring, points: cleanPoints },
    });
    if (config?.vault?.cap) store.trimVault(config.vault.cap);
  }

  store.logOp("remember", { id, ring, points: cleanPoints.length });

  // 进圈那一刻就按这一圈的比例削一遍。
  // 不这么做的话，"圈四 只留八成"要等到它第一次掉圈才生效，
  // 那在圈四的这些天里她等于一台录音机 —— 闲聊不该记得那么全。
  thinPointsForRing(store, config, id, ring);

  return store.getMemory(id);
}

/**
 * 她没拆点时，替她把一整句切成要点
 *
 * 只按中文标点切，一个字都不改，也不替她总结。
 * 切不开（没标点）就整句当一个点 —— 那它就是"只记得一句"。
 *
 * 这不是库在决定内容：内容还是她的，库只代劳格式。
 */
export function autoSplit(content) {
  const raw = String(content ?? "").trim();
  if (!raw) return [];
  const parts = raw
    .split(/[，。、；：！？,.;:!?\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [raw];
}

/**
 * 按某一圈的可见/缓冲比例，削掉多余的点
 *
 * 两个地方用：进圈那一刻（remember）、以及往外掉一圈（decay 的 demote）。
 * 放这个文件是因为 decay.js 已经 import 了这边，反向 import 会成环。
 *
 * @param {number|null} progress 进圈多久了（0~1）。闲聊圈会按它逐日变淡。
 * @returns {{kept:number, buffered:number}} 留了几个可见的、几个进缓冲的
 */
export function thinPointsForRing(store, config, memoryId, ring, progress = null) {
  const pts = store.listPoints(memoryId); // 已按她排的序，越前越重要
  const n = pts.length;
  if (n === 0) return { kept: 0, buffered: 0 };

  const visible = visibleRatioOf(ring, config, progress);
  const buffer = bufferRatioOf(ring, config); // null = 这一圈不参与缓冲

  let keepIdx;
  if (ring === "recall") {
    // 回忆圈：随机留，"记得有这么回事但说不清"
    keepIdx = shuffleIdx(n).slice(0, Math.max(1, Math.round(n * visible)));
  } else {
    // 其它圈：她说哪个重要就留哪个
    keepIdx = [...Array(n).keys()].slice(0, Math.max(1, Math.round(n * visible)));
  }

  const keepSet = new Set(keepIdx);

  // 缓冲圈能捞回的上限，以原文为标尺（不叠乘）
  const bufCount = buffer === null ? 0 : Math.max(0, Math.round(n * buffer));
  const bufIdx = new Set();
  if (bufCount > keepSet.size) {
    for (let i = 0; i < n && bufIdx.size < bufCount - keepSet.size; i++) {
      if (!keepSet.has(i)) bufIdx.add(i);
    }
  }

  pts.forEach((p, i) => {
    const vis = keepSet.has(i);
    store.setPointVisible(p.id, vis);
    store.setPointBuffered(p.id, !vis && bufIdx.has(i));
  });

  return { kept: keepSet.size, buffered: bufIdx.size };
}

/** 洗牌，只返回下标 */
function shuffleIdx(n) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 她改变主意：把一条记忆挪到别的圈
 * 注意这是她"主动"的行为，和系统降级不是一回事
 */
export function moveMemory(store, config, memoryId, toRing) {
  if (!RING_ORDER.includes(toRing)) {
    throw new Error(`未知的圈: ${toRing}`);
  }
  const mem = store.getMemory(memoryId);
  if (!mem) throw new Error(`找不到这条记忆: ${memoryId}`);

  store.moveRing(memoryId, toRing);
  store.logOp("move", { id: memoryId, from: mem.ring, to: toRing });
  return store.getMemory(memoryId);
}

/**
 * 钉住 / 拔掉
 */
export function pinMemory(store, config, memoryId, pinned = true) {
  const mem = store.getMemory(memoryId);
  if (!mem) throw new Error(`找不到这条记忆: ${memoryId}`);

  const now = Date.now();
  store.db
    .prepare("UPDATE memories SET pinned = ?, ring = ?, ring_entered_at = ?, updated_at = ? WHERE id = ?")
    .run(pinned ? 1 : 0, pinned ? "core" : "ring1", now, now, memoryId);

  store.logOp(pinned ? "pin" : "unpin", { id: memoryId });
  return store.getMemory(memoryId);
}

/**
 * 被提及往回拉（D3）
 *
 * 圈四、圈五的事，被反复捞回来之后，会不知不觉往回游一圈。
 * 三条铁律：
 *   1. 只有 ring4 / ring5 能被拉回来，圈一二三是她郑重放进去的，不靠"提得多"往上爬
 *   2. 圈三封顶 —— 再怎么说，也回不到"她当时觉得极其强烈"那个位置
 *   3. **升圈不还点** —— 只改圈和计时，已经掉掉的细节不会回来
 *
 * 她不知道系统在这么做。这是这套库自己的事。
 *
 * @returns {string|null} 升到了哪一圈；没升返回 null
 */
export function maybePromote(store, config, memoryId, now = Date.now()) {
  const cfg = config.promote ?? {};
  if (cfg.enabled === false) return null;

  const mem = store.getMemory(memoryId);
  if (!mem) return null;

  const from = cfg.from ?? ["ring4", "ring5"];
  if (!from.includes(mem.ring)) return null;

  const need = cfg.afterHits ?? 3;
  if ((mem.hits ?? 0) < need) return null;

  const i = RING_ORDER.indexOf(mem.ring);
  if (i <= 0) return null;

  const target = RING_ORDER[i - 1];
  const ceiling = cfg.ceiling ?? "ring3";
  const ceilingIdx = RING_ORDER.indexOf(ceiling);
  // 升完之后不能比天花板更靠里
  if (ceilingIdx >= 0 && i - 1 < ceilingIdx) return null;

  // 只挪圈、重置计时，points 一个不动
  store.moveRing(memoryId, target, now);
  store.db.prepare("UPDATE memories SET hits = 0 WHERE id = ?").run(memoryId);
  store.logOp("promote", { id: memoryId, from: mem.ring, to: target, hits: mem.hits });

  return target;
}

/**
 * 忘掉某一条（她主动清掉，或者你手动删）
 */
export function forgetOne(store, config, memoryId) {
  const mem = store.getMemory(memoryId);
  if (!mem) return false;
  store.deleteMemory(memoryId);
  store.logOp("forget", { id: memoryId, ring: mem.ring });
  return true;
}