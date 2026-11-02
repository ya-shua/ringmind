/**
 * QQ 聊天记录导入 —— 对接 QQ Chat Exporter（QCE）
 *
 * 思路：我们自己不解密任何东西。QCE 注入进 QQ 进程，让 QQ 自己把消息交出来，
 * 我们只负责问它要、拿回来、送进记忆库。
 *
 * QCE 那边必输的两个前提：
 *   · 它在跑，监听 127.0.0.1:40653
 *   · %USERPROFILE%\.qq-chat-exporter\security.json 里有 accessToken
 *
 * 这里刻意不引第三方依赖 —— 跟主程序保持一致，只用 node: 自带的。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** QCE 默认端口，它自己写死在程序里 */
export const QCE_PORT = 40653;
export const QCE_BASE = `http://127.0.0.1:${QCE_PORT}`;

/** 令牌文件放在用户主目录下 */
export function qceTokenPath() {
  return join(homedir(), ".qq-chat-exporter", "security.json");
}

/**
 * 读 QCE 的访问令牌。
 * 文件不在或者读烂了都返回 null —— 调用方据此判断"还没装 / 还没跑过"。
 */
export function readQceToken() {
  const p = qceTokenPath();
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const t = j?.accessToken;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** 带超时的 fetch，把超时和其他网络错误区分开 */
async function hit(url, opts = {}, ms = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: r.ok, status: r.status, body, text };
  } catch (e) {
    const msg = e?.message || String(e);
    return {
      ok: false,
      status: 0,
      body: null,
      text: "",
      // 连不上是最常见的情况（QCE 没跑 / 端口不通），别把 fetch 的原始报错甩给用户
      error:
        e?.name === "AbortError"
          ? "超时"
          : /fetch failed|ECONNREFUSED|other side closed/i.test(msg)
            ? "连不上"
            : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测 QCE 是否就绪。
 *
 * 返回的 state 是给界面直接用的，四种：
 *   no-token   没装过 / 从来没跑起来过（连令牌文件都没有）
 *   offline    装了但没在跑（端口不通）
 *   unauthorized 在跑，但令牌不对（可能换了用户或重置过）
 *   ready      能用了
 *
 * 刻意不抛异常 —— 这本来就是"可能没有"的东西，不该让面板因此报错。
 */
export async function probeQce() {
  const token = readQceToken();

  // 先探端口。用一个不需要令牌就会应答的路径判断"活着没有"。
  // /api/users/lookup 需要令牌，401 也说明服务在跑，正好能区分"没跑"和"令牌错"。
  const r = await hit(`${QCE_BASE}/api/users/lookup?uin=10000`, {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });

  if (r.status === 0) {
    return {
      state: token ? "offline" : "no-token",
      tokenPath: qceTokenPath(),
      hasToken: Boolean(token),
      base: QCE_BASE,
      error: r.error || "连不上",
    };
  }

  if (r.status === 401 || r.status === 403) {
    return {
      state: "unauthorized",
      tokenPath: qceTokenPath(),
      hasToken: Boolean(token),
      base: QCE_BASE,
      error: "令牌无效",
    };
  }

  // 其余情况（200 / 404 / 400）都说明 HTTP 服务活着
  return {
    state: token ? "ready" : "no-token",
    tokenPath: qceTokenPath(),
    hasToken: Boolean(token),
    base: QCE_BASE,
    status: r.status,
    body: r.body,
  };
}

/** 所有需要令牌的调用都走这里，统一带 Authorization */
async function api(path, { token, method = "GET", body = null, ms = 15000 } = {}) {
  if (!token) throw new Error("没有 QCE 令牌，先启动一次 QCE");
  return hit(`${QCE_BASE}${path}`, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, ms);
}

/**
 * QQ 号 → peerUid。
 * QCE 的漫游接口只认 peerUid，纯数字会被拒。
 */
export async function lookupPeer(qq, token) {
  const r = await api(`/api/users/lookup?uin=${encodeURIComponent(String(qq))}`, { token });
  if (!r.ok || !r.body?.success) {
    return { ok: false, error: r.error || r.body?.message || "查询失败" };
  }
  const d = r.body.data || {};
  if (!d.found) return { ok: false, error: "这个号查不到会话" };
  return { ok: true, uid: String(d.uid || "") };
}

/**
 * 列好友 / 群。
 *
 * 这两个接口是实测出来的，不是猜的：
 *   GET /api/friends → data.friends[]  { uid, uin, nick, remark, avatarUrl }
 *   GET /api/groups  → data.groups[]   { groupCode, groupName, memberCount, remark }
 *
 * 好友里包含"自己"这一条，界面上要不要显示由调用方决定。
 */
export async function listFriends(token) {
  const r = await api("/api/friends?page=1&pageSize=1000", { token, ms: 20000 });
  if (!r.ok || !r.body?.success) {
    return { ok: false, error: r.error || r.body?.message || `HTTP ${r.status}` };
  }
  const d = r.body.data || {};
  const arr = Array.isArray(d.friends) ? d.friends : [];
  return {
    ok: true,
    total: Number(d.totalCount || arr.length),
    list: arr.map((f) => ({
      uid: String(f.uid || ""),
      uin: String(f.uin || ""),
      name: f.remark || f.nick || String(f.uin || ""),
      nick: f.nick || "",
      remark: f.remark || "",
      avatar: f.avatarUrl || "",
      online: Boolean(f.isOnline),
      kind: "friend",
    })),
  };
}

export async function listGroups(token) {
  const r = await api("/api/groups?page=1&pageSize=1000", { token, ms: 20000 });
  if (!r.ok || !r.body?.success) {
    return { ok: false, error: r.error || r.body?.message || `HTTP ${r.status}` };
  }
  const d = r.body.data || {};
  const arr = Array.isArray(d.groups) ? d.groups : [];
  return {
    ok: true,
    total: Number(d.totalCount || arr.length),
    list: arr.map((g) => ({
      uid: String(g.groupCode || ""),
      uin: String(g.groupCode || ""),
      name: g.groupName || String(g.groupCode || ""),
      remark: g.remark || "",
      members: Number(g.memberCount || 0),
      avatar: g.avatarUrl || "",
      kind: "group",
    })),
  };
}

/**
 * 最近会话：本机 QQ 里真正聊过的那些（含临时会话、群聊）。
 * 好友列表里没有的会话（比如非好友的单聊）就在这里 —— 导入最该从这份名单开始。
 */
export async function listRecentContacts(token) {
  const r = await api("/api/recent-contacts?limit=500&includeAll=true", { token, ms: 20000 });
  if (!r.ok || !r.body?.success) {
    return { ok: false, error: r.error || r.body?.message || `HTTP ${r.status}` };
  }
  const d = r.body.data || {};
  const arr = Array.isArray(d.contacts) ? d.contacts : Array.isArray(d.recentContacts) ? d.recentContacts : [];
  return {
    ok: true,
    list: arr.map((c) => ({
      uid: String(c.peerUid || c.uid || ""),
      uin: String(c.uin || ""),
      name: c.name || c.nick || c.remark || String(c.uin || c.peerUid || ""),
      chatType: Number(c.chatType ?? c.type ?? 1),
      lastTs: Number(c.timestamp || c.lastTimestamp || 0),
      kind: Number(c.chatType ?? c.type ?? 1) === 2 ? "group" : "friend",
    })),
  };
}

/**
 * 建一个导出任务。
 *
 * start / end 用 Unix 秒。format 默认 JSON —— 记忆库要结构化的。
 */
export async function startRoamingExport({
  token,
  peerUid,
  sessionName = "",
  start,
  end,
  format = "JSON",
  maxMessages = 50000,
}) {
  const r = await api("/api/messages/roaming/export", {
    token,
    method: "POST",
    body: {
      peer: { chatType: 1, peerUid, guildId: "" },
      sessionName,
      format,
      filter: { startTime: Math.floor(start), endTime: Math.floor(end) },
      options: { includeResourceLinks: false, prettyFormat: false },
      roaming: { maxMessages },
    },
    ms: 30000,
  });
  if (!r.ok || !r.body?.success) {
    return { ok: false, error: r.error || r.body?.message || `HTTP ${r.status}` };
  }
  return { ok: true, data: r.body.data || {} };
}

/**
 * 本地导出：不走 QQ 服务器漫游，直接读本机 QQ 的数据库。
 * 会话没开漫游、或漫游记录不在服务器上时（漫游接口报业务码 -2），这条路照样能拉到
 * 本机存着的记录 —— 好友私聊和群聊都支持。
 */
export async function startLocalExport({
  token,
  peerUid,
  chatType = 1,
  sessionName = "",
  start,
  end,
  format = "JSON",
}) {
  const r = await api("/api/messages/export", {
    token,
    method: "POST",
    body: {
      peer: { chatType, peerUid, guildId: "" },
      sessionName,
      format,
      filter: { startTime: Math.floor(start), endTime: Math.floor(end) },
      options: { includeResourceLinks: false, prettyFormat: false },
    },
    ms: 30000,
  });
  if (!r.ok || !r.body?.success) {
    return { ok: false, error: r.error || r.body?.message || `HTTP ${r.status}` };
  }
  return { ok: true, data: r.body.data || {} };
}

/** 查任务进度 */
export async function getTask(taskId, token) {
  const r = await api(`/api/tasks/${encodeURIComponent(taskId)}`, { token });
  if (!r.ok || !r.body?.success) {
    return { ok: false, error: r.error || r.body?.message || `HTTP ${r.status}` };
  }
  return { ok: true, data: r.body.data || {} };
}

/** 取消任务 */
export async function cancelTask(taskId, token) {
  const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
    token,
    method: "POST",
    body: {},
  });
  return { ok: r.ok && r.body?.success !== false, data: r.body?.data || {} };
}

