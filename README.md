# dsh-memory-store ｜ 本地记忆库读写层

给 DSH 加一组 `companion_memory_*` 工具：一个 SQLite 文件就是长期记忆，支持四路召回、软删、会话采集和可选的系统提示注入。

## 做什么

- 读：事实 FTS、事实向量、情境段 FTS、情境段向量四路召回，RRF 融合后按重要度 × 时间衰减排序
- 写：`remember` / `update` / `forget`，只软删（写 `archived_ts`），不物理删
- 采集：监听会话事件，把消息写进 `messages`，每轮结束落一条 `kind = turn` 的 episode
- 治理：`gc` 归档又旧又不重要的条目，默认 dryRun
- 注入（可选）：每轮从最近的消息里检索，拼一段不超过 `maxChars` 的 `<companion_memory>` 块塞进系统提示，带冷却

## 不做什么

- 不做自动抽取、星图、审计那些后台任务
- 不自己跑 embedding 模型：向量走 Ollama 的 `/api/embeddings`，拿不到就退化成纯 FTS

## 要求

| 项 | 要求 |
| --- | --- |
| DSH | 0.2.2-rc.1 |
| Node | >= 22.12（内置 `node:sqlite`，需要 FTS5） |
| 数据库 | 一个 SQLite 文件；空目录会自动按 `schema.sql` 建库 |
| 可选 | Ollama + `bge-m3`（1024 维向量） |

## 安装

1. 放好仓库，在 profile 的 `package.json` 里加 `"dsh-memory-store": "link:D:/plugins/dsh-memory-store"`
2. 想单独建库可以跑：

```bash
node tools/init-db.mjs D:/data/memory-store
```

3. 在 profile 的 `cordis.patch.yml` 里写配置（`dataDir` 指到你自己的目录）
4. 重启 DSH

## 工具

| 工具 | 做什么 |
| --- | --- |
| `companion_memory_search(query, limit?, kinds?)` | 四路召回 |
| `companion_memory_remember(text, kind?, importance?)` | 写一条 |
| `companion_memory_update(id, text?, importance?, status?)` | 改一条 |
| `companion_memory_forget(id, reason?)` | 软删 |
| `companion_memory_gc(dryRun?, minAgeDays?, maxImportance?, limit?)` | 归档清理 |
| `companion_memory_stats()` | 计数与状态 |

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `<DSH_HOME>/memory-store` | 数据库目录 |
| `dbFile` | `memory.db` | 文件名 |
| `readOnly` | `false` | 只读模式：库不存在也不建 |
| `capture` | `true` | 是否把会话消息写进库 |
| `recallLimit` | `8` | 默认召回条数 |
| `minScore` | `0.12` | 召回最低分 |
| `embedding.enabled` | `true` | 是否调 Ollama 算向量 |
| `embedding.endpoint` | `http://localhost:11434` | Ollama 地址 |
| `embedding.model` | `bge-m3` | 向量模型 |
| `injection.enabled` | `true` | 是否自动注入系统提示 |
| `injection.maxChars` | `1200` | 注入块上限 |
| `injection.cooldownMs` | `1800000` | 两次注入的最小间隔 |

## 数据约定

- 默认 `scope = owner`、`scope_id = owner:local`、`conversation_type = dm`
- `mem_fts` / `epi_fts` 是 FTS5 `(text, grams)`，`grams` 存空格分隔的中文 bigram
- `embedding` 是 Float32Array 的 BLOB，维度跟着模型走
- 兼容 schema v4 的既有库：表结构不改，直接读写

## 已知限制

- 中文检索靠 bigram，`minScore` 偏保守时召回会少
- Ollama 没起时向量召回静默退化，不影响 FTS
- 注入会占系统提示预算，长会话里建议调小 `maxChars`


## 风险

- 聊天原文会写进本机 SQLite，库文件本身就是隐私；备份、加密、删除要自己管
- 注入会把检索到的片段塞进模型请求，等于把记忆内容发给模型服务商
- 同一台机器的其他账号能读到这个库
- `forget` 是软删，物理文件里还在；要真删得自己清库
- `dataDir` 指错（指到旧库或空目录）会写脏数据，换目录前先备份

---

作者：温凌微（Vera），网名暗海拾星。个人自用后整理开源，不是官方项目。
