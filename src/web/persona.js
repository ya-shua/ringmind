/**
 * 人格筛选 —— 让她自己读一段对话，决定记住什么。
 *
 * 跟"全量计入"的根本区别：
 *   全量计入 = 每条消息原样塞进圈，不管有没有意义
 *   人格筛选 = 她读完整段，挑出真正值得记的事，自己写成一条记忆
 *
 * 为什么不是逐条问「这条要不要」：
 *   两万条问两万次，她会答成机器，而且贵十倍。
 *   读一段、归纳出几件事，那才是"记"这个动作本来的样子。
 *
 * 这里只做「问她」和「解析她的回答」，不碰数据库。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** 她可以放进去的位置。ring4 及以下不给她选 —— 那些是"还没想清楚"的接盘层。 */
const ALLOWED_RINGS = ["core", "ring1", "ring2", "ring3", "ring4"];

/** 一次喂多少条。太少浪费调用次数，太多她会抓不住重点。 */
export const BATCH_SIZE = 60;

export function personaConfigPath(dir) {
  return dir + "/persona.json";
}

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-chat",
  // 她的人格。留空就只用下面的任务说明。
  persona: "",
  enabled: false,
};

export function readPersonaConfig(dir) {
  const p = personaConfigPath(dir);
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return { ...DEFAULTS, ...(j && typeof j === "object" ? j : {}) };
  } catch {
    return { ...DEFAULTS, __corrupt: true };
  }
}

export function writePersonaConfig(dir, patch) {
  const cur = readPersonaConfig(dir);
  const next = { ...cur, ...(patch || {}) };
  delete next.__corrupt;
  // 只留认识的字段，别把界面塞进来的杂项也写进文件
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = next[k];
  writeFileSync(personaConfigPath(dir), JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}

/** 把一条消息压成她能读的一行 */
function line(m) {
  const who = m.who === "self" ? "我" : "他";
  const t = new Date(Number(m.ts) || Date.now());
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${who}(${hh}:${mm}): ${m.text}`;
}

/** 一批消息 → 一次请求的 prompt */
function buildMessages(cfg, batch, chatName) {
  const head =
    (cfg.persona ? cfg.persona.trim() + "\n\n---\n\n" : "") +
    `下面是一段聊天记录${chatName ? `（${chatName}）` : ""}，从旧到新。\n\n` +
    "请你以你自己的视角读一遍，挑出**真正值得记住**的事。\n\n" +
    "要求：\n" +
    "1. 不要逐条判断。几段闲聊里能提炼出一件事就够了，也可能一件事都没有。\n" +
    "2. 每条记忆用一句你自己的话写，别照抄原话。\n" +
    "3. 给每条标一个圈：\n" +
    "   core  = 钉住的秘密、底线、承诺\n" +
    "   ring1 = 想起来心里还会一动的事\n" +
    "   ring2 = 很开心或很难过的事\n" +
    "   ring3 = 有点意思、值得留着的日常\n" +
    "   ring4 = 没什么分量但不想完全丢的\n" +
    "4. 完全没价值的（纯表情、纯语气词、重复的寒暄）直接不要。\n" +
    "5. 只输出 JSON 数组，不要解释。格式：\n" +
    '   [{"remember":"一句话","ring":"ring2","emotion":7}]\n' +
    "   没值得记的就输出 []。\n\n" +
    "聊天记录：\n";

  const body = batch.map(line).join("\n");
  return head + body;
}

/** 从模型回答里抠出 JSON 数组 */
function extractJson(text) {
  if (!text) return null;
  const s = String(text).trim();
  // 有的模型会包 ```json ... ```
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : s;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * 问她一批。
 * 返回 { ok, items:[{remember,ring,emotion}], usage, error }
 */
export async function askBatch(cfg, batch, chatName) {
  if (!cfg.apiKey) return { ok: false, error: "没配 API Key" };

  const url = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "") + "/chat/completions";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.model || DEFAULTS.model,
        messages: [{ role: "user", content: buildMessages(cfg, batch, chatName) }],
        temperature: 0.3,
        max_tokens: 2000,
        stream: false,
      }),
      signal: ctl.signal,
    });

    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}

    if (!r.ok) {
      const msg = j?.error?.message || text.slice(0, 200);
      return { ok: false, error: `HTTP ${r.status}：${msg}` };
    }

    const content = j?.choices?.[0]?.message?.content || "";
    const arr = extractJson(content);
    if (!arr) return { ok: false, error: "她没按格式回答", raw: content.slice(0, 300) };

    const items = [];
    for (const it of arr) {
      const remember = typeof it?.remember === "string" ? it.remember.trim() : "";
      if (!remember) continue;
      let ring = String(it?.ring || "ring3");
      if (!ALLOWED_RINGS.includes(ring)) ring = "ring3";
      const emotion = Math.max(0, Math.min(10, Number(it?.emotion) || 0));
      items.push({ remember, ring, emotion });
    }

    return { ok: true, items, usage: j?.usage || null };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "超时" : e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 切成批 */
export function chunk(list, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}