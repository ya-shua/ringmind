/**
 * 环形的心 · 主入口
 *
 * 一个记忆库 = 一个 .db 文件。打开它就是打开一段人生。
 *
 * 用法：
 *   const db = new Ringmind("./data/memory.db", "memory");
 *   db.remember({ content: "老爹带我出门…", ring: "ring4", points: ["黄色", "大汽车"], emotion: 7 });
 *   db.recall(["黄色"]);
 *   db.decay();
 */

import { Store } from "./store/db.js";
import { loadConfig, saveConfig, setMode, normalize, deepMerge } from "./core/config.js";
import { remember, moveMemory, pinMemory, forgetOne } from "./core/remember.js";
import { runDecay, planDecay, ringStats } from "./core/decay.js";
import { recall, searchMemory, inspectMemory } from "./core/recall.js";
import { RINGS, RING_ORDER, MODES, PRESETS, applyPreset as applyPresetTo, presetOf } from "./core/rings.js";

export class Ringmind {
  /**
   * @param {string} path 库文件路径，":memory:" 用于测试
   * @param {string} [name] 库名
   */
  constructor(path = ":memory:", name) {
    this.store = Store.open(path, name);
    this.config = loadConfig(this.store);
  }

  // ── 配置 ──────────────────────────────────────────────

  getConfig() {
    return this.config;
  }

  updateConfig(patch) {
    // 必须深合并：面板只传改动的那几项，浅合并会把整块（比如 customRatios）冲掉
    this.config = normalize(deepMerge(this.config, patch));
    saveConfig(this.store, this.config);
    this.config = loadConfig(this.store);
    return this.config;
  }

  /**
   * 整份换掉配置（能删除字段，updateConfig 的深合并不行）
   *
   * 只在"删掉一个自定义方案"这种场合用：patch 里少一个 key 时深合并会把它留着，
   * 所以这里直接给整份新的，normalize 之后写回去。
   */
  replaceConfig(next) {
    this.config = normalize(next);
    saveConfig(this.store, this.config);
    this.config = loadConfig(this.store);
    return this.config;
  }

  setMode(mode) {
    this.config = setMode(this.store, this.config, mode);
    return this.config;
  }

  /**
   * 换场景档：private（私聊为主）/ mixed（混合）/ group（群聊为主）
   *
   * 换完每项还能单独改，例如：
   *   db.setPreset("group");
   *   db.updateConfig({ rings: { ring1: { days: 120, cap: 900 } } });
   */
  setPreset(presetId) {
    this.config = normalize(applyPresetTo(this.config, presetId));
    saveConfig(this.store, this.config);
    this.config = loadConfig(this.store);
    return this.config;
  }

  /** 当前这一档：把每圈实际会待几天、能装几条摊开算 */
  presetInfo() {
    const p = presetOf(this.config, this.config.preset);
    // 只有"所有对话都会进来"的这几圈，才按每天进多少条去推算
    // 圈一二三和圆心是"她自己拆点记的"，跟聊多聊少无关，只按天数算
    const densityRings = new Set(["ring4", "ring5", "recall"]);

    return {
      preset: this.config.preset,
      label: p?.label ?? this.config.preset,
      perDay: p?.perDay ?? null,
      rings: RING_ORDER.map((id) => {
        const cap = this.config.rings[id]?.cap ?? null;
        const days = this.config.rings[id]?.days ?? null;
        // 容量先满的话，实际停留就是这个天数
        const capDays =
          densityRings.has(id) && cap && p?.perDay ? Math.floor(cap / p.perDay) : null;
        return {
          id,
          label: RINGS[id].label,
          days,
          cap,
          /** 实际能待几天（时间闸和容量闸取先到的） */
          effectiveDays: days === null ? null : capDays === null ? days : Math.min(days, capDays),
          /** true = 容量先满，天数没起作用 */
          capLimited: capDays !== null && capDays < (days ?? Infinity),
        };
      }),
    };
  }

  // ── 记 ────────────────────────────────────────────────

  remember(input) {
    return remember(this.store, this.config, input);
  }

  move(memoryId, toRing) {
    return moveMemory(this.store, this.config, memoryId, toRing);
  }

  pin(memoryId, pinned = true) {
    return pinMemory(this.store, this.config, memoryId, pinned);
  }

  forget(memoryId) {
    return forgetOne(this.store, this.config, memoryId);
  }

  // ── 想 ────────────────────────────────────────────────

