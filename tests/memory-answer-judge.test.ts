import { expect, it } from "vitest";
import { adjudicateMemoryAnswer } from "../scripts/lib/memory-answer-judge.js";
import {
  scoreMemoryAnswer,
  type AnswerScoreInput,
} from "../scripts/lib/memory-answer-score.js";
import { ScriptedModel, response } from "./helpers.js";
const input: AnswerScoreInput = {
  query: { id: "test", expected: ["work"], answer: "合成工作" },
  answer: { answer: "合成工作", abstain: false, memoryIds: ["work"] },
  status: "completed",
  availableIds: ["work"],
  facts: [{ id: "work", text: "有来源的合成工作" }],
};
it("结构或引用失败不调用评审，不能由评审覆盖", async () => {
  const bad = {
      ...input,
      status: "failed",
      query: { ...input.query, query: "合成问题" },
    },
    initial = scoreMemoryAnswer(bad),
    model = new ScriptedModel(() => response('{"pass":true}'));
  expect(initial.verdict).toBe("fail");
  expect(
    (await adjudicateMemoryAnswer(bad, initial, model, "synthetic")).verdict,
  ).toBe("fail");
  expect(model.requests).toHaveLength(0);
});

it("评审异常保持待复核，伪造通过但缺字段的评审输出不能放行", async () => {
  const value = { ...input, query: { ...input.query, query: "合成问题" } },
    initial = scoreMemoryAnswer(value);
  expect(initial.verdict).toBe("review");
  const errorModel = new ScriptedModel(async function* () {
    throw Error("synthetic_provider_failure");
  });
  expect(
    (await adjudicateMemoryAnswer(value, initial, errorModel, "synthetic"))
      .verdict,
  ).toBe("review");
  const malformed = new ScriptedModel(() => response('{"pass":true}'));
  expect(
    (await adjudicateMemoryAnswer(value, initial, malformed, "synthetic"))
      .verdict,
  ).toBe("review");
});
