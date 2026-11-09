#!/usr/bin/env node
/**
 * 总库容量上限（条数）。0 = 不限。
 *
 *   node scripts/set-vault-cap.mjs 200000    # 最多留 20 万条，超了删最旧的
 *   node scripts/set-vault-cap.mjs 0         # 不限（默认就是这个）
 *   node scripts/set-vault-cap.mjs           # 只看现在是多少、用了多少
 *
 * 为什么要它：总库是原始存档，只增不减；机器跑几年能把磁盘吃满。
 * 注意删的是**最旧的原文**，删了真找不回来 —— 所以默认不限，设之前想清楚。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ringmind } from '../src/index.js'
import { saveConfig } from '../src/core/config.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function resolveDbPath() {
  if (process.env.RING_DB) return process.env.RING_DB
  try {
    const loc = JSON.parse(readFileSync(join(ROOT, 'data-location.json'), 'utf8'))
    if (loc.dbPath) return loc.dbPath
  } catch { /* 没有就用默认 */ }
  return join(ROOT, 'data', 'memory.db')
}

const db = new Ringmind(resolveDbPath(), 'memory')
const store = db.store
const cfg = db.config
const cap = cfg.vault?.cap ?? 0
const used = store.vaultCount()

const arg = process.argv[2]
if (arg === undefined) {
  console.log(`总库上限：${cap > 0 ? cap + ' 条' : '不限'}`)
  console.log(`现在有：${used} 条`)
  process.exit(0)
}

const n = Number(arg)
if (!Number.isFinite(n) || n < 0) {
  console.error('用法：node scripts/set-vault-cap.mjs <条数|0>')
  process.exit(1)
}

cfg.vault = { ...(cfg.vault || {}), enabled: cfg.vault?.enabled !== false, cap: Math.floor(n) }
saveConfig(store, cfg)

let trimmed = 0
if (n > 0) trimmed = store.trimVault(n)
console.log(`上限改成：${n > 0 ? n + ' 条' : '不限'}`)
console.log(`现在有：${store.vaultCount()} 条${trimmed ? `（刚删了最旧的 ${trimmed} 条）` : ''}`)