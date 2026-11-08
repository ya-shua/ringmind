#!/usr/bin/env node
/**
 * 环形的心 · MCP server（stdio，零第三方依赖）
 * ============================================================================
 * 为什么要有这个文件：
 *   记忆库本体只是一个 npm 包，自己接不了任何东西。
 *   这个文件就是那只「手」：让 DSH agent（也就是 QQ 里的那条鱼）能记事、想起来、慢慢忘。
 *
 * 三条铁律（接壳时最容易踩）：
 *   ① 她只知道五个位置：自我圈（圆心）/ 一圈 / 二圈 / 三圈 / 闲聊圈（四圈）。
 *      ring5（模糊圈）和 recall（回忆圈）**不进工具描述、不进返回值** ——
 *      她掉进去也不该知道自己掉进去了，只会觉得"这事我记不太清了"。
 *   ② 分工：她决定记什么、多重要、放哪圈；库决定什么时候淡、什么时候掉。工具不替她判断。
 *   ③ 百分比以原文为标尺 —— 这一层只搬运，不计算。
 *   ④ 她没有删除权：不提供 ring_forget。她决定记什么，记了之后什么时候掉由库说了算。
 *
 * 跟别的组件抢什么：
 *   - **不占端口**：直接 in-process 打开 .db，不经过 HTTP，不碰 3101/3080。
 *   - **不抢 QQ 账号**：它是被 DSH 的 MCP 客户端 spawn 的 stdio 子进程，消息链路还是
 *     QQ → SnowLuma → qq-bridge → DSH → 这里，一个账号一条线。
 *   - **不跟 Hindsight 抢记忆**：这里只存"人味"（谁说过什么、生活里的小事）。
 */

import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ringmind, RINGS } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/* ───────────────────────── 打开库 ───────────────────────── */

function resolveDbPath() {
  if (process.env.RING_DB) return process.env.RING_DB
  try {
    const loc = JSON.parse(readFileSync(join(ROOT, 'data-location.json'), 'utf8'))
    if (loc.dbPath) return loc.dbPath
  } catch { /* 没有就用默认 */ }
  return join(ROOT, 'data', 'memory.db')
}

const DB_PATH = resolveDbPath()
let db
try {
  db = new Ringmind(DB_PATH, 'memory')
} catch (e) {
  // 打不开就明确报出来，别让工具静默变成"她什么都想不起来"
  process.stderr.write(`[ring-mcp] 打不开记忆库 ${DB_PATH}: ${e?.message ?? e}\n`)
  process.exit(1)
}

/* ─────────────────────── 每天补跑一次降级 ───────────────────────
 * `decay()` 不跑，计时就是死的（记忆永远不掉圈）。MCP 是 DSH 每次会话现 spawn 的，
 * 所以"启动时补跑"正好等价于"每天至少一次"，不需要额外的 cron / 守护进程。
 */
const DECAY_STATE = join(HERE, '.decay-state.json')
const DAY = 86400000

/** 同一天（按本地日历）—— 用来判断"今天跑过没有" */
function sameLocalDay(a, b) {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  )
}

function catchUpDecay(via = 'mcp-start') {
  const now = Date.now()
  let last = 0
  try { last = Number(JSON.parse(readFileSync(DECAY_STATE, 'utf8')).lastDecayAt) || 0 } catch { /* 第一次跑 */ }
  // 闸按"自然日"算，不按"距上次满 24 小时" ——
  // 后者会跟着接入时刻往后漂，漂过你常用的那个时间点就整整漏一天（历史上 11/5 20:57 → 11/7 23:24 漏了 50 小时）。
  if (last && sameLocalDay(last, now)) return

  // 先占住今天再动手：两个会话同一秒起来时，后到的那个看见"今天已跑"就跳过，
  // 不会各跑一次导致同一天掉两圈。（写文件是一瞬间的事，抢到的窗口极窄）
  try { writeFileSync(DECAY_STATE, JSON.stringify({ lastDecayAt: now }, null, 2)) } catch { /* 写不了就照跑 */ }

  // 错过几天就补几轮（每轮只掉一圈，跑一次补不回来）
  const missed = Math.min(30, Math.max(1, Math.round((now - last) / DAY)))
  const start = last || now - DAY
  for (let i = 0; i < missed; i++) {
    // 最后一轮用真实的 now：别拿"上次 + N 天"去算，那可能是个未来时刻
    const at = i === missed - 1 ? now : start + DAY * (i + 1)
    try { db.decay({ now: at, via }) } catch (e) {
      process.stderr.write(`[ring-mcp] decay 失败: ${e?.message ?? e}\n`)
    }
  }
  try { writeFileSync(DECAY_STATE, JSON.stringify({ lastDecayAt: now }, null, 2)) } catch { /* 写不了就算了，下次再试 */ }
}

