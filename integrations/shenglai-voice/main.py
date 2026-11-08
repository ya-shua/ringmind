# -*- coding: utf-8 -*-
"""
环形的心 · 声来语音输出插件

她（AI 角色）的每条文字回复，自动用声来合成语音，跟在文字后面发出去。
文字照常发，语音跟一条 —— 关掉插件就回到纯文字。

它只做一件事：拿回复文本 → 调声来的 /api/speak → 把生成的音频挂到回复上。
  · 用哪个音色   → 你在声来面板登记的音色里选（配置 SHENGLAI_VOICE）
  · 合成失败     → 文字照发，语音静默跳过（绝不因为语音挂了丢回复）

装法
────
  1. 确认声来面板在跑：http://127.0.0.1:17878（双击桌面「声来」或 ZCode 里 /voice:panel）
  2. 在声来面板登记好音色（比如「测试御姐」）
  3. 把本目录整个丢进 AstrBot 的插件目录：
       <AstrBot>/data/plugins/astrbot_plugin_shenglai_voice/
  4. 在 AstrBot WebUI 的插件页启用它

配置（环境变量，可选）
────
  SHENGLAI_URL    声来面板地址（默认 http://127.0.0.1:17878）
  SHENGLAI_VOICE  默认音色名（默认 测试御姐）
  SHENGLAI_RATE   语速（默认 1.0）

会话命令
────
  /voice_on   开启本会话语音回复（默认开）
  /voice_off  关闭本会话语音回复

注意
────
  · 语音是 WAV 文件，NapCat/aiocqhttp 会转成 QQ 语音发出去
  · 声来用的音色来自免费音色大厅或你克隆的音色，合成费用取决于所选模型
"""

import asyncio
import os
import tempfile
import urllib.parse
import urllib.request

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register
import astrbot.api.message_components as Comp

# ── 配置 ──────────────────────────────────────────────
SHENGLAI_URL = os.environ.get("SHENGLAI_URL", "http://127.0.0.1:17878").rstrip("/")
SHENGLAI_VOICE = os.environ.get("SHENGLAI_VOICE", "测试御姐")
SHENGLAI_RATE = os.environ.get("SHENGLAI_RATE", "1.0")
TIMEOUT = float(os.environ.get("SHENGLAI_TIMEOUT", "30"))
MAX_TEXT = 500  # 超长回复不合成（防刷屏防超时）


def _plain_text(chain) -> str:
    """把 AstrBot 回复链里的纯文字拼出来。"""
    parts = []
    for comp in chain:
        t = getattr(comp, "text", None)
        if t and isinstance(t, str):
            parts.append(t)
    return "".join(parts).strip()


def _speak(text: str, voice: str, rate: str) -> str | None:
    """调声来的 /api/speak，返回落地的临时音频路径；失败返回 None。"""
    qs = urllib.parse.urlencode({"voice": voice, "text": text, "rate": rate})
    req = urllib.request.Request(f"{SHENGLAI_URL}/api/speak?{qs}")
    try:
        audio = urllib.request.urlopen(req, timeout=TIMEOUT).read()
    except Exception:
        return None
    if len(audio) < 512:  # 太短说明是错误 JSON 响应
        return None
    fd, path = tempfile.mkstemp(suffix=".wav", prefix="shenglai_")
    with os.fdopen(fd, "wb") as f:
        f.write(audio)
    return path


@register("shenglai_voice", "ya-shua", "声来语音输出", "1.0.0")
class ShengLaiVoicePlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.disabled_sessions: set[str] = set()  # 关了语音的会话

    # 每条 AI 回复发出去之前，挂一条语音
    @filter.on_decorating_result()
    async def speak_reply(self, event: AstrMessageEvent):
        origin = event.unified_msg_origin
        if origin in self.disabled_sessions:
            return
        result = event.get_result()
        if result is None or not result.chain:
            return
        text = _plain_text(result.chain)
        if not text or len(text) > MAX_TEXT:
            return
        loop = asyncio.get_event_loop()
        wav = await loop.run_in_executor(
            None, _speak, text, SHENGLAI_VOICE, SHENGLAI_RATE)
        if not wav:
            return
        try:
            result.chain.append(Comp.Record.fromFileSystem(wav))
        except Exception:
            pass  # 语音挂了不影响文字回复

    @filter.command("voice_on")
    async def voice_on(self, event: AstrMessageEvent):
        """开启本会话的语音回复"""
        self.disabled_sessions.discard(event.unified_msg_origin)
        yield event.plain_result("✅ 语音回复已开启")

    @filter.command("voice_off")
    async def voice_off(self, event: AstrMessageEvent):
        """关闭本会话的语音回复"""
        self.disabled_sessions.add(event.unified_msg_origin)
        yield event.plain_result("🔇 语音回复已关闭")
