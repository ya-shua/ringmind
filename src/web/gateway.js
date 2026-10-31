/**
 * 网关自愈 —— 换 QQ 号后，面板自己把 token 换成对的。
 * ============================================================================
 * 为什么要有这个文件：
 *
 *   SnowLuma 的 OneBot 配置是**按账号分文件**的：`<SnowLuma>/config/onebot_<QQ号>.json`。
 *   换号登录后，新号的 accessToken 和旧号不一样，而面板的 `onebot.json` 里存的还是旧的
 *   —— 于是探测直接 401（retcode 1401），面板上一律显示「网关异常」。
 *
 *   更麻烦的是：**同一个号，HTTP（3000）和 WebSocket（3001）的 token 还是两个不同的值**。
 *   老版本这两个值一样，所以一直没暴露；换成不一样的号时就栽了。
 *
 *   这里不猜，也不解析日志：把 SnowLuma 配置目录下所有账号的 HTTP token 挨个拿去问一次
 *   `get_login_info`，哪个通就用哪个，然后写回 `onebot.json`。
 *
 * 和 qq-bridge 的 `snowluma-conn.js` 是同一套思路（那边已经跑通很久了）。
 *
 * 只在探测失败时触发，正常路径一行都不跑；带节流，不会把健康检查拖慢。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 自愈节流：同一次故障里别反复扫盘 */
const HEAL_COOLDOWN_MS = 60_000;
let lastHealAt = 0;
let lastHealResult = null;

/**
 * 从 SnowLuma 主目录读出所有账号的网关配置。
 *
 * 目录里可能有多个 `onebot_<QQ号>.json`（换过几次号就会有好几份），
 * 还可能有 `.bak-xxx` 之类的备份 —— 只认严格命名的正式文件。
 *
 * @param {string} gatewayDir SnowLuma 主目录（不是 config 子目录）
 * @returns {Array<{uin:string, file:string, http:{token:string,host:string,port:number}|null}>}
 */
export function readGatewayAccounts(gatewayDir) {
  if (!gatewayDir) return [];
  const dir = join(gatewayDir, "config");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在 / 没权限 —— 当作没有，上层退回手动配置
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^onebot_(\d+)\.json$/i.exec(e.name); // 备份文件自动被排除
    if (!m) continue;
    const file = join(dir, e.name);
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      const http = Array.isArray(j?.networks?.httpServers) ? j.networks.httpServers[0] : null;
      out.push({
        uin: m[1],
        file,
        http: http
          ? {
              token: String(http.accessToken ?? ""),
              host: String(http.host || "127.0.0.1"),
              port: Number(http.port) || 3000,
            }
          : null,
      });
    } catch {
      // 单个文件坏了不影响其它账号
    }
  }
  return out.sort((a, b) => a.uin.localeCompare(b.uin));
}

/** 试一次 get_login_info：通了返回账号信息，不通返回 null。 */
async function probeLogin(baseUrl, token, timeoutMs) {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/get_login_info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    if (body?.status !== "ok" || body?.retcode !== 0) return null;
    return body.data || {};
  } catch {
    return null;
  }
}

/**
 * 找出一个**真能用**的网关配置。
 *
 * 候选顺序：先试现在存着的那份（说不定只是网关刚重启还没起好），
 * 再按账号逐个试配置目录里的 token。谁通就用谁。
 *
 * @param {{ url?:string, token?:string, gatewayDir?:string }} ob 当前配置
 * @param {{ timeoutMs?:number, force?:boolean }} [opt]
 * @returns {Promise<null | {token:string, url:string, uin:string, self:object, changed:boolean}>}
 */
export async function healGateway(ob, { timeoutMs = 2000, force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastHealAt < HEAL_COOLDOWN_MS) return lastHealResult;
  lastHealAt = now;

  const baseUrl = String(ob?.url || "http://127.0.0.1:3000");
  const accounts = readGatewayAccounts(ob?.gatewayDir);
  if (!accounts.length) {
    lastHealResult = null; // 没配目录 / 目录读不到 —— 无从下手，退回原来的错误提示
    return null;
  }

  // ① 先试现有的（不浪费一次机会：可能只是网关还没起好）
  if (ob?.token) {
    const self = await probeLogin(baseUrl, ob.token, timeoutMs);
    if (self && String(self.user_id ?? "") !== "") {
      lastHealResult = { token: ob.token, url: baseUrl, uin: String(self.user_id), self, changed: false };
      return lastHealResult;
    }
  }

  // ② 再按账号逐个试
  for (const acc of accounts) {
    if (!acc.http?.token) continue;
    if (acc.http.token === ob?.token) continue; // 上面已经试过了
    const url = `http://${acc.http.host}:${acc.http.port}`;
    const self = await probeLogin(url, acc.http.token, timeoutMs);
    if (!self || String(self.user_id ?? "") === "") continue;
    lastHealResult = {
      token: acc.http.token,
      url,
      uin: String(self.user_id),
      self,
      changed: acc.http.token !== ob?.token || url !== baseUrl,
    };
    return lastHealResult;
  }

  lastHealResult = null;
  return null;
}

/**
 * 把找到的配置写回 `onebot.json`。
 *
 * 只改 token / url 两个字段，别的（控制台地址、密码、gatewayDir）原样保留。
 * 写失败不抛：自愈成功但落盘失败，这次的会话照样能用，只是下次还得再自愈一遍。
 *
 * @returns {boolean} 是否真的写过
 */
export function saveGatewayConfig(file, ob, healed) {
  if (!healed?.changed) return false;
  try {
    const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const next = {
      ...cur,
      url: healed.url || cur.url || "http://127.0.0.1:3000",
      token: healed.token,
    };
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 测试用：把节流状态清掉，免得用例之间互相影响。 */
export function resetHealCooldownForTest() {
  lastHealAt = 0;
  lastHealResult = null;
}