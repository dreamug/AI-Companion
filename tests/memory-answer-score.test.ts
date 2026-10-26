import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { textHash } from "../src/memory/evidence.js";
import {
  scoreMemoryAnswer,
  MemoryAnswerSchema,
  canonicalMemoryAnswer,
  type AnswerRubric,
  type AnswerScoreInput,
} from "../scripts/lib/memory-answer-score.js";

const fixture = (file: string) =>
  readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
const dataset = JSON.parse(fixture("memory-query-regression.json")),
  rubric = JSON.parse(fixture("memory-answer-rubric.json")) as AnswerRubric,
  recorded = JSON.parse(fixture("memory-answer-recorded.json")) as {
    rows: (Omit<AnswerScoreInput, "facts"> & { oldCorrect: boolean })[];
  };
const baseline = (id = "work-2"): AnswerScoreInput => ({
  ...structuredClone(recorded.rows.find((r) => r.query.id === id)!),
  facts: dataset.facts,
});

it("旧答卷重放只转换引用ID，不得沿用会删除额外字段的历史投影", () => {
  const aliases = new Map([["storage-id", "fixture-id"]]);
  const raw = {
    answer: "  原文🙂\n",
    abstain: false,
    memoryIds: ["storage-id", "unseen", "storage-id", 7],
    notes: "这项事实不能被丢弃",
  };
  const before = structuredClone(raw);
  const projected = canonicalMemoryAnswer(raw, aliases);
  expect(projected).toEqual({
    ...raw,
    memoryIds: ["fixture-id", "unseen", "fixture-id", 7],
  });
  expect(raw).toEqual(before);
  expect(MemoryAnswerSchema.safeParse(projected).success).toBe(false);
  for (const value of [null, [], 7, "text", { answer: "x" }, { memoryIds: 1 }])
    expect(canonicalMemoryAnswer(value, aliases)).toEqual(value);
});

it("猜中内部fixture ID也不能冒充实际交付的存储ID", () => {
  const input = baseline();
  const projected = input.answer as { memoryIds: string[] };
  input.originalCitations = {
    reported: projected.memoryIds,
    delivered: projected.memoryIds.map((id) => `storage:${id}`),
  };
  expect(scoreMemoryAnswer(input, rubric).reasons).toContain(
    "citation_not_in_qualified_context",
  );
  input.originalCitations.reported = input.originalCitations.delivered;
  expect(scoreMemoryAnswer(input, rubric).verdict).toBe("pass");
});

it("协议保留原文空白，不允许空回答或把未核对事实藏到额外字段", () => {
  const value = { answer: "  原文🙂\n", abstain: true, memoryIds: [] };
  expect(MemoryAnswerSchema.parse(value).answer).toBe(value.answer);
  expect(
    MemoryAnswerSchema.safeParse({ ...value, answer: "  \n" }).success,
  ).toBe(false);
  expect(
    MemoryAnswerSchema.safeParse({ ...value, notes: "额外的个人事实" }).success,
  ).toBe(false);
});

it("严格验收保留原始标记与引用，不按标准标签自动补正", () => {
  const input = baseline("unknown-0");
  input.answer = { answer: "不知道", abstain: false, memoryIds: [] };
  const before = structuredClone(input);
  expect(scoreMemoryAnswer(input, rubric).verdict).toBe("fail");
  expect(input).toEqual(before);
});

it("有根据的文字也不能豁免漏引，未知呼语转入通用评审", () => {
  const input = baseline("work-0");
  input.answer = { answer: "你是陶瓷修复师。", abstain: false, memoryIds: [] };
  expect(scoreMemoryAnswer(input, rubric).verdict).toBe("fail");
  input.answer = {
    answer: "王总，你是陶瓷修复师。",
    abstain: false,
    memoryIds: ["work-new"],
  };
  expect(scoreMemoryAnswer(input, rubric).verdict).toBe("review");
});

it("冻结源、逐题原评分不变；四题误判纠正，真正弃答仍失败", () => {
  expect(textHash(fixture("memory-query-regression.json"))).toBe(
    rubric.datasetHash,
  );
  const rows = recorded.rows.map((r) => ({
    id: r.query.id,
    ...scoreMemoryAnswer({ ...r, facts: dataset.facts }, rubric),
    oldCorrect: r.oldCorrect,
  }));
  expect(rows.filter((r) => r.literalCorrect)).toHaveLength(19);
  expect(rows.every((r) => r.literalCorrect === r.oldCorrect)).toBe(true);
  expect(rows.filter((r) => r.verdict === "pass")).toHaveLength(23);
  expect(rows.filter((r) => r.verdict !== "pass").map((r) => r.id)).toEqual([
    "work-5",
  ]);
});