catchUpDecay('mcp-start')

/* 长驻会话的补漏：每小时看一次表，真的衰减一天最多一次，且贴着凌晨 4 点跑。
   catchUpDecay 内部有"今天跑过就不再跑"的闸，这里只负责别让长开的会话错过那一天。 */
function msUntilNextCompaction() {
  const n = new Date();
  const four = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 4, 0, 0, 0);
  if (n >= four) four.setDate(four.getDate() + 1);
  return four - n;
}
setTimeout(function compactionTick() {
  try { catchUpDecay('tick') } catch { /* 补跑失败就等下一班 */ }
  setTimeout(compactionTick, msUntilNextCompaction())
}, msUntilNextCompaction())

/* ───────────────────────── 她的四个位置 ───────────────────────── */

/** 能对她说的四个位置（顺序就是提示词里的顺序）。
 *  闲聊圈（ring4）不在里面 —— 它是接盘层，由桥接层的自动入库兜底写，她不知道有这一格。 */
const HER_RINGS = ['core', 'ring1', 'ring2', 'ring3']

/**
 * 位置怎么说：名字在前、圈号在后。
 * ring5 / recall 一律说成"记不太清了" —— 她不知道这两个格子存在。
 */
function ringLabel(ring) {
  // 她看不见的那三格：不说"四圈/五圈/回忆圈"，只按时间感觉说
  if (ring === 'ring4') return '刚才'
  if (ring === 'ring5') return '记不太清了'
  if (ring === 'recall') return '只剩个影子'
  return RINGS[ring]?.label ?? ring
}

