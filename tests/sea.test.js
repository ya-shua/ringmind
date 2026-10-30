/**
 * 记忆海 · 测试
 *
 * 海是只读的视图，不碰记忆逻辑（那是 core.test.js 的活）。
 * 这里只验证「画出来的东西跟设计一致」：
 *   - 圈画在对应的轨道上，圆心的星挂在心外一圈
 *   - 越老越靠外（往外掉画进位置里）
 *   - 亮度跟模式走（遗忘 vs 永不忘，整片海不一样亮）
 *   - 闲聊圈逐日变淡
 *   - 共享钩子的记忆连成线，每星最多 6 条
 *   - 同一条记忆每次都在同一个位置（确定性）
 *   - 总库默认不画，要了才给幻影
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ringmind } from "../src/index.js";
import { metaMemoryDefaultOf } from "../src/core/rings.js";
import { buildSeaScene, SEA_ORBITS } from "../src/web/sea.js";
import { createServer } from "../src/web/server.js";

const DAY = 86400000;
const NOW = Date.now();

function fresh() {
  return new Ringmind(":memory:", "海测试库");
}

/** 某条星到圆心的距离 */
function radiusOf(star) {
  return Math.hypot(star.x, star.y, star.z);
}

function starOf(scene, id) {
  return scene.points.find((s) => s.id === id);
}

test("每条记忆都成星，圈画在对应的轨道上", () => {
  const db = fresh();
  const a = db.remember({ content: "圆心：我的底线是不说谎", ring: "core", points: ["底线"], speaker: "self" });
  const b = db.remember({ content: "一圈：一起去看海，特别开心", ring: "ring1", points: ["看海", "开心"], emotion: 8 });
  const c = db.remember({ content: "闲聊：今天天气不错", ring: "ring4", points: ["天气"] });

  const scene = buildSeaScene(db.store, db.getConfig(), { now: NOW });

  assert.equal(scene.points.length, 3);
  assert.equal(starOf(scene, a.id).ring, "core");
  assert.equal(starOf(scene, b.id).ring, "ring1");
  assert.equal(starOf(scene, c.id).ring, "ring4");
  assert.equal(scene.stats.pointsTotal, 4); // 1 + 2 + 1
  assert.equal(scene.stats.pointsAlive, 4);

  db.close();
});

test("圆心的星挂在心外，一圈贴着轨道", () => {
  const db = fresh();
  const a = db.remember({ content: "圆心的秘密", ring: "core", points: ["秘密"] });
  const b = db.remember({ content: "一圈的大事", ring: "ring1", points: ["大事"] });

  const scene = buildSeaScene(db.store, db.getConfig(), { now: NOW });

  const coreR = radiusOf(starOf(scene, a.id));
  assert.ok(coreR >= SEA_ORBITS.core[0] - 7 && coreR <= SEA_ORBITS.core[1] + 1, "圆心的星挂在心外一圈（不叠在心上，也不跑远）");
  const r = radiusOf(starOf(scene, b.id));
  assert.ok(r >= SEA_ORBITS.ring1[0] - 12 && r <= SEA_ORBITS.ring1[1] + 12, `一圈的星应落在轨道上，实际 ${r}`);

  db.close();
});

test("同圈里越老的星越靠外 —— 掉圈之前，位置先掉", () => {
  const db = fresh();
  const oldOne = db.remember({ content: "九十天前的事", ring: "ring1", points: ["旧事"] });
  const newOne = db.remember({ content: "昨天的事", ring: "ring1", points: ["新事"] });
  db.store.moveRing(oldOne.id, "ring1", NOW - 80 * DAY);
  db.store.moveRing(newOne.id, "ring1", NOW - 2 * DAY);

  const scene = buildSeaScene(db.store, db.getConfig(), { now: NOW });

  assert.ok(
    radiusOf(starOf(scene, oldOne.id)) > radiusOf(starOf(scene, newOne.id)),
    "待得久的星应该更靠外缘"
  );

  db.close();
});

test("亮度跟模式走：遗忘模式下模糊圈比一圈暗，永不忘下整片海都亮", () => {
  const db = fresh();
  const inner = db.remember({ content: "一圈的事", ring: "ring1", points: ["一"] });
  const fuzzy = db.remember({ content: "模糊的事", ring: "ring5", points: ["五"] });

  const forget = buildSeaScene(db.store, db.getConfig(), { now: NOW });
  assert.ok(
    starOf(forget, fuzzy.id).alpha < starOf(forget, inner.id).alpha,
    "她快看不见的圈，星就该暗"
  );
  assert.ok(starOf(forget, fuzzy.id).alpha >= 0.35, "但面板是人的上帝视角，不能全黑");

  db.setMode("never-forget");
  const never = buildSeaScene(db.store, db.getConfig(), { now: NOW });
  assert.equal(starOf(never, fuzzy.id).alpha, 1.0, "永不忘模式一个点都不少，星就该满亮");

  db.close();
});

test("闲聊圈的星逐日变淡（fadePerDay）", () => {
  const db = fresh();
  const freshOne = db.remember({ content: "刚说的闲聊", ring: "ring4", points: ["刚"] });
  const staleOne = db.remember({ content: "几天前的闲聊", ring: "ring4", points: ["旧"] });
  db.store.moveRing(staleOne.id, "ring4", NOW - 4.5 * DAY);

  const scene = buildSeaScene(db.store, db.getConfig(), { now: NOW });

  assert.equal(starOf(scene, freshOne.id).alpha, 1.0, "刚进圈一个点都不少");
  assert.ok(
    starOf(scene, staleOne.id).alpha < 0.95,
    `待了几天的星该淡了，实际 ${starOf(scene, staleOne.id).alpha}`
  );

  db.close();
});