it.each([
  "你不是陶瓷修复师。",
  "你以前是陶瓷修复师。",
  "你姐姐是陶瓷修复师。",
  "你是外科医生。",
  "你是陶瓷修复师，月薪一百万元。",
  "你是陶瓷修复师，合同职位全称是首席专家。",
  "你是陶瓷修复师，工号是12345。",
  "也许是陶瓷修复师。",
  "不是外科医生才怪，陶瓷修复师。",
  "记录上写陶瓷修复师，但实际上是航天工程师。",
])("包含答案字面不能掩盖否定、主体、时态或附加无据断言：%s", (text) => {
  const input = baseline();
  input.answer = { answer: text, abstain: false, memoryIds: ["work-new"] };
  expect(scoreMemoryAnswer(input, rubric).verdict).not.toBe("pass");
});

it("额外有效来源只有实际支持附加断言且已交付上下文才能通过", () => {
  const input = baseline("family-work-0");
  expect(scoreMemoryAnswer(input, rubric).verdict).toBe("pass");
  input.availableIds = input.availableIds.filter((id) => id !== "sister-name");
  expect(scoreMemoryAnswer(input, rubric).reasons).toContain(
    "citation_not_in_qualified_context",
  );
  input.availableIds.push("sister-name");
  input.answer = {
    answer: "你姐姐是航天工程师。",
    abstain: false,
    memoryIds: ["sister-work", "sister-name"],
  };
  expect(scoreMemoryAnswer(input, rubric).reasons).toContain(
    "citation_without_supported_claim",
  );
});

it.each([
  null,
  [],
  { answer: "陶瓷修复师", abstain: false, memoryIds: "work-new" },
  { answer: "陶瓷修复师", abstain: "false", memoryIds: ["work-new"] },
  { answer: "", abstain: false, memoryIds: [] },
])("异常输出留作失败，不能让评分器崩溃或按默认值通过：%j", (answer) => {
  const result = scoreMemoryAnswer({ ...baseline(), answer }, rubric);
  expect(result.verdict).toBe("fail");
  expect(result.reasons).toContain("invalid_answer_schema");
});

it("来源内容改变、漏引、乱引、重复引用、未完成输出均不能通过", () => {
  const input = baseline();
  const answer = {
    answer: "陶瓷修复师",
    abstain: false,
    memoryIds: ["work-new"],
  };
  expect(scoreMemoryAnswer({ ...input, answer }, rubric).verdict).toBe("pass");
  for (const memoryIds of [
    [],
    ["sister-work"],
    ["work-new", "work-new"],
    ["fake"],
  ])
    expect(
      scoreMemoryAnswer({ ...input, answer: { ...answer, memoryIds } }, rubric)
        .verdict,
    ).toBe("fail");
  expect(
    scoreMemoryAnswer({ ...input, answer, status: "cancelled" }, rubric)
      .verdict,
  ).toBe("fail");
  expect(
    scoreMemoryAnswer(
      {
        ...input,
        answer,
        facts: input.facts.map((f) =>
          f.id === "work-new" ? { ...f, text: "已改为其他职业" } : f,
        ),
      },
      rubric,
    ).reasons,
  ).toContain("rubric_fact_changed");
});

it("未知问题必须真正弃答；无据值、乱引和未识别表述都不能自动通过", () => {
  const input = baseline("unknown-0");
  for (const answer of [
    { answer: "工号是12345", abstain: true, memoryIds: [] },
    { answer: "不知道", abstain: false, memoryIds: [] },
    { answer: "不知道", abstain: true, memoryIds: ["work-new"] },
  ])
    expect(scoreMemoryAnswer({ ...input, answer }, rubric).verdict).not.toBe(
      "pass",
    );
});

it("远程语义反例不能先被字面或有界规则直接放行", () => {
  const controls = JSON.parse(fixture("memory-answer-judge-controls.json")) as {
    queryId: string;
    text: string;
    cited: string[];
    abstain: boolean;
    expected: string;
  }[];
  for (const c of controls.filter((c) => c.expected === "fail")) {
    expect(
      scoreMemoryAnswer(
        {
          ...baseline(c.queryId),
          answer: { answer: c.text, abstain: c.abstain, memoryIds: c.cited },
        },
        rubric,
      ).verdict,
    ).not.toBe("pass");
  }
});

it("合格偏好支持的呼语不等同于回答昵称属性；无依据呼语不能借机通过", () => {
  const input = baseline("work-0");
  input.availableIds.push("address-new");
  input.answer = {
    answer: "小栖，你是陶瓷修复师。",
    abstain: false,
    memoryIds: ["work-new"],
  };
  expect(scoreMemoryAnswer(input, rubric).verdict).toBe("fail");
  (input.answer as { memoryIds: string[] }).memoryIds.push("address-new");
  expect(scoreMemoryAnswer(input, rubric).verdict).toBe("pass");
  input.availableIds = input.availableIds.filter((id) => id !== "address-new");
  expect(scoreMemoryAnswer(input, rubric).verdict).not.toBe("pass");
  input.answer = {
    answer: "王总，你是陶瓷修复师。",
    abstain: false,
    memoryIds: ["work-new"],
  };
  expect(scoreMemoryAnswer(input, rubric).verdict).not.toBe("pass");
});

it.each(["sibling-coemployment", "unrecorded-secondary-job", "adjacent-skill"])(
  "记录全量也不能证明未记录的属性为假：%s",
  (id) => {
    const data = JSON.parse(fixture("memory-open-world.json")),
      rule = JSON.parse(
        fixture("memory-open-world-rubric.json"),
      ) as AnswerRubric,
      input: AnswerScoreInput = {
        query: data.queries.find((q: { id: string }) => q.id === id),
        facts: data.facts,
        availableIds: data.facts.map((f: { id: string }) => f.id),
        status: "completed",
        answer: { answer: "不知道", abstain: true, memoryIds: [] },
      };
    expect(textHash(fixture("memory-open-world.json"))).toBe(rule.datasetHash);
    expect(scoreMemoryAnswer(input, rule).verdict).toBe("pass");
    input.answer = {
      answer: "你现在是陶瓷修复师，所以你不做别的工作，也不会制作陶瓷。",
      abstain: false,
      memoryIds: ["work-new"],
    };
    expect(scoreMemoryAnswer(input, rule).verdict).not.toBe("pass");
  },
);

it.each(["sibling-coemployment", "unrecorded-secondary-job", "adjacent-skill"])(
  "明确正向证据不能被核实提示一概变成未知：%s",
  (id) => {
    const data = JSON.parse(fixture("memory-positive-attributes.json")),
      rule = JSON.parse(
        fixture("memory-positive-attributes-rubric.json"),
      ) as AnswerRubric,
      query = data.queries.find((q: { id: string }) => q.id === id),
      input: AnswerScoreInput = {
        query,
        facts: data.facts,
        availableIds: data.facts.map((f: { id: string }) => f.id),
        status: "completed",
        answer: {
          answer: query.answer,
          abstain: false,
          memoryIds: query.expected,
        },
      };
    expect(textHash(fixture("memory-positive-attributes.json"))).toBe(
      rule.datasetHash,
    );
    expect(scoreMemoryAnswer(input, rule).verdict).toBe("pass");
    input.availableIds = input.availableIds.filter(
      (v) => !query.expected.includes(v),
    );
    expect(scoreMemoryAnswer(input, rule).verdict).toBe("fail");
  },
);

it("局部已知必须既答已知职业又承认合同职位缺失，不能凭职业补全正式职位", () => {
  const data = JSON.parse(fixture("memory-answer-boundaries.json")),
    partialRubric = JSON.parse(
      fixture("memory-answer-boundaries-rubric.json"),
    ) as AnswerRubric,
    input: AnswerScoreInput = {
      query: data.queries.find((q: { id: string }) => q.id === "partial-title"),
      answer: {
        answer: "你是陶瓷修复师，正式合同职位名称没有记录。",
        abstain: false,
        memoryIds: ["work-new"],
      },
      status: "completed",
      availableIds: ["work-new"],
      facts: data.facts,
    };
  expect(textHash(fixture("memory-answer-boundaries.json"))).toBe(
    partialRubric.datasetHash,
  );
  expect(scoreMemoryAnswer(input, partialRubric).verdict).toBe("pass");
  for (const text of [
    "陶瓷修复师。",
    "正式合同职位名称没有记录。",
    "陶瓷修复师，正式合同职位名称是首席修复专家。",
  ])
    expect(
      scoreMemoryAnswer(
        { ...input, answer: { ...(input.answer as object), answer: text } },
        partialRubric,
      ).verdict,
    ).not.toBe("pass");
});
