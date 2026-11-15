/**
 * dsh-memory-store —— 本地记忆库读写层
 *
 * 数据默认落在 <DSH_HOME>/memory-store/memory.db；目录为空时按 schema.sql 建库。
 * 兼容既有 schema v4 的库（表结构不改），直接读写。
 *
 * 读：四路召回 —— 事实 FTS、事实向量、情境段 FTS、情境段向量，RRF 融合后
 *     按重要度 × 时间衰减排序。
 * 写：remember / update / forget（软删，写 archived_ts，永不物理删）。
 * 采集：监听会话事件，把 user/assistant 消息写进 messages，每轮结束落一条
 *       kind='turn' 的 episode 并同步 epi_fts（按 content_hash 去重）。
 * 治理：companion_memory_gc 归档又旧又不重要的条目，默认 dryRun。
 *
 * 表结构要点（原插件留的）：
 *   memories / episodes / messages，两张 FTS5 表 mem_fts、epi_fts 都是 (text, grams)，
 *   grams 存空格分隔的中文 bigram；embedding 是 Float32Array 的 BLOB。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const name = 'dsh-memory-store'
// 必须等 tools 服务就绪再 apply，否则 ctx.get('tools') 是空的，六个 companion_memory_* 工具都注册不上，
// 注入钩子也会被提前 return 掉。
export const inject = ['tools']

const DEFAULT_DATA_DIR =
  process.env.DSH_MEMORY_STORE_DIR
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory-store')
const K = 10

function now() {
  return Date.now()
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 中文 bigram：把一段话切成「相邻两字」的 token，跟 mem_fts.grams 的存法对齐。 */
export function bigrams(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim()
  const out = new Set()
  for (const chunk of s.split(/\s+/)) {
    if (!chunk) continue
    const chars = [...chunk]
    if (chars.length === 1) out.add(chars[0])
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
  }
  return [...out]
}

function toBlob(vec) {
  const f = Float32Array.from(vec)
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

function fromBlob(buf) {
  if (!buf) return null
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4))
  } catch {
    return null
  }
}

function cosine(a, b) {
  if (!a || !b) return 0
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

async function embed(cfg, text) {
  const e = cfg.embedding || {}
  if (!e.enabled) return null
  try {
    const url = `${String(e.endpoint || 'http://localhost:11434').replace(/\/+$/, '')}/api/embeddings`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: e.model || 'bge-m3', prompt: String(text ?? '').slice(0, 4000) }),
      signal: AbortSignal.timeout(Number(e.timeoutMs) || 8000),
    })
    if (!res.ok) return null
    const json = await res.json()
    const vec = json?.embedding
    if (!Array.isArray(vec) || vec.length < 32) return null
    return vec
  } catch {
    return null
  }
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite')
  const existed = fs.existsSync(file)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 4000')
  if (!existed) {
    const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    db.exec(schema)
    console.info(`[memory-store] 新建记忆库并初始化表结构: ${file}`)
  }
  return db
}

function text(value) {
  return String(value ?? '')
}

