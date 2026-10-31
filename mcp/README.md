# 环形的心 · MCP 壳（mcp/）

把记忆库接到 DSH agent 上的那只手。记忆库本体只是个 npm 包，接不上任何东西；这一层把它变成她能调用的工具。

## 谁在用它

```
QQ ──► SnowLuma（OneBot v11 WS）──► qq-bridge ──► DSH agent ──► mcp-ring ──► memory.db
                                                       │
                                                       └─ 同一个 agent 也能在 DSH 桌面端直接用
```

`server.mjs` 是 stdio MCP server，**直接 in-process 打开 .db**，不经过 HTTP。

## 为什么不用 HTTP 接

- 不占端口：DSH 3080/50643、桥接 3100、SnowLuma 3000/3001 都不用动，也就不存在端口冲突。
- 不用鉴权：没有网络边界，也就没有 token 泄到 QQ 群里的风险。
- 一次会话一个进程：DSH 每次起会话时 spawn 它，退出就关库，不会长期占着 sqlite。

## 冲突与解决（接之前踩过的）

| 冲突 | 症状 | 解法 |
| --- | --- | --- |
| QQ 账号独占 | 两个机器人框架（如 AstrBot + SnowLuma）同时登同一个号，消息双收双回、被风控 | 只留一条链路：SnowLuma → qq-bridge → DSH。AstrBot 不启动 |
| QQ 安全守卫 | `qq-tool-restrict` 白名单不含 `mcp__ring__`，工具在 QQ 会话里被隐藏，调用还会被拒 | 在 `qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 加 `mcp__ring__`（纯记忆读写，无本机执行能力） |
| SnowLuma token 不一致 | httpServer 和 wsServer 的 accessToken 不同，桥接只配一个 ⇒ WebSocket 1006、QQ 侧"发消息完全没反应" | 把 `config/onebot_<QQ号>.json` 里两个 token 统一 |
| DSH 端口漂移 | 桌面版每次启动换端口，`dsh.baseUrl` 写死就永久失联 | 不用管，`bridge.js` 已有端口扫描自愈（日志里会写「DSH 端点已更新」） |
| 记忆双库 | 和 Hindsight（工程记忆）互相污染、上下文翻倍 | 分工：ring 只记人味（谁说过什么、生活小事），工具描述与预设章节里写明边界，不做自动注入 |
| sqlite 并发写 | 面板与 MCP 同时写同一条库 | 库用 WAL；MCP 的写是串行的，别同时开第二个写进程（面板只读就没事） |

## 五个工具

| 工具 | 干什么 |
| --- | --- |
| `ring_remember` | 记一件事，自己挑位置（圆心 / 一圈 / 二圈 / 三圈 / 闲聊圈），可拆点 |
| `ring_recall` | 给几个由头，想起来一部分（想不全才正常） |
| `ring_search` | 按关键词查原话（不触发遗忘机制） |
| `ring_overview` | 各位置各有几条、最近记了什么 |
| `ring_forget` | 主动忘掉一条 |

**模糊圈（五圈）和回忆圈不对她暴露**：不进工具 enum、不进返回文案，掉进去只显示"记不太清了"。
详见 `src/core/rings.js`（位置定义与可见比例）和 `src/core/recall.js`（想起来时怎么挑点）。

## 每天补跑一次降级

`decay()` 不跑计时就是死的。MCP 每次被 spawn 时检查 `.decay-state.json`，
跨天就按错过的天数补跑（每轮掉一圈，所以错过几天要跑几次）。

## 自测

```bash
# 用内存库跑一遍五个工具，不碰真库
RING_DB=:memory: node --input-type=module -e "
import { spawn } from 'node:child_process'
" # 或直接喂 JSON-RPC（见 docs）
```

生产验证（本机实测过）：

```bash
dsh --profile headless "调用 ring_overview 工具，把它返回的原文逐字贴出来"
```