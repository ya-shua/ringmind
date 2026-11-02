#!/usr/bin/env node
/**
 * 把隐私门禁装到 .git/hooks 里。
 *
 * 为什么要这个脚本：`.git/hooks` 不跟着仓库走，换台机器 / 重新 clone
 * 之后钩子就没了。所以钩子内容放在这里，clone 完跑一次：
 *
 *   node scripts/install-git-hooks.mjs
 *
 * 它只写两个文件，不碰别的东西：
 *   .git/hooks/pre-commit   提交前查暂存区
 *   .git/hooks/pre-push     推送前再查一遍已提交但没推的
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

let hooksDir;
try {
  const p = git(["rev-parse", "--git-path", "hooks"]);
  hooksDir = resolve(ROOT, p);
} catch {
  console.error("✗ 这不在一个 git 仓库里");
  process.exit(1);
}

if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

/* ── 找 node 的逻辑两边共用 ─────────────────────────────── */

const FIND_NODE = `NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="node"
else
  for p in \\
    "/d/AI/QQ大肥鱼/SnowLuma/node.exe" \\
    "/c/Program Files/nodejs/node.exe" \\
    "/c/Program Files (x86)/nodejs/node.exe" \\
    "$HOME/AppData/Roaming/nvm/current/node.exe" \\
    "/usr/local/bin/node" \\
    "/usr/bin/node"
  do
    if [ -x "$p" ]; then NODE="$p"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo ""
  echo "  隐私门禁：没找到 node，本次跳过检查。"
  echo "  装好 node 后重新提交，或手动跑：node scripts/privacy-gate.mjs --staged"
  echo ""
  exit 0
fi`;

const PRE_COMMIT = `#!/bin/sh
# 隐私门禁 · 提交前 —— 由 scripts/install-git-hooks.mjs 生成，别手改
# 查暂存区：隐私泄露 / 不该上传的内部文档
# 绕过的办法：git commit --no-verify（但 CI 那边还会再查一次）

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && exit 0
cd "$ROOT" || exit 0

${FIND_NODE}

"$NODE" scripts/privacy-gate.mjs --staged
`;

const PRE_PUSH = `#!/bin/sh
# 隐私门禁 · 推送前 —— 由 scripts/install-git-hooks.mjs 生成，别手改
# 提交那关已经被 pre-commit 拦过一次，这里再查一遍「已提交但还没推」的内容，
# 防的是 --no-verify 绕过、或者提交之后才被别的东西改坏。

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && exit 0
cd "$ROOT" || exit 0

${FIND_NODE}

# 找出还没推到上游的提交改了哪些文件
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null)"
if [ -n "$UPSTREAM" ]; then
  FILES="$(git diff --name-only "$UPSTREAM"..HEAD 2>/dev/null)"
else
  FILES="$(git ls-files)"
fi

[ -z "$FILES" ] && exit 0

echo "$FILES" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  "$NODE" scripts/privacy-gate.mjs --files "$f" || exit 1
done
`;

const targets = [
  { name: "pre-commit", body: PRE_COMMIT },
  { name: "pre-push", body: PRE_PUSH },
];

for (const t of targets) {
  const p = resolve(hooksDir, t.name);
  writeFileSync(p, t.body, { encoding: "utf8", mode: 0o755 });
  try {
    chmodSync(p, 0o755);
  } catch {
    /* Windows 上 chmod 多半无效，Git 自己会按 shebang 执行 */
  }
  console.log("  ✓ " + p);
}

console.log("\n装好了。之后的 git commit / git push 都会先过隐私门禁。");
console.log("想跳过门禁（不建议）：git commit --no-verify");
console.log("手动查一遍：node scripts/privacy-gate.mjs --all");