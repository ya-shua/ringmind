/**
 * 环形的心 · 数据库结构
 *
 * 设计要点：
 * 1. 所有"点"都存在 points 表里，靠 visible / buffered 两个标记控制她能看到多少
 *    —— 不存两份，避免不一致
 * 2. 点的删除是"确定性"的：降级那一刻就定死，之后每次想起来内容一致
 * 3. 总库（vault）单独一张表，她访问不到
 */

/** 结构版本，将来迁移用 */
export const SCHEMA_VERSION = 5;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 元信息：结构版本、库名、创建时间等
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 数据总库：原始存档，她访问不到
CREATE TABLE IF NOT EXISTS vault (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  source  TEXT,              -- private | group
  speaker TEXT,              -- user | self
  text    TEXT NOT NULL,
  meta    TEXT               -- 附加信息（JSON）
);
CREATE INDEX IF NOT EXISTS idx_vault_ts ON vault(ts);

-- 记忆条目
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  ring_entered_at INTEGER NOT NULL DEFAULT 0, -- 进当前这一圈的时间（掉圈即归零）
  born_load  INTEGER NOT NULL DEFAULT 0,   -- 产生时的全局消息计数
  ring       TEXT    NOT NULL,             -- core/ring1..ring5/recall
  source     TEXT    NOT NULL,             -- private | group
  speaker    TEXT    NOT NULL,             -- user | self
  content    TEXT    NOT NULL,             -- 把点串起来的一句话
  emotion    REAL    DEFAULT 0,            -- 0..10
  hits       INTEGER DEFAULT 0,            -- 被想起的次数
  pinned     INTEGER DEFAULT 0,            -- 是否被她钉住
  note       TEXT,                         -- 批注（更正、存疑）
  note_suspect INTEGER DEFAULT 0,          -- 这条 note 是"可能不准"的（语音转写）
  message_id TEXT,                         -- 来源消息的稳定 id（幂等用，重复投递不再写）
  import_batch TEXT,                       -- 导入批次（面板导入的才标，撤回用）
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_ring   ON memories(ring);
CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_mem_born   ON memories(created_at);
-- 注意：message_id 的唯一索引不写在这里。
-- 这里的 SQL 在 migrate() 之前跑，老库还没有 message_id 那一列，建索引会直接报错。
-- 它由 migrate()（老库）和 ensureIndexes()（新库）两头保证。

-- 收到过的消息 id：幂等靠它
--   为什么不直接看 memories.message_id？因为合并进来的一句不单独占一行 ——
--   第 2 句被并进第 1 条之后，memories 里找不到它的 id，重发就会被再并一遍。
--   所以每个 message_id 都在这张表里留一条，指向它最后落进的那条记忆。
CREATE TABLE IF NOT EXISTS seen_messages (
  message_id TEXT PRIMARY KEY,
  memory_id  TEXT NOT NULL,
  ts         INTEGER NOT NULL
);

-- 自动入库的"上一段对话"游标：合并窗口靠它跨进程续上
--   slot = 会话key|发言方（私聊:123|0 / 群:456|1）
--   重启后靠这张表知道"刚才那段对话的最后一条是哪条"，不然每次开会话都会把对话拆成两截。
CREATE TABLE IF NOT EXISTS conv_state (
  slot      TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  first_ts  INTEGER NOT NULL,
  last_ts   INTEGER NOT NULL
);

-- 点（细节点 / 钩子）
--   weight   : 她的排序，1 = 最看重；NULL = 没进钩子列表
--   visible  : 现在还能不能"看见"
--   buffered : 看不见了，但缓冲圈里还留着一份
CREATE TABLE IF NOT EXISTS points (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT    NOT NULL,
  text      TEXT    NOT NULL,
  weight    INTEGER,
  visible   INTEGER DEFAULT 1,
  buffered  INTEGER DEFAULT 0,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pt_mem  ON points(memory_id);
CREATE INDEX IF NOT EXISTS idx_pt_text ON points(text);
CREATE INDEX IF NOT EXISTS idx_pt_w    ON points(memory_id, weight);

-- 表情记录：只记编号 + 意思 + 描述，不存图
CREATE TABLE IF NOT EXISTS stickers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sticker_id TEXT NOT NULL,          -- QQ 给的稳定编号
  meaning   TEXT,                    -- 摸鱼 / 偷懒
  desc      TEXT,                    -- 一条蓝色小鱼趴在桌上
  used_at   INTEGER,
  context   TEXT
);
CREATE INDEX IF NOT EXISTS idx_stk_used ON stickers(used_at);

-- Token 用量：从 DSH 的账本同步进来，做一份长期存档
--   DSH 的账本是单个 JSON 文件，整体重写，丢了就没了；
--   这里按 (天, provider, 模型) 存一行，重复同步只会覆盖同一行，不会越积越多。
CREATE TABLE IF NOT EXISTS token_usage (
  day      TEXT    NOT NULL,             -- 2026-10-07
  provider TEXT    NOT NULL,             -- deepseek-account / deep / dps / qianwenai
  model    TEXT    NOT NULL,             -- deepseek-flash
  hit      INTEGER DEFAULT 0,            -- 缓存命中输入
  miss     INTEGER DEFAULT 0,            -- 未命中输入
  write    INTEGER DEFAULT 0,            -- 缓存写入
  output   INTEGER DEFAULT 0,            -- 输出
  calls    INTEGER DEFAULT 0,
  cost     REAL    DEFAULT 0,            -- 账本自己算的钱（0 = 免费额度）
  synced_at INTEGER,
  PRIMARY KEY (day, provider, model)
);
CREATE INDEX IF NOT EXISTS idx_tu_day ON token_usage(day);

-- 操作日志：谁在什么时候动了什么（调试与回滚用）
CREATE TABLE IF NOT EXISTS ops (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,             -- demote / promote / forget / pin / edit
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_ts ON ops(ts);
`;

/**
 * 从老版本升上来。
 * v1 → v2：memories 加 ring_entered_at（掉圈计时锚点）。
 *          老的库一律用 created_at 回填 —— 它们本来就没记过进圈时间。
 * v2 → v3：加 token_usage 表。SCHEMA_SQL 里是 CREATE TABLE IF NOT EXISTS，
 *          老库打开时会自动补上，这里不用 ALTER。
 * v3 → v4：memories 加 import_batch（导入批次标记，撤回导入用）。
 *          只有面板导入的记忆才有值，日常记住的都是 NULL。
 * v4 → v5：自动入库的两件配套东西 ——
 *          ① memories 加 message_id（唯一索引，重复投递只写一次）
 *          ② 新表 conv_state（合并游标），合并窗口不再只活在进程内存里
 *          另外补 note_suspect：语音转写进来的 note 要标"可能不准"。
 */
export function migrate(db, fromVersion) {
  const v = Number(fromVersion ?? 0);

  if (v < 2) {
    const cols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    if (!cols.includes("ring_entered_at")) {
      db.exec("ALTER TABLE memories ADD COLUMN ring_entered_at INTEGER NOT NULL DEFAULT 0");
    }
    db.exec("UPDATE memories SET ring_entered_at = created_at WHERE ring_entered_at = 0");
  }

  if (v < 4) {
    const cols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    if (!cols.includes("import_batch")) {
      db.exec("ALTER TABLE memories ADD COLUMN import_batch TEXT");
    }
  }

  if (v < 5) {
    const cols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    if (!cols.includes("note_suspect")) {
      db.exec("ALTER TABLE memories ADD COLUMN note_suspect INTEGER DEFAULT 0");
    }
    if (!cols.includes("message_id")) {
      db.exec("ALTER TABLE memories ADD COLUMN message_id TEXT");
    }
    // 老库里 message_id 都是 NULL，唯一索引对 NULL 不生效，建索引不会撞
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_msgid ON memories(message_id) WHERE message_id IS NOT NULL"
    );
    db.exec(`CREATE TABLE IF NOT EXISTS conv_state (
      slot      TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      first_ts  INTEGER NOT NULL,
      last_ts   INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS seen_messages (
      message_id TEXT PRIMARY KEY,
      memory_id  TEXT NOT NULL,
      ts         INTEGER NOT NULL
    )`);
  }

  return SCHEMA_VERSION;
}

/**
 * 新库也要有的东西（migrate 只在老库上跑，全新库走不到 v<5 那段）
 * 现在只有一条：message_id 的唯一索引 —— 幂等靠它。
 */
export function ensureIndexes(db) {
  const cols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  if (cols.includes("message_id")) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_msgid ON memories(message_id) WHERE message_id IS NOT NULL"
    );
  }
  db.exec(`CREATE TABLE IF NOT EXISTS conv_state (
    slot      TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    first_ts  INTEGER NOT NULL,
    last_ts   INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS seen_messages (
    message_id TEXT PRIMARY KEY,
    memory_id  TEXT NOT NULL,
    ts         INTEGER NOT NULL
  )`);
}

/** 首次建库时要写入的元信息 */
export function metaSeed(name) {
  return [
    ["schema_version", String(SCHEMA_VERSION)],
    ["name", name ?? "未命名"],
    ["created_at", String(Date.now())],
  ];
}