  recall(cues, opts) {
    return recall(this.store, this.config, cues, opts);
  }

  search(keyword, opts) {
    return searchMemory(this.store, this.config, keyword, opts);
  }

  inspect(memoryId) {
    return inspectMemory(this.store, this.config, memoryId);
  }

  // ── 忘 ────────────────────────────────────────────────

  decay(opts) {
    return runDecay(this.store, this.config, opts);
  }

  planDecay(now) {
    return planDecay(this.store, this.config, now);
  }

  stats() {
    return ringStats(this.store);
  }

  /**
   * 今天的动静 —— 全部从 ops 日志里数出来，不另存计数
   *
   * 面板上的"今天新记住 / 掉圈 / 忘掉"就用这个。
   * @param {number} [now]
   */
  todayStats(now = Date.now()) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const since = d.getTime();

    const rows = this.store.db
      .prepare("SELECT kind, COUNT(*) AS n FROM ops WHERE ts >= ? GROUP BY kind")
      .all(since);

    const by = Object.fromEntries(rows.map((r) => [r.kind, r.n]));

    const last = this.store.db
      .prepare("SELECT ts, payload FROM ops WHERE kind = 'decay' ORDER BY ts DESC LIMIT 1")
      .get();

    const first = this.store.db
      .prepare("SELECT MIN(created_at) AS t FROM memories")
      .get();

    return {
      since,
      remembered: by.remember ?? 0,
      demoted: by.demote ?? 0,
      forgotten: by.forget ?? 0,
      promoted: by.promote ?? 0,
      /** 最近一次整理：什么时候、动了多少 */
      lastDecay: last
        ? {
            at: last.ts,
            applied: (() => {
              try {
                return JSON.parse(last.payload || "{}").applied ?? 0;
              } catch {
                return 0;
              }
            })(),
          }
        : null,
      /** 库里最早的一条 */
      earliest: first?.t ?? null,
      /** 记忆条数（不含总库） */
      memories: this.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,
      /** 点总数 */
      points: this.store.db.prepare("SELECT COUNT(*) AS n FROM points").get().n,
      /** 其中已经看不见的 */
      pointsGone: this.store.db
        .prepare("SELECT COUNT(*) AS n FROM points WHERE visible = 0 AND buffered = 0")
        .get().n,
      /** 被钉住的条数 */
      pinned: this.store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE pinned = 1").get().n,
    };
  }

  /** 给面板用的一份总览 */
  overview() {
    const stats = this.stats();
    const rings = RING_ORDER.map((id) => ({
      id,
      label: RINGS[id].label,
      desc: RINGS[id].desc,
      days: this.config.rings[id]?.days ?? null,
      cap: this.config.rings[id]?.cap ?? null,
      ...stats[id],
    }));

    return {
      name: this.store.getMeta("name"),
      mode: this.config.mode,
      modeLabel: MODES[this.config.mode]?.label ?? this.config.mode,
      preset: this.config.preset,
      presetLabel: presetOf(this.config, this.config.preset)?.label ?? this.config.preset,
      rings,
      vault: this.store.vaultCount(),
      schemaVersion: this.store.schemaVersion,
    };
  }

  /** 某一圈里的记忆（面板"她的自我圈"那张表用） */
  byRing(ringId, limit = 50) {
    return this.store.listByRing(ringId, limit).map((m) => ({
      ...m,
      ringLabel: RINGS[m.ring]?.label ?? m.ring,
      points: this.store.listPoints(m.id).length,
      visible: this.store.listPoints(m.id).filter((p) => p.visible).length,
    }));
  }

  /** 库里最近记下的几条（面板"最近"那张表用） */
  recent(limit = 6) {
    return this.store.db
      .prepare(
        `SELECT id, content, ring, source, created_at, hits, pinned
           FROM memories ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit)
      .map((m) => ({
        ...m,
        ringLabel: RINGS[m.ring]?.label ?? m.ring,
        points: this.store.listPoints(m.id).length,
        visible: this.store.listPoints(m.id).filter((p) => p.visible).length,
      }));
  }

  close() {
    this.store.close();
  }
}

export { Store } from "./store/db.js";
export * from "./core/rings.js";
export * from "./core/config.js";
export * from "./core/remember.js";
export * from "./core/decay.js";
export * from "./core/recall.js";
export { SCHEMA_SQL, SCHEMA_VERSION } from "./store/schema.js";

export default Ringmind;