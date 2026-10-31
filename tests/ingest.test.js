/**
 * 通用入库服务（server/ingest-server.mjs）的测试
 *
 * 只测"解析"这一层 —— 它决定了消息进库时长什么样，是最容易错的地方。
 * 写库那一段用的是环心本体（已有 tests/core.test.js 盯着），这里不重复测。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseMessage, vaultLine, isPlaceholder } from "../server/ingest-server.mjs";

const CFG = { owners: ["1234567890"], maxChars: 600, mergeWindowMs: 300_000 };

/* ═══════════════ 认得出谁在说话 ═══════════════ */

describe("parseMessage · 会话与身份", () => {
  test("AstrBot 的 UMO 能拆出群聊和群号", () => {
    const m = parseMessage({ umo: "aiocqhttp:group:111222333", uid: "123456789", text: "今天好热" }, CFG);
    assert.equal(m.kind, "group");
    assert.equal(m.convId, "111222333");
    assert.equal(m.convKey, "group:111222333");
    assert.equal(m.isOwner, false);
  });

  test("AstrBot 的 UMO 能拆出私聊和 QQ 号", () => {
    const m = parseMessage({ umo: "aiocqhttp:private:1234567890", uid: "1234567890", text: "面有点辣" }, CFG);
    assert.equal(m.kind, "private");
    assert.equal(m.convId, "1234567890");
    assert.equal(m.isOwner, true);
  });

  test("老格式的 key 也认", () => {
    const m = parseMessage({ key: "private:1234567890", text: "嗨" }, CFG);
    assert.equal(m.kind, "private");
    assert.equal(m.convId, "1234567890");
  });

  test("umo 优先于 key —— 两个都给时信 umo", () => {
    const m = parseMessage(
      { umo: "aiocqhttp:group:111", key: "private:222", text: "x" },
      CFG
    );
    assert.equal(m.kind, "group");
    assert.equal(m.convId, "111");
  });
});

/* ═══════════════ 主人判定 ═══════════════ */

describe("parseMessage · 谁是主人", () => {
  test("配了 owners 就认得出", () => {
    const m = parseMessage({ umo: "aiocqhttp:private:1234567890", uid: "1234567890", text: "x" }, CFG);
    assert.equal(m.isOwner, true);
  });

  test("没配 owners 谁都不是主人", () => {
    const m = parseMessage({ umo: "aiocqhttp:private:1234567890", uid: "1234567890", text: "x" }, { ...CFG, owners: [] });
    assert.equal(m.isOwner, false);
  });

  test("群友不是主人", () => {
    const m = parseMessage({ umo: "aiocqhttp:group:111222333", uid: "999999", text: "x" }, CFG);
    assert.equal(m.isOwner, false);
  });
});

/* ═══════════════ 占位词 ═══════════════ */

describe("占位词（不补前缀）", () => {
  test("这些词不算人名", () => {
    for (const w of ["私聊", "群聊", "私信", "未知", "", "  ", "private", "GROUP"]) {
      assert.equal(isPlaceholder(w), true, w + " 应该被当成占位词");
    }
  });

  test("真昵称不算占位", () => {
    for (const w of ["某人", "小明", "大肥鱼", "Alice"]) {
      assert.equal(isPlaceholder(w), false, w + " 不该被当成占位词");
    }
  });

  test("sender 是占位词时清成空串，总库里就不会出现「私聊：私聊：」", () => {
    const m = parseMessage({ key: "private:1234567890", sender: "私聊", text: "我还以为你要上天了" }, CFG);
    assert.equal(m.sender, "");
    const line = vaultLine(m);
    assert.ok(!line.includes("私聊：私聊"), "不该出现重复的私聊：" + line);
    assert.ok(line.includes("我还以为你要上天了"));
  });
});

/* ═══════════════ 时间 ═══════════════ */

describe("parseMessage · 时间", () => {
  test("毫秒时间戳原样用", () => {
    const m = parseMessage({ text: "x", ts: 1761926400000 }, CFG);
    assert.equal(m.ts, 1761926400000);
  });

  test("秒级时间戳自动换成毫秒", () => {
    const m = parseMessage({ text: "x", ts: 1761926400 }, CFG);
    assert.equal(m.ts, 1761926400000);
  });

  test("没给时间就用现在", () => {
    const before = Date.now();
    const m = parseMessage({ text: "x" }, CFG);
    assert.ok(m.ts >= before && m.ts <= Date.now() + 1000);
  });
});

/* ═══════════════ 内容 ═══════════════ */

describe("parseMessage · 内容", () => {
  test("空的 text 直接拒", () => {
    assert.ok(parseMessage({ text: "" }, CFG).error);
    assert.ok(parseMessage({ text: "   " }, CFG).error);
    assert.ok(parseMessage({}, CFG).error);
  });

  test("超过 maxChars 就截，并留一个省略号", () => {
    const m = parseMessage({ text: "长".repeat(700) }, CFG);
    assert.equal(m.text.length, 601); // 600 + "…"
    assert.ok(m.text.endsWith("…"));
  });

  test("不超过就一个字都不动", () => {
    const m = parseMessage({ text: "今天中午吃的面不错" }, CFG);
    assert.equal(m.text, "今天中午吃的面不错");
  });
});

/* ═══════════════ 总库那一行长什么样 ═══════════════ */

describe("vaultLine 格式", () => {
  test("主人带【管理员】，昵称和正文用冒号隔开", () => {
    const m = parseMessage(
      { umo: "aiocqhttp:private:1234567890", uid: "1234567890", sender: "某人", text: "面有点辣", ts: 1761926400000 },
      CFG
    );
    const line = vaultLine(m);
    assert.ok(line.includes("【管理员】某人：面有点辣"), line);
    assert.ok(line.includes("私聊"), line);
  });

  test("她说的话带（她）", () => {
    const m = parseMessage(
      { umo: "aiocqhttp:private:1234567890", uid: "9876543210", sender: "大肥鱼", text: "下次少放点盐", isSelf: true },
      CFG
    );
    const line = vaultLine(m);
    assert.ok(line.includes("（她）"), line);
    assert.ok(line.includes("大肥鱼：下次少放点盐"), line);
  });

  test("群聊标群聊", () => {
    const m = parseMessage({ umo: "aiocqhttp:group:111222333", uid: "1", sender: "小明", text: "好热" }, CFG);
    assert.ok(vaultLine(m).includes("群聊：小明：好热"));
  });

  test("没有昵称时不留多余的冒号", () => {
    const m = parseMessage({ key: "private:1234567890", text: "没名字的一条" }, CFG);
    const line = vaultLine(m);
    assert.ok(!line.includes("：："), "不该出现两个连续冒号：" + line);
    assert.ok(line.endsWith("没名字的一条"));
  });
});