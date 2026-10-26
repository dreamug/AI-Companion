import { afterEach, expect, it } from "vitest";
import { Harness } from "../src/harness.js";
import { ScriptedModel, response, setup, until } from "./helpers.js";
import { CONVERSATION_TURN_INSTRUCTION } from "../src/conversation-style.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function fixture(experiment: boolean, pacing = false) {
  const model = new ScriptedModel(async function* (r) {
    if (r.purpose === "extract")
      yield* response('{"intent":"none","items":[]}');
    else if (r.purpose === "judge") {
      const data = JSON.parse(r.messages[0]!.content);
      yield* response(
        data.contractPart === "operations"
          ? '{"checks":[],"requiredAction":"none","userEvidence":null}'
          : '{"checks":[]}',
      );
    } else yield* response("这一段先回应具体内容。\n\n最后再自然留下话头。");
  });
  const x = setup({ model });
  // The setup harness owns no work; upgrade explicitly before constructing its replacement.
  x.store.enableMemoryV3();
  const h = new Harness(x.store, model, {
    ...stableMemoryConfig(x.config),
    conversationExperiment: experiment,
  });
  h.updateSettings({
    expectedRevision: x.store.settings().revision,
    splitReplies: true,
    messagePacing: pacing,
    memoryFormationMode: "explicit_only",
  });
  cleanup.push(async () => {
    await h.close();
    await x.dispose();
  });
  return { ...x, h, model };
}
it.each([false, true])(
  "conversation flag %s is captured per run and never changes the number or scope of original checks",
  async (experiment) => {
    const x = fixture(experiment),
      r = x.h.submit("今天想聊两句。", "one");
    await x.h.waitForIdle();
    const chats = x.model.requests.filter((r) => r.purpose === "chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]!.system.includes(CONVERSATION_TURN_INSTRUCTION)).toBe(
      experiment,
    );
    expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(
      2,
    );
    expect(x.store.require("runs", r.runId).status).toBe("completed");
    expect(x.store.require("runs", r.runId).config.conversationExperiment).toBe(
      experiment,
    );
    expect(x.h.snapshot().conversationExperiment).toBe(experiment);
    expect(x.store.all("memories")).toHaveLength(0);
  },
);
it("paced CM3 reply publishes its first checked bubble before waiting; stopping during the gap keeps only that bubble", async () => {
  const x = fixture(true, true),
    r = x.h.submit("我在呢。", "paced");
  await until(() => x.store.require("runs", r.runId).config.replySent === 1);
  const shown = x.store
    .all("messages")
    .filter((m) => m.role === "assistant" && m.content);
  expect(shown).toHaveLength(1);
  expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(2);
  x.h.cancel(r.runId);
  await x.h.waitForIdle();
  expect(
    x.store.all("messages").filter((m) => m.role === "assistant" && m.content),
  ).toHaveLength(1);
  expect(x.store.require("runs", r.runId).status).toBe("cancelled");
});
