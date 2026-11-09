# SnowLuma + qq-bridge · 在用（另一半）

> qq-bridge 是本机 DSH 侧的桥接插件，源码不在这个仓库。这里只写它和记忆库的边界。

## 它干什么、不干什么

```
QQ ──► SnowLuma（OneBot v11 WS）──► qq-bridge ──► DSH agent ──► mcp-ring ──► memory.db
                                         │
                                         └─ 把 mcp__ring__* 工具交给 agent
```

- **干**：把 QQ 消息送进 DSH 会话，把 agent 的回复发回 QQ；把记忆库的 MCP 工具挂给 agent
- **不干**：不自动写记忆。`ring_ingest` 是给「聊天框架那侧」用的机器工具，
  桥接层不需要替她记 —— 自动入库由会话框架负责（海螺 / AstrBot 插件）

所以接 qq-bridge 只需要管两件事：

## 1. 工具白名单

桥接会限制 agent 能调哪些 MCP 工具。`mcp__ring__` 不在白名单里时，
工具在 QQ 会话里直接看不见，调了也会被拒。

```
qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs
  SAFE_PREFIXES 里加 "mcp__ring__"
```

记忆库不给任何本机执行能力（没有 shell、没有文件写），加进去是安全的。

## 2. 别和别的路抢库

qq-bridge 这条链上，写记忆的是 agent 自己（`ring_remember`，她主动记）。
如果同时还有一份 AstrBot 插件在往**同一个** `.db` POST `/ingest`，
同一句话会进去两遍。

**三条路互斥**：qq-bridge（agent 主动记）/ `ingest-server`（HTTP 自动入库）/ 海螺（MCP 自动入库）。
要同时养两只机器人，给它们两个库文件。

## 她自己的话

桥接这条链上，她自己发出去的话**不会自动进记忆库** —— 只有海螺那侧会（`speaker=self`）。
如果以后想让桥接也记，挂到「发送成功之后」，不要提到「生成回复时」：
没发出去的回复不算她说过。