test("共享钩子的记忆连成线，每颗星最多 6 条", () => {
  const db = fresh();
  const a = db.remember({ content: "和大肥鱼去河边抓虾", ring: "ring3", points: ["大肥鱼", "抓虾"] });
  const b = db.remember({ content: "大肥鱼说好下周去看海", ring: "ring2", points: ["大肥鱼", "看海"] });

  const scene = buildSeaScene(db.store, db.getConfig(), { now: NOW });

  const linked = scene.edges.some(
    (e) => (e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id)
  );
  assert.ok(linked, "共享同一个钩子的两条记忆该连起来");

  // 8 条记忆全共享同一个钩子：谁都不能超过 6 条线
  for (let i = 0; i < 8; i++) {
    db.remember({ content: "第" + i + "件有共享钩的事" + "甲乙丙丁戊己庚辛"[i].repeat(4), ring: "ring3", points: ["共享钩", "词" + i] });
  }
  const busy = buildSeaScene(db.store, db.getConfig(), { now: NOW });
  const deg = new Map();
  for (const e of busy.edges) {
    deg.set(e.a, (deg.get(e.a) || 0) + 1);
    deg.set(e.b, (deg.get(e.b) || 0) + 1);
  }
  for (const [id, d] of deg) assert.ok(d <= 6, `星 ${id} 有 ${d} 条线，超了`);
  assert.ok(busy.edges.length >= 8, "共享钩的连线大部分都该在");

  db.close();
});

test("不相关的记忆不硬连", () => {
  const db = fresh();
  const a = db.remember({ content: "修好了漏水的水龙头", ring: "ring3", points: ["水龙头"] });
  const b = db.remember({ content: "讨论小说的结局怎么写", ring: "ring3", points: ["小说"] });

  const scene = buildSeaScene(db.store, db.getConfig(), { now: NOW });
  const linked = scene.edges.some(
    (e) => (e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id)
  );
  assert.ok(!linked, "八竿子打不着的两条别连");

  db.close();
});

test("同一条记忆每次都在同一个位置（确定性）", () => {
  const db = fresh();
  const m = db.remember({ content: "位置不该跳的记忆", ring: "ring2", points: ["稳"] });

  const s1 = buildSeaScene(db.store, db.getConfig(), { now: NOW });
  const s2 = buildSeaScene(db.store, db.getConfig(), { now: NOW });

  const p1 = starOf(s1, m.id), p2 = starOf(s2, m.id);
  assert.deepEqual([p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], "同样的库、同样的时刻，位置必须一样");

  db.close();
});

test("总库默认不画，要了才给幻影", () => {
  const db = fresh();
  db.remember({ content: "原始消息一", ring: "ring4", points: ["一"] });
  db.remember({ content: "原始消息二", ring: "ring4", points: ["二"] });
  assert.equal(db.store.vaultCount(), 2, "remember 会往总库存原始消息");

  const plain = buildSeaScene(db.store, db.getConfig(), { now: NOW });
  assert.equal(plain.ghosts.length, 0, "默认没有幻影");
  assert.equal(plain.stats.vault, 2, "但总数里报出来");

  const withVault = buildSeaScene(db.store, db.getConfig(), { now: NOW, vault: true });
  assert.equal(withVault.ghosts.length, 2);
  for (const g of withVault.ghosts) {
    assert.equal(g.ring, "vault");
    assert.ok(g.alpha < 0.25, "幻影就该几乎看不见");
    assert.ok(radiusOf(g) >= SEA_ORBITS.vault[0] - 1, "幻影在最外层");
  }

  db.close();
});

test("圈元数据：她看得见的圈有标记，元记忆标记跟 recall 同一套硬保障", () => {
  const db = fresh();
  const scene = buildSeaScene(db.store, db.getConfig(), { now: NOW });

  const byId = Object.fromEntries(scene.rings.map((r) => [r.id, r]));
  assert.equal(byId.core.sheSees, true);
  assert.equal(byId.ring2.sheSees, true);
  assert.equal(byId.ring4.sheSees, false);
  assert.equal(byId.recall.sheSees, false);

  // 跟着当前默认值走（rings.js 的 META_MEMORY_DEFAULT 是会演进的设计，海不该写死它）
  const cfg = db.getConfig();
  assert.equal(
    scene.metaMemory,
    !!cfg.metaMemory && cfg.mode !== "never-forget",
    "海的元记忆标记 = 配置值 + 永不忘硬挡"
  );
  assert.equal(scene.metaMemory, metaMemoryDefaultOf(cfg.mode), "新库的默认值应该跟 META_MEMORY_DEFAULT 一致");

  db.setMode("never-forget");
  const never = buildSeaScene(db.store, db.getConfig(), { now: NOW });
  assert.equal(never.metaMemory, false, "永不忘模式下元记忆硬性不生效");

  db.close();
});

test("面板接口：没登录不给海，登录了才给", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ringmind-sea-"));
  const s = await createServer({ dataDir: dir, port: 0 });
  try {
    const denied = await fetch(s.url + "/api/sea");
    assert.equal(denied.status, 401, "没登录拿不到海");

    s.db.remember({ content: "面板里的记忆", ring: "ring3", points: ["海"] });

    const login = await fetch(s.url + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: s.token }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const r = await fetch(s.url + "/api/sea", { headers: { cookie } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.equal(j.data.points.length, 1);
    assert.equal(j.data.points[0].ring, "ring3");
    assert.ok(j.data.rings.some((x) => x.id === "core"), "圈元数据要给全");
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
