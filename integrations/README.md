# 接别的框架 · 适配器目录

记忆库本体不认任何聊天框架。这一层把「常见框架怎么接」各写一份，
**每个框架一个薄适配器，只做三件事**：

```
① 拿到文本（收到的消息 / 要发出去的回复）
② 调通用层（写记忆 POST /ingest，或读记忆走 MCP）
③ 把结果挂回该框架的回复对象
```

**合并、幂等、衰减、容量、长度上限，全在通用层里，适配器一行都不许有。**
这样每加一个框架，只是加一个几十行的文件。

## 两条路，别混

| 路子 | 谁在用 | 怎么走 |
| --- | --- | --- |
| **HTTP `/ingest`** | AstrBot、NapCat 直连、自研机器人 | `POST http://127.0.0.1:5188/ingest` |
| **MCP 工具** | 海螺（在用）、任何 DSH agent | `ring_ingest` / `ring_remember` / `ring_recall` |

两条路的**写入行为完全一致**（同一份 `src/core/ingest.js`：五条判据合并 + `message_id` 幂等），
区别只是传输：HTTP 给「不在 DSH 里的机器人」，MCP 给「本来就在 DSH 里的会话」。

⚠️ **三条路别同时写同一个 `.db`**：`qq-bridge` / `ingest-server` / 海螺的 MCP —
同一句话会进去两遍。要养两只机器人，给它们两个库文件。

## 常见框架

| 框架 | 目录 | 状态 | 说明 |
| --- | --- | --- | --- |
| **海螺（conch）** | [`conch/`](conch/) | ✅ 在用 | 走 MCP，`speaker` 分 `user`/`self`，`conv_key` 一聊天一槽 |
| **AstrBot** | [`astrbot/`](astrbot/) | 📦 示例，未在使用 | 走 HTTP，一行 POST 就够 |
| **NapCat（OneBot v11）** | [`napcat/`](napcat/) | 📖 照着写 | 事件里有 `message_type`/`group_id`/`user_id`，直接 POST |
| **SnowLuma + qq-bridge** | [`qq-bridge/`](qq-bridge/) | ✅ 在用（另一半） | 桥接不写记忆，只把 MCP 工具交给 agent |

## 万能适配器模板

只要你的框架能拿到「文本 + 会话 + 发言方 + 时间」，粘一段就能用。

**Python**

```python
import json, time, urllib.request

INGEST = "http://127.0.0.1:5188/ingest"

def to_ring(text, conv_key, speaker="user", source="group", message_id="", note=""):
    """把一条消息写进记忆库。失败只打日志，绝不影响聊天。"""
    payload = {
        "text": text,
        "key": conv_key,          # private:<QQ号> 或 group:<群号>
        "speaker": speaker,       # user = 别人 / self = 她自己说的（存活 ×3）
        "source": source,
        "message_id": message_id, # 有它才幂等（重连/重发不会写两遍）
        "ts": int(time.time() * 1000),
    }
    if note:
        payload["note"] = note    # 可能不准的内容（语音转写）
    req = urllib.request.Request(
        INGEST, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass
```

**Node**

```js
const INGEST = 'http://127.0.0.1:5188/ingest'

async function toRing({ text, convKey, speaker = 'user', source = 'group', messageId = '', note = '' }) {
  try {
    await fetch(INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, key: convKey, speaker, source, message_id: messageId, note }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {}
}
```

## 每个框架都得回答的四个问题

1. **怎么指代"这一条属于哪段对话"** —— `private:<QQ>` / `group:<群号>`。
   群和私聊必须分开；**不同私聊也要分开**，否则张三和李四会被拼成同一条。
2. **怎么区分"谁说的"** —— 别人的话 `user`，她自己的话 `self`（存活时间 ×3）。
   别传显示名，那等于放弃权重。
3. **有没有稳定的消息 id** —— 有就传 `message_id`，重连重放不会重复写。
4. **语音转写放在哪** —— 正文放转写 + 标记（`[语音转写] …`），`note` 写「可能不准」。
   别把转写当原话存。

## 语音输出

跟记忆库无关，单独一份通用客户端：[`tts-client/`](tts-client/)（声来面板，零依赖 + CLI）。