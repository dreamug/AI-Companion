import { afterEach, describe, expect, it } from "vitest";
import { setup, ScriptedModel, response, finish } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
const points = [
  "input",
  "run_start",
  "tool",
  "message_finish",
  "memory_consolidation",
  "extraction_progress",
  "outbox",
  "delivery_attempt",
  "delivery_receipt",
];
describe("九个真实业务切点的提交前／后故障", () => {
  for (const point of points)
    for (const phase of ["before_commit", "after_commit"])
      it(`${point}.${phase}`, async () => {
        let armed = false,
          fired = false,
          chatCalls = 0;
        const model = new ScriptedModel(async function* (request) {
          if (request.purpose === "extract")
            yield* response(
              JSON.stringify({
                assertions: [
                  {
                    text: "合成提取事实",
                    category: "fact",
                    certainty: "stated",
                    sourceIds: ["src"],
                  },
                ],
                openLoops: [],
              }),
            );
          else if (
            request.purpose === "chat" &&
            point === "tool" &&
            chatCalls++ === 0
          ) {
            yield {
              type: "tool",
              call: {
                id: "tool-one",
                name: "propose_memory",
                input: { text: "合成工具建议", category: "fact" },
              },
            };
            yield { ...finish, reason: "tool-calls" };
          } else yield* response("合成回复");
        });
        const x = setup({
          model,
          faults: {
            hit(p) {
              if (armed && !fired && p === `${point}.${phase}`) {
                fired = true;
                throw new Error("injected_boundary_failure");
              }
            },
          },
        });
        cleanups.push(x.dispose);
        const after = phase === "after_commit";
        if (point === "input") {
          armed = true;
          expect(() => x.h.submit("合成输入", "fault-input")).toThrow(
            "injected_boundary_failure",
          );
          expect(x.store.list("runs")).toHaveLength(after ? 1 : 0);
          expect(x.store.list("messages")).toHaveLength(after ? 1 : 0);
          if (after)
            expect(x.h.submit("合成输入", "fault-input").duplicate).toBe(true);
        } else if (["run_start", "tool", "message_finish"].includes(point)) {
          armed = true;
          const r = x.h.submit("合成运行", "fault-run");
          await x.h.waitForIdle();
          expect(x.store.list("runs")).toHaveLength(1);
          if (point === "tool") {
            expect(x.store.list("memories")).toHaveLength(after ? 1 : 0);
            expect(x.store.toolResult(r.runId, "tool-one") !== undefined).toBe(
              after,
            );
          }
          if (point === "message_finish") {
            expect(x.store.require("runs", r.runId).status).toBe(
              after ? "completed" : "failed",
            );
            expect(
              x.store.events().some((e) => e.type === "message.completed"),
            ).toBe(after);
          }
          if (point === "run_start")
            expect(
              x.store.list("messages").filter((m) => m.role === "assistant"),
            ).toHaveLength(1);
        } else if (
          ["memory_consolidation", "extraction_progress"].includes(point)
        ) {
          x.store.put("sources", {
            id: "src",
            text: "合成提取事实",
            kind: "message",
            revision: 1,
            deleted: false,
            createdAt: x.clock.now(),
          });
          x.store.put("jobs", {
            id: "job",
            kind: "extract",
            status: "pending",
            sources: [{ id: "src", revision: 1 }],
            epoch: 1,
            attempts: 0,
            createdAt: x.clock.now(),
            nextAt: x.clock.now(),
          });
          armed = true;
          await x.h.tick();
          expect(x.store.list("memories")).toHaveLength(after ? 1 : 0);
          expect(x.store.require("jobs", "job").status).toBe(
            after ? "completed" : "failed",
          );
        } else {
          x.h.channel("page", "granted");
          x.h.createFollowUp({
            text: "合成跟进",
            dueAt: x.clock.now(),
            latestAt: x.clock.now() + 3600000,
          });
          if (point === "outbox") {
            armed = true;
            await x.h.tick();
            expect(x.store.list("deliveries")).toHaveLength(after ? 1 : 0);
          } else {
            await x.h.tick();
            const d = x.store.list("deliveries")[0]!;
            if (point === "delivery_attempt") {
              armed = true;
              expect(() =>
                x.h.deliveryEvent(d.id, { event: "attempt", clientId: "page" }),
              ).toThrow("injected_boundary_failure");
              expect(x.store.require("deliveries", d.id).status).toBe(
                after ? "attempt_started" : "ready",
              );
            } else {
              const permit = x.h.deliveryEvent(d.id, {
                event: "attempt",
                clientId: "page",
              }) as { attemptId: string };
              armed = true;
              expect(() =>
                x.h.deliveryEvent(d.id, {
                  event: "constructed",
                  clientId: "page",
                  attemptId: permit.attemptId,
                }),
              ).toThrow("injected_boundary_failure");
              expect(x.store.require("deliveries", d.id).status).toBe(
                after ? "constructed" : "attempt_started",
              );
            }
          }
        }
        expect(fired).toBe(true);
      });
});