/**
 * 把 QCE 导出的 JSON 拆成一条条消息。
 *
 * 谁说的这件事，靠 sender.uin 和"机器人号"比：
 *   · 用户填了机器人号 → 按填的来（换过号就填多个，旧的也算她）
 *   · 没填 → 退回 chatInfo.peerUin（这次导出对应的那一位）
 *
 * 这样换号不会把历史一起废掉：老号的话只要在名单里，仍然算她说的。
 */
export function parseExport(json, botUins = []) {
  const info = json?.chatInfo || {};
  const selfUin = String(info.selfUin || "");
  const peerUin = String(info.peerUin || "");

  const bots = new Set((Array.isArray(botUins) ? botUins : []).map((x) => String(x).trim()).filter(Boolean));
  if (bots.size === 0 && peerUin) bots.add(peerUin);

  const raw = Array.isArray(json?.messages) ? json.messages : [];
  const out = [];
  for (const m of raw) {
    const uin = String(m?.sender?.uin || "");
    const text = typeof m?.content?.text === "string" ? m.content.text : "";
    // 空文本、纯图片、撤回、系统提示都不进记忆库 —— 记下来也没用
    if (!text.trim()) continue;
    if (m?.recalled) continue;
    if (m?.system) continue;

    out.push({
      id: String(m?.id || ""),
      seq: String(m?.seq || ""),
      ts: Number(m?.timestamp || 0),
      uin,
      // self = 她说的（机器人），owner = 主人说的
      who: bots.has(uin) ? "self" : "owner",
      text: text.trim(),
    });
  }

  return {
    chatName: info.name || "",
    // private / group —— memories.source 只认这两个值
    chatType: String(info.type || "private"),
    selfUin,
    peerUin,
    bots: [...bots],
    total: raw.length,
    kept: out.length,
    messages: out,
  };
}
export async function downloadResult(downloadUrl, token, ms = 120000) {
  if (!token) throw new Error("没有 QCE 令牌");
  // 下载只准打 QCE 自己 —— 这个请求带着 Bearer 令牌，放去别的地址
  // 等于把令牌送出去（面板要是被人塞了个外链，令牌就漏了）
  const raw = String(downloadUrl || "");
  let url;
  if (raw.startsWith("/")) {
    url = QCE_BASE + raw;
  } else {
    try {
      const u = new URL(raw);
      const base = new URL(QCE_BASE);
      if (u.protocol !== base.protocol || u.host !== base.host) {
        return { ok: false, error: "下载地址不是 QCE 的（" + u.host + "），已拒绝" };
      }
      url = u.href;
    } catch {
      return { ok: false, error: "下载地址不对" };
    }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: ctl.signal,
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, buf };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "下载超时" : e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 列出 QCE 里已经导好的任务（不管是谁发起的）。
 * 用户在 QCE 自己的界面里导完，面板靠这个把它找回来。
 */
export async function listTasks(token, limit = 60) {
  const d = await hit(`${QCE_BASE}/api/tasks?page=1&pageSize=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000);
  if (!d.ok) throw new Error(d.error || `QCE 回了 HTTP ${d.status}`);
  const b = d.body || {};
  const raw = b?.data?.tasks || b?.tasks || [];
  const tasks = [];
  for (const t of raw) {
    if (t.taskKind && t.taskKind !== "roaming_export" && t.taskKind !== "export") continue;
    if (!t.downloadUrl && !t.filePath) continue;
    tasks.push({
      taskId: t.taskId || "",
      fileName: t.fileName || "",
      downloadUrl: t.downloadUrl || "",
      filePath: t.filePath || "",
      messageCount: t.messageCount ?? 0,
      status: t.status || t.taskStatus || "",
      sessionName: t.sessionName || "",
      chatType: t.peer?.chatType ?? 0,
      // QCE 给的是 ISO 字符串，统一成毫秒，前端自己格式化
      createdAt: t.createdAt ? new Date(t.createdAt).getTime() : 0,
    });
  }
  return { tasks };
}

// ── 自动安装 QCE ───────────────────────────────────────
//
// 装到 <项目>/vendor/qce/（vendor/ 已在 .gitignore 里，不进仓库）。
//
// 为什么要有这一套：QCE 不是 npm 包，是个几十 MB 的注入包。
// 让用户自己去 GitHub 找 asset、解压、找 bat，太容易卡住。
// 但这一步本质是"程序自动下载并运行第三方 exe"，所以必须由用户
// 点一次确认才开始，绝不偷偷做。
//
// 全程只有三个阶段：查版本 → 下载 → 解压。启动单独一个动作，
// 因为启动前要先确认 QQ 已经退了。

const QCE_REPO = "shuakami/qq-chat-exporter";
const INSTALL_TIMEOUT = 10 * 60 * 1000;

/** 安装任务的当前状态。同一时间只允许一个。 */
let installJob = null;

export function installState() {
  return installJob
    ? { ...installJob }
    : { phase: "idle", pct: 0, message: "还没开始", done: false, error: null };
}

/** 已经装好的话，返回 napiLoader.bat 的路径，没有就 null */
export function findLauncher(dir) {
  const candidates = [
    join(dir, "napiLoader.bat"),
    join(dir, "launcher-user.bat"),
    join(dir, "NapCat-Framework-QCE", "napiLoader.bat"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** 找版本号最高、名字最像 Framework 包的那个 asset */
function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const framework = assets.filter((a) => /napi|framework/i.test(a.name) && /\.zip$/i.test(a.name));
  if (framework.length) return framework[0];
  // 退一步：任何 zip 都行，但优先 Framework
  const anyZip = assets.filter((a) => /\.zip$/i.test(a.name));
  const preferred = anyZip.find((a) => /framework/i.test(a.name));
  return preferred || anyZip[0] || null;
}

/**
 * 启动安装。立刻返回，进度看 installState()。
 * 同一时间只跑一个；已经在跑就返回 false。
 */
export function startInstall(dir) {
  if (installJob && !installJob.done) return false;

  installJob = {
    phase: "resolving",
    pct: 0,
    message: "查最新版本…",
    done: false,
    error: null,
    version: null,
    file: null,
    startedAt: Date.now(),
  };

  (async () => {
    try {
      const { mkdir, writeFile, rm, rename } = await import("node:fs/promises");
      const { execFile } = await import("node:child_process");
      const { tmpdir } = await import("node:os");

      await mkdir(dir, { recursive: true });

      // ① 查最新 release
      const rel = await fetch(`https://api.github.com/repos/${QCE_REPO}/releases/latest`, {
        headers: { "User-Agent": "ringmind", Accept: "application/vnd.github+json" },
      });
      if (!rel.ok) throw new Error(`查版本失败（HTTP ${rel.status}）`);
      const release = await rel.json();
      const asset = pickAsset(release);
      if (!asset) throw new Error("这个版本里没找到可用的 zip");

      installJob.version = release.tag_name || "";
      installJob.file = asset.name;
      installJob.phase = "downloading";
      installJob.message = "下载 " + asset.name + "…";

      // ② 下载
      const ctl = new AbortController();
      const killer = setTimeout(() => ctl.abort(), INSTALL_TIMEOUT);
      let buf;
      try {
        const r = await fetch(asset.browser_download_url, {
          headers: { "User-Agent": "ringmind" },
          signal: ctl.signal,
        });
        if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`);
        const total = Number(r.headers.get("content-length") || asset.size || 0);

        if (r.body && total > 0) {
          const chunks = [];
          let got = 0;
          for await (const ch of r.body) {
            chunks.push(ch);
            got += ch.length;
            installJob.pct = Math.min(95, Math.round((got / total) * 95));
            installJob.message = `下载中 ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
          }
          buf = Buffer.concat(chunks);
        } else {
          buf = Buffer.from(await r.arrayBuffer());
        }
      } finally {
        clearTimeout(killer);
      }

      if (!buf || buf.length < 1024) throw new Error("下载下来是空的");

      // ③ 解压。
      // 这里必须写成临时 .ps1 再用 -File 跑：
      // 多行脚本塞进 -Command 时换行会被吞，路径和后面的语句黏成一行，
      // 报错会变成"未能找到文件 D:\...\qce') [System.IO.Compression..."这种鬼样子。
      installJob.phase = "extracting";
      installJob.pct = 96;
      installJob.message = "解压…";

      const zipPath = join(tmpdir(), "qce-" + Date.now() + ".zip");
      const psPath = join(tmpdir(), "qce-unzip-" + Date.now() + ".ps1");
      await writeFile(zipPath, buf);

      const q = (s) => s.replace(/'/g, "''");
      const ps = [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `$zipPath = '${q(zipPath)}'`,
        `$dest = '${q(dir)}'`,
        "if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }",
        "New-Item -ItemType Directory -Path $dest -Force | Out-Null",
        // Zip Slip 防线：压缩包条目名可以写 ..\，不做这道检查，解压就能把文件写到目标目录外面去
        "$destRoot = [System.IO.Path]::GetFullPath($dest + [System.IO.Path]::DirectorySeparatorChar)",
        "$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)",
        "try {",
        "  foreach ($e in $zip.Entries) {",
        "    $target = [System.IO.Path]::GetFullPath((Join-Path $dest $e.FullName))",
        "    if (-not $target.StartsWith($destRoot, [System.StringComparison]::OrdinalIgnoreCase)) {",
        "      throw ('压缩包里有条目想跑到目标目录外面：' + $e.FullName)",
        "    }",
        "    if ([string]::IsNullOrEmpty($e.Name)) {",
        "      New-Item -ItemType Directory -Path $target -Force | Out-Null",
        "    } else {",
        "      $parent = Split-Path $target -Parent",
        "      if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }",
        "      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)",
        "    }",
        "  }",
        "} finally { $zip.Dispose() }",
      ].join("\r\n");

      // 带 BOM 的 UTF-8，否则中文路径在 PowerShell 里会被按 GBK 解成乱码
      await writeFile(psPath, "\uFEFF" + ps, "utf8");

      await new Promise((ok, fail) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psPath],
          { timeout: 300000 },
          (err, _so, se) => (err ? fail(new Error(String(se || err.message).split("\n")[0].trim())) : ok())
        );
      });

      await rm(zipPath, { force: true }).catch(() => {});
      await rm(psPath, { force: true }).catch(() => {});

      installJob.phase = "done";
      installJob.pct = 100;
      installJob.message = "装好了";
      installJob.done = true;
      installJob.launcher = findLauncher(dir);
    } catch (e) {
      installJob.phase = "error";
      installJob.done = true;
      installJob.error = e?.message || String(e);
      installJob.message = "没装成";
    }
  })();

  return true;
}

/**
 * QQ 在不在跑，跑的是哪几个号。
 *
 * QQ NT 多开时每个号一个主进程，命令行带 `--from-multiple-login <uin>`，
 * 其余都是这个主进程的子进程（gpu / renderer / network...）。
 * 所以只认带这个参数的那些，拿到的就是"真正登录着的号"。
 *
 * 调用方要的是"我该退哪个"，不是"QQ 开没开" —— 所以返回号列表。
 */
export async function qqRunning() {
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise((ok) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | Select-Object -ExpandProperty CommandLine",
        ],
        { timeout: 10000 },
        (e, so) => ok(String(so || ""))
      );
    });
    const uins = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/--from-multiple-login\s+(\d{5,12})/);
      if (m) uins.add(m[1]);
    }
    return { any: /QQ\.exe/i.test(out) || uins.size > 0, uins: [...uins] };
  } catch {
    // 拿不到就当没开 —— 宁可放行让用户自己判断，也别因为探测失败把人挡在门外
    return { any: false, uins: [] };
  }
}

/**
 * 启动 napiLoader.bat。
 *
 * 这里不做"还有 QQ 在跑就一律拒绝"的硬拦：多开环境下你很可能只退了一个号，
 * 另一个还挂着。真正要满足的是"我要注入的那个号已经退出"，
 * 判断权交给用户 —— 界面把在跑的号列出来，由他决定。
 */
export async function launchQce(launcher) {
  if (!launcher || !existsSync(launcher)) {
    return { ok: false, error: "找不到 napiLoader.bat，可能还没装好" };
  }
  try {
    const { execFile } = await import("node:child_process");
    const dir = launcher.slice(0, Math.max(launcher.lastIndexOf("\\"), launcher.lastIndexOf("/"))) || ".";
    // start 的引号规则很坑：路径带空格时第一段引号会被当成窗口标题，
    // 所以显式给一个空标题占位。
    await new Promise((ok, fail) => {
      execFile(
        "cmd.exe",
        ["/c", "start", "", "/D", dir, launcher],
        { timeout: 20000 },
        (e) => (e ? fail(e) : ok())
      );
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}