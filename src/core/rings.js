/**
 * 环形的心 · 圈的定义
 *
 * 九个位置：
 *   vault   数据总库（原始存档，她访问不到）
 *   core    圆心 · 自我圈（她觉得最最重要的才放这里）
 *   ring1   极其强烈
 *   ring2   很开心 / 很难过
 *   ring3   有点意思
 *   ring4   闲聊（接盘层，她看不见）
 *   ring5   模糊圈（她看不见）
 *   recall  回忆圈（她看不见）
 *   buffer  缓冲圈（不是独立存储，是视图）
 *
 * ⚠️ 可见性（2026-10-29 定）：
 *   她**只看得见四个**——core / ring1 / ring2 / ring3。
 *   ring4 不是给她挑的地方，是**接盘层**：她没表态、没记的事都落在这里。
 *   因为是刚发生的事，实际还没忘（缓冲圈满格），5 天逐日淡之后才掉进 ring5 开始真忘。
 *   ring5 / recall 是库在模拟"她忘"，她掉进去也不会发现自己掉进去了。
 *   ⇒ 提示词、工具 enum、返回文案里都不要出现 ring4 / ring5 / recall 的名字。
 *   详见 docs/设计确认-2026-10-29.md 一、二节。
 *
 * ⚠️ 天数有两套（2026-10-29 核对）：
 *   下面 RINGS 里的 days 是**没选预设时**的兜底值（ring1 180 / ring2 60 / ring3 14）。
 *   一旦选了 PRESETS（private / mixed / group），圈一二三全是 90 / 30 / 10，覆盖掉兜底。
 *   已有的库实际生效的可能是 private（看它自己的 meta.config.preset）。
 *
 * ⚠️ 实际停留 = min(时间闸 days, 容量闸 cap) —— 先到的那个说了算。
 *   容量算小了，天数形同虚设。改天数时必须同步放大 cap，否则改了等于没改。
 */

/** 记忆真正所在的圈（按从内到外排序） */
export const RING_ORDER = ["core", "ring1", "ring2", "ring3", "ring4", "ring5", "recall"];

/** 圈的元数据 */
export const RINGS = {
  core: {
    id: "core",
    label: "圆心 · 自我圈",
    desc: "钉住的秘密、底线、承诺。永不外出。",
    days: null, // 永不到期
    cap: 300,
    visible: 1.0,
    buffer: 1.0,
  },
  ring1: {
    id: "ring1",
    label: "一圈 · 极其强烈",
    desc: "想起来还会心里一动的事。",
    days: 180,
    cap: 1000,
    visible: 1.0,
    buffer: 1.0,
  },
  ring2: {
    id: "ring2",
    label: "二圈 · 很开心 / 很难过",
    desc: "情绪很浓的事。",
    days: 60,
    cap: 500,
    visible: 1.0,
    buffer: 1.0,
  },
  ring3: {
    id: "ring3",
    label: "三圈 · 有点意思",
    desc: "还记得、值得留着的事。",
    days: 14,
    cap: 300,
    visible: 1.0,
    buffer: 1.0,
  },
  ring4: {
    id: "ring4",
    label: "四圈 · 闲聊圈",
    desc: "近几天的日常。进圈时什么都记得，之后每天淡一点，待满只剩八成；这五天里提醒一下全都能想起来。",
    days: 5,
    cap: 500,
    visible: 1.0, // 进圈那一刻：一个点都不少
    visibleEnd: 0.8, // 待满这五天：只剩八成
    buffer: 1.0, // 这五天里缓冲圈满格 —— 才发生的事，提一下当然想得起来
  },
  ring5: {
    id: "ring5",
    label: "五圈 · 模糊圈",
    desc: "开始糊了。显示原文 40%，缓冲圈能捞回 70%。",
    days: 30,
    cap: 1000,
    visible: 0.4,
    buffer: 0.7,
  },
  recall: {
    id: "recall",
    label: "回忆圈",
    desc: "只剩 30% 的随机点，钩子全在，但怎么想都想不起来。缓冲圈不再参与。",
    days: 365, // 进回忆圈满一年就彻底消失。面板可调（改 config.rings.recall.days）
    cap: 5000, // 兜底：再往后总得有个头。满了随机挤（不是按最老）
    visible: 0.3,
    buffer: null, // 缓冲圈不参与
  },
};

