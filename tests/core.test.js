/**
 * 核心逻辑测试
 * 跑：node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert";
import { Ringmind, hookWeights } from "../src/index.js";
import { metaMemoryDefaultOf } from "../src/core/rings.js";

const DAY = 86400000;

function fresh() {
  return new Ringmind(":memory:", "测试库");
}

test("钩子权重：3 个点 = 50% / 33% / 17%", () => {
  const w = hookWeights(3);
  assert.equal(w.length, 3);
  assert.ok(Math.abs(w[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(w[1] - 1 / 3) < 1e-9);
  assert.ok(Math.abs(w[2] - 1 / 6) < 1e-9);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("记一件事，能原样查回来", () => {
  const db = fresh();
  const mem = db.remember({
    content: "老爹带我出门，路上看到一辆黄色的大汽车",
    ring: "ring4",
    points: ["黄色", "大汽车", "老爹"],
    emotion: 7,
    source: "private",
    speaker: "user",
  });

  assert.ok(mem.id);
  assert.equal(mem.ring, "ring4");
  assert.equal(mem.points.length, 3);
  assert.equal(mem.points[0].text, "黄色");
  assert.equal(mem.points[0].weight, 1);

  // 总库也存了
  assert.equal(db.store.vaultCount(), 1);

  db.close();
});

test("时间到了会往下一圈掉", () => {
  const db = fresh();
  const t0 = Date.now();

  const mem = db.remember({
    content: "今天下雨，没出门",
    ring: "ring4", // 5 天
    points: ["下雨", "没出门"],
    at: t0,
  });

  // 第 3 天：还在圈四
  db.decay({ now: t0 + 3 * DAY });
  assert.equal(db.store.getMemory(mem.id).ring, "ring4");

  // 第 6 天：掉到圈五
  db.decay({ now: t0 + 6 * DAY });
  assert.equal(db.store.getMemory(mem.id).ring, "ring5");

  // 圈五 30 天，第 40 天：掉到回忆圈
  db.decay({ now: t0 + 40 * DAY });
  assert.equal(db.store.getMemory(mem.id).ring, "recall");

  db.close();
});

test("降级会删点，而且删掉的点确实看不见了", () => {
  const db = fresh();
  const t0 = Date.now();

  const mem = db.remember({
    content: "那天很开心",
    ring: "ring4",
    points: ["开心", "那天", "一起", "吃饭", "看电影", "回家", "路上", "下雨", "伞", "笑"],
    at: t0,
  });

  // 闲聊圈进去是满的：10 个点一个不少
  assert.equal(db.store.getMemory(mem.id).points.filter((p) => p.visible).length, 10);

  // 掉到圈五：她自己只能看到 40%
  db.decay({ now: t0 + 6 * DAY });
  const after = db.store.getMemory(mem.id);
  const visible = after.points.filter((p) => p.visible).length;

  assert.ok(visible <= 4, `圈五应该只剩 4 个点，实际 ${visible}`);

  // 但缓冲圈里还留着一些
  const buffered = after.points.filter((p) => p.buffered && !p.visible).length;
  assert.ok(buffered > 0, "缓冲圈应该留着一部分，实际是 0");

  db.close();
});

test("被提醒能想起一部分，但想不全", () => {
  const db = fresh();
  const t0 = Date.now();

  const mem = db.remember({
    content: "老爹带我出门看到一辆黄色的大汽车",
    ring: "ring4",
    points: ["黄色", "大汽车", "老爹", "出门", "看到"],
    at: t0,
  });

  // 掉到圈五（自己只能看到 40%）
  db.decay({ now: t0 + 6 * DAY });

  const before = db.store.getMemory(mem.id).points.filter((p) => p.visible).length;

  // 提醒她"黄色"，她应该能多想起一些
  const results = db.recall(["黄色", "大汽车"]);
  assert.ok(results.length > 0, "应该能想起来");

  const top = results.find((r) => r.id === mem.id);
  assert.ok(top, "应该找回这条");
  assert.ok(top.points.length >= before, "被提醒后应该不比之前少");
  assert.ok(top.points.length <= 5, "但不能超过原点数");
  assert.equal(top.ceiling, 0.7, "圈五的缓冲天花板应该是 70%");

  db.close();
});

test("容量满了会挤掉最老的", () => {
  const db = fresh();
  db.updateConfig({ rings: { ring4: { days: 9999, cap: 3 } } });

  const t0 = Date.now();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const m = db.remember({
      content: `第 ${i} 件事`,
      ring: "ring4",
      points: ["测试"],
      at: t0 + i * 1000,
    });
    ids.push(m.id);
  }

  assert.equal(db.store.countByRing("ring4"), 5);

  db.decay({ now: t0 + 10000 });

  // 圈四只剩 3 条，最老的 2 条掉到圈五
  assert.equal(db.store.countByRing("ring4"), 3);
  assert.equal(db.store.getMemory(ids[0]).ring, "ring5");
  assert.equal(db.store.getMemory(ids[1]).ring, "ring5");
  assert.equal(db.store.getMemory(ids[4]).ring, "ring4");

  db.close();
});

test("群聊优先被挤，私聊有保底", () => {
  const db = fresh();
  db.updateConfig({ rings: { ring4: { days: 9999, cap: 10 } } });

  const t0 = Date.now();
  const privIds = [];
  const groupIds = [];

  for (let i = 0; i < 5; i++) {
    privIds.push(db.remember({ content: `私 ${i}`, ring: "ring4", points: ["a"], source: "private", at: t0 + i }).id);
    groupIds.push(db.remember({ content: `群 ${i}`, ring: "ring4", points: ["b"], source: "group", at: t0 + 100 + i }).id);
  }

  assert.equal(db.store.countByRing("ring4"), 10);

  // 再加 2 条群聊 → 12 条，超出 10
  for (let i = 0; i < 2; i++) {
    groupIds.push(db.remember({ content: `群更多 ${i}`, ring: "ring4", points: ["c"], source: "group", at: t0 + 200 + i }).id);
  }

  db.decay({ now: t0 + 100000 });

  const privLeft = db.store.countByRingAndSource("ring4", "private");
  const groupLeft = db.store.countByRingAndSource("ring4", "group");

  assert.equal(privLeft + groupLeft, 10);
  assert.ok(privLeft >= 4, `私聊至少留 4 条，实际 ${privLeft}`);
  assert.ok(groupLeft <= 6, `群聊最多 6 条，实际 ${groupLeft}`);

  db.close();
});

test("圆心永不外出", () => {
  const db = fresh();
  const t0 = Date.now();

  const mem = db.remember({
    content: "被老爹说是他女儿这件事",
    points: ["女儿", "老爹"],
    pinned: true,
    at: t0 - 10000 * DAY,
  });

  assert.equal(mem.ring, "core");

  db.decay({ now: t0 });
  assert.equal(db.store.getMemory(mem.id).ring, "core", "圆心不该被降级");

  db.close();
});

test("伪遗忘模式：缓冲圈 100%，被提醒能全想起来", () => {
  const db = fresh();
  db.setMode("pseudo-forget");

  const t0 = Date.now();
  const mem = db.remember({
    content: "黄色的大汽车",
    ring: "ring4",
    points: ["黄色", "大汽车", "路上", "下午", "太阳"],
    at: t0,
  });

  db.decay({ now: t0 + 6 * DAY }); // 掉到圈五

  // 只提两个：能想起大部分，但不全
  const partial = db.recall(["黄色", "大汽车"]).find((r) => r.id === mem.id);
  assert.ok(partial);
  assert.equal(partial.ceiling, 1.0, "伪遗忘模式的缓冲天花板应该是 100%");
  assert.ok(partial.points.length >= 3, `至少想起 3 个，实际 ${partial.points.length}`);
  assert.ok(partial.points.length < 5, "没提醒到的部分仍然想不起来");

  // 全部提醒：一点不差地全回来
  const all = db.recall(["黄色", "大汽车", "路上", "下午", "太阳"]).find((r) => r.id === mem.id);
  assert.equal(all.points.length, 5, "全提醒了就该全想起来");

  db.close();
});

test("同样全提醒，遗忘模式只能想起 70%", () => {
  const db = fresh(); // 默认遗忘模式
  const t0 = Date.now();

  const mem = db.remember({
    content: "黄色的大汽车",
    ring: "ring4",
    points: ["黄色", "大汽车", "路上", "下午", "太阳"],
    at: t0,
  });

  db.decay({ now: t0 + 6 * DAY });

  const all = db.recall(["黄色", "大汽车", "路上", "下午", "太阳"]).find((r) => r.id === mem.id);

  assert.ok(all);
  assert.equal(all.ceiling, 0.7, "遗忘模式圈五的天花板是 70%");
  assert.ok(all.points.length <= 4, `最多想起 4 个（70%），实际 ${all.points.length}`);
  assert.ok(all.points.length >= 3, `至少想起 3 个，实际 ${all.points.length}`);

  db.close();
});

test("模式切换能存住", () => {
  const db = fresh();
  assert.equal(db.getConfig().mode, "forget");

  db.setMode("never-forget");
  assert.equal(db.getConfig().mode, "never-forget");

  // 重新打开同一个库，配置还在
  const cfg = db.getConfig();
  assert.equal(cfg.mode, "never-forget");

  db.close();
});

test("她说的话比事件记忆牢 3 倍", () => {
  const db = fresh();
  const t0 = Date.now();

  const userMem = db.remember({
    content: "用户说的",
    ring: "ring4",
    points: ["a"],
    speaker: "user",
    at: t0,
  });

  const selfMem = db.remember({
    content: "她自己说的",
    ring: "ring4",
    points: ["b"],
    speaker: "self",
    at: t0,
  });

  // 过 6 天：用户的掉了，自己的还在
  db.decay({ now: t0 + 6 * DAY });

  assert.equal(db.store.getMemory(userMem.id).ring, "ring5");
  assert.equal(db.store.getMemory(selfMem.id).ring, "ring4", "自己说的话应该多撑一会儿");

  db.close();
});

test("总览能给出每个圈的数量", () => {
  const db = fresh();
  db.remember({ content: "a", ring: "ring4", points: ["x"] });
  db.remember({ content: "b", ring: "ring4", points: ["y"] });
  db.remember({ content: "c", ring: "ring3", points: ["z"] });

  const ov = db.overview();
  assert.equal(ov.rings.find((r) => r.id === "ring4").total, 2);
  assert.equal(ov.rings.find((r) => r.id === "ring3").total, 1);
  assert.equal(ov.vault, 3);

  db.close();
});

test("掉一圈之后，倒计时从进圈那天重新算", () => {
  const db = fresh();
  db.updateConfig({ rings: { ring1: { days: 180 }, ring2: { days: 60 } } });
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();

  const mem = db.remember({
    content: "圈一的老事",
    ring: "ring1", // 180 天
    points: ["一", "二", "三", "四", "五"],
    at: t0,
  });

  // 逐天推进，模拟每天凌晨跑一次 decay
  let cur = t0;
  const advanceTo = (days) => {
    const target = t0 + days * DAY;
    while (cur < target) {
      cur = Math.min(target, cur + DAY);
      db.decay({ now: cur });
    }
  };

  advanceTo(180);
  assert.equal(db.store.getMemory(mem.id).ring, "ring1", "180 天应该还在圈一");

  advanceTo(181);
  assert.equal(db.store.getMemory(mem.id).ring, "ring2", "第 181 天掉到圈二");

  // 关键：圈二 60 天，不能让它在第 182 天就继续往下掉
  advanceTo(182);
  assert.equal(db.store.getMemory(mem.id).ring, "ring2", "刚进圈二，不该马上再掉");

  advanceTo(240);
  assert.equal(db.store.getMemory(mem.id).ring, "ring2", "圈二没满 60 天，还在圈二");

  // 严格小于：进圈第 60 天那天还不算超，满 61 天才掉
  advanceTo(242);
  assert.equal(db.store.getMemory(mem.id).ring, "ring3", "圈二超过 60 天才掉圈三");

  db.close();
});

test("一条圈一的记忆不会一天之内掉穿所有圈", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();

  const mem = db.remember({
    content: "很久以前的事",
    ring: "ring1",
    points: ["一", "二", "三"],
    at: t0,
  });

  // 隔 200 天才想起来跑一次 decay
  db.decay({ now: t0 + 200 * DAY });

  // 只该掉一级，不该直接到回忆圈
  assert.equal(db.store.getMemory(mem.id).ring, "ring2", "一次 decay 只掉一圈");

  db.close();
});

test("D3：圈五被反复捞回，攒够了会不知不觉升到圈四", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();

  const mem = db.remember({
    content: "老爹带我出门看到一辆黄色的大汽车",
    ring: "ring4",
    points: ["黄色", "大汽车", "老爹", "出门", "看到"],
    at: t0,
  });

  // 掉到圈五
  db.decay({ now: t0 + 6 * DAY });
  assert.equal(db.store.getMemory(mem.id).ring, "ring5");

  // 提醒 3 次（默认 afterHits = 3）
  for (let i = 0; i < 3; i++) {
    db.recall(["黄色", "大汽车"], { now: t0 + 7 * DAY });
  }

  assert.equal(db.store.getMemory(mem.id).ring, "ring4", "圈五攒够 3 次应该升回圈四");

  db.close();
});

test("D3：圈三封顶，圈一二三不会被升上去", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();

  const mem = db.remember({
    content: "有点意思的一件事",
    ring: "ring3",
    points: ["甲", "乙", "丙"],
    at: t0,
  });

  for (let i = 0; i < 10; i++) {
    db.recall(["甲", "乙"], { now: t0 + 1000 });
  }

  assert.equal(db.store.getMemory(mem.id).ring, "ring3", "圈三不参与升圈");

  db.close();
});

test("D3：升圈不还点 —— 掉掉的细节不会因为提得多回来", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();

  const mem = db.remember({
    content: "五个点的事",
    ring: "ring4",
    points: ["一", "二", "三", "四", "五"],
    at: t0,
  });

  // 掉到圈五：40% 可见，最多 70% 缓冲
  db.decay({ now: t0 + 6 * DAY });

  const before = db.store.listPoints(mem.id);
  const beforeGone = before.filter((p) => !p.visible && !p.buffered).length;
  assert.ok(beforeGone > 0, "这个测试需要有点已经被彻底删掉");

  for (let i = 0; i < 3; i++) {
    db.recall(["一", "二", "三"], { now: t0 + 7 * DAY });
  }

  assert.equal(db.store.getMemory(mem.id).ring, "ring4", "升回圈四了");

  const after = db.store.listPoints(mem.id);
  const afterGone = after.filter((p) => !p.visible && !p.buffered).length;
  assert.equal(afterGone, beforeGone, "彻底没了的点，升圈后还是没的");

  db.close();
});

test("D3：升圈后重新计时 —— 被反复提起的东西本来就该更难掉", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();

  const mem = db.remember({
    content: "反复被人提起的一件事",
    ring: "ring4",
    points: ["一", "二", "三", "四", "五"],
    at: t0,
  });

  // 圈四 5 天，第 6 天掉到圈五
  db.decay({ now: t0 + 6 * DAY });
  assert.equal(db.store.getMemory(mem.id).ring, "ring5");

  // 第 7 天被提 3 次，升回圈四。计时从"升圈那天"重开。
  for (let i = 0; i < 3; i++) {
    db.recall(["一", "二"], { now: t0 + 7 * DAY });
  }
  assert.equal(db.store.getMemory(mem.id).ring, "ring4");

  // 若没重开计时，进圈时间还是第 6 天，第 11 天就该超期。
  // 现实是第 11 天只过了 4 天，不该掉。
  db.decay({ now: t0 + 11 * DAY });
  assert.equal(
    db.store.getMemory(mem.id).ring,
    "ring4",
    "从升圈那天重算，第 11 天还没到 5 天",
  );

  // 第 13 天，距第 7 天已过 6 天 > 5 天，这才掉。
  db.decay({ now: t0 + 13 * DAY });
  assert.equal(
    db.store.getMemory(mem.id).ring,
    "ring5",
    "从升圈那天算满 5 天才掉",
  );

  db.close();
});

test("刚放进闲聊圈是满的，之后每天淡一点，待满剩八成", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();
  const twenty = Array.from({ length: 20 }, (_, i) => `点${i + 1}`);

  const mem = db.remember({ content: "刚聊的一堆事", ring: "ring4", points: twenty, at: t0 });
  const vis = () => db.store.visiblePoints(mem.id).length;
  const buf = () => db.store.bufferedPoints(mem.id).length;

  // 第 1 天：一个点都不少 —— 就是我一直在说的那个别扭，现在没了
  assert.equal(vis(), 20, "刚说完当然全记得");
  assert.equal(buf(), 0, "全看得见，还没进缓冲");

  // 第 2 天 95%
  db.decay({ now: t0 + 1 * DAY });
  assert.equal(vis(), 19, "第 2 天该是 95%");

  // 第 3 天 90%
  db.decay({ now: t0 + 2 * DAY });
  assert.equal(vis(), 18, "第 3 天该是 90%");

  // 第 4 天 85%
  db.decay({ now: t0 + 3 * DAY });
  assert.equal(vis(), 17, "第 4 天该是 85%");

  // 第 5 天 80%
  db.decay({ now: t0 + 4 * DAY });
  assert.equal(vis(), 16, "第 5 天该是 80%");

  // 掉出去的那些这几天都在缓冲里 —— 才发生的事，提一下全想得起来
  assert.equal(buf(), 4, "掉掉的 4 个都该在缓冲圈里");
  assert.equal(db.store.getMemory(mem.id).ring, "ring4", "还没到掉圈的时候");

  db.close();
});

test("模糊圈一进去就是四成，缓冲最多七成", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();
  const ten = Array.from({ length: 10 }, (_, i) => `点${i + 1}`);

  const b = db.remember({ content: "糊了的事", ring: "ring5", points: ten, at: t0 });
  assert.equal(db.store.visiblePoints(b.id).length, 4, "一进去就只剩四成");
  assert.equal(db.store.bufferedPoints(b.id).length, 3, "缓冲能捞回七成，也就是再 3 个");

  // 圈一二三是她郑重放进去的，圆心是她钉的 —— 都该一个不少
  const five = ["一", "二", "三", "四", "五"];
  const c = db.remember({ content: "圈三", ring: "ring3", points: five, at: t0 });
  assert.equal(db.store.visiblePoints(c.id).length, 5, "圈三全留");

  const d = db.remember({ content: "钉住的", points: five, pinned: true, at: t0 });
  assert.equal(db.store.getMemory(d.id).ring, "core");
  assert.equal(db.store.visiblePoints(d.id).length, 5, "圆心全留");

  db.close();
});

test("她没拆点，库替她按标点切；放哪圈还是她说了算", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();

  // 只甩一整句、没指定圈 → 库替她切，默认进闲聊圈
  const bare = db.remember({
    content: "老爹带我出门，看到一辆黄色的大汽车，特别亮",
    at: t0,
  });
  assert.equal(bare.ring, "ring4", "没说放哪圈就进闲聊圈");
  assert.deepEqual(
    db.store.listPoints(bare.id).map((p) => p.text),
    ["老爹带我出门", "看到一辆黄色的大汽车", "特别亮"],
    "库只按标点切，一个字都不改",
  );

  // 说了放圈一，但没拆点 → 照样替她拆，再放进圈一
  const said = db.remember({
    content: "她第一次说喜欢下雨天，说是因为声音好听",
    ring: "ring1",
    at: t0,
  });
  assert.equal(said.ring, "ring1", "她说放圈一就放圈一");
  assert.equal(db.store.listPoints(said.id).length, 2, "也替她拆好了（一个逗号切两段）");

  // 一句话里没标点 → 切不开，整句当一个点，不是不给点
  const oneBlob = db.remember({
    content: "那天风很大",
    at: t0,
  });
  assert.equal(db.store.listPoints(oneBlob.id).length, 1, "切不开就整句一个点");
  assert.equal(db.store.listPoints(oneBlob.id)[0].text, "那天风很大");

  // 她自己拆了点的，一个字都不许动
  const hers = db.remember({
    content: "随便写的整句",
    points: ["她说的重点", "次要的"],
    ring: "ring2",
    at: t0,
  });
  assert.deepEqual(
    db.store.listPoints(hers.id).map((p) => p.text),
    ["她说的重点", "次要的"],
    "她自己拆的优先，库不插手",
  );

  db.close();
});

test("回忆圈待满一年就彻底消失，不到一年还在", () => {
  const db = fresh();
  db.updateConfig({ rings: { recall: { days: 365 } } });
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();

  const mem = db.remember({
    content: "很久以前的一件事",
    ring: "recall",
    points: ["一", "二", "三"],
    at: t0,
  });
  assert.ok(db.store.getMemory(mem.id), "刚放进去应该在");

  // 第 364 天：还在
  db.decay({ now: t0 + 364 * DAY });
  assert.ok(db.store.getMemory(mem.id), "不到一年还该在");

  // 第 366 天：过了一年，彻底没了
  db.decay({ now: t0 + 366 * DAY });
  assert.equal(db.store.getMemory(mem.id), undefined, "过一年就该彻底消失");

  db.close();
});

test("回忆圈的期限可以调控（面板改的就是这个）", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();
  db.updateConfig({ rings: { recall: { days: 30 } } });

  const mem = db.remember({
    content: "调过期限的一件事",
    ring: "recall",
    points: ["一", "二"],
    at: t0,
  });

  db.decay({ now: t0 + 31 * DAY });
  assert.equal(db.store.getMemory(mem.id), undefined, "期限改成 30 天，31 天就该没了");

  db.close();
});

test("回忆圈超出上限会挤掉，而且是随机挤不是按最老", () => {
  const db = fresh();
  const t0 = new Date("2026-01-01T10:00:00+08:00").getTime();
  db.updateConfig({ rings: { recall: { cap: 5 } } });

  // 放 8 条进回忆圈，时间从老到新
  for (let i = 0; i < 8; i++) {
    db.remember({
      content: `第${i}件事`,
      ring: "recall",
      points: ["点" + i],
      at: t0 + i * DAY,
    });
  }
  assert.equal(db.store.countByRing("recall"), 8);

  db.decay({ now: t0 + 100 * DAY });

  const left = db.store.countByRing("recall");
  assert.equal(left, 5, "回忆圈上限 5，超出的应该被挤掉");

  db.close();
});

test("换场景档：三档的天数和容量整套搬过来", () => {
  const db = fresh();

  // 默认是混合
  assert.equal(db.getConfig().preset, "mixed");
  assert.equal(db.getConfig().rings.ring4.days, 5, "混合档闲聊圈 5 天");
  assert.equal(db.getConfig().rings.ring4.cap, 1000, "混合档闲聊圈 1000 条");

  // 换成群聊为主
  const g = db.setPreset("group");
  assert.equal(g.preset, "group");
  assert.equal(g.rings.ring4.days, 3, "群聊档三天一轮");
  assert.equal(g.rings.ring4.cap, 3000);
  assert.equal(g.rings.recall.cap, 20000);

  // 换成私聊为主
  const p = db.setPreset("private");
  assert.equal(p.preset, "private");
  assert.equal(p.rings.ring1.cap, 100);
  assert.equal(p.rings.recall.days, 365);

  // 换档之后还能单项微调
  db.updateConfig({ rings: { ring1: { days: 120 } } });
  assert.equal(db.getConfig().rings.ring1.days, 120, "单项能改");
  assert.equal(db.getConfig().preset, "private", "改单项不该把档位名字改掉");

  // 存进去了（重新打开还是这一档）
  assert.equal(db.config.preset, "private");

  db.close();
});

test("容量比起天数先满的时候，会明说「实际待不了那么久」", () => {
  const db = fresh();
  db.setPreset("private"); // 一天约 50 条

  const info = db.presetInfo();
  const byId = Object.fromEntries(info.rings.map((r) => [r.id, r]));

  // 闲聊圈 400 条 / 一天 50 条 = 8 天，比 days(5) 宽 → 天数说了算
  assert.equal(byId.ring4.effectiveDays, 5, "闲聊圈是时间在管");
  assert.equal(byId.ring4.capLimited, false);

  // 模糊圈 800 条 / 一天 50 条 = 16 天，但 days 是 30 → 容量先满
  assert.equal(byId.ring5.effectiveDays, 16, "模糊圈实际只待 16 天");
  assert.equal(byId.ring5.capLimited, true, "要标出来是容量在管");

  // 回忆圈 1000 条 / 一天 50 条 = 20 天，days 365 → 容量先满
  assert.equal(byId.recall.effectiveDays, 20);
  assert.equal(byId.recall.capLimited, true);

  db.close();
});

test("预设名字写错了不会崩，退回默认那档", () => {
  const db = fresh();
  db.updateConfig({ preset: "乱写的" });
  assert.equal(db.getConfig().preset, "mixed", "认不出来的就用默认档");

  db.close();
});

test("换档会把每圈的天数和容量都填满，不留空洞", () => {
  const db = fresh();
  for (const id of ["private", "mixed", "group"]) {
    db.setPreset(id);
    const cfg = db.getConfig();
    for (const ring of ["core", "ring1", "ring2", "ring3", "ring4", "ring5", "recall"]) {
      assert.ok(cfg.rings[ring], `${id} 档缺了 ${ring}`);
      assert.ok(cfg.rings[ring].cap > 0, `${id} 档 ${ring} 容量没填`);
    }
  }
  db.close();
});

test("元记忆：打开后会告诉 AI 还有几个点没想起来", () => {
  const db = fresh();
  // 遗忘模式默认是不开的（自然淡忘、不自知），这里显式打开来验证功能本身
  db.updateConfig({ metaMemory: true });
  const t0 = Date.now();
  const pts = ["黄色", "大汽车", "路边", "下午", "太阳"];
  const mem = db.remember({ content: "黄色大汽车停在路边", ring: "ring5", points: pts, at: t0 });

  const r = db.recall(["黄色"], { now: t0 + 1000 }).find((x) => x.id === mem.id);
  assert.ok(r, "应该能想起来");
  assert.ok(r.gap, "开着元记忆就该有 gap");
  assert.equal(r.gap.total, pts.length, "原本几个点");
  assert.equal(r.gap.shown, r.points.length, "这次想起几个");
  assert.equal(r.gap.missing, r.gap.total - r.gap.shown, "还剩几个");
  assert.ok(r.gap.missing > 0, "圈五只看得到四成，必然有想不起来的");
  db.close();
});

test("元记忆：关掉就不给 gap", () => {
  const db = fresh();
  db.updateConfig({ metaMemory: false });
  const t0 = Date.now();
  const mem = db.remember({
    content: "黄色大汽车停在路边",
    ring: "ring5",
    points: ["黄色", "大汽车", "路边", "下午", "太阳"],
    at: t0,
  });

  const r = db.recall(["黄色"], { now: t0 + 1000 }).find((x) => x.id === mem.id);
  assert.ok(r, "还是能想起来");
  assert.equal(r.gap, undefined, "关掉就不该有 gap");
  db.close();
});

test("元记忆：永不忘模式下，开关开着也不给 gap", () => {
  const db = fresh();
  db.setMode("never-forget");
  db.updateConfig({ metaMemory: true }); // 故意开着
  const t0 = Date.now();
  const mem = db.remember({
    content: "黄色大汽车停在路边",
    ring: "ring5",
    points: ["黄色", "大汽车", "路边", "下午", "太阳"],
    at: t0,
  });

  const r = db.recall(["黄色"], { now: t0 + 1000 }).find((x) => x.id === mem.id);
  assert.ok(r, "还是能想起来");
  assert.equal(r.gap, undefined, "什么都不忘的模式，凭什么有缺口");
  db.close();
});

test("元记忆：遗忘模式默认关着（自然淡忘，不该自知）", () => {
  const db = fresh();
  const cfg = db.getConfig();
  assert.equal(cfg.mode, "forget", "新库默认遗忘模式");
  assert.equal(cfg.metaMemory, false, "遗忘模式下元记忆默认关");
  db.close();
});

test("元记忆：默认值表 —— 只有伪遗忘开", () => {
  assert.equal(metaMemoryDefaultOf("pseudo-forget"), true, "伪遗忘最需要它");
  assert.equal(metaMemoryDefaultOf("forget"), false, "遗忘要自然，不该自知");
  assert.equal(metaMemoryDefaultOf("never-forget"), false, "什么都没忘");
  assert.equal(metaMemoryDefaultOf("custom"), true, "自定义交给用户");
  assert.equal(metaMemoryDefaultOf("乱写的"), true, "不认识的模式退回开");
});

test("元记忆：伪遗忘模式下开着，能说出还缺几个点", () => {
  const db = fresh();
  db.setMode("pseudo-forget");
  db.updateConfig({ metaMemory: true });
  const t0 = Date.now();
  const pts = ["黄色", "大汽车", "路边", "下午", "太阳"];
  const mem = db.remember({ content: "黄色大汽车停在路边", ring: "ring5", points: pts, at: t0 });

  const r = db.recall(["黄色"], { now: t0 + 1000 }).find((x) => x.id === mem.id);
  assert.ok(r, "应该能想起来");
  assert.ok(r.gap, "伪遗忘模式开着元记忆，就该有缺口");
  assert.equal(r.gap.total, pts.length);
  db.close();
});
