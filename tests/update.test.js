/**
 * 在线更新 · 测试
 *
 * update.js 会 git stash + 覆盖文件，一直没测试——这份补上。
 * 不碰真网络：remote 用本地裸仓库，git fetch/merge 走文件系统。
 *
 * 测的路径（文档里点名的两条 + 两条加固）：
 *   ① 不是 git 仓库 → 拒绝更新
 *   ② 本地有改动   → 先 stash，更新完留着不丢
 *   ③ 干净本地     → 快进到新版本
 *   ④ 本地分叉     → 拒绝快进，改动退回原样
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { applyUpdate, checkForUpdate, setRootForTest } from "../src/web/update.js";

/** 带测试身份的 git */
function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=ringmind-test", "-c", "user.email=test@ringmind.local", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"] }
  ).toString().trim();
}

/** 建一套「远端(裸) + 本地克隆」的夹具，初始 package.json 1.0.0 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ringmind-update-"));
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  const work = join(base, "work");

  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "ringmind", version: "1.0.0" }, null, 2));
  writeFileSync(join(seed, "README.md"), "# ringmind\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "v1.0.0");
  git(seed, "init", "--bare", "-b", "main", remote);  // 裸仓库也要 -b main，否则 clone 出来是空的
  git(seed, "push", remote, "main");

  git(base, "clone", remote, work);
  return { base, remote, seed, work, cleanup() { rmSync(base, { recursive: true, force: true }); } };
}

/** 在 seed 里提交一个新版本并推上远端 */
function pushVersion(fx, version, extraFile) {
  writeFileSync(join(fx.seed, "package.json"), JSON.stringify({ name: "ringmind", version }, null, 2));
  if (extraFile) writeFileSync(join(fx.seed, extraFile), "new content from remote");
  git(fx.seed, "add", "-A");
  git(fx.seed, "commit", "-m", "v" + version);
  git(fx.seed, "push", fx.remote, "main");
}

test("① 不是 git 仓库 → 拒绝更新，也报不出新版", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ringmind-nogit-"));
  setRootForTest(dir);
  try {
    const r = await applyUpdate();
    assert.equal(r.ok, false);
    assert.match(r.error, /不是 git/);

    const c = await checkForUpdate({ force: true });
    assert.equal(c.hasUpdate, false);
    assert.equal(c.canAutoUpdate, false);
  } finally {
    setRootForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("② 干净本地：快进更新到新版本，数据文件毫发无伤", async () => {
  const fx = fixture();
  setRootForTest(fx.work);
  try {
    pushVersion(fx, "1.1.0", "NEW_FEATURE.md");

    const r = await applyUpdate();
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.stashed, false);
    assert.equal(r.toVersion, "1.1.0");
    assert.ok(existsSync(join(fx.work, "NEW_FEATURE.md")), "远端新文件要落下来");
    assert.ok(existsSync(join(fx.work, "package.json")), "package.json 还在");
  } finally {
    setRootForTest(null);
    fx.cleanup();
  }
});

test("③ 本地有改动：先 stash，更新完留着不丢", async () => {
  const fx = fixture();
  setRootForTest(fx.work);
  try {
    pushVersion(fx, "1.1.0");
    // 本地未提交的改动（用户改了一行）
    writeFileSync(join(fx.work, "README.md"), "# 我自己改过的标题\n");

    const r = await applyUpdate();
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.stashed, true, "有改动要先收进 stash");

    // 改动没丢：stash 里能找回来
    const stashList = git(fx.work, "stash", "list");
    assert.match(stashList, /ringmind-auto-update/, "stash 要带 ringmind 标记");
    const restored = git(fx.work, "stash", "show", "-p", "stash@{0}");
    assert.match(restored, /我自己改过的标题/, "改动内容要完整留在 stash 里");

    // 更新照常到位
    assert.equal(r.toVersion, "1.1.0");
  } finally {
    setRootForTest(null);
    fx.cleanup();
  }
});

test("④ 本地分叉：拒绝快进，stash 的改动退回原样", async () => {
  const fx = fixture();
  setRootForTest(fx.work);
  try {
    // 本地提交一个分叉
    writeFileSync(join(fx.work, "LOCAL_ONLY.txt"), "我的本地提交");
    git(fx.work, "add", "-A");
    git(fx.work, "commit", "-m", "本地提交");
    // 未提交改动（stash 后要能退回来）
    writeFileSync(join(fx.work, "README.md"), "# 分叉测试的未提交改动\n");
    // 远端也往前走
    pushVersion(fx, "1.1.0");

    const r = await applyUpdate();
    assert.equal(r.ok, false);
    assert.match(r.error, /快进/);

    // stash 已退回：未提交改动还原在场（Windows 会把换行规范成 CRLF，比内容比字节）
    const back = readFileSync(join(fx.work, "README.md"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(back, "# 分叉测试的未提交改动\n");
    assert.ok(existsSync(join(fx.work, "LOCAL_ONLY.txt")), "本地提交不能被动");
  } finally {
    setRootForTest(null);
    fx.cleanup();
  }
});
