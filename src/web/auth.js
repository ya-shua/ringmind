/**
 * 环形的心 · 访问令牌
 *
 * 跟 SnowLuma 一个路子：第一次启动生成一串随机令牌，
 * 打印在启动窗口里，同时写进 data/token.txt。
 * 忘了就看文件，想换就改文件（或者面板里改）。
 *
 * 为什么不用账号密码：
 *   这东西跑在自己电脑/自己的服务器上，多一个用户名只是多一个要记的东西。
 *   一串够长的令牌，安全性比"用户名 + 短密码"高得多。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = "token.txt";

/** 令牌长度：24 个字符，约 144 bit，暴力猜基本没戏 */
const TOKEN_BYTES = 18;

/**
 * 确保有令牌
 *
 * @param {string} dataDir 数据目录，比如 ./data
 * @param {object} [opts]
 * @param {boolean} [opts.silent] 不打印
 * @returns {{token: string, created: boolean, path: string}}
 */
export function ensureToken(dataDir, { silent = false } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, TOKEN_FILE);

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 8) {
      return { token: existing, created: false, path };
    }
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  writeFileSync(path, token + "\n", "utf8");

  if (!silent) {
    console.log("");
    console.log("  环形的心 · 首次启动");
    console.log("  ─────────────────────────────");
    console.log("  访问令牌:  " + token);
    console.log("  已写入:    " + path);
    console.log("  打开面板时用它登录，记不住就回来看这个文件。");
    console.log("");
  }

  return { token, created: true, path };
}

/**
 * 校验令牌
 *
 * 用恒定时间比较，不因为前面几位对错而提前返回。
 *
 * @param {string} dataDir
 * @param {string} input 用户输入的
 * @returns {boolean}
 */
export function verifyToken(dataDir, input) {
  const path = join(dataDir, TOKEN_FILE);
  if (!existsSync(path)) return false;

  const real = readFileSync(path, "utf8").trim();
  const given = String(input ?? "").trim();

  if (!real || !given) return false;

  const a = Buffer.from(real, "utf8");
  const b = Buffer.from(given, "utf8");

  if (a.length !== b.length) {
    // 长度不同也要走一遍比较，避免用长度差异试探
    timingSafeEqual(a, a);
    return false;
  }

  return timingSafeEqual(a, b);
}

/**
 * 换一个新令牌
 *
 * @param {string} dataDir
 * @param {string} [custom] 自己指定；不传就随机生成
 * @returns {string} 新的令牌
 */
export function rotateToken(dataDir, custom) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, TOKEN_FILE);

  const token =
    custom && String(custom).trim().length >= 8
      ? String(custom).trim()
      : randomBytes(TOKEN_BYTES).toString("base64url");

  writeFileSync(path, token + "\n", "utf8");
  return token;
}

/** 读当前令牌（只在本地调试时用，别发给外面） */
export function readToken(dataDir) {
  const path = join(dataDir, TOKEN_FILE);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim() || null;
}

/**
 * 极简的会话管理：登录成功后发一个 cookie，24 小时有效
 *
 * 服务端只需要记 token 的哈希，不存原文。
 */
export function makeSessionCookie() {
  return "ringmind_session=" + randomBytes(24).toString("base64url") + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400";
}