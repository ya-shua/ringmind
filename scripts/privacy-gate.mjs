#!/usr/bin/env node
/**
 * 隐私门禁 —— 提交 / 推送前检查有没有把不该上传的东西带出去。
 *
 * 用法：
 *   node scripts/privacy-gate.mjs --staged    只查暂存区（pre-commit 用）
 *   node scripts/privacy-gate.mjs --all       查全部已跟踪文件（CI 用）
 *   node scripts/privacy-gate.mjs --files a b 查指定文件
 *
 * 退出码：0 = 通过；1 = 有拦截项；2 = 参数错。
 *
 * ── 为什么要分级、为什么不裸扫数字 ────────────────────────────
 * 「5-11 位数字」同时匹配真 QQ 号、端口号、毫秒常量、字节数、测试假号。
 * 裸扫的结果是满屏误报，人就会养成「反正都是误报」的习惯直接跳过 ——
 * 那这个门禁就废了。所以：
 *
 *   · 拦截（block）：证据足够强，几乎不可能是正常代码
 *   · 警告（warn） ：像，但可能只是示例数据；不拦，只提示
 *   · 放过（skip） ：明确的正常写法（版本号、端口、毫秒、白名单号码）
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ── 白名单：明确的正常数字，永远不报 ─────────────────────── */

/** 常见毫秒 / 字节 / 计数常量。这些出现在全是正常代码里，报出来只会淹没真问题。 */
const BENIGN_NUMBERS = new Set([
  "10000", "20000", "30000", "50000", "60000", "90000", "100000",
  "120000", "180000", "300000", "600000", "900000",
  "86400", "86400000", "1048576", "4294967296", "3600000",
  // 各种默认端口
  "3000", "3001", "5099", "5173", "40653", "8080", "9090",
  // 一眼假的占位号（本项目测试和文档里一直在用）
  "123456789", "1234567890", "9876543210", "111222333", "12345678901",
]);

/** 版本号样子的东西：1.2.3 / 1.2 / v1.2.3 —— 一律不算 */
const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

/** 端口上下文：127.0.0.1:40653、localhost:3000、:port 40653 */
const PORT_CONTEXT_RE = /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|端口|port)[^\d]{0,4}(\d{2,5})\b/gi;

/* ── 规则 ──────────────────────────────────────────────── */

/**
 * 每条规则：
 *   id      报错时的短标识
 *   level   block | warn
 *   scan    (text, file) => [{ line, col, text }...]
 */
