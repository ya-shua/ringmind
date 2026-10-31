# -*- coding: utf-8 -*-
"""
环形的心 · AstrBot 转发插件

它只做一件事：把 AstrBot 收到的每一条消息，原样转给 ringmind 的入库服务
（server/ingest-server.mjs），让记忆库有人往里写。

它自己不做任何判断 ——
  · 该不该记   → 环心说了算（收到了就记）
  · 掉不掉     → 环心的衰减说了算
  · 要不要压缩 → 环心不做压缩，只删点
这里只是"搬运工"，一个字都不改消息内容。

装法
────
  1. 先把入库服务跑起来（在 ringmind 仓库根目录）：
       node server/ingest-server.mjs
  2. 把本目录整个丢进 AstrBot 的插件目录：
       <AstrBot>/data/plugins/astrbot_plugin_ring_ingest/
  3. 在 AstrBot WebUI 的插件页启用它
  4. 发一条消息，看到入库服务那边打印 vault 涨了，就成了

配置
────
  改本文件顶部的 INGEST_URL / TIMEOUT 即可，或者用环境变量：
    RING_INGEST_URL=http://127.0.0.1:5188/ingest

注意
────
  · 只有纯文本会进库。图片、语音、表情会记成 [图片] / [语音] / [表情] 这样的占位,
    因为环心现在没有视觉模型 —— 让它"假装看见了"比不记更糟。
  · 主人判定不在这里做。插件只把 QQ 号发过去，由入库服务的 owners 配置决定,
    这样换框架、换机器人都不用改插件。
"""

import asyncio
import json
import os
import urllib.request

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register

# ── 配置 ──────────────────────────────────────────────
INGEST_URL = os.environ.get("RING_INGEST_URL", "http://127.0.0.1:5188/ingest")
TIMEOUT = float(os.environ.get("RING_INGEST_TIMEOUT", "3"))

# 消息链里这些类型没有文本可存，记个占位就够
PLACEHOLDER = {
    "Image": "[图片]",
    "Record": "[语音]",
    "Video": "[视频]",
    "File": "[文件]",
    "Face": "[表情]",
    "Poke": "[戳一戳]",
}


@register(
    "astrbot_plugin_ring_ingest",
    "ringmind",
    "把 AstrBot 收到的消息转发给环形的心记忆库",
    "1.0.0",
    "https://github.com/ya-shua/ringmind",
)
class RingIngestPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.url = INGEST_URL

    # ── 工具 ──────────────────────────────────────────

    def _chain_to_text(self, event: AstrMessageEvent) -> str:
        """把消息链压成一行文本，非文本段记占位。"""
        try:
            chain = event.message_obj.message
        except Exception:
            return event.message_str or ""

        parts = []
        for seg in chain or []:
            name = type(seg).__name__
            text = getattr(seg, "text", None)
            if name == "Plain" and text:
                parts.append(text)
            elif name in PLACEHOLDER:
                parts.append(PLACEHOLDER[name])
            elif text:
                parts.append(str(text))

        joined = "".join(parts).strip()
        # 消息链拼不出来就退回纯文本
        return joined or (event.message_str or "").strip()

    def _build_payload(self, event: AstrMessageEvent, text: str, is_self: bool = False) -> dict:
        """凑一个入库服务认得的 JSON。字段拿不到就留空，不瞎猜。"""
        payload = {
            "text": text,
            "isSelf": is_self,
            "sender": event.get_sender_name() or "",
            "uid": str(event.get_sender_id() or ""),
            "umo": getattr(event, "unified_msg_origin", "") or "",
        }

        # 群聊才带群号；私聊 group_id 是空串
        gid = ""
        try:
            gid = str(event.get_group_id() or "")
        except Exception:
            pass
        if gid:
            payload["key"] = "group:" + gid
        elif payload["uid"]:
            payload["key"] = "private:" + payload["uid"]

        ts = None
        try:
            ts = event.message_obj.timestamp
        except Exception:
            pass
        if ts:
            payload["ts"] = int(ts) if int(ts) > 10**12 else int(ts) * 1000

        return payload

    async def _post(self, payload: dict):
        """发过去。失败只记日志，绝不往外抛 —— 记忆库挂了不该拖垮聊天。"""

        def _do():
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                self.url,
                data=body,
                headers={"Content-Type": "application/json; charset=utf-8"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read().decode("utf-8", "replace")

        try:
            # urllib 是阻塞的，丢到线程里，别卡住事件循环
            await asyncio.to_thread(_do)
        except Exception as e:
            print(f"[ring-ingest] 转发失败（记忆库那端没起来？）：{e}")

    # ── 收：别人说的 ──────────────────────────────────

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        text = self._chain_to_text(event)
        if not text:
            return
        await self._post(self._build_payload(event, text))

    # ── 收：她自己说的 ────────────────────────────────

    @filter.after_message_sent()
    async def on_sent(self, event: AstrMessageEvent):
        """她真正发出去的那句话。

        用 after_message_sent 而不是 on_llm_response：
        后者拿到的是"模型输出的原文"，可能被转语音、被装饰、被拆成多条，
        实际发出去的东西跟它不一定一样。这里拿到的是已经发完的最终结果。
        """
        text = ""
        try:
            result = event.get_result()
            chain = getattr(result, "chain", None)
            parts = []
            for seg in chain or []:
                name = type(seg).__name__
                t = getattr(seg, "text", None)
                if name == "Plain" and t:
                    parts.append(t)
                elif name in PLACEHOLDER:
                    parts.append(PLACEHOLDER[name])
                elif t:
                    parts.append(str(t))
            text = "".join(parts).strip()
        except Exception:
            pass

        if not text:
            return

        payload = self._build_payload(event, text, is_self=True)
        # 她说话时 sender_id 可能是对方，昵称要靠 self_id 补
        try:
            self_id = str(event.get_self_id() or "")
            if self_id:
                payload["uid"] = self_id
        except Exception:
            pass
        await self._post(payload)