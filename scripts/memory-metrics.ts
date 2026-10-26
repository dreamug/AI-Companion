import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { candidateMetrics } from "../src/memory/metrics.js";
import { LOCAL_SCOPE } from "../src/domain.js";

// Do not import Store/loadConfig: this command never creates, recovers, or migrates databases.
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!["--data-dir", "--traffic"].includes(args[i]!) || !args[i + 1])
    throw new Error(
      "Usage: npm run memory:metrics -- --data-dir PATH --traffic natural|synthetic|unknown|all",
    );
  options.set(args[i]!, args[i + 1]!);
}
const root = resolve(
  options.get("--data-dir") ?? process.env.HARNESS_DATA_DIR ?? "data",
);
const traffic = z
  .enum(["natural", "synthetic", "unknown", "all"])
  .parse(options.get("--traffic") ?? "natural");
const manifest = join(root, "bots.json");
const records = existsSync(manifest)
  ? z
      .object({
        bots: z.array(
          z.object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            archivedAt: z.number().optional(),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync(manifest, "utf8")))
      .bots.filter((b) => !b.archivedAt)
  : [{ id: "xiaoye" }];
const now = Date.now();
const reports = records.map((b) => {
  const path = join(
    b.id === "xiaoye" ? root : join(root, "bots", b.id),
    "companion.sqlite",
  );
  if (!existsSync(path)) return { botId: b.id, state: "database_missing" };
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma("user_version", { simple: true });
    if (version !== 1 && version !== 2)
      return { botId: b.id, state: "unsupported_schema", version };
    return {
      botId: b.id,
      ...candidateMetrics(
        db,
        b.id === "xiaoye"
          ? LOCAL_SCOPE
          : {
              ownerUserId: LOCAL_SCOPE.ownerUserId,
              relationshipId: `bot-${b.id}`,
            },
        now,
        traffic === "all" ? undefined : traffic,
      ),
    };
  } finally {
    db.close();
  }
});
console.log(JSON.stringify({ at: now, reports }, null, 2));