/**
 * 场景预设（2026-10-28 定）
 *
 * 分档只按一件事：**这边一天大概记几条**。
 * 因为那是客观的、能量出来的，而且直接决定容量该给多大。
 *
 * 天数 = 你想让这种事在她脑子里活多久（主观，随便填）
 * 容量 = 一天记几条 × 天数 × 余量（客观，能算）
 *
 * 每个圈里有两个闸门：时间闸（days）和容量闸（cap），
 * **实际停留 = 先到的那个**。容量算小了，就是容量说了算，天数形同虚设。
 */
export const PRESETS = {
  private: {
    id: "private",
    label: "私聊为主",
    desc: "基本只在私聊，一天大概几十条。",
    /** 一天进闲聊圈的条数（用来推算容量是否够） */
    perDay: 50,
    rings: {
      core: { days: null, cap: 150 },
      ring1: { days: 90, cap: 100 },
      ring2: { days: 30, cap: 200 },
      ring3: { days: 10, cap: 300 },
      ring4: { days: 5, cap: 400 },
      ring5: { days: 30, cap: 800 },
      recall: { days: 365, cap: 1000 },
    },
  },
  mixed: {
    id: "mixed",
    label: "混合",
    desc: "私聊加几个群，一天大概一两百条。",
    perDay: 150,
    rings: {
      core: { days: null, cap: 300 },
      ring1: { days: 90, cap: 300 },
      ring2: { days: 30, cap: 300 },
      ring3: { days: 10, cap: 300 },
      ring4: { days: 5, cap: 1000 },
      ring5: { days: 20, cap: 2000 },
      recall: { days: 180, cap: 4000 },
    },
  },
  group: {
    id: "group",
    label: "群聊为主",
    desc: "主要在群里，一天两三百条消息。",
    perDay: 300,
    rings: {
      core: { days: null, cap: 500 },
      ring1: { days: 90, cap: 800 },
      ring2: { days: 30, cap: 1000 },
      ring3: { days: 10, cap: 1500 },
      ring4: { days: 3, cap: 3000 },
      ring5: { days: 10, cap: 5000 },
      recall: { days: 90, cap: 20000 },
    },
  },
};

/**
 * 默认用哪一档
 *
 * ⚠️ 这只是"新建库时的默认"。已有的库可能已经是 private（见 meta.config.preset），
 * 所以它的一二三圈是 90 / 30 / 10 天，不是上面 RINGS 里的 180 / 60 / 14。
 * 三档预设的圈一二三完全一样（90/30/10），差别只在闲聊圈/模糊圈/回忆圈。
 * （2026-10-29 核对，见 docs/设计确认-2026-10-29.md 第四节）
 */
export const DEFAULT_PRESET = "mixed";

/** 自定义方案的 id 前缀：custom:<key> */
export const CUSTOM_PREFIX = "custom:";

/**
 * 取一个方案：先看内置三档，再看用户自己建的
 *
 * 内置三档是写死的模板，改不了；用户要改就得"基于某档新建一个"，
 * 新方案存进 config.customPresets，随便改、随便删。
 *
 * @param {object} config
 * @param {string} id private | mixed | group | custom:<key>
 * @returns {{id?:string,label?:string,perDay?:number,rings:object}|null}
 */
export function presetOf(config, id) {
  if (PRESETS[id]) return PRESETS[id];
  if (typeof id !== "string" || !id.startsWith(CUSTOM_PREFIX)) return null;
  const key = id.slice(CUSTOM_PREFIX.length);
  const cp = config?.customPresets?.[key];
  if (!cp) return null;
  return cp;
}

/** 三种模式（+ 自定义）的预设 */
export const MODES = {
  forget: {
    id: "forget",
    label: "遗忘模式",
    desc: "会忘。被提醒能想起来一部分，但想不全。",
    visible: { ring4: 1.0, ring5: 0.4, recall: 0.3 },
    buffer: { ring4: 1.0, ring5: 0.7 },
    fade: true, // 闲聊圈逐日变淡
    vaultAccessible: false,
  },
  "pseudo-forget": {
    id: "pseudo-forget",
    label: "伪遗忘模式",
    desc: "看起来忘了，一提示全回来。连自己都以为忘了。",
    visible: { ring4: 1.0, ring5: 0.4, recall: 0.3 },
    buffer: { ring4: 1.0, ring5: 1.0 },
    fade: true,
    vaultAccessible: false,
  },
  "never-forget": {
    id: "never-forget",
    label: "永不忘记模式",
    desc: "总库开放，什么都能查回来。",
    visible: { ring4: 1.0, ring5: 1.0, recall: 1.0 },
    buffer: { ring4: 1.0, ring5: 1.0 },
    fade: false, // 这一档不许变淡
    vaultAccessible: true,
  },
  custom: {
    id: "custom",
    label: "自定义",
    desc: "每个圈单独调百分比。",
    visible: null,
    buffer: null,
    fade: true,
    vaultAccessible: false,
  },
};

