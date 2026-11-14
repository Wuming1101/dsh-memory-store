-- dsh-memory-store 最小表结构（兼容 schema v4 的读写子集）
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE TABLE IF NOT EXISTS memories (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT    NOT NULL CHECK (kind IN
                     ('fact','pref','insight','update','diary','core','reflection')),
  text               TEXT    NOT NULL,
  subject            TEXT,
  scope              TEXT    NOT NULL CHECK (scope IN
                     ('owner','friend','group','self','public','legacy')),
  scope_id           TEXT    NOT NULL,
  person_id          INTEGER REFERENCES people(id),
  conversation_type  TEXT    DEFAULT 'dm',
  source_message_ids TEXT,
  source_episode_id  INTEGER REFERENCES episodes(id),
  importance         REAL    NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  emotional          INTEGER NOT NULL DEFAULT 0 CHECK (emotional IN (0,1)),
  emotion            TEXT,
  status             TEXT    NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','pending_audit','superseded','archived')),
  superseded_by      INTEGER REFERENCES memories(id),
  content_hash       TEXT    NOT NULL,
  embed_model        TEXT,
  dim                INTEGER,
  embedding          BLOB,
  created_ts         INTEGER NOT NULL,
  updated_ts         INTEGER NOT NULL,
  last_seen_ts       INTEGER NOT NULL,
  archived_ts        INTEGER,
  surprise           REAL,
  valence            REAL,
  arousal            REAL,
  flash              INTEGER NOT NULL DEFAULT 0 CHECK (flash IN (0,1)),
  code6              INTEGER,
  last_injected_ts   INTEGER,
  inject_count_30m   INTEGER NOT NULL DEFAULT 0,
  extra              TEXT,
  self_ref           INTEGER NOT NULL DEFAULT 0,
  agency             TEXT,
  confidence         REAL,
  expires_at         INTEGER
);

CREATE TABLE IF NOT EXISTS episodes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT    NOT NULL,
  conversation_id   TEXT    NOT NULL,
  conversation_type TEXT    NOT NULL DEFAULT 'dm',
  scope             TEXT    NOT NULL,
  scope_id          TEXT    NOT NULL,
  person_id         INTEGER REFERENCES people(id),
  kind              TEXT    NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn','scene','session')),
  text              TEXT    NOT NULL,
  start_ts          INTEGER NOT NULL,
  end_ts            INTEGER NOT NULL,
  msg_from          INTEGER,
  msg_to            INTEGER,
  importance        REAL    NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  embed_model       TEXT,
  dim               INTEGER,
  embedding         BLOB,
  content_hash      TEXT    NOT NULL,
  created_ts        INTEGER NOT NULL,
  title             TEXT,
  scene_label       TEXT,
  topic             TEXT,
  segment_id        INTEGER,
  member_ids        TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  platform          TEXT    NOT NULL DEFAULT 'dsh',
  session_id        TEXT    NOT NULL,
  conversation_id   TEXT    NOT NULL,
  conversation_type TEXT    NOT NULL DEFAULT 'dm'
                    CHECK (conversation_type IN ('dm','group','self')),
  sender_id         TEXT    NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  text              TEXT    NOT NULL,
  ts                INTEGER NOT NULL,
  seq               INTEGER,
  scope             TEXT    NOT NULL,
  scope_id          TEXT    NOT NULL,
  content_hash      TEXT    NOT NULL,
  raw_meta          TEXT,
  created_ts        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(text, grams, tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS epi_fts USING fts5(text, grams, tokenize='unicode61');

CREATE INDEX IF NOT EXISTS ix_memories_scope  ON memories(scope, scope_id, status);
CREATE INDEX IF NOT EXISTS ix_memories_kind   ON memories(kind, status);
CREATE INDEX IF NOT EXISTS ix_memories_hash   ON memories(content_hash);
CREATE INDEX IF NOT EXISTS ix_episodes_scope  ON episodes(scope, scope_id, start_ts);
CREATE INDEX IF NOT EXISTS ix_messages_conv   ON messages(conversation_id, ts);
