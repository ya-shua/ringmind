# 接 AstrBot

> 环心本体不依赖任何机器人框架。它只认两样东西：**MCP 工具**（她主动记/查）和
> **一个 HTTP 写入接口**（别人把聊天灌进来）。这一层就是后者。

---

## 为什么需要它

以前只有 `qq-bridge` 会往环心写。换成 AstrBot、NapCat 直连、自研 Python 机器人，
记忆库就是空的 —— MCP 工具都在，但库里面一条数据没有，她调 `ring_recall` 什么也捞不到。

`server/ingest-server.mjs` 把"写入"抽成一个 HTTP 接口，**谁的框架都能接，环心一行代码没改**。

---

## 链路

```
QQ 消息 ──► AstrBot 插件 ──POST /ingest──► ingest-server ──► memory.db
                                                          ├─ vault  每条原文，永不合并
                                                          └─ ring4  同一段对话合并成一条
她的回复 ─────────────────────────────────┘（isSelf=true，单独存）
```

---

## 三步装好

### 1. 跑入库服务

在 ringmind 仓库根目录：

```bash
node server/ingest-server.mjs
```

看到这行就是好了：

```
[ring-ingest] listening http://127.0.0.1:5188
  库: /path/to/data/memory.db
  主人: 1234567890
  合并窗口: 300 秒
```

**换成你的主人 QQ**：在 `server/ingest.json` 里写（没有这个文件就建一个）：

```json
{
  "owners": ["你的QQ号"],
  "mergeWindowMs": 300000,
  "maxChars": 600,
  "port": 5188
}
```

或者用环境变量：`RING_OWNERS=123456,789012 node server/ingest-server.mjs`

### 2. 装 AstrBot 插件

把 `integrations/astrbot/` 整个目录复制到：

```
<AstrBot>/data/plugins/astrbot_plugin_ring_ingest/
```

目录里应该有 `main.py`。然后在 AstrBot WebUI 的插件页启用它。

> 入库服务不在本机的话，进 `main.py` 改 `INGEST_URL`，或者设环境变量 `RING_INGEST_URL`。

### 3. 验一下

发一条消息，看入库服务那边：

```bash
curl http://127.0.0.1:5188/health
# {"ok":true,"vault":1,...}
```

`vault` 从 0 变成 1 就成了。

---

## 接口

### `POST /ingest`

```jsonc
{
  "text": "今天中午吃的面不错",     // 必填
  "umo": "aiocqhttp:private:1234567890",  // 可选，AstrBot 的 UMO
  "uid": "1234567890",              // 可选，发送者 QQ（判主人用）
  "key": "private:1234567890",      // 可选，老格式
  "sender": "某人",                  // 可选，昵称
  "isSelf": false,                  // 可选，是不是她自己说的
  "ts": 1761926400000               // 可选，毫秒时间戳，默认现在
}
```

返回：

```jsonc
{ "ok": true, "action": "new", "memoryId": "m_xxx", "vault": 12 }
// action 是 "new"（新开一条）或 "append"（并进了上一条）
```

### `GET /health`

```jsonc
{ "ok": true, "db": "…", "vault": 119, "memories": { "ring4": {...}, … }, "owners": [...], "mergeWindowMs": 300000 }
```

---

## 四条它故意不做的事

| 不做 | 为什么 |
|---|---|
| **不跑衰减** | 掉圈由 `mcp/server.mjs` 启动时补跑，或面板上手点。这个服务只负责记 |
| **不改内容** | 一个字不动，只截断超过 `maxChars` 的部分 |
| **不做过滤** | 收到就记。该不该让某条入记忆，是框架那边的事 |
| **不压缩** | 环心的降级是**确定性地删点**，从不调 LLM 改写字句 |

---

## 几个坑

**① 昵称是占位词**

有些框架拿不到昵称，会塞 `私聊` / `群聊` / `未知` 进来。直接拼前缀会变成：

```
私聊：私聊：我还以为你要上天了
```

入库服务认这些词，见到了就当没有名字、不补前缀。你要加自己的占位词，改
`server/ingest-server.mjs` 里的 `PLACEHOLDERS`。

**② 主人判定**

不靠 AstrBot 的 `admins_id`（那是 WebUI 登录名，不是 QQ 号）。靠 `uid` 比 `owners`。
所以插件必须把 `uid` 发过来 —— `main.py` 已经带了。

配了 `owners` 之后，主人的话在总库里长这样：

```
2026/10/31 22:38｜私聊：【管理员】某人：今天中午吃的面不错
```

**③ 图片和语音**

现在只记 `[图片]` / `[语音]` 这种占位。**环心还没有视觉模型，让它"假装看见了"比不记更糟。**
等接了视觉模型再改。要加自己的占位词，改 `main.py` 的 `PLACEHOLDER`。

**④ 合并窗口**

同一段对话会合并成一条进闲聊圈，**五条判据**（同一个聊天 / 同一个发言方 / 时间不回溯 /
间隔 ≤ 90 秒 / 本段 ≤ 5 分钟），规则在 `src/core/ingest.js`，HTTP 和 MCP 共用一份。
**不合并的话，5 天上限一到就直接爆了。**

⑤ **别把工具回执当记忆**（这条最容易犯）

「用音色 X 说了一句 Y」「调用了 Z 工具」这种是**操作记录**，不是她说的话。
一夜之间能灌进来几十条，把闲聊圈挤满，还会盖住真正的聊天。
要么别写，要么包成一条真记忆再写 —— 千万别一次合成写一条。
真要留痕，带上 `message_id`（重发不会重复）和 `speaker`（她自己说的传 `self`）。

---

## 和 qq-bridge 的关系

**两条路互斥，别同时接到同一个库。**

```
qq-bridge（Node）  →  src/ring-ingest.mjs      → 库
AstrBot（Python）  →  server/ingest-server.mjs → 库
```

如果两套都往同一个 `.db` 写，总库里同一句话会出现两次，圈里的合并顺序也会乱。
同一台机器想同时养两只机器人，就**用两个库文件**：

```bash
RING_DB=/path/to/bot-a.db node server/ingest-server.mjs --port 5188
RING_DB=/path/to/bot-b.db node server/ingest-server.mjs --port 5189
```