/** 默认配置：一个全新记忆库的初始状态 */
/**
 * 元记忆在每个模式下的默认值。
 *
 * 「元记忆」= 她知不知道自己忘了。
 *
 * 它给的信息是「这条记忆有几个点、你想起了几个、还剩几个」（见 recall.js 的 gap）。
 * 这个信息很重 —— 她一旦知道，就会反复想「我是不是忘了什么」。
 *
 *   - 伪遗忘：**开**。这个模式她其实全记得，只是默认没拿出来。
 *     「我记得好像有这回事，但细节想不起来了」正是它的表演，
 *     被提醒一下就全回来 —— 元记忆和这个模式是一体的。
 *   - 遗忘：**关**。这个模式追求自然淡忘：她确实记不全，但她不自知、不纠结。
 *     让她时刻知道自己漏了几个点，就不是「最像人」了，是「一直在焦虑」。
 *   - 永不忘：**关**。一个点都不少，谈不上「意识到自己忘了」。
 *   - 自定义：**开**。交给用户自己配。
 *
 * 这只是「默认值」——用户可以在面板上改，改的时候会提示。
 * 真正的生效判断在 recall.js 里：永不忘模式下即使用户开着也不给缺口。
 */
export const META_MEMORY_DEFAULT = {
  forget: false,
  "pseudo-forget": true,
  "never-forget": false,
  custom: true,
};

/** 某个模式下，元记忆默认该不该开 */
export function metaMemoryDefaultOf(mode) {
  if (mode in META_MEMORY_DEFAULT) return META_MEMORY_DEFAULT[mode];
  return true;
}

/** 各种记忆模式的预设比例 */

export const DEFAULT_CONFIG = {
  /** forget | pseudo-forget | never-forget | custom */
  mode: "forget",

  /**
   * 允许她意识到自己忘了（元记忆）。
   *
   * 新建的库默认是 forget 模式，而那个模式不该有元记忆（见 META_MEMORY_DEFAULT），
   * 所以这里跟着设 false —— 保证「新建一个库」和「切到遗忘模式」的默认值一致。
   */
  metaMemory: false,

  /**
   * 允不允许把总库查回来（她的回忆能不能翻到原始存档）。
   * 永不忘模式下默认开，其他模式默认关，用户可以在面板里改。
   */
  vaultAccessible: false,

  /** 各圈的停留天数与容量；null 表示不限制 */
  rings: Object.fromEntries(
    RING_ORDER.map((id) => [
      id,
      {
        days: PRESETS[DEFAULT_PRESET].rings[id]?.days ?? RINGS[id].days,
        cap: PRESETS[DEFAULT_PRESET].rings[id]?.cap ?? RINGS[id].cap,
      },
    ])
  ),

  /** 当前用的场景档：private / mixed / group，或 custom:<key> */
  preset: DEFAULT_PRESET,

  /**
   * 用户自己建的方案
   * key → { label, perDay, rings: { core:{days,cap}, ... } }
   * 内置三档不在这里，也不可改。
   */
  customPresets: {},

  /** 自定义模式下各圈的显示比例与缓冲比例（覆盖模式预设） */
  customRatios: {
    visible: { ring4: 0.8, ring5: 0.4, recall: 0.3 },
    buffer: { ring4: 0.9, ring5: 0.7 },
    /**
     * 每天淡多少（百分比/天）。只对会变淡的圈有效，现在是闲聊圈。
     * 不填就按内置的 visibleEnd 走；填了就用「起始 - 每天 × 天数」算终点。
     * 默认 4 —— 和原来 1.0 → 0.8 / 5 天是同一个数。
     */
    fadePerDay: { ring4: 4 },
  },

  /** 配额：每一圈内部私聊保底 40%，群聊最多 60% */
  quota: { private: 0.4, group: 0.6 },

  /** 总库：默认开启，她够不着 */
  vault: { enabled: true, cap: 0 },

  /** 压缩/降级任务：每天凌晨 4 点 */
  compaction: { enabled: true, hour: 4, minute: 0 },

  /** 她说的话比事件记忆牢 3 倍 */
  selfSpeechWeight: 3,

  /**
   * 被提及往回拉（D3）
   * 圈四、圈五的事被反复捞回来，会不知不觉往回游一圈。
   * 她自己不知道系统在这么做，也管不了。
   */
  promote: {
    enabled: true,
    /** 攒够几次"捞回来"才升一圈（每次真多想起内容算一次） */
    afterHits: 3,
    /** 最高升到哪一圈，不能再往里 */
    ceiling: "ring3",
    /** 只有这两圈能被拉回来 */
    from: ["ring4", "ring5"],
  },

  /** 提示恢复：每次提示最多往回拉多少 */
  recall: { maxAttempts: null } // null = 不限制，由她自己决定什么时候放弃
};

