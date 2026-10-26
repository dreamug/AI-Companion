import type Database from "better-sqlite3";
export const MEMORY_SCHEMA = `
CREATE INDEX memory_fact_scan ON memories(owner,relationship,id);
CREATE TABLE memory_state(owner TEXT NOT NULL,relationship TEXT NOT NULL,memoryVersion INTEGER NOT NULL DEFAULT 0,contextVersion INTEGER NOT NULL DEFAULT 0,indexVersion INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,relationship));
CREATE TABLE conversation_segments(id TEXT PRIMARY KEY,owner TEXT NOT NULL,relationship TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE UNIQUE INDEX segment_open ON conversation_segments(owner,relationship) WHERE json_extract(data,'$.status')='open';
CREATE TABLE conversation_summaries(id TEXT PRIMARY KEY,owner TEXT NOT NULL,relationship TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE UNIQUE INDEX summary_identity ON conversation_summaries(owner,relationship,json_extract(data,'$.rangeKey'),json_extract(data,'$.policyVersion'),json_extract(data,'$.inputHash'));
CREATE VIRTUAL TABLE conversation_summary_fts USING fts5(summary_id UNINDEXED,owner UNINDEXED,relationship UNINDEXED,text,tokenize='trigram');
CREATE TABLE memory_dependencies(owner TEXT NOT NULL,relationship TEXT NOT NULL,dependentType TEXT NOT NULL,dependentId TEXT NOT NULL,inputType TEXT NOT NULL,inputId TEXT NOT NULL,PRIMARY KEY(owner,relationship,dependentType,dependentId,inputType,inputId));
CREATE INDEX memory_dependents ON memory_dependencies(owner,relationship,inputType,inputId);
CREATE TABLE memory_embeddings(owner TEXT NOT NULL,relationship TEXT NOT NULL,memoryId TEXT NOT NULL,memoryRevision INTEGER NOT NULL,chunkId TEXT NOT NULL,spanStartUtf16 INTEGER NOT NULL,spanEndUtf16 INTEGER NOT NULL,textHash TEXT NOT NULL,sourceFingerprint TEXT NOT NULL,modelKey TEXT NOT NULL,dimension INTEGER NOT NULL CHECK(dimension=384),vector BLOB NOT NULL CHECK(length(vector)=1536),createdAt INTEGER NOT NULL,PRIMARY KEY(owner,relationship,memoryId,modelKey,chunkId));
CREATE TABLE memory_index_state(owner TEXT NOT NULL,relationship TEXT NOT NULL,memoryId TEXT NOT NULL,wantedRevision INTEGER NOT NULL,modelKey TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('dirty','ready','failed')),attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0,reason TEXT,PRIMARY KEY(owner,relationship,memoryId,modelKey));
`;
export function createMemorySchema(db: Database.Database) {
  db.exec(MEMORY_SCHEMA);
  db.pragma("user_version = 2");
}
