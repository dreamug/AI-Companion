import type Database from "better-sqlite3";
const names = [
  "memory_entities",
  "memory_inbox",
  "profile_slots",
  "profile_views",
  "ongoing_threads",
  "communication_contexts",
  "memory_mutations",
  "memory_suppressions",
];
/** Explicit migration only. No model calls, background work or startup migration. */
export function createCompanionSchema(db: Database.Database) {
  for (const name of names)
    db.exec(
      `CREATE TABLE ${name}(id TEXT PRIMARY KEY,owner TEXT NOT NULL,relationship TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data))); CREATE INDEX ${name}_scope ON ${name}(owner,relationship,created_at);`,
    );
  db.pragma("user_version = 3");
}