/**
 * 换一个场景档：把那一档的天数和容量整套搬过来
 *
 * 搬完之后每项仍然可以单独改（改 `config.rings[id].days/cap`）。
 * @param {object} config
 * @param {string} presetId private | mixed | group
 */
export function applyPreset(config, presetId) {
  const preset = presetOf(config, presetId);
  if (!preset) return config;
  return {
    ...config,
    preset: presetId,
    rings: Object.fromEntries(
      RING_ORDER.map((id) => [
        id,
        {
          days: preset.rings[id]?.days ?? RINGS[id].days,
          cap: preset.rings[id]?.cap ?? RINGS[id].cap,
        },
      ])
    ),
  };
}

/**
 * 取某个圈在当前配置下真正生效的可见比例
 *
 * @param {string} ringId
 * @param {object} config
 * @param {number|null} progress 进圈多久了（0~1）。给了就按这个圈的"渐变"算，
 *                               不给就返回进圈那一刻的比例。
 *                               只有带 visibleEnd 的圈（现在是闲聊圈）才会变。
 */
export function visibleRatioOf(ringId, config, progress = null) {
  const mode = MODES[config.mode] ?? MODES.forget;
  const preset = mode.visible;
  const custom = config.customRatios?.visible ?? {};
  const def = RINGS[ringId]?.visible ?? 1.0;

  const start =
    preset && ringId in preset
      ? preset[ringId]
      : config.mode === "custom" && ringId in custom
        ? custom[ringId]
        : def;

  // 这一档不许变淡，或者这个圈没有终点值 → 一直是进圈那个比例
  const end = RINGS[ringId]?.visibleEnd;
  if (mode.fade === false || end === undefined || end === null) return start;

  if (progress === null || progress === undefined) return start;
  const t = Math.min(1, Math.max(0, Number(progress) || 0));

  // 「每天淡多少」可以自己定：算出等效终点，盖掉内置的 visibleEnd
  let effEnd = end;
  const perDay = config?.customRatios?.fadePerDay?.[ringId];
  if (perDay != null && Number.isFinite(Number(perDay)) && Number(perDay) > 0) {
    const days = Number(config?.rings?.[ringId]?.days);
    if (Number.isFinite(days) && days > 0) {
      effEnd = Math.max(0, start - (Number(perDay) / 100) * days);
    }
  }

  return start + (effEnd - start) * t;
}

/**
 * 取某个圈在当前配置下缓冲圈的上限
 * @param {string} ringId
 * @param {object} config
 * @returns {number|null} null 表示缓冲圈不参与
 */
export function bufferRatioOf(ringId, config) {
  const mode = MODES[config.mode] ?? MODES.forget;
  const preset = mode.buffer;
  const custom = config.customRatios?.buffer ?? {};
  const def = RINGS[ringId]?.buffer ?? null;

  if (preset && ringId in preset) return preset[ringId];
  if (config.mode === "custom" && ringId in custom) return custom[ringId];
  return def;
}

/**
 * 记忆的下一圈（掉级目标）
 * @param {string} ringId
 * @returns {string|null} null 表示彻底消失
 */
export function nextRingOf(ringId) {
  const i = RING_ORDER.indexOf(ringId);
  if (i < 0 || i >= RING_ORDER.length - 1) return null;
  return RING_ORDER[i + 1];
}

/** 某个模式下，「可查询总库」默认该不该开 */
export function vaultAccessibleDefaultOf(mode) {
  if (mode === "never-forget") return true;
  if (mode === "custom") return false;
  return false;
}
