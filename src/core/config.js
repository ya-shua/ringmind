/**
 * 环形的心 · 配置
 *
 * 配置存在库文件里（meta.config），跟着库走。
 * 换库 = 换一套配置，这就是"新建空库"的底气。
 */

import { CUSTOM_PREFIX, DEFAULT_CONFIG, DEFAULT_PRESET, MODES, PRESETS, RING_ORDER } from "../core/rings.js";

/** 深合并：只有普通对象才递归，数组直接替换 */
export function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== "object" || typeof patch !== "object") return patch;

  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = key in base ? deepMerge(base[key], patch[key]) : patch[key];
  }
  return out;
}

/** 读取配置；没存过就返回默认值 */
export function loadConfig(store) {
  const saved = store.getConfig();
  if (!saved) return structuredClone(DEFAULT_CONFIG);
  return deepMerge(structuredClone(DEFAULT_CONFIG), saved);
}

/** 保存配置 */
export function saveConfig(store, config) {
  const clean = normalize(config);
  store.saveConfig(clean);
  return clean;
}

/** 切换模式 */
export function setMode(store, config, mode) {
  if (!MODES[mode]) throw new Error(`未知模式: ${mode}`);
  const next = { ...config, mode };
  return saveConfig(store, next);
}

/**
 * 把配置整理成干净的结构
 * 防止外面传进来的脏数据写进库
 */
export function normalize(config) {
  const c = { ...config };

  if (!MODES[c.mode]) c.mode = "forget";

  // 用户自己建的方案：先洗干净再存
  const rawCustom =
    c.customPresets && typeof c.customPresets === "object" && !Array.isArray(c.customPresets)
      ? c.customPresets
      : {};
  const customPresets = {};
  for (const [key, v] of Object.entries(rawCustom)) {
    const k = String(key).replace(/[^\w\u4e00-\u9fa5-]/g, "").slice(0, 40);
    if (!k || !v || typeof v !== "object") continue;
    const rings = {};
    for (const id of RING_ORDER) {
      const cur = v.rings?.[id] ?? DEFAULT_CONFIG.rings[id];
      rings[id] = {
        days: cur.days === null || cur.days === undefined ? null : Math.max(0, Number(cur.days)),
        cap: cur.cap === null || cur.cap === undefined ? null : Math.max(1, Number(cur.cap)),
      };
    }
    customPresets[k] = {
      label: String(v.label || k).slice(0, 40),
      perDay: Math.max(0, Number(v.perDay) || 0),
      rings,
    };
  }
  c.customPresets = customPresets;

  // 场景档：内置三档，或 custom:<key>（那个 key 必须真存在）
  if (!PRESETS[c.preset]) {
    const isCustom =
      typeof c.preset === "string" &&
      c.preset.startsWith(CUSTOM_PREFIX) &&
      !!customPresets[c.preset.slice(CUSTOM_PREFIX.length)];
    if (!isCustom) c.preset = DEFAULT_PRESET;
  }

  // 每圈的天数与容量
  const rings = {};
  for (const id of RING_ORDER) {
    const def = DEFAULT_CONFIG.rings[id];
    const cur = c.rings?.[id] ?? def;
    rings[id] = {
      days: cur.days === null || cur.days === undefined ? null : Math.max(0, Number(cur.days)),
      cap: cur.cap === null || cur.cap === undefined ? null : Math.max(1, Number(cur.cap)),
    };
  }
  c.rings = rings;

  // 百分比统一夹到 0..1
  const clamp01 = (v, fallback) => {
    const n = Number(v);
    if (Number.isNaN(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  };

  const visible = c.customRatios?.visible ?? {};
  const buffer = c.customRatios?.buffer ?? {};
  c.customRatios = {
    visible: Object.fromEntries(
      Object.entries(visible).map(([k, v]) => [k, clamp01(v, 0.5)])
    ),
    buffer: Object.fromEntries(
      Object.entries(buffer).map(([k, v]) => [k, clamp01(v, 0.5)])
    ),
  };

  c.quota = {
    private: clamp01(c.quota?.private, 0.4),
    group: clamp01(c.quota?.group, 0.6),
  };

  c.vault = {
    enabled: c.vault?.enabled !== false,
    cap: Math.max(0, Number(c.vault?.cap) || 0),
  };

  c.compaction = {
    enabled: c.compaction?.enabled !== false,
    hour: Math.min(23, Math.max(0, Number(c.compaction?.hour ?? 4))),
    minute: Math.min(59, Math.max(0, Number(c.compaction?.minute ?? 0))),
  };

  c.metaMemory = c.metaMemory !== false;
  c.selfSpeechWeight = Math.max(1, Number(c.selfSpeechWeight) || 3);

  return c;
}