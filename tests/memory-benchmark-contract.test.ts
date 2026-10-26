import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { textHash } from "../src/memory/evidence.js";
import {
  memoryBenchmarkDiagnostics,
  MEMORY_BENCHMARK_OUTPUT_INSTRUCTION,
  summarizeMemoryRetrieval,
} from "../scripts/lib/memory-benchmark-contract.js";

it("版本清单固定题目与标注，不能通过静默修改旧题或把review当通过提高分数", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("./fixtures/memory-benchmark-manifest-v1.json", import.meta.url),
      "utf8",
    ),
  );
  expect(manifest.independentHumanGold).toBe(false);
  expect(manifest.strictGate).toMatchObject({
    allRequired: true,
    failBlocks: true,
    reviewBlocks: true,
    semanticCanOffsetProtocol: false,
  });
  for (const input of manifest.inputs)
    expect(
      textHash(
        readFileSync(
          new URL(`./fixtures/${input.path}`, import.meta.url),
          "utf8",
        ),
      ),
    ).toBe(input.sha256);
});

it("全量交付的命中率不伪称top5：第六条仍可完整交付，但不计入有序检索指标", () => {
  expect(
    summarizeMemoryRetrieval([
      {
        mode: "all",
        expected: ["six"],
        actual: ["1", "2", "3", "4", "5", "six"],
      },
    ]),
  ).toMatchObject({
    completeRecall: 1,
    sourceHitRate: 1,
    rankedQuestions: 0,
    rankedRecallAt5: null,
  });
});

it("多来源题的Recall@5计算来源覆盖比例，命中任一项不能冒充全召回", () => {
  expect(
    summarizeMemoryRetrieval([
      {
        mode: "hybrid",
        expected: ["a", "b"],
        actual: ["a", "x", "y", "z", "w", "b"],
      },
    ]),
  ).toMatchObject({
    sourceHitRate: 1,
    completeRecall: 1,
    rankedRecallAt5: 0.5,
    rankedQuestions: 1,
  });
});

it("未知题单列，不因没有召回目标而自动算正确，也不塞入已知题分母", () => {
  expect(
    summarizeMemoryRetrieval([
      { mode: "hybrid", expected: [], actual: ["irrelevant"] },
    ]),
  ).toMatchObject({
    known: 0,
    unknownExcluded: 1,
    sourceHitRate: null,
    completeRecall: null,
    rankedRecallAt5: null,
  });
});

it("协议、未知标记与来源交付分别报告，不能把评审接受数冒充语义正确率", () => {
  const input = {
    query: { id: "x", expected: [], answer: null },
    answer: {
      answer: "会。",
      abstain: false,
      memoryIds: ["p"],
      type: "json_object",
    },
    status: "completed",
    availableIds: ["p"],
    facts: [{ id: "p", text: "无关事实" }],
  };
  const before = structuredClone(input);
  expect(memoryBenchmarkDiagnostics(input)).toMatchObject({
    protocol: "fail",
    answerabilityFlag: "fail",
    citationDelivery: "pass",
    semanticAccuracy: "requires_validated_review",
  });
  expect(input).toEqual(before);
});

it("报告交付不等于相关；原存储ID资格失败不能被题集ID转换掩盖", () => {
  const input = {
    query: { id: "x", expected: ["p"], answer: "x" },
    answer: { answer: "x", abstain: false, memoryIds: ["p"] },
    status: "completed",
    availableIds: ["p"],
    facts: [],
    originalCitations: { reported: ["p"], delivered: ["storage-p"] },
  };
  expect(memoryBenchmarkDiagnostics(input)).toMatchObject({
    protocol: "pass",
    answerabilityFlag: "pass",
    citationDelivery: "fail",
  });
});

it("合成输出合同只约定结构和来源规则，没有题号、标准值或语义主题特例", () => {
  for (const word of [
    "陶瓷",
    "航天",
    "小栖",
    "work-new",
    "adjacent-skill",
    "青岚",
    "临川",
    "城市照明",
    "同声传译",
  ])
    expect(MEMORY_BENCHMARK_OUTPUT_INSTRUCTION).not.toContain(word);
});
