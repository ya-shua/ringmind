/**
 * 环形的心 · 在线更新
 *
 * 跟本项目一个路子：零依赖，只用 Node 自带的东西。
 *
 * 规矩（重要）：
 *   - 只碰代码，绝不碰数据。data/、libraries.json、data-location.json、
 *     onebot.json、token.txt 全在 .gitignore 里，git 更新时不会动它们。
 *   - 有本地改动就先 stash 再更新，不会硬盖掉别人改的东西。
 *   - 更新完自己重启面板；起不来也不会把原来的库搞坏。
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

/** 仓库和分支：改仓库名只要改这两行 */
const REPO = "ya-shua/ringmind";
const BRANCH = "main";
const API = "https://api.github.com/repos/" + REPO;

/** 数据类文件：更新前后要确认它们还在、字节没变 */
const DATA_GUARD = ["libraries.json", "data-location.json", "onebot.json"];

function run(cmd, args, opts = {}) {
  return new Promise((ok) => {
    execFile(cmd, args, { cwd: ROOT, windowsHide: true, timeout: 90000, ...opts }, (err, stdout, stderr) => {
      ok({
        ok: !err,
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

export function localVersion() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return String(j.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function isGitCheckout() {
  return existsSync(join(ROOT, ".git"));
}

function ghHeaders() {
  const h = { "User-Agent": "ringmind-panel", Accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

/** 记一下数据文件的指纹，更新后再比一次 */
function dataFingerprint() {
  const out = {};
  for (const f of DATA_GUARD) {
    const p = join(ROOT, f);
    try {
      if (existsSync(p)) out[f] = readFileSync(p, "utf8").length + ":" + f;
      else out[f] = "missing";
    } catch {
      out[f] = "error";
    }
  }
  return out;
}

/**
 * 最小 tar 解析：GitHub 的源码包是 gzip 过的 ustar。
 * 只认得普通文件（type '0' / '\0'），目录和链接直接跳过 —— 够用了。
 */
function untarGz(buf) {
  const raw = zlib.gunzipSync(buf);
  const files = new Map();
  let off = 0;
  while (off + 512 <= raw.length) {
    const head = raw.subarray(off, off + 512);
    // 全零块 = 结束
    let zero = true;
    for (let i = 0; i < 512; i++) if (head[i] !== 0) { zero = false; break; }
    if (zero) break;

    const nameRaw = head.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeOctal = head.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const type = String.fromCharCode(head[156] || 48);
    const prefix = head.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(sizeOctal, 8) || 0;

    // ustar 的长路径分成 prefix + name
    let name = nameRaw;
    if (prefix) name = prefix + "/" + name;

    off += 512;
    if (type === "0" || type === "\0") {
      if (name && size >= 0) {
        files.set(name, raw.subarray(off, off + size));
      }
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * 走 GitHub API 下载源码包然后覆盖 —— git 协议在国内常被重置，这条路一般通。
 *
 * 只覆盖仓库里跟踪的文件（清单来自本地 git），不会碰 data/ 这些没跟踪的东西。
 */
async function applyViaTarball() {
  const r = await fetch(API + "/tarball/" + BRANCH, {
    headers: ghHeaders(),
    redirect: "follow",
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) {
    throw new Error("下载源码包失败：HTTP " + r.status + (r.status === 404 ? "（仓库还没公开）" : ""));
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const files = untarGz(buf);
  if (!files.size) throw new Error("源码包是空的");

  // GitHub 的包外面套了一层 <owner>-<repo>-<sha>/
  const first = [...files.keys()][0] || "";
  const slash = first.indexOf("/");
  const strip = slash > 0 ? slash + 1 : 0;

  // 只写仓库跟踪的文件，且不许跑到仓库外面去
  const tracked = await run("git", ["ls-files"]);
  const allow = new Set(
    (tracked.ok ? tracked.stdout : "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  let written = 0;
  let skipped = 0;
  const ROOT_ABS = resolve(ROOT);
  for (const [rel, data] of files) {
    const p = strip ? rel.slice(strip) : rel;
    if (!p || p.endsWith("/")) continue;
    if (!allow.has(p)) { skipped++; continue; }
    const abs = resolve(join(ROOT, p));
    if (!abs.startsWith(ROOT_ABS + (process.platform === "win32" ? "\\" : "/")) && abs !== ROOT_ABS) {
      skipped++;
      continue;
    }
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, data);
      written++;
    } catch {
      skipped++;
    }
  }

  return { mode: "tarball", written, skipped, total: files.size };
}

/**
 * 查有没有新版
 *
 * 先用 API 拿远端最新提交，跟本地 HEAD 比；
 * 不一样才去 fetch 算差几个提交（fetch 慢，别每次都做）。
 */
// GitHub 匿名查询每小时只有 60 次，面板每 30 分钟自动查一次也会攒着耗掉。
// 3 分钟内复用上一次结果，别把额度烧完。
const CHECK_TTL_MS = 3 * 60_000;
let lastCheckAt = 0;
let lastCheckResult = null;

export function clearCheckCache() {
  lastCheckAt = 0;
  lastCheckResult = null;
}

export async function checkForUpdate({ force = false } = {}) {
  if (!force && lastCheckResult && Date.now() - lastCheckAt < CHECK_TTL_MS) {
    return lastCheckResult;
  }
  const result = await checkForUpdateOnce();
  lastCheckAt = Date.now();
  lastCheckResult = result;
  return result;
}

async function checkForUpdateOnce() {
  const current = localVersion();
  const git = isGitCheckout();

  if (!git) {
    return {
      ok: true,
      current,
      latest: current,
      hasUpdate: false,
      canAutoUpdate: false,
      reason: "这个装法不是 git 克隆的，没法自动更新。想自动更新就 git clone 一份。",
      repoUrl: "https://github.com/" + REPO,
    };
  }

  const head = await run("git", ["rev-parse", "HEAD"]);
  const localSha = head.ok ? head.stdout : "";

  // 同时记下内容树：commit 的 sha 会因为提交时间/作者不同而变化，
  // 但内容一样时 tree 的 sha 一定一样。比内容比 commit 更靠得住。
  const headTree = await run("git", ["rev-parse", "HEAD^{tree}"]);
  const localTree = headTree.ok ? headTree.stdout : "";

  // 只用 GitHub API，不跑 git fetch —— 国内直连 git 协议能卡到一分多钟
  const opt = { headers: ghHeaders(), signal: AbortSignal.timeout(8000) };

  let remoteSha = "";
  let remoteTree = "";
  let remoteError = null;
  try {
    const r = await fetch(API + "/commits/" + BRANCH, opt);
    if (r.ok) {
      const j = await r.json();
      remoteSha = String(j.sha || "");
      remoteTree = String(j.commit?.tree?.sha || "");
    } else {
      if (r.status === 403 || r.status === 429) {
        const reset = r.headers.get("x-ratelimit-reset");
        const when = reset
          ? new Date(Number(reset) * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
          : "一会儿";
        remoteError = "GitHub 的匿名查询次数用完了（每小时 60 次），" + when + " 之后再试";
      } else {
        remoteError =
          "GitHub 返回 " + r.status +
          (r.status === 404 ? "（仓库还没公开，别人也就下载不了）" : "");
      }
    }
  } catch (e) {
    remoteError = "连不上 GitHub：" + (e?.name === "TimeoutError" ? "超时" : e?.message || e);
  }

  if (!remoteSha) {
    return {
      ok: false,
      current,
      latest: current,
      hasUpdate: false,
      canAutoUpdate: false,
      error: remoteError || "拿不到远端版本",
      repoUrl: "https://github.com/" + REPO,
    };
  }

  const sameContent = !!(localTree && remoteTree && localTree === remoteTree);

  if ((localSha && remoteSha === localSha) || sameContent) {
    return {
      ok: true,
      current,
      latest: current,
      hasUpdate: false,
      canAutoUpdate: true,
      localSha,
      remoteSha,
      localTree,
      remoteTree,
      sameContent,
      behind: 0,
      ahead: 0,
      repoUrl: "https://github.com/" + REPO,
    };
  }

  // 不一样 → 问 compare 接口差多少，顺手拿几条新提交说明
  let behind = 0;
  let ahead = 0;
  let latestVersion = current;
  let commits = [];

  if (localSha) {
    try {
      const cr = await fetch(API + "/compare/" + localSha + "..." + BRANCH, opt);
      if (cr.ok) {
        const cj = await cr.json();
        // compare 是 base(本地)...head(远端)：
        //   ahead_by  = 远端比本地多的提交 → 本地落后多少，就是要更新多少
        //   behind_by = 本地比远端多的提交 → 本地有多少没推上去
        behind = Number(cj.ahead_by) || 0;
        ahead = Number(cj.behind_by) || 0;
        if (Array.isArray(cj.commits)) {
          commits = cj.commits
            .slice(-6)
            .reverse()
            .map((c) => ({
              sha: String(c.sha || "").slice(0, 8),
              message: String(c.commit?.message || "").split("\n")[0].slice(0, 90),
              date: String(c.commit?.author?.date || "").slice(0, 10),
            }));
        }
      }
    } catch {}
  }

  // 远端 package.json 的版本号
  try {
    const pr = await fetch(API + "/contents/package.json?ref=" + BRANCH, opt);
    if (pr.ok) {
      const pj = await pr.json();
      if (pj && pj.content) {
        const txt = Buffer.from(pj.content, "base64").toString("utf8");
        latestVersion = String(JSON.parse(txt).version || latestVersion);
      }
    }
  } catch {}

  if (behind === 0 && ahead === 0 && remoteSha !== localSha) behind = 1;

  return {
    ok: true,
    current,
    latest: latestVersion,
    hasUpdate: behind > 0,
    canAutoUpdate: true,
    localSha,
    remoteSha,
    behind,
    ahead,
    commits,
    repoUrl: "https://github.com/" + REPO,
    compareUrl: "https://github.com/" + REPO + "/compare/" + (localSha || BRANCH) + "..." + BRANCH,
  };
}

/**
 * 执行更新
 *
 * 顺序：备份数据指纹 → stash 本地改动 → 合并远端 → 核对指纹 → 报告
 * 任何一步不对都退回原样。
 */
export async function applyUpdate() {
  if (!isGitCheckout()) {
    return { ok: false, error: "不是 git 装的，没法自动更新" };
  }

  const before = dataFingerprint();
  const fromVersion = localVersion();
  const fromSha = (await run("git", ["rev-parse", "HEAD"])).stdout;

  // 本地有改动就先收起来（不丢，留在 stash 里）
  const st = await run("git", ["status", "--porcelain"]);
  const dirty = st.ok && st.stdout.length > 0;
  let stashed = false;
  if (dirty) {
    const label = "ringmind-auto-update-" + new Date().toISOString().replace(/[:.]/g, "-");
    const s = await run("git", ["stash", "push", "--include-untracked", "-m", label]);
    if (!s.ok) {
      return { ok: false, error: "本地有改动，且自动收起来失败：" + (s.stderr || s.stdout) };
    }
    stashed = true;
  }

  const f = await run("git", ["fetch", "--quiet", "origin", BRANCH]);

  if (!f.ok) {
    // git 协议不通（国内常见）：改走 API 源码包，只覆盖代码文件
    let via = null;
    try {
      via = await applyViaTarball();
    } catch (e) {
      if (stashed) await run("git", ["stash", "pop", "--quiet"]);
      return {
        ok: false,
        error: "拉取失败，源码包也没下成：" + (e?.message || e),
        detail: f.stderr || f.stdout || null,
      };
    }
    clearCheckCache();
    const after2 = dataFingerprint();
    const lost2 = Object.keys(before).filter((k) => before[k] !== "missing" && after2[k] === "missing");
    return {
      ok: true,
      mode: "tarball",
      fromVersion,
      toVersion: localVersion(),
      fromSha,
      toSha: fromSha,
      stashed,
      written: via.written,
      warning: lost2.length ? "这些数据文件不见了：" + lost2.join("、") : null,
      note: "git 协议连不上，改用源码包覆盖了 " + via.written + " 个文件。",
    };
  }

  const m = await run("git", ["merge", "--ff-only", "origin/" + BRANCH]);
  if (!m.ok) {
    // 不是快进（本地有分叉提交），退回
    if (stashed) await run("git", ["stash", "pop", "--quiet"]);
    return {
      ok: false,
      error: "没法快进更新（本地有分叉的提交）。可以手动处理，或者删掉重装。",
      detail: m.stderr || m.stdout,
    };
  }

  // 数据文件核对：必须还在，且不是被删了
  clearCheckCache();
  const after = dataFingerprint();
  const lost = Object.keys(before).filter((k) => before[k] !== "missing" && after[k] === "missing");
  if (lost.length) {
    return {
      ok: true,
      warning: "更新完了，但这些数据文件不见了：" + lost.join("、") + "。请手动检查。",
      fromVersion,
      toVersion: localVersion(),
      fromSha,
      toSha: (await run("git", ["rev-parse", "HEAD"])).stdout,
      stashed,
    };
  }

  return {
    ok: true,
    fromVersion,
    toVersion: localVersion(),
    fromSha,
    toSha: (await run("git", ["rev-parse", "HEAD"])).stdout,
    stashed,
    stashNote: stashed
      ? "你之前的本地改动已收进 git stash，需要的话用 git stash list / git stash pop 找回。"
      : null,
  };
}

/**
 * 更新完重启自己
 *
 * 做法：写一个临时 .bat，脱离父进程跑：
 *   等几秒（让这次请求先回出去）→ 杀掉占 5173 的进程（包括自己）→ 再启动
 * 面板起来之前，前端会一直轮询 /api/health。
 */
export async function restartPanel({ port = 5173, delayMs = 1200 } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, error: "自动重启目前只支持 Windows，请手动重启面板" };
  }

  const vbs = join(ROOT, "后台启动.vbs");
  if (!existsSync(vbs)) {
    return { ok: false, error: "找不到「后台启动.vbs」，请手动重启面板" };
  }

  // 交给独立的 PowerShell 进程：等几秒 → 杀掉占端口的进程 → 再启动
  const ps = [
    "Start-Sleep -Seconds 3",
    "$p = Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue",
    "if ($p) { $p.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }",
    "Start-Sleep -Seconds 3",
    'Start-Process wscript.exe -ArgumentList "' + vbs + '"',
  ].join("; ");

  // 关键：用 -EncodedCommand 传脚本。
  // 直接 -Command 会把带中文的路径经命令行传过去，编码一错就启动不了。
  const encoded = Buffer.from(ps, "utf16le").toString("base64");

  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
  } catch (e) {
    return { ok: false, error: "起重启进程失败：" + (e?.message || e) };
  }

  // 给 HTTP 响应留点时间，然后自己退
  setTimeout(() => process.exit(0), Math.max(300, delayMs));

  return { ok: true, restarting: true, delayMs };
}