const fmtTime = (ms) => {
  const d = new Date(Number(ms) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ───────────────────────── 工具实现 ───────────────────────── */

function toolRemember({ content, ring, points, emotion }) {
  const text = String(content ?? '').trim()
  if (!text) throw new Error('content 不能为空 —— 要说清楚"记的是哪件事"')
  if (!ring) {
    throw new Error('要记就得说放哪儿：' + HER_RINGS.join(' / ') + '（不填就等于没记）')
  }
  if (!HER_RINGS.includes(ring)) {
    throw new Error(`ring 只能是 ${HER_RINGS.join(' / ')}（她自己挑的地方）`)
  }
  const input = { content: text, ring, speaker: 'self' }
  if (Array.isArray(points) && points.length) input.points = points.map((p) => String(p).trim()).filter(Boolean)
  if (emotion !== undefined && emotion !== null) input.emotion = Number(emotion)

  const mem = db.remember(input)
  const pts = mem?.points?.length ?? 0
  return [
    `记下了（#${mem?.id ?? '?'} · ${ringLabel(mem?.ring ?? ring)}）`,
    pts ? `拆成 ${pts} 个点：${(mem.points ?? []).map((p) => (typeof p === 'string' ? p : p.text)).join('、')}` : '没拆点，整句存着，库会按标点替她切',
  ].join('\n')
}

function toolRecall({ cues, limit = 5 }) {
  const list = (Array.isArray(cues) ? cues : [cues]).map((c) => String(c ?? '').trim()).filter(Boolean)
  if (!list.length) throw new Error('cues 不能为空 —— 给个由头（几个关键词）才想得起来')
  const got = db.recall(list, { limit: Math.min(Number(limit) || 5, 10) })
  if (!got.length) return `关于「${list.join('、')}」……想不起来了。`

  const lines = [`关于「${list.join('、')}」，想起来的：`]
  got.forEach((r, i) => {
    const extra = r.recovered > 0 ? `（被这么一提，又多想起来 ${r.recovered} 个细节）` : ''
    lines.push('')
    // 故意不给她时间戳。
    // 精确到秒的"2026-10-28 13:19:01"不是回忆，是查数据库；
    // 而模糊化的"上个月"又要按圈调精度，等于替她撒谎。
    // 干脆不给 —— 她只记得内容和位置，时间感交给她自己从上下文里体会。
    lines.push(`${i + 1}. [${ringLabel(r.ring)}] ${r.content}`)
    if (r.points?.length) lines.push(`   记得的细节：${r.points.join('、')}${extra}`)
    else lines.push(`   只记得有这回事，细节想不起来了${extra}`)
  })
  return lines.join('\n')
}

function toolSearch({ keyword, limit = 10 }) {
  const kw = String(keyword ?? '').trim()
  if (!kw) throw new Error('keyword 不能为空')
  const rows = db.search(kw, { limit: Math.min(Number(limit) || 10, 30) })
  if (!rows.length) return `库里没有包含「${kw}」的记忆。`
  return [`包含「${kw}」的记忆（${rows.length} 条）：`]
    .concat(rows.map((m) => `- [${ringLabel(m.ring)} · ${fmtTime(m.created_at)}] ${m.content}`))
    .join('\n')
}

function toolOverview() {
  const stats = db.stats() || {}
  const recent = db.recent(12)
  // stats 的形状是 { ring1: { total, private, group }, ... }（ringStats 的约定），没有总数字段
  const countOf = (id) => Number(stats?.[id]?.total ?? 0)
  const total = HER_RINGS.reduce((n, id) => n + countOf(id), 0)
  const counts = HER_RINGS.map((id) => `${RINGS[id].label} ${countOf(id)}`)
  const lines = [`现在我记着 ${total} 条。各位置：${counts.join('、')}`, '', '最近记下的：']
  // 只列她看得见的四个位置；闲聊圈/模糊圈/回忆圈的她"想不起来"，不列
  const shown = recent.filter((m) => HER_RINGS.includes(m.ring)).slice(0, 6)
  if (!shown.length) lines.push('（还空着，没什么可想的）')
  else shown.forEach((m) => lines.push(`- [${ringLabel(m.ring)} · ${fmtTime(m.created_at)}] ${m.content}`))
  return lines.join('\n')
}

/**
 * 自动入库（给桥接层 / 视觉插件用的机器工具，不进她的工具清单）：
 * 她没表态的媒体描述落闲聊圈 —— 和 ring-ingest 的合并入库同一语义。
 * 故意不放进 TOOLS：工具清单是她的认知边界，自动入库不该被她（或 agent）点名调用。
 * 插件（留影）知道工具名，直接 tools/call 即可。
 */
function toolIngest({ content, points, source, speaker, at }) {
  const text = String(content ?? '').trim()
  if (!text) throw new Error('content 不能为空')
  const input = {
    content: text,
    ring: 'ring4',            // 自动入库 = 接盘层，她不知道有这一格
    speaker: String(speaker ?? 'user'),
    source: String(source ?? 'private'),
    skipVault: true,          // 原文已由桥接层逐条备份进总库，描述是派生物不重复存
  }
  if (Array.isArray(points) && points.length) input.points = points.map((p) => String(p).trim()).filter(Boolean)
  if (at) input.at = Number(at)
  const mem = db.remember(input)
  const pts = mem?.points?.length ?? 0
  return `留影入库（#${mem?.id ?? '?'} · 闲聊圈 · ${pts} 点）：${text.slice(0, 60)}`
}

// 没有 toolForget —— 她这边不提供删除。
// 分工铁律：她决定记什么，记忆库决定什么时候淡、什么时候掉。
// 「她不能直接删数据」写死在 docs/交接.md 第 92 行。
// 底层 Ringmind.forget() 还在（面板维护、误写入清理要用），只是不暴露给她。

/* ───────────────────────── 工具清单 ─────────────────────────
 * 描述就是她的"认知边界"：这里不出现 ring5 / recall，她想不起来用。
 *
 * ⚠️ TODO（2026-10-29 对账，暂未改）：
 *   按 docs/设计确认-2026-10-29.md 第一节，她**只看得见四个位置**——
 *   core / ring1 / ring2 / ring3。闲聊圈（ring4）是接盘层，她看不见。
 *   但这版 HER_RINGS 里还带着 ring4，下面 description 也写着"闲聊圈（四圈）= 日常（默认）"，
 *   和那份文档冲突。改它 = 改她的行为（她不能再往闲聊圈点名记），所以先留着等确认。
 *   要改的话三处一起：HER_RINGS、ring_remember 的 description、ringLabel() 的映射。
 */

const TOOLS = [
  {
    name: 'ring_remember',
    description:
      '把一件事记进你的记忆里。你自己决定记不记、放哪个位置 —— ' +
      '判断的锚是「这件事我以后还要不要提、多久以后还要提」：' +
      '自我圈（圆心）= 最最重要、绝不放手（一直要提）；一圈 = 想起来心还会动（很久以后）；' +
      '二圈 = 很开心或很难过（几个月后）；三圈 = 有点意思、值得留着（这周还会提）。' +
      '不记也没关系，不记的事会自然淡掉。' +
      '重要的事可以自己拆几个点（points），以后想起来就是这些点；不拆也行，库会按标点替你切。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '这件事的原文，越具体越好（谁、在哪、干了什么）' },
        ring: {
          type: 'string',
          enum: HER_RINGS,
          description: '放哪个位置（四个之一）。不填就不记 —— 不记的话这条会自然淡掉，你不用管。',
        },
        points: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：这件事里最要紧的几个点（按重要程度排，先说的重要）',
        },
        emotion: { type: 'number', description: '可选：当时的情绪强度 1-10' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'ring_recall',
    description:
      '被提醒的时候想起来：给几个由头（人、物、地点、词），捞回相关的记忆。' +
      '注意：捞回来的一定不全 —— 越久的事细节越少，这是正常的，别硬编。',
    inputSchema: {
      type: 'object',
      properties: {
        cues: {
          type: 'array',
          items: { type: 'string' },
          description: '由头关键词，比如 ["松花江", "采冰"]',
        },
        limit: { type: 'number', description: '最多想几条，默认 5', default: 5 },
      },
      required: ['cues'],
      additionalProperties: false,
    },
  },
  {
    name: 'ring_search',
    description: '按关键词在记忆里查原文（不触发"想起来"的模糊机制，查到的是原话）。想知道"我到底记过没有"时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要找的词' },
        limit: { type: 'number', description: '最多几条，默认 10', default: 10 },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
  },
  {
    name: 'ring_overview',
    description: '看看自己现在记着些什么：各位置各有几条、最近记下的几件事。想知道"我还记得她/他什么"时用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  // ⚠️ 故意不提供「删除」和「修改」。
  //    分工铁律（docs/交接.md 第 87 行）：她决定记什么，记忆库决定什么时候淡、什么时候掉。
  //    「她不能直接删数据，库不能替她判断意义」—— 这条不能混。
  //    记错了走 note 批注（更正 / 存疑），原文永远留着。
]

const HANDLERS = {
  ring_remember: toolRemember,
  ring_recall: toolRecall,
  ring_search: toolSearch,
  ring_overview: toolOverview,
  ring_ingest: toolIngest, // 机器工具：不进 TOOLS（她的认知边界），插件直呼工具名
}

/* ───────────────────────── JSON-RPC over stdio ───────────────────────── */

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (raw) => {
  const line = raw.trim()
  if (!line) return

  let msg
  try { msg = JSON.parse(line) } catch { return }

  // 通知（没有 id）不需要回
  if (msg.id === undefined || msg.id === null) return

  const ok = (result) => write({ jsonrpc: '2.0', id: msg.id, result })
  const err = (code, message) => write({ jsonrpc: '2.0', id: msg.id, error: { code, message } })

  try {
    switch (msg.method) {
      case 'initialize':
        ok({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ringmind', version: '1.0.1' },
        })
        return

      case 'ping':
        ok({})
        return

      case 'tools/list':
        ok({ tools: TOOLS })
        return

      case 'tools/call': {
        const name = msg.params?.name
        const args = msg.params?.arguments ?? {}
        const fn = HANDLERS[name]
        if (!fn) {
          ok({ content: [{ type: 'text', text: `没有这个工具：${name}` }], isError: true })
          return
        }
        try {
          ok({ content: [{ type: 'text', text: fn(args) }] })
        } catch (e) {
          // 工具失败走 result.isError（不是 JSON-RPC error）—— 这样模型能看到原因
          ok({ content: [{ type: 'text', text: `[ring] ${e?.message ?? e}` }], isError: true })
        }
        return
      }

      default:
        err(-32601, `method not found: ${msg.method}`)
    }
  } catch (e) {
    err(-32603, String(e?.message ?? e))
  }
})

rl.on('close', () => {
  try { db.close() } catch { /* 进程要退了，忽略 */ }
  process.exit(0)
})

// 兜底：别让未捕获异常把 stdio 弄脏
process.on('uncaughtException', (e) => {
  process.stderr.write(`[ring-mcp] uncaught: ${e?.stack ?? e}\n`)
})