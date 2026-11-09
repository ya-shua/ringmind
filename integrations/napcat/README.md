# NapCat（OneBot v11）· 照着写

NapCat 是 OneBot v11 的实现，任何语言接它的 WebSocket 就能收发消息。
记忆库这边给它一条 HTTP 路：**收到一条就 POST 一条**。

不需要装插件，二十行代码的事。

## 字段对照

NapCat 推给你的事件 → `/ingest` 要的字段：

| NapCat（OneBot v11） | 给 `/ingest` | 说明 |
| --- | --- | --- |
| `message_type`（`private`/`group`） | `source` | 原样 |
| `group_id` | `key = "group:" + group_id` | 群聊 |
| `user_id` | `key = "private:" + user_id` | 私聊，**按对方 QQ 分槽**，别都用 `private` |
| `sender.card` / `sender.nickname` | `sender` | 名字只进正文，**不要**当 `speaker` |
| `message_id` | `message_id` | 有了才幂等 |
| `time`（**秒**） | `ts`（毫秒） | `time * 1000` |
| `raw_message` | `text` | 纯文本；图片建议自己打成 `[图片]` |
| 她自己发的（自己 QQ 号的消息事件） | `isSelf: true` | → `speaker=self`，存活 ×3 |

## 最小实现（Python，用 websockets）

```python
import asyncio, json, urllib.request
import websockets

WS = "ws://127.0.0.1:3001"            # NapCat 的 WS 地址
INGEST = "http://127.0.0.1:5188/ingest"
SELF_ID = "1000001"                    # 她自己的 QQ 号（示例，换成真的）privacy-ok

def to_ring(payload):
    try:
        req = urllib.request.Request(
            INGEST, data=json.dumps(payload).encode(), method="POST",
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass   # 记忆库挂了不能拖垮聊天

def on_event(ev):
    if ev.get("post_type") != "message":
        return
    kind = ev.get("message_type")           # private / group
    text = (ev.get("raw_message") or "").strip()
    if not text:
        return                              # 纯图/纯表情：没有文字可记
    uid = str(ev.get("user_id") or "")
    is_self = uid == SELF_ID
    if kind == "group":
        key = "group:" + str(ev.get("group_id"))
    else:
        # 私聊：对方发来的就按对方分槽；她自己发的按会话对方分槽
        key = "private:" + (uid if not is_self else str(ev.get("target_id") or ev.get("self_id")))
    sender = (ev.get("sender") or {}).get("card") or (ev.get("sender") or {}).get("nickname") or ""
    to_ring({
        "text": text,
        "key": key,
        "sender": sender,
        "source": "group" if kind == "group" else "private",
        "isSelf": is_self,
        "message_id": str(ev.get("message_id") or ""),
        "ts": int(ev.get("time") or 0) * 1000,
    })

async def main():
    async with websockets.connect(WS) as ws:
        async for raw in ws:
            try:
                ev = json.loads(raw)
            except Exception:
                continue
            on_event(ev)

asyncio.run(main())
```

## 三件事别做

1. **别把 `sender` 当 `speaker`** —— 显示名会让衰减退化成普通待遇。
2. **别所有私聊都用 `key="private"`** —— 不同的人会被并成同一条记忆。
3. **别在记忆库里面做合并** —— 合并、幂等、90 秒窗口都在记忆库那侧，这边只管一条一条 POST。