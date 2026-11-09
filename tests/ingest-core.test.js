/**
 * 自动入库规则（src/core/ingest.js）的测试
 *
 * 这一层是"一条消息算不算同一段对话"的唯一判断处 ——
 * 以前它只活在 HTTP 那条路上，换入口就丢，54 条工具回执把库塞满。
 * 所以五条判据每条都要钉住。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Ringmind } from "../src/index.js";
import { ingestMessage } from "../src/core/ingest.js";

const T0 = Date.UTC(2026, 10, 9, 2, 0, 0); // 固定时间，别让测试随真实时钟漂
const SEC = 1000;
const MIN = 60 * SEC;

function fresh() {
  return new Ringmind(":memory:", "测试库");
}

const base = (over = {}) => ({
  content: "今天中午吃的面不错",
  source: "private",
  speaker: "user",
  convKey: "private:1234567890",
  at: T0,
  ...over,
});

describe("ingestMessage · 五条判据", () => {
  test("① 同一个聊天 + ② 同一个发言方：间隔够近就并进同一条", () => {
    const db = fresh();
    const a = ingestMessage(db.store, db.config, base());
    const b = ingestMessage(db.store, db.config, base({ content: "有点辣", at: T0 + 30 * SEC }));
    assert.equal(a.action, "new");
    assert.equal(b.action, "append");
    assert.equal(a.id, b.id);
    assert.match(b.content, /面不错；有点辣/);
  });

  test("同一个发言方、不同聊天 → 各开一条", () => {
    const db = fresh();
    const a = ingestMessage(db.store, db.config, base());
    const b = ingestMessage(
      db.store, db.config,
      base({ content: "在群里说话", source: "group", convKey: "group:999", at: T0 + 10 * SEC })
    );
    assert.equal(b.action, "new");
    assert.notEqual(a.id, b.id);
  });

  test("② 她和别人各自成段，不混进同一条", () => {
    const db = fresh();
    const a = ingestMessage(db.store, db.config, base());
    const b = ingestMessage(db.store, db.config, base({ content: "我也觉得", speaker: "self", at: T0 + 5 * SEC }));
    assert.equal(b.action, "new");
    assert.notEqual(a.id, b.id);
    assert.equal(db.store.getMemory(b.id).speaker, "self");
  });

  test("③ 时间回溯 → 新开一条（补录历史不许插进刚才那段）", () => {
    const db = fresh();
    ingestMessage(db.store, db.config, base({ at: T0 + 2 * MIN }));
    const back = ingestMessage(db.store, db.config, base({ content: "补一条旧的", at: T0 }));
    assert.equal(back.action, "new");
  });

  test("④ 间隔超过 90 秒 → 断开", () => {
    const db = fresh();
    ingestMessage(db.store, db.config, base());
    const far = ingestMessage(db.store, db.config, base({ content: "过了一会儿", at: T0 + 91 * SEC }));
    assert.equal(far.action, "new");
    // 90 秒整还算是同一段
    const db2 = fresh();
    ingestMessage(db2.store, db2.config, base());
    const edge = ingestMessage(db2.store, db2.config, base({ content: "刚刚好", at: T0 + 90 * SEC }));
    assert.equal(edge.action, "append");
  });

  test("⑤ 本段超过 5 分钟 → 断开（哪怕每条之间只隔 10 秒）", () => {
    const db = fresh();
    ingestMessage(db.store, db.config, base({ at: T0 }));
    let last = null;
    for (let t = 10; t <= 290; t += 10) {
      last = ingestMessage(db.store, db.config, base({ content: "第" + t + "秒", at: T0 + t * SEC }));
      assert.equal(last.action, "append", `第 ${t} 秒还在 5 分钟里，应该并进上一条`);
    }
    // 300 秒内都还能并；超过 5 分钟就必须新开
    const over = ingestMessage(db.store, db.config, base({ content: "第 310 秒", at: T0 + 310 * SEC }));
    assert.equal(over.action, "new");
  });

  test("合并时把点一起补上（不然那段话搜不到也淡不掉）", () => {
    const db = fresh();
    const a = ingestMessage(db.store, db.config, base());
    const before = db.store.getMemory(a.id).points.length;
    ingestMessage(db.store, db.config, base({ content: "汤也很好喝，下次再去", at: T0 + 20 * SEC }));
    const after = db.store.getMemory(a.id).points.length;
    assert.ok(after > before, `点数应该变多：${before} → ${after}`);
  });
});

describe("ingestMessage · 幂等与总库", () => {
  test("noMerge：相隔 3 秒的两件「事」不合并（收表情 / 语音回执这类）", () => {
    const db = fresh();
    const a = ingestMessage(db.store, db.config, base({
      content: "我收了一张表情包：一只猫",
      convKey: "self:stickers",
      speaker: "self",
      messageId: "sticker:aaa",
      noMerge: true,
    }));
    const b = ingestMessage(db.store, db.config, base({
      content: "我收了一张表情包：一只狗",
      convKey: "self:stickers",
      speaker: "self",
      messageId: "sticker:bbb",
      noMerge: true,
      at: T0 + 3 * SEC,
    }));
    assert.equal(a.action, "new");
    assert.equal(b.action, "new");
    assert.notEqual(a.id, b.id);
    assert.doesNotMatch(b.content, /猫/);
  });

  test("noMerge 不占合并游标：紧接着的聊天不会被并进那条事件", () => {
    const db = fresh();
    const ev = ingestMessage(db.store, db.config, base({
      content: "我收了一张表情包：一只猫",
      convKey: "self:stickers",
      speaker: "self",
      messageId: "sticker:ccc",
      noMerge: true,
    }));
    const chat = ingestMessage(db.store, db.config, base({
      content: "在干嘛",
      convKey: "self:stickers",
      speaker: "self",
      messageId: "m-chat-1",
      at: T0 + 5 * SEC,
    }));
    assert.equal(chat.action, "new");
    assert.equal(chat.id !== ev.id, true);
  });

  test("同一条 message_id 投递两次只留一条，第二次不写", () => {
    const db = fresh();
    const a = ingestMessage(db.store, db.config, base({ messageId: "qq-001" }));
    const b = ingestMessage(db.store, db.config, base({ messageId: "qq-001", at: T0 + 10 * SEC }));
    assert.equal(a.action, "new");
    assert.equal(b.action, "duplicate");
    assert.equal(db.store.countByRing("ring4"), 1);
  });

  test("重复的 message_id 连点也一起不再补", () => {
    const db = fresh();
    ingestMessage(db.store, db.config, base({ messageId: "qq-002" }));
    const n1 = db.store.getMemory(db.store.findByMessageId("qq-002").id).points.length;
    ingestMessage(db.store, db.config, base({ messageId: "qq-002", at: T0 + 5 * SEC }));
    const n2 = db.store.getMemory(db.store.findByMessageId("qq-002").id).points.length;
    assert.equal(n1, n2);
  });

  test("并进上一条的那句，重发时也算重复（不许再并一遍）", () => {
    const db = fresh();
    ingestMessage(db.store, db.config, base({ messageId: "m1" }));
    const merged = ingestMessage(db.store, db.config, base({ content: "有点辣", messageId: "m2", at: T0 + 20 * SEC }));
    assert.equal(merged.action, "append");
    const lenBefore = db.store.getMemory(merged.id).content.length;
    const again = ingestMessage(db.store, db.config, base({ content: "有点辣", messageId: "m2", at: T0 + 25 * SEC }));
    assert.equal(again.action, "duplicate");
    assert.equal(db.store.getMemory(merged.id).content.length, lenBefore);
    assert.equal(db.store.countByRing("ring4"), 1);
  });

  test("没有 message_id 的（她主动记的）不参与去重，连发十次「在吗」就是十条事", () => {
    const db = fresh();
    for (let i = 0; i < 3; i++) {
      ingestMessage(db.store, db.config, base({ content: "在吗", at: T0 + i * 100 * SEC }));
    }
    assert.equal(db.store.countByRing("ring4"), 3);
  });

  test("自动入库默认不进总库（原文由调用方逐条进）", () => {
    const db = fresh();
    ingestMessage(db.store, db.config, base({ messageId: "qq-003" }));
    assert.equal(db.store.vaultCount(), 0);
  });

  test("note 存得下，转写标「可能不准」", () => {
    const db = fresh();
    const r = ingestMessage(
      db.store, db.config,
      base({ content: "[语音]", note: "他说今天会下雨", noteSuspect: true, messageId: "qq-004" })
    );
    const mem = db.store.getMemory(r.id);
    assert.equal(mem.content, "[语音]");
    assert.equal(mem.note_voice, "他说今天会下雨"); // 语音批注单独一列
    assert.equal(mem.note_suspect, 1);
  });

  test("图片批注落 note_visual，覆盖时不碰语音那条", () => {
    const db = fresh();
    const r = ingestMessage(
      db.store, db.config,
      base({ content: "[语音]", note: "转写的那句", noteSuspect: true, messageId: "v9" })
    );
    db.store.setMemoryNote(r.id, "我的说法：摆烂猫", false, "visual");
    db.store.setMemoryNote(r.id, "我的说法：摆烂猫改名了", false, "visual");
    const mem = db.store.getMemory(r.id);
    assert.equal(mem.note_visual, "我的说法：摆烂猫改名了"); // 覆盖只换图片那一列
    assert.equal(mem.note_voice, "转写的那句");
  });

  test("合并时 note 也接上，不丢后说的那段", () => {
    const db = fresh();
    const a = ingestMessage(db.store, db.config, base({ content: "[语音]", note: "第一句", noteSuspect: true, messageId: "v1" }));
    ingestMessage(db.store, db.config, base({ content: "[语音]", note: "第二句", noteSuspect: true, messageId: "v2", at: T0 + 20 * SEC }));
    const mem = db.store.getMemory(a.id);
    assert.match(mem.note_voice, /第一句；第二句/);
    assert.equal(mem.note_suspect, 1);
  });
});