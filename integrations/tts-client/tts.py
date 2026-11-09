# -*- coding: utf-8 -*-
"""声来语音 · 框架无关的客户端

从 `integrations/astrbot/main.py` 里抽出来的那一小块：**只做「文本 → wav 文件」**。
不认任何框架，不读任何框架的配置，零第三方依赖（只用标准库）。

为什么要单独抽：同一个能力在 AstrBot、海螺、自己写的机器人里都要用，
各写一遍就会各踩一遍同样的坑（超时、错误 JSON 当音频、临时文件不删）。

用法（Python）
────────────
    from tts import speak
    wav = speak("今天中午吃的面不错")      # → '/tmp/shenglai_xxx.wav' 或 None
    if wav:
        ... 把 wav 当语音发出去 ...
        os.unlink(wav)

用法（命令行，任何语言的框架都能 exec 它）
────────────────────────────────────────
    python tts.py -t "今天中午吃的面不错" -o reply.wav
    python tts.py -t "你好" -o a.wav --voice 测试御姐 --rate 1.1
    python tts.py --check          # 只看声来面板通不通

配置（环境变量，都有默认值）
──────────────────────────
    SHENGLAI_URL     声来面板地址，默认 http://127.0.0.1:17878
    SHENGLAI_VOICE   默认音色名，默认 `测试御姐`
    SHENGLAI_RATE    语速，默认 1.0
    SHENGLAI_TIMEOUT 超时秒数，默认 30

注意
────
  · 合成失败一律返回 None / 退出码 1，**绝不抛异常**：语音挂了不能拖垮文字回复
  · 声来返回的是 WAV；QQ 那侧（NapCat / aiocqhttp）会自己转成语音消息
  · 一次调用一个文件，调用方负责删
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = os.environ.get("SHENGLAI_URL", "http://127.0.0.1:17878").rstrip("/")
DEFAULT_VOICE = os.environ.get("SHENGLAI_VOICE", "测试御姐")
DEFAULT_RATE = os.environ.get("SHENGLAI_RATE", "1.0")
TIMEOUT = float(os.environ.get("SHENGLAI_TIMEOUT", "30"))

# 超过这个长度就别合成了：又慢又贵，而且一条 5 分钟语音没人听
MAX_TEXT = 500
# 小于这么多字节几乎肯定是错误 JSON，不是音频
MIN_AUDIO = 512


def panel_alive(url: str = "") -> bool:
    """声来面板在不在（/api/speak 不带参数时会回错误 JSON，但连接能建立就算活着）"""
    base = (url or DEFAULT_URL).rstrip("/")
    try:
        with urllib.request.urlopen(base + "/", timeout=3) as resp:
            return resp.status < 500
    except urllib.error.HTTPError:
        return True  # 有 HTTP 响应就算活着
    except Exception:
        return False


def speak(text: str, voice: str = "", rate: str = "", url: str = "") -> str | None:
    """合成一句话，返回落地的临时 wav 路径；失败返回 None。

    text 为空 / 太长 → None。
    合成失败、超时、返回的不是音频 → None（不抛异常）。
    """
    body = str(text or "").strip()
    if not body:
        return None
    if len(body) > MAX_TEXT:
        body = body[:MAX_TEXT]

    base = (url or DEFAULT_URL).rstrip("/")
    params = {
        "voice": voice or DEFAULT_VOICE,
        "rate": rate or DEFAULT_RATE,
        "text": body,
    }
    req = urllib.request.Request(base + "/api/speak?" + urllib.parse.urlencode(params))
    try:
        audio = urllib.request.urlopen(req, timeout=TIMEOUT).read()
    except Exception:
        return None
    if len(audio) < MIN_AUDIO:
        return None

    fd, path = tempfile.mkstemp(suffix=".wav", prefix="shenglai_")
    with os.fdopen(fd, "wb") as f:
        f.write(audio)
    return path


def speak_to(text: str, out_path: str, voice: str = "", rate: str = "", url: str = "") -> bool:
    """合成到指定文件（CLI 用）。成功返回 True。"""
    tmp = speak(text, voice=voice, rate=rate, url=url)
    if not tmp:
        return False
    try:
        os.replace(tmp, out_path)
        return True
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="声来语音客户端：文本 → wav")
    ap.add_argument("-t", "--text", help="要合成的文本")
    ap.add_argument("-o", "--out", default="out.wav", help="输出的 wav 路径（默认 out.wav）")
    ap.add_argument("--voice", default="", help="音色名（默认取环境变量或「测试御姐」）")
    ap.add_argument("--rate", default="", help="语速（默认 1.0）")
    ap.add_argument("--url", default="", help="声来面板地址")
    ap.add_argument("--check", action="store_true", help="只检查面板通不通")
    args = ap.parse_args(argv)

    if args.check:
        ok = panel_alive(args.url)
        print(("声来面板在线：" if ok else "连不上声来面板：") + (args.url or DEFAULT_URL))
        return 0 if ok else 1

    if not args.text:
        ap.error("要么给 -t 文本，要么用 --check")

    if not speak_to(args.text, args.out, voice=args.voice, rate=args.rate, url=args.url):
        print("合成失败（文字照发，这条语音跳过）", file=sys.stderr)
        return 1
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())