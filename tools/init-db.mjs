#!/usr/bin/env node
/**
 * 建一个空的 dsh-memory-store 记忆库。
 * 用法：node tools/init-db.mjs [数据目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const arg = process.argv[2] || process.env.DSH_MEMORY_STORE_DIR || ''
const dataDir = arg || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory-store')
fs.mkdirSync(dataDir, { recursive: true })

const file = path.join(dataDir, 'memory.db')
const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

const db = new DatabaseSync(file)
db.exec(schema)
const tables = db
  .prepare("select name from sqlite_master where type = 'table' order by name")
  .all()
  .map((r) => r.name)

console.log('已初始化: ' + file)
console.log('表: ' + tables.join(', '))
db.close()
