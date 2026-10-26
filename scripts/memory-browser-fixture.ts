import { setTimeout as wait } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { BotManager } from "../src/bots.js";
import { createApp } from "../src/server.js";
import { MockModel, type ModelEvent, type ModelRequest } from "../src/model.js";

// Browser-only deterministic fixture. No paid provider and no existing data directory.
class ConfirmationFixtureModel extends MockModel {
  override async *stream(r: ModelRequest): AsyncGenerator<ModelEvent> {
    const text =
      r.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (r.purpose === "extract") {
      const payload = JSON.parse(text);
      const sources: { id: string; text: string }[] = Array.isArray(payload)
        ? payload
        : payload.userSources;
      const assertions = sources
        .filter(
          (s) =>
            s.text.startsWith("合成确认：") || s.text.startsWith("合成偏好："),
        )
        .map((s) => ({
          text: s.text.slice(5).replace(/^请记住，/u, ""),
          category: "preference",
          certainty: "stated",
          retention: "durable",
          sourceIds: [s.id],
        }));
      yield {
        type: "text",
        text: JSON.stringify({ assertions, openLoops: [] }),
      };
      yield {
        type: "finish",
        reason: "stop",
        usage: {
          calls: 1,
          estimated: true,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      };
      return;
    }
    if (
      r.purpose === "chat" &&
      text.startsWith("合成旧工具：") &&
      !r.messages.some((m) => m.toolName === "propose_memory")
    ) {
      yield {
        type: "tool",
        call: {
          id: "fixture-proposal",
          name: "propose_memory",
          input: { text: text.slice(5), category: "preference" },
        },
      };
      yield {
        type: "finish",
        reason: "tool-calls",
        usage: {
          calls: 1,
          estimated: true,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      };
      return;
    }
    if (r.purpose === "chat" && text.startsWith("合成等待："))
      await wait(10000, undefined, { signal: r.signal });
    if (r.purpose === "summary") {
      let parts: { role?: string; text?: string }[] = [];
      try {
        parts = JSON.parse(text);
      } catch {}
      const summary =
        parts
          .filter((p) => !p.role || p.role === "user")
          .map((p) => p.text ?? "")
          .join("；")
          .slice(0, 400) || "合成摘要";
      yield { type: "text", text: JSON.stringify({ summary }) };
      yield {
        type: "finish",
        reason: "stop",
        usage: {
          calls: 1,
          estimated: true,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      };
      return;
    }
    yield* super.stream(r);
  }
}
const dir = mkdtempSync(join(tmpdir(), "aic-memory-browser-"));
const config = loadConfig({
  dataDir: dir,
  port: 4320,
  modelMode: "mock",
  memoryV2: true,
  memorySummaries: true,
  trafficOrigin: "synthetic",
  schedulerMs: 50,
});
const bots = new BotManager(config, () => new ConfirmationFixtureModel());
const app = await createApp(bots.get("xiaoye"), { bots });
await app.listen({ host: config.host, port: config.port });
bots.start();
async function stop() {
  await app.close();
  await bots.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