/** 从 DSH 会话事件里抽纯文本（跳过 reasoning / 工具块）。 */
function eventText(event) {
  const data = event?.data ?? event
  const blocks = data?.message?.content ?? data?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function localDay(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function apply(ctx, rawConfig = {}) {
  const cfg = {
    dataDir: DEFAULT_DATA_DIR,
    dbFile: 'memory.db',
    readOnly: false,
    capture: true,
    recallLimit: 8,
    minScore: 0.12,
    embedding: { enabled: true, endpoint: 'http://localhost:11434', model: 'bge-m3', timeoutMs: 8000 },
    injection: { enabled: true, maxChars: 1200, cooldownMs: 30 * 60 * 1000, minQueryChars: 6 },
    ...rawConfig,
    embedding: {
      ...{ enabled: true, endpoint: 'http://localhost:11434', model: 'bge-m3', timeoutMs: 8000 },
      ...(rawConfig.embedding || {}),
    },
    injection: {
      ...{ enabled: true, maxChars: 1200, cooldownMs: 30 * 60 * 1000, minQueryChars: 6 },
      ...(rawConfig.injection || {}),
    },
  }

  const dbPath = path.join(cfg.dataDir, cfg.dbFile)
  let db = null
  let dbError = null
  try {
    if (!fs.existsSync(dbPath)) {
      if (cfg.readOnly) throw new Error(`数据文件不存在: ${dbPath}`)
      fs.mkdirSync(cfg.dataDir, { recursive: true })
    }
    db = openDb(dbPath)
  } catch (err) {
    dbError = String(err?.message || err)
    console.error(`[memory-forge] 打开记忆库失败: ${dbError}`)
  }

  const requireDb = () => {
    if (!db) throw new Error(`记忆库不可用：${dbError || '未初始化'}`)
    return db
  }

  // ── 检索：四路召回 ────────────────────────────────────
  function ftsIds(table, grams, limit) {
    if (!grams.length) return []
    for (const mode of ['and', 'or']) {
      const q = grams.map((g) => `"${g}"`).join(mode === 'and' ? ' ' : ' OR ')
      try {
        const rows = db
          .prepare(`SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) LIMIT ?`)
          .all(q, limit)
        if (rows.length) return rows.map((r) => Number(r.id))
      } catch {
        /* 换下一种 */
      }
    }
    return []
  }

  function vectorIds(table, qvec, where, limit) {
    if (!qvec) return []
    try {
      const rows = db
        .prepare(`SELECT id, embedding FROM ${table} WHERE embedding IS NOT NULL AND ${where} LIMIT 1200`)
        .all()
      const sims = []
      for (const r of rows) {
        const v = fromBlob(r.embedding)
        if (!v) continue
        const sim = cosine(Float32Array.from(qvec), v)
        if (sim > 0.2) sims.push([Number(r.id), sim])
      }
      sims.sort((a, b) => b[1] - a[1])
      return sims.slice(0, limit).map(([id]) => id)
    } catch {
      return []
    }
  }

  const FIELDS = {
    m: 'id, kind, text, importance, status, created_ts, last_seen_ts',
    e: 'id, kind, title, scene_label, text, importance, status, start_ts, end_ts',
  }

  async function recall(query, limit = cfg.recallLimit, kinds) {
    if (!db) throw new Error(`记忆库不可用：${dbError || '未初始化'}`)
    const text0 = text(query).trim()
    if (!text0) return []
    const n = Math.max(1, Math.min(50, Number(limit) || cfg.recallLimit))
    const grams = bigrams(text0)
    const grab = n * 4
    const qvec = await embed(cfg, text0)

    const cands = new Map() // key -> { mfts?, mvec?, efts?, evec? }
    const bump = (key, chan, rank) => {
      const cur = cands.get(key) || {}
      if (!cur[chan] || rank < cur[chan]) cur[chan] = rank
      cands.set(key, cur)
    }

    ftsIds('mem_fts', grams, grab).forEach((id, i) => bump(`m:${id}`, 'mfts', i + 1))
    ftsIds('epi_fts', grams, grab).forEach((id, i) => bump(`e:${id}`, 'efts', i + 1))
    vectorIds('memories', qvec, "status = 'active'", grab).forEach((id, i) => bump(`m:${id}`, 'mvec', i + 1))
    vectorIds('episodes', qvec, "status = 'active' AND kind IN ('turn','scene')", grab).forEach((id, i) =>
      bump(`e:${id}`, 'evec', i + 1),
    )

    if (!cands.size) return []

    // 按类型取详情
    const memIds = []
    const epiIds = []
    for (const key of cands.keys()) {
      const [t, id] = key.split(':')
      ;(t === 'm' ? memIds : epiIds).push(Number(id))
    }
    const details = new Map()
    if (memIds.length) {
      for (const row of db
        .prepare(`SELECT ${FIELDS.m} FROM memories WHERE id IN (${memIds.map(() => '?').join(',')})`)
        .all(...memIds))
        details.set(`m:${row.id}`, row)
    }
    if (epiIds.length) {
      for (const row of db
        .prepare(`SELECT ${FIELDS.e} FROM episodes WHERE id IN (${epiIds.map(() => '?').join(',')})`)
        .all(...epiIds))
        details.set(`e:${row.id}`, row)
    }

    const chans = 4
    const maxRrf = chans / (K + 1)
    const ranked = []
    for (const [key, ch] of cands) {
      const row = details.get(key)
      if (!row) continue
      if (row.status && row.status !== 'active') continue
      if (key.startsWith('e:') && row.kind && !['turn', 'scene'].includes(row.kind)) continue
      if (Array.isArray(kinds) && kinds.length && !kinds.includes(row.kind)) continue
      let rrf = 0
      for (const c of ['mfts', 'mvec', 'efts', 'evec']) if (ch[c]) rrf += 1 / (K + ch[c])
      let score = (rrf / maxRrf) * (0.5 + Math.min(1, Math.max(0, Number(row.importance) || 0.3)))
      const ts = Number(row.last_seen_ts || row.created_ts || row.start_ts || 0)
      if (ts > 0) {
        const days = (now() - ts) / 86400000
        score *= Math.max(0.3, Math.pow(0.5, days / 30))
      }
      if (score < Number(cfg.minScore)) continue
      ranked.push({
        type: key.startsWith('e:') ? 'episode' : 'memory',
        id: Number(row.id),
        kind: row.kind,
        text: row.text,
        title: row.title || undefined,
        scene: row.scene_label || undefined,
        importance: row.importance,
        at: ts ? new Date(ts).toISOString() : undefined,
        score: Number(score.toFixed(6)),
        via: ['mfts', 'mvec', 'efts', 'evec'].filter((c) => ch[c]).join('+'),
      })
    }
    ranked.sort((a, b) => b.score - a.score)
    return ranked.slice(0, n)
  }

  // ── 写入 ─────────────────────────────────────────────
  async function remember({ text: body, kind = 'fact', importance = 0.5, scope, scopeId, personId }) {
    const d = requireDb()
    const content = text(body).trim()
    if (!content) throw new Error('text 不能为空')
    if (cfg.readOnly) throw new Error('memory-forge 当前是只读模式')
    const hash = sha256(content)
    const dup = d.prepare('SELECT id, status FROM memories WHERE content_hash = ? LIMIT 1').get(hash)
    const ts = now()
    if (dup) {
      d.prepare('UPDATE memories SET last_seen_ts = ? WHERE id = ?').run(ts, dup.id)
      return { id: Number(dup.id), duplicated: true, status: dup.status }
    }
    const vec = await embed(cfg, content)
    const info = d
      .prepare(
        `INSERT INTO memories (kind, text, importance, status, content_hash, created_ts, updated_ts, last_seen_ts,
           scope, scope_id, conversation_type, person_id, embed_model, dim, embedding)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        kind,
        content,
        Number(importance) || 0.5,
        'active',
        hash,
        ts,
        ts,
        ts,
        scope || 'owner',
        scopeId || 'owner:local',
        'dm',
        personId ?? null,
        vec ? cfg.embedding.model : null,
        vec ? vec.length : null,
        vec ? toBlob(vec) : null,
      )
    const id = Number(info.lastInsertRowid)
    d.prepare('INSERT INTO mem_fts(rowid, text, grams) VALUES (?,?,?)').run(id, content, bigrams(content).join(' '))
    return { id, duplicated: false, embedded: Boolean(vec) }
  }

  async function update({ id, text: body, importance, status }) {
    const d = requireDb()
    if (cfg.readOnly) throw new Error('memory-forge 当前是只读模式')
    const row = d.prepare('SELECT id, text FROM memories WHERE id = ?').get(Number(id))
    if (!row) throw new Error(`没有 id=${id} 的记忆`)
    const ts = now()
    if (body !== undefined) {
      const content = text(body).trim()
      const vec = await embed(cfg, content)
      d.prepare(
        'UPDATE memories SET text = ?, content_hash = ?, updated_ts = ?, embed_model = ?, dim = ?, embedding = ? WHERE id = ?',
      ).run(
        content,
        sha256(content),
        ts,
        vec ? cfg.embedding.model : null,
        vec ? vec.length : null,
        vec ? toBlob(vec) : null,
        Number(id),
      )
      d.prepare('DELETE FROM mem_fts WHERE rowid = ?').run(Number(id))
      d.prepare('INSERT INTO mem_fts(rowid, text, grams) VALUES (?,?,?)').run(Number(id), content, bigrams(content).join(' '))
    }
    if (importance !== undefined) d.prepare('UPDATE memories SET importance = ?, updated_ts = ? WHERE id = ?').run(Number(importance), ts, Number(id))
    if (status !== undefined) d.prepare('UPDATE memories SET status = ?, updated_ts = ? WHERE id = ?').run(String(status), ts, Number(id))
    return { id: Number(id), updated: true }
  }

  function forget({ id, reason }) {
    const d = requireDb()
    if (cfg.readOnly) throw new Error('memory-forge 当前是只读模式')
    const row = d.prepare('SELECT id, status FROM memories WHERE id = ?').get(Number(id))
    if (!row) throw new Error(`没有 id=${id} 的记忆`)
    d.prepare("UPDATE memories SET status = 'archived', archived_ts = ?, updated_ts = ? WHERE id = ?").run(now(), now(), Number(id))
    return { id: Number(id), status: 'archived', reason: reason ?? null, physicalDelete: false }
  }

  function stats() {
    const d = requireDb()
    const byKind = d.prepare("SELECT kind, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY kind ORDER BY n DESC").all()
    const byStatus = d.prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status').all()
    const epi = d.prepare("SELECT kind, COUNT(*) AS n FROM episodes WHERE status = 'active' GROUP BY kind").all()
    const msgs = d.prepare('SELECT COUNT(*) AS n FROM messages').get()
    const size = (() => {
      try {
        return fs.statSync(dbPath).size
      } catch {
        return null
      }
    })()
    const jobs = d.prepare('SELECT name, last_ok_ts, last_error FROM jobs ORDER BY name').all()
    return {
      db: dbPath,
      bytes: size,
      memories: Number(byStatus.reduce((a, r) => a + Number(r.n), 0)),
      byKind,
      byStatus,
      episodes: epi,
      messages: Number(msgs?.n ?? 0),
      jobs,
    }
  }

  /** GC：归档「又旧又不重要」的事实，默认 dryRun。不碰 critical 语义（核心/反思/偏好不动）。 */
  function gc({ dryRun = true, minAgeDays = 45, maxImportance = 0.4, limit = 50 } = {}) {
    const d = requireDb()
    if (cfg.readOnly) throw new Error('memory-forge 当前是只读模式')
    const cutoff = now() - Number(minAgeDays) * 86400000
    const rows = d
      .prepare(
        `SELECT id, kind, text, importance, created_ts FROM memories
         WHERE status = 'active'
           AND importance <= ?
           AND created_ts < ?
           AND kind NOT IN ('core','reflection','pref')
         ORDER BY importance ASC, created_ts ASC
         LIMIT ?`,
      )
      .all(Number(maxImportance), cutoff, Math.min(500, Math.max(1, Number(limit) || 50)))
    const out = { dryRun: Boolean(dryRun), minAgeDays: Number(minAgeDays), maxImportance: Number(maxImportance), count: rows.length, ids: rows.map((r) => Number(r.id)) }
    if (!dryRun && rows.length) {
      const ts = now()
      const stmt = d.prepare("UPDATE memories SET status = 'archived', archived_ts = ?, updated_ts = ? WHERE id = ?")
      for (const r of rows) stmt.run(ts, ts, Number(r.id))
    }
    return out
  }

  // ── 采集：会话事件 → messages / episodes ─────────────
  const buffers = new Map() // sessionId -> { user: [], assistant: [], startTs }
  const seenHash = new Set()

  function recordMessage(d, { sessionId, role, body, ts }) {
    const content = text(body).trim()
    if (!content) return false
    const hash = sha256(`${sessionId}|${role}|${content}`)
    if (seenHash.has(hash)) return false
    const dup = d.prepare('SELECT id FROM messages WHERE content_hash = ? LIMIT 1').get(hash)
    if (dup) {
      seenHash.add(hash)
      return false
    }
    d.prepare(
      `INSERT INTO messages (platform, session_id, conversation_id, conversation_type, sender_id, role, text, ts,
         scope, scope_id, content_hash, created_ts)
       VALUES ('dsh', ?, ?, 'dm', 'owner', ?, ?, ?, 'owner', 'owner:local', ?, ?)`,
    ).run(sessionId, sessionId, role, content, ts, hash, ts)
    seenHash.add(hash)
    return true
  }

  function recordTurn(d, { sessionId, userText, assistantText, startTs, endTs }) {
    const body = [
      userText ? `用户：${userText}` : '',
      assistantText ? `助手：${assistantText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .trim()
    if (!body) return 0
    const hash = sha256(`${sessionId}|turn|${startTs}|${body}`)
    const dup = d.prepare('SELECT id FROM episodes WHERE content_hash = ? LIMIT 1').get(hash)
    if (dup) return 0
    const title = (userText || assistantText || '').split('\n')[0].slice(0, 60)
    const info = d
      .prepare(
        `INSERT INTO episodes (session_id, conversation_id, conversation_type, scope, scope_id, kind, text,
           start_ts, end_ts, importance, status, content_hash, created_ts, title)
         VALUES (?, ?, 'dm', 'owner', 'owner:local', 'turn', ?, ?, ?, 0.5, 'active', ?, ?, ?)`,
      )
      .run(sessionId, sessionId, body, startTs, endTs, hash, now(), title)
    const id = Number(info.lastInsertRowid)
    d.prepare('INSERT INTO epi_fts(rowid, text, grams) VALUES (?,?,?)').run(id, body, bigrams(body).join(' '))
    return id
  }

  if (cfg.capture && db) {
    try {
      ctx.on('session/event', (session, event) => {
        try {
          const sid =
            (typeof session === 'string' ? session : session?.id || session?.header?.id || session?.session?.id) ?? ''
          if (!sid) return
          const type = event?.type
          const ts = Number(event?.time) || now()
          const buf = buffers.get(sid) || { user: [], assistant: [], startTs: ts }
          if (type === 'turn/start') {
            buffers.set(sid, { user: [], assistant: [], startTs: ts })
            return
          }
          if (type === 'user/message') {
            const body = eventText(event)
            if (body) {
              buf.user.push(body)
              recordMessage(db, { sessionId: sid, role: 'user', body, ts })
              buffers.set(sid, buf)
            }
            return
          }
          if (type === 'assistant/message') {
            const body = eventText(event)
            if (body) {
              buf.assistant.push(body)
              recordMessage(db, { sessionId: sid, role: 'assistant', body, ts })
              buffers.set(sid, buf)
            }
            return
          }
          if (type === 'turn/end') {
            const userText = buf.user.join('\n')
            const assistantText = buf.assistant.join('\n')
            if (userText || assistantText) {
              recordTurn(db, { sessionId: sid, userText, assistantText, startTs: buf.startTs, endTs: ts })
            }
            buffers.delete(sid)
          }
        } catch (err) {
          console.error(`[memory-forge] 采集失败: ${String(err?.message || err)}`)
        }
      })
    } catch (err) {
      console.error(`[memory-forge] 采集钩子没挂上: ${String(err?.message || err)}`)
    }
  }

  // ── 工具注册 ─────────────────────────────────────────
  const tools = ctx.get('tools')
  if (!tools || typeof tools.register !== 'function') {
    console.error('[memory-forge] 没有 tools 服务，工具未注册')
    return
  }

  const define = (spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: text(value) }],
    },
    execute: spec.execute,
  })

  const disposers = []
  const reg = (spec) => {
    try {
      disposers.push(tools.register(define(spec)))
    } catch (err) {
      console.error(`[memory-forge] 注册 ${spec.name} 失败: ${String(err?.message || err)}`)
    }
  }

  reg({
    name: 'companion_memory_search',
    description:
      'Search the long-term memory database — both facts and past conversation episodes (four channels: fact FTS, fact vector, episode FTS, episode vector). Returns the most relevant entries with type, id, kind, text and score.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in natural language. Chinese works best.' },
        limit: { type: 'integer', description: 'Max entries to return. Default 8.' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter: fact, pref, insight, update, diary, core, reflection, turn, scene.',
        },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const rows = await recall(args.query, args.limit, args.kinds)
      if (!rows.length) return '记忆库里没有匹配的条目。'
      return rows
        .map(
          (r) =>
            `[${r.type}:${r.id}] ${r.kind} (${r.score}) ${r.at ? r.at.slice(0, 10) + ' ' : ''}${r.title ? r.title + '｜' : ''}${r.text}`,
        )
        .join('\n')
    },
  })

  reg({
    name: 'companion_memory_remember',
    description:
      'Store one durable memory (a fact, preference, decision or insight) in the long-term memory database. Same text is deduplicated by content hash; a duplicate only refreshes its last-seen time.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory to store, one self-contained statement.' },
        kind: { type: 'string', description: 'fact | pref | insight | update | diary | core | reflection. Default fact.' },
        importance: { type: 'number', description: '0..1, default 0.5.' },
      },
      required: ['text'],
    },
    execute: async (args) => {
      const r = await remember(args)
      return r.duplicated ? `已存在，更新了最近出现时间（id=${r.id}）` : `已写入 id=${r.id}${r.embedded ? '（含向量）' : ''}`
    },
  })

  reg({
    name: 'companion_memory_update',
    description: 'Update an existing memory by id: its text, importance, or status.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Memory id.' },
        text: { type: 'string', description: 'Replacement text.' },
        importance: { type: 'number', description: '0..1.' },
        status: { type: 'string', description: 'active | archived.' },
      },
      required: ['id'],
    },
    execute: async (args) => {
      const r = await update(args)
      return `已更新 id=${r.id}`
    },
  })

  reg({
    name: 'companion_memory_forget',
    description: 'Retire a memory by id. It becomes archived (tombstone kept); nothing is physically deleted.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Memory id.' },
        reason: { type: 'string', description: 'Why it is retired.' },
      },
      required: ['id'],
    },
    execute: async (args) => {
      const r = forget(args)
      return `已归档 id=${r.id}（未物理删除）`
    },
  })

  reg({
    name: 'companion_memory_gc',
    description:
      'Archive memories that are both old and unimportant. Dry run by default and never touches core, reflection or pref entries. Returns the ids it would archive (or did archive).',
    parameters: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: 'Default true; pass false to actually archive.' },
        minAgeDays: { type: 'integer', description: 'Only entries older than this many days. Default 45.' },
        maxImportance: { type: 'number', description: 'Only entries at or below this importance. Default 0.4.' },
        limit: { type: 'integer', description: 'Max entries per run. Default 50.' },
      },
      required: [],
    },
    execute: async (args) => {
      const r = gc(args || {})
      if (!r.count) return `没有符合条件的条目（年龄 > ${r.minAgeDays} 天、重要度 ≤ ${r.maxImportance}）。`
      return `${r.dryRun ? '预演' : '已归档'} ${r.count} 条：${r.ids.join(', ')}`
    },
  })

  reg({
    name: 'companion_memory_stats',
    description: 'Report memory database size, counts by kind and status, episode/message totals and background job state.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const s = stats()
      const kinds = s.byKind.map((r) => `${r.kind}=${r.n}`).join(', ')
      const eps = s.episodes.map((r) => `${r.kind}=${r.n}`).join(', ')
      const jobs = s.jobs.map((j) => `${j.name}${j.last_error ? '(err)' : ''}`).join(', ')
      return `库 ${s.db}（${Math.round((s.bytes || 0) / 1048576)}MB）\n记忆 ${s.memories} 条：${kinds}\n情境段（active）：${eps || '无'}；消息 ${s.messages} 条\n后台任务：${jobs}`
    },
  })

  // ── 可选注入 ─────────────────────────────────────────
  if (cfg.injection?.enabled) {
    const lastInjected = new Map()
    try {
      ctx.on('agent/created', (agent) => {
        try {
          agent?.ctx?.on?.('system-prompt/assemble', async (assembly, context, next) => {
            const assembled = await next()
            try {
              const sid = String(agent?.id ?? agent?.session?.id ?? '')
              if (now() - (lastInjected.get(sid) || 0) < Number(cfg.injection.cooldownMs)) return assembled
              const query = text(context?.messages?.at?.(-1)?.text ?? '').trim()
              if (query.length < Number(cfg.injection.minQueryChars)) return assembled
              const rows = await recall(query, 4)
              if (!rows.length) return assembled
              let block = '\n\n<companion_memory>\n'
              for (const r of rows) {
                const line = `- ${r.text}`
                if (block.length + line.length > Number(cfg.injection.maxChars)) break
                block += line + '\n'
              }
              block += '</companion_memory>'
              lastInjected.set(sid, now())
              return { ...assembled, variables: { ...(assembled?.variables || {}), companionMemory: block.trim() } }
            } catch {
              return assembled
            }
          })
        } catch {}
      })
    } catch (err) {
      console.error(`[memory-forge] 注入钩子没挂上（不影响工具）: ${String(err?.message || err)}`)
    }
  }

  ctx.on('dispose', () => {
    for (const d of disposers) {
      try {
        d?.()
      } catch {}
    }
    try {
      db?.close?.()
    } catch {}
  })

  console.log(
    `[memory-forge] 已挂载：${dbPath}（${db ? '可读写' : `打不开：${dbError}`}），工具 ${disposers.length} 个，采集 ${cfg.capture ? '开' : '关'}，注入 ${cfg.injection?.enabled ? '开' : '关'}`,
  )
}

export default { name, inject, apply }