const RULES = [
  {
    id: "local-path",
    level: "block",
    why: "本机绝对路径：会暴露用户名和目录结构",
    scan(text) {
      const out = [];
      // Windows：盘符 + 用户目录/桌面/项目目录
      const winRe = /[A-Za-z]:\\[^\s"'`<>|]*?(?:Users|我的电脑|桌面|Desktop|AppData)[^\s"'`<>|]*/g;
      // Unix：/home/xxx 或 /Users/xxx
      const nixRe = /\/(?:home|Users)\/[A-Za-z0-9._-]+\/[^\s"'`<>|]*/g;
      for (const re of [winRe, nixRe]) {
        let m;
        while ((m = re.exec(text))) out.push({ line: lineOf(text, m.index), text: m[0].trim() });
      }
      return out;
    },
  },

  {
    id: "token",
    level: "block",
    why: "令牌 / 密钥：拿到就能操作你的账号",
    scan(text, file) {
      const out = [];
      // GitHub 那几种新格式自带前缀，命中即可确定
      const knownRe = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g;
      let m;
      while ((m = knownRe.exec(text))) out.push({ line: lineOf(text, m.index), text: m[0].slice(0, 12) + "…" });

      // 其余 32+ 位连续串：只有同文件出现 token/secret 之类字样才算，
      // 否则 base64、哈希、minified 字符串全会误报。
      if (/token|secret|api[_-]?key|authorization|passw/i.test(text)) {
        const longRe = /\b[A-Za-z0-9_-]{24,}\b/g;
        while ((m = longRe.exec(text))) {
          const v = m[0];
          // 纯十六进制：commit hash、md5、设备/会话 ID 长这样，八成不是令牌。
          if (/^[0-9a-f]+$/i.test(v)) continue;

          // 真令牌是随机串，几乎一定「大小写混着 + 带数字」。
          // 光看长度会把 vaultAccessible、stopImmediatePropagation、webkit-outline
          // 这些正常标识符全认成令牌 —— 所以必须两个条件同时成立：
          //   ① 有数字
          //   ② 同时有大写和小写
          const hasDigit = /\d/.test(v);
          const hasUpper = /[A-Z]/.test(v);
          const hasLower = /[a-z]/.test(v);
          if (!hasDigit || !hasUpper || !hasLower) continue;

          const isTestFile = /tests?\//.test(file) || /\.test\./.test(file);
          out.push({
            line: lineOf(text, m.index),
            text: v.slice(0, 10) + "…（" + v.length + " 位）",
            // 测试文件里的假令牌不该拦住提交，提示一下就行
            downgrade: isTestFile,
          });
        }
      }
      return out;
    },
  },

  {
    id: "qq-number",
    level: "block",
    why: "QQ 号：带 qq/uin/账号 上下文，基本可以确定是真号",
    scan(text) {
      const out = [];
      const re = /(?:qq|uin|账号|q号|qq号|群号)[^\d\n]{0,8}(\d{5,11})(?!\d)/gi;
      let m;
      while ((m = re.exec(text))) {
        const num = m[1];
        if (BENIGN_NUMBERS.has(num)) continue;
        out.push({ line: lineOf(text, m.index), text: m[0].trim() });
      }
      return out;
    },
  },

  {
    id: "phone",
    level: "block",
    why: "手机号：11 位、1[3-9] 开头",
    scan(text) {
      const out = [];
      // 前后都不能紧贴数字 —— 否则会从时间戳 / 长 ID 里截出一段
      const re = /(?<![\d])1[3-9]\d{9}(?![\d])/g;
      let m;
      while ((m = re.exec(text))) {
        const num = m[0];
        if (BENIGN_NUMBERS.has(num)) continue;
        // 前后 20 字符里如果有 ms/毫秒/时间戳/time，更可能是时间值，降级成警告由上层处理
        const ctx = text.slice(Math.max(0, m.index - 20), m.index + 20);
        if (/ms\b|毫秒|时间戳|timestamp|Date\.now|expire/i.test(ctx)) {
          out.push({ line: lineOf(text, m.index), text: num, downgrade: true });
          continue;
        }
        out.push({ line: lineOf(text, m.index), text: num });
      }
      return out;
    },
  },

  {
    id: "bare-number",
    level: "warn",
    why: "引号里的 5-11 位裸数字：可能是真号，也可能只是示例数据",
    scan(text, file) {
      // 测试文件里这种数字是常态，警告都嫌吵
      if (/tests?\//.test(file) || /\.test\./.test(file)) return [];
      const out = [];
      const re = /(["'`])(\d{5,11})\1/g;
      let m;
      while ((m = re.exec(text))) {
        const num = m[2];
        if (BENIGN_NUMBERS.has(num)) continue;
        if (VERSION_RE.test(num)) continue;
        // 端口上下文放过
        const ctx = text.slice(Math.max(0, m.index - 24), m.index + 24);
        if (/(?:127\.0\.0\.1|localhost|port|端口|:)\s*$/.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
        out.push({ line: lineOf(text, m.index), text: num });
      }
      return out;
    },
  },

  {
    id: "email",
    level: "warn",
    why: "邮箱地址：确认是不是你自己的真实邮箱",
    scan(text) {
      const out = [];
      const re = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
      let m;
      while ((m = re.exec(text))) {
        const v = m[0];
        // 保留域名（RFC 2606 / 6761）和常见的假地址放过
        if (/@(?:[\w-]+\.)?(?:example\.(?:com|org|net)|test|invalid|localhost|local|internal)\b/i.test(v)) continue;
        if (/@noreply\.github\.com$/i.test(v)) continue;
        out.push({ line: lineOf(text, m.index), text: v });
      }
      return out;
    },
  },
];

/* ── 路径规则：不该进仓库的文档 ─────────────────────────── */

/**
 * 有些东西从内容上完全看不出问题，但它本来就不该上传：
 * 项目设计、交接记录、遗留问题、草稿、备份。
 *
 * 这里按路径和文件名判断，跟内容扫描是两回事。
 * 判断依据要松紧合适 —— 收太紧会拦掉正常的 README，收太松等于没拦。
 */

/** 整个目录都不进仓库 */
const FORBIDDEN_DIRS = ["docs/", "demo/", "vendor/", "backups/", "backup/", "私有/", "internal/", "笔记/"];

/** 文件名开头像内部记录的 */
const FORBIDDEN_NAME_PREFIX = /^(?:设计|设计确认|交接|遗留问题|剩余工作|参数表|接入QQ|草稿|笔记|备忘|内部|计划|TODO|WIP|想法)/i;

/** 文件名里带这些片段，说明是过程性文档 */
const FORBIDDEN_NAME_PART = /[-_](?:设计|交接|遗留|草稿|内部|备忘|笔记|计划|问题)$|(?:设计|交接|遗留问题|草稿|备忘|笔记)[-_]/;

/** 项目正常文档，哪怕在根目录也放过 */
const ALLOWED_DOC = /^(?:README|CHANGELOG|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|LICENSE|NOTICE|AUTHORS|COPYING)(?:[.-][\w-]+)?(?:\.md|\.txt)?$/i;

/** 子项目自带的 README 是正常的 */
const ALLOWED_SUBDIR_README = /^(?:integrations|mcp|server|scripts|src)\/[^/]+\/README\.md$/i;

function checkPath(file) {
  const p = file.replace(/\\/g, "/");

  for (const d of FORBIDDEN_DIRS) {
    if (p.startsWith(d) || p.includes("/" + d)) {
      return { rule: "internal-doc", level: "block", why: `内部目录 ${d} 不进仓库` };
    }
  }

  const base = p.split("/").pop();

  if (ALLOWED_DOC.test(base) || ALLOWED_SUBDIR_README.test(p)) return null;

  // 只对文档类文件做名字判断，代码文件按名字收会误伤
  if (/\.(md|txt|docx?|pdf|rtf|org)$/i.test(base)) {
    if (FORBIDDEN_NAME_PREFIX.test(base) || FORBIDDEN_NAME_PART.test(base)) {
      return { rule: "internal-doc", level: "block", why: `看起来是内部记录（${base}），不该上传` };
    }
  }

  return null;
}

/* ── 工具 ──────────────────────────────────────────────── */

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

/** 只看文本类文件，二进制跳过 */
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|html|htm|css|json|md|txt|yml|yaml|ps1|bat|cmd|vbs|sh|py|toml|ini|cfg|env|example|gitignore|gitattributes)$/i;

function isTextFile(f) {
  if (TEXT_EXT.test(f)) return true;
  // 无扩展名但名字像配置
  return /(^|\/)(LICENSE|Makefile|Dockerfile|\.gitignore|\.gitattributes|\.env)$/i.test(f);
}

/** 行内豁免：这一行写了 privacy-ok 就跳过 */
const SKIP_LINE_RE = /privacy-ok|隐私放行|@allow-privacy/i;

function scanFile(file, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  const skipped = new Set();
  lines.forEach((ln, i) => { if (SKIP_LINE_RE.test(ln)) skipped.add(i + 1); });

  for (const rule of RULES) {
    let hits;
    try {
      hits = rule.scan(content, file) || [];
    } catch (e) {
      continue;
    }
    for (const h of hits) {
      if (skipped.has(h.line)) continue;
      findings.push({
        rule: rule.id,
        level: h.downgrade ? "warn" : rule.level,
        why: rule.why,
        file,
        line: h.line,
        text: h.text,
      });
    }
  }
  return findings;
}

/* ── 取文件列表 ────────────────────────────────────────── */

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function stagedFiles() {
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n").map((s) => s.trim()).filter(Boolean);
}

function trackedFiles() {
  return git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
}

/* ── 主流程 ────────────────────────────────────────────── */

const argv = process.argv.slice(2);
let files;
let mode;

if (argv.includes("--staged")) {
  mode = "暂存区";
  files = stagedFiles();
} else if (argv.includes("--all")) {
  mode = "全部已跟踪文件";
  files = trackedFiles();
} else if (argv.includes("--files")) {
  mode = "指定文件";
  files = argv.slice(argv.indexOf("--files") + 1);
} else {
  console.error("用法：node scripts/privacy-gate.mjs --staged | --all | --files <...>");
  process.exit(2);
}

// 门禁自己跳过自己：里面的示例数字和正则本来就是给人看的
const SELF = "scripts/privacy-gate.mjs";
const targets = files.filter((f) => f && f !== SELF && isTextFile(f) && existsSync(join(ROOT, f)));

const findings = [];

// 先查路径：该不该进仓库，跟内容无关
for (const f of targets) {
  const bad = checkPath(f);
  if (bad) {
    findings.push({ ...bad, file: f, line: 0, text: "（整个文件）" });
  }
}

for (const f of targets) {
  let content;
  try {
    content = readFileSync(join(ROOT, f), "utf8");
  } catch {
    continue;
  }
  // 超长 minified 单行文件跳过（误报率极高，收益极低）
  if (content.length > 2_000_000) continue;
  findings.push(...scanFile(f, content));
}

const blocks = findings.filter((x) => x.level === "block");
const warns = findings.filter((x) => x.level === "warn");

const head = (l) => (l === "block" ? "拦截" : "警告");

if (!findings.length) {
  console.log(`隐私门禁：${mode} ${targets.length} 个文件，未发现问题。`);
  process.exit(0);
}

console.log(`隐私门禁：${mode} ${targets.length} 个文件`);
console.log(`  拦截 ${blocks.length} 项 · 警告 ${warns.length} 项\n`);

for (const x of [...blocks, ...warns]) {
  console.log(`  [${head(x.level)}] ${x.file}:${x.line}  ${x.rule}`);
  console.log(`        内容：${x.text}`);
  console.log(`        原因：${x.why}`);
}

if (warns.length && !blocks.length) {
  console.log("\n只有警告，没拦住。确认这些是示例数据就可以提交。");
  console.log("如果某一行确实是正常写法，在那一行加注释 privacy-ok 就不会再报。");
  process.exit(0);
}

if (blocks.length) {
  console.log("\n有拦截项，本次提交被挡下。");
  console.log("处理方式：");
  console.log("  1) 删掉 / 换成占位（推荐）");
  console.log("  2) 那一行确实是正常写法 → 行尾加注释 privacy-ok");
  console.log("  3) 只改这一处 → git add 后重新提交");
  process.exit(1);
}