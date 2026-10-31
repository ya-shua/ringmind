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
/* ═══════════════ 合并不该把点丢掉 ═══════════════ */

describe("ingest · 合并时补点", () => {
  const mk = async () => {
    const { Ringmind } = await import("../src/index.js");
    return new Ringmind(":memory:", "test");
  };

  const msg = (text, extra = {}) => ({
    text,
    kind: "private",
    convId: "1234567890",
    uid: "1234567890",
    sender: "某人",
    isOwner: true,
    isSelf: false,
    ts: Date.now(),
    convKey: "private:1234567890",
    ...extra,
  });

  test("并进上一条之后，新内容也要有自己的点", async () => {
    const { ingest } = await import("../server/ingest-server.mjs");
    const db = await mk();

    const a = ingest(msg("今天吃的面有点辣"), db);
    const b = ingest(msg("明天想吃火锅", { ts: Date.now() + 1000 }), db);

    assert.equal(b.action, "append");
    assert.equal(a.memoryId, b.memoryId);

    const mem = db.store.getMemory(b.memoryId);
    assert.ok(mem.content.includes("有点咸"), mem.content);
    assert.ok(mem.content.includes("火锅"), mem.content);

    // 关键：火锅这几个字必须进 points，否则 recall 永远搜不到
    const pts = db.store.listPoints(b.memoryId);
    const texts = pts.map((p) => p.text).join("|");
    assert.ok(texts.includes("火锅"), "points 里应该有火锅，实际：" + texts);
    assert.ok(texts.includes("有点咸"), "points 里应该有面，实际：" + texts);

    db.close();
  });

  test("新点排在最后（weight 为空，越晚越不重要）", async () => {
    const { ingest } = await import("../server/ingest-server.mjs");
    const db = await mk();

    const a = ingest(msg("第一句"), db);
    ingest(msg("第二句", { ts: Date.now() + 1000 }), db);
    ingest(msg("第三句", { ts: Date.now() + 2000 }), db);

    const pts = db.store.listPoints(a.memoryId);
    assert.ok(pts.length >= 3, "至少三个点，实际 " + pts.length);
    assert.equal(pts[0].weight, 1, "第一个点是 remember 写的，weight=1");
    // 后面追加的点 weight 是 null
    const nulls = pts.filter((p) => p.weight === null);
    assert.ok(nulls.length >= 2, "追加的点 weight 该是 null，实际 " + nulls.length);

    // 按 listPoints 的排序，null 一定垫在最后
    const firstNull = pts.findIndex((p) => p.weight === null);
    for (let i = firstNull; i < pts.length; i++) {
      assert.equal(pts[i].weight, null, "从第一个 null 往后都该是 null");
    }

    db.close();
  });

  test("recall 能捞到合并进来的后半截", async () => {
    const { ingest } = await import("../server/ingest-server.mjs");
    const db = await mk();

    ingest(msg("今天吃的面有点辣"), db);
    ingest(msg("明天想吃火锅", { ts: Date.now() + 1000 }), db);

    const hit = db.search("火锅");
    assert.ok(hit.length > 0, "search 应该能搜到火锅");

    db.close();
  });

  test("总库不会因为合并而重复写", async () => {
    const { ingest } = await import("../server/ingest-server.mjs");
    const db = await mk();

    ingest(msg("一条"), db);
    ingest(msg("两条", { ts: Date.now() + 1000 }), db);
    ingest(msg("三条", { ts: Date.now() + 2000 }), db);

    assert.equal(db.store.vaultCount(), 3, "三条消息 = 总库三行");
    assert.equal(db.stats().ring4.total, 1, "圈里合并成一条");

    db.close();
  });
});