import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  auditMemoryClaims,
  validateClaimAudit,
  validateInventory,
  claimAuditVerdict,
  type ClaimInventory,
  type ClaimProof,
} from "../scripts/lib/memory-claim-audit.js";

it("评审漏拆或证明非法属于待复核，真实引用和无据断言属于失败，两者均不通过", () => {
  for (const reason of [
    "incomplete_decomposition",
    "invalid_subject_link",
    "claim_coverage_mismatch",
  ])
    expect(claimAuditVerdict({ passed: false, reason })).toBe("review");
  for (const reason of [
    "citation_closure_mismatch",
    "unsupported_or_misclassified_claim",
    "historical_scope_without_evidence",
    "answer_target_or_marker_mismatch",
  ])
    expect(claimAuditVerdict({ passed: false, reason })).toBe("fail");
  expect(claimAuditVerdict({ passed: true })).toBe("pass");
});
import type { AnswerScoreInput } from "../scripts/lib/memory-answer-score.js";
import { ScriptedModel, response, finish } from "./helpers.js";
import {
  answerSegments,
  compoundScopes,
  historicalDisclosureScopes,
} from "../scripts/lib/memory-claim-structure.js";

it("历史披露的不存在不能借用当前未知标记或正向资料通过", () => {
  const text = "你从来没有提过你的入会日期。";
  const value = {
    query: { id: "history", expected: [], answer: null },
    answer: { answer: text, abstain: true, memoryIds: [] },
    status: "completed",
    availableIds: [],
    facts: [],
  };
  const inv: ClaimInventory = {
    segments: [
      { quote: text, claims: [{ kind: "unknown", focus: "入会日期" }] },
    ],
  };
  const p: ClaimProof = {
    version: "atomic-proof-v3",
    targetClaimIds: ["0.0"],
    segments: [{ index: 0, fullyDecomposed: true, faithful: true }],
    claims: [{ id: "0.0", assessment: "valid_unknown", witnesses: [] }],
    explanation: "不能用unknown掩盖历史断言",
  };
  expect(validateClaimAudit(value, inv, p)).toMatchObject({
    passed: false,
    reason: "historical_scope_without_evidence",
  });
  const sourced = {
    ...value,
    query: { ...value.query, expected: ["h"], answer: text },
    answer: { ...value.answer, abstain: false, memoryIds: ["h"] },
    availableIds: ["h"],
    facts: [{ id: "h", text: "用户从来没有提过其入会日期。" }],
  };
  const factInv: ClaimInventory = {
    segments: [
      {
        quote: text,
        claims: [{ kind: "fact", subject: "用户", focus: "入会日期" }],
      },
    ],
  };
  const sourcedProof: ClaimProof = {
    ...p,
    claims: [
      {
        id: "0.0",
        assessment: "entailed",
        witnesses: [
          {
            evidenceId: "h",
            role: "direct",
            sourceSubject: "用户",
            quote: sourced.facts[0]!.text,
          },
        ],
      },
    ],
  };
  expect(validateClaimAudit(sourced, factInv, sourcedProof).passed).toBe(true);
});

it.each([
  "你从来没有说过你的邮编。",
  "此前你从未提及这个预约。",
  "之前没聊到过你的昵称。",
  "全库没有你的门牌记录。",
])("跨领域历史范围均需证据：%s", (text) =>
  expect(historicalDisclosureScopes(text).length).toBeGreaterThan(0),
);

it.each([
  "本轮没找到你的邮编。",
  "我不确定你是否从未提过邮编。",
  "不能说你从来没有说过邮编。",
  "你喜欢《从未说过再见》。",
  "用户从未参加过说唱比赛。",
  "我不知道你之前有没有提过这个预约。",
])("未知、引用与其他经历不冒充历史披露范围：%s", (text) =>
  expect(historicalDisclosureScopes(text)).toEqual([]),
);

const input: AnswerScoreInput & {
  query: AnswerScoreInput["query"] & { query: string };
} = {
  query: {
    id: "unseen",
    query: "青岚住哪里，还会什么？",
    answer: "里斯本、手语",
    expected: ["place", "skill", "alias"],
  },
  answer: {
    answer: "青岚住在里斯本，而且会手语。",
    abstain: false,
    memoryIds: ["alias", "place", "skill"],
  },
  status: "completed",
  availableIds: ["alias", "place", "skill", "noise"],
  facts: [
    { id: "alias", text: "用户的合伙人叫青岚。" },
    { id: "place", text: "用户的合伙人住在里斯本。" },
    { id: "skill", text: "用户的合伙人会手语。" },
    { id: "noise", text: "用户喜欢下雪。" },
  ],
};
const inventory: ClaimInventory = {
  segments: [
    {
      quote: "青岚住在里斯本，而且会手语。",
      claims: [
        {
          text: "青岚住在里斯本",
          kind: "fact",
          focus: "住在里斯本",
          subject: "青岚",
        },
        { text: "青岚会手语", kind: "fact", focus: "会手语", subject: "青岚" },
      ],
    },
  ],
};
const proof: ClaimProof = {
  version: "atomic-proof-v3",
  targetClaimIds: ["0.0", "0.1"],
  segments: [{ index: 0, fullyDecomposed: true, faithful: true }],
  claims: [
    {
      id: "0.0",
      assessment: "entailed",
      subjectLinks: [
        {
          from: "青岚",
          to: "用户的合伙人",
          evidenceId: "alias",
          quote: "用户的合伙人叫青岚。",
        },
      ],
      witnesses: [
        {
          evidenceId: "place",
          quote: "合伙人住在里斯本",
          role: "direct",
          sourceSubject: "用户的合伙人",
        },
        { evidenceId: "alias", quote: "合伙人叫青岚", role: "identity" },
      ],
    },
    {
      id: "0.1",
      assessment: "entailed",
      subjectLinks: [
        {
          from: "青岚",
          to: "用户的合伙人",
          evidenceId: "alias",
          quote: "用户的合伙人叫青岚。",
        },
      ],
      witnesses: [
        {
          evidenceId: "skill",
          quote: "合伙人会手语",
          role: "direct",
          sourceSubject: "用户的合伙人",
        },
        { evidenceId: "alias", quote: "合伙人叫青岚", role: "identity" },
      ],
    },
  ],
  explanation: "独立属性和主体连接分别有依据。",
};

it("不同领域的并列属性各自归因，辅助身份来源也须闭合", () => {
  expect(validateClaimAudit(input, inventory, proof)).toMatchObject({
    passed: true,
    citationComplete: true,
  });
  const missing = structuredClone(input);
  (missing.answer as { memoryIds: string[] }).memoryIds = ["place", "skill"];
  expect(validateClaimAudit(missing, inventory, proof)).toMatchObject({
    passed: false,
    reason: "citation_closure_mismatch",
  });
  const extra = structuredClone(input);
  (extra.answer as { memoryIds: string[] }).memoryIds.push("noise");
  expect(validateClaimAudit(extra, inventory, proof).passed).toBe(false);
});

it("等价充分来源按完整路径验证；未引用的替代来源不被强加，身份桥仍不能省略", () => {
  const p = structuredClone(proof);
  p.targetClaimIds = ["0.1"];
  p.claims[0]!.alternatives = [
    {
      witnesses: [
        {
          evidenceId: "combined",
          quote: "青岚住在里斯本",
          role: "direct",
          sourceSubject: "青岚",
        },
      ],
    },
  ];
  const withAlternative = {
    ...input,
    query: {
      ...input.query,
      query: "青岚会什么交流技能？",
      expected: ["skill", "alias"],
    },
    availableIds: [...input.availableIds, "combined"],
    facts: [...input.facts, { id: "combined", text: "青岚住在里斯本。" }],
  };
  expect(validateClaimAudit(withAlternative, inventory, p).passed).toBe(true);
  const changed = {
    ...withAlternative,
    answer: {
      ...(input.answer as object),
      memoryIds: ["combined", "alias", "skill"],
    },
  };
  expect(validateClaimAudit(changed, inventory, p).passed).toBe(true);
  // The second atom still requires its identity link even though the first
  // atom has a self-contained alternative about a named subject.
  changed.answer.memoryIds = ["combined", "skill"];
  expect(validateClaimAudit(changed, inventory, p).passed).toBe(false);
  changed.answer.memoryIds = ["combined", "alias", "skill", "noise"];
  expect(validateClaimAudit(changed, inventory, p).passed).toBe(false);
});

it.each([
  [
    "漏掉回答尾部",
    {
      segments: [
        { quote: "青岚住在里斯本，", claims: inventory.segments[0]!.claims },
      ],
    },
  ],
  [
    "把未覆盖断言放空",
    { segments: [{ quote: "青岚住在里斯本，而且会手语。", claims: [] }] },
  ],
  [
    "修改原文",
    {
      segments: [
        {
          quote: "青岚在里斯本，而且会手语。",
          claims: inventory.segments[0]!.claims,
        },
      ],
    },
  ],
  ["漏字段", { segments: [] }],
])("拆解不能自报覆盖后漏原文：%s", (_name, raw) => {
  expect(
    validateInventory((input.answer as { answer: string }).answer, raw).passed,
  ).toBe(false);
});

it.each([
  [
    "漏评复合句",
    (p: ClaimProof) => {
      p.segments[0]!.fullyDecomposed = false;
    },
  ],
  [
    "压成非原子命题",
    (p: ClaimProof) => {
      p.claims[0]!.assessment = "not_atomic";
    },
  ],
  [
    "引用代替属性证据",
    (p: ClaimProof) => {
      p.claims[0]!.witnesses = [p.claims[0]!.witnesses[1]!];
    },
  ],
  [
    "丢一个原子",
    (p: ClaimProof) => {
      p.claims.pop();
    },
  ],
  [
    "重复原子",
    (p: ClaimProof) => {
      p.claims[1]!.id = "0.0";
    },
  ],
  [
    "多评不存在的原子",
    (p: ClaimProof) => {
      p.claims[0]!.id = "99.0";
    },
  ],
  [
    "错误主体不能借来源过关",
    (p: ClaimProof) => {
      p.claims[0]!.assessment = "unsupported";
    },
  ],
  [
    "事实藏在回应行为",
    (p: ClaimProof) => {
      p.claims[0]!.assessment = "wrong_kind";
    },
  ],
  [
    "虚构证据原文",
    (p: ClaimProof) => {
      p.claims[0]!.witnesses[0]!.quote = "住在火星";
    },
  ],
  [
    "不存在来源",
    (p: ClaimProof) => {
      p.claims[0]!.witnesses[0]!.evidenceId = "ghost";
    },
  ],
  [
    "重复来源",
    (p: ClaimProof) => {
      p.claims[0]!.witnesses.push(p.claims[0]!.witnesses[0]!);
    },
  ],
  [
    "总判定否定",
    (p: ClaimProof) => {
      p.targetClaimIds = [];
    },
  ],
  [
    "忽略本题目标",
    (p: ClaimProof) => {
      p.targetClaimIds = ["0.0"];
    },
  ],
  [
    "重复段",
    (p: ClaimProof) => {
      p.segments.push(p.segments[0]!);
    },
  ],
])("严格拒绝评审漏洞：%s", (_name, mutate) => {
  const changed = structuredClone(proof);
  mutate(changed);
  expect(validateClaimAudit(input, inventory, changed).passed).toBe(false);
});

it("来源未交付、状态失败、重复引用、伪造标记不能通过", () => {
  for (const change of [
    { availableIds: ["alias", "skill"] },
    { status: "failed" },
    {
      answer: {
        ...(input.answer as object),
        memoryIds: ["alias", "place", "skill", "skill"],
      },
    },
    { answer: { ...(input.answer as object), abstain: true } },
  ])
    expect(
      validateClaimAudit({ ...input, ...change }, inventory, proof).passed,
    ).toBe(false);
});

it("未知和纯回应无需伪造证据，但附带个性称呼仍是可核实事实", () => {
  const unknown = {
    ...input,
    query: { ...input.query, expected: [], answer: null },
    answer: {
      answer: "是否会潜水，目前不确定。",
      abstain: true,
      memoryIds: [],
    },
  };
  const inv = {
    segments: [
      {
        quote: unknown.answer.answer,
        claims: [
          {
            text: "本轮不能确定用户是否会潜水",
            kind: "unknown",
            focus: "是否会潜水",
          },
          { text: "本轮尚不确定", kind: "unknown", focus: "目前不确定" },
        ],
      },
    ],
  };
  const p: ClaimProof = {
    ...proof,
    targetClaimIds: ["0.0", "0.1"],
    claims: [
      {
        ...proof.claims[0]!,
        assessment: "valid_unknown",
        witnesses: [],
        subjectLinks: [],
      },
      {
        ...proof.claims[1]!,
        assessment: "valid_unknown",
        witnesses: [],
        subjectLinks: [],
      },
    ],
  };
  expect(validateClaimAudit(unknown, inv, p).passed).toBe(true);
  p.claims[0]!.witnesses = proof.claims[0]!.witnesses;
  expect(validateClaimAudit(unknown, inv, p).passed).toBe(false);
});

it("原样覆盖不混用字符单位，emoji、空白和标点都保留", () => {
  const text = "𠮷🙂，\n会手语。";
  const inv = {
    segments: [
      {
        quote: "𠮷🙂，\n",
        claims: [
          { text: "使用称呼𠮷", kind: "fact", focus: "𠮷", subject: "用户" },
        ],
      },
      {
        quote: "会手语。",
        claims: [
          { text: "会手语", kind: "fact", focus: "会手语", subject: "青岚" },
        ],
      },
    ],
  };
  expect(validateInventory(text, inv).passed).toBe(true);
  inv.segments[0]!.quote = "𠮷🙂，";
  expect(validateInventory(text, inv).passed).toBe(false);
});

function reviewer(
  inv: ClaimInventory,
  p: ClaimProof,
  repairFirst = false,
  citationMatches: Record<string, unknown[]> = {},
) {
  return new ScriptedModel((request) => {
    if (repairFirst && request.messages.length === 1) return response("{}");
    const data = JSON.parse(request.messages[0]!.content as string);
    if (data.candidate)
      return response(
        JSON.stringify({
          matches: citationMatches[data.candidate.id] ?? [],
          explanation: "逐条引用核验",
        }),
      );
    if (data.anchor) {
      const c = p.claims.find((c) => c.id === data.anchor.id)!;
      return response(
        JSON.stringify({
          ...c,
          subject: data.anchor.subject,
          explanation: "逐项证据核验",
        }),
      );
    }
    if (data.inventory)
      return response(
        JSON.stringify({
          targetClaimIds: p.targetClaimIds,
          segments: p.segments,
          explanation: "独立覆盖核验",
        }),
      );
    return response(JSON.stringify(inv));
  });
}

it("来源核对补全原文中的关系主体后，证明与覆盖必须使用同一个已解析主体", async () => {
  const value = {
    query: {
      id: "relation",
      query: "我的同伴住在哪？",
      expected: ["p"],
      answer: "海岸城",
    },
    answer: { answer: "你同伴住在海岸城。", abstain: false, memoryIds: ["p"] },
    status: "completed",
    availableIds: ["p"],
    facts: [{ id: "p", text: "用户的同伴住在海岸城。" }],
  };
  const inv: ClaimInventory = {
    segments: [
      {
        quote: value.answer.answer,
        claims: [{ kind: "fact", focus: "住在海岸城", subject: "同伴" }],
      },
    ],
  };
  const p: ClaimProof = {
    version: "atomic-proof-v3",
    targetClaimIds: ["0.0"],
    segments: [{ index: 0, fullyDecomposed: true, faithful: true }],
    claims: [
      {
        id: "0.0",
        assessment: "entailed",
        witnesses: [
          {
            evidenceId: "p",
            quote: "住在海岸城",
            role: "direct",
            sourceSubject: "用户的同伴",
          },
        ],
      },
    ],
    explanation: "关系同一",
  };
  const base = reviewer(inv, p);
  const model = new ScriptedModel((request) => {
    const d = JSON.parse(request.messages[0]!.content as string);
    return d.anchor
      ? response(
          JSON.stringify({
            ...p.claims[0],
            subject: "用户的同伴",
            explanation: "由回答中你同伴补全",
          }),
        )
      : base.stream(request);
  });
  expect((await auditMemoryClaims(value, model, "synthetic")).verdict).toBe(
    "pass",
  );
  const coverage = model.requests
    .map((r) => JSON.parse(r.messages[0]!.content as string))
    .find((d) => d.inventory);
  expect(coverage.inventory[0].claims[0].subject).toBe("用户的同伴");
});

it("未知和回应元信息不把属性所属人误当认知行为主体；覆盖采用有限的非推理请求", async () => {
  const value = {
    query: {
      id: "unknown",
      query: "我的编号是多少？",
      expected: [],
      answer: null,
    },
    answer: { answer: "本轮没有你的编号资料。", abstain: true, memoryIds: [] },
    status: "completed",
    availableIds: [],
    facts: [],
  };
  const inv: ClaimInventory = {
    segments: [
      {
        quote: value.answer.answer,
        claims: [{ kind: "unknown", focus: "编号资料", subject: "用户" }],
      },
    ],
  };
  const p: ClaimProof = {
    version: "atomic-proof-v3",
    targetClaimIds: ["0.0"],
    segments: [{ index: 0, fullyDecomposed: true, faithful: true }],
    claims: [{ id: "0.0", assessment: "valid_unknown", witnesses: [] }],
    explanation: "助手缺资料，不是用户不知道",
  };
  const model = reviewer(inv, p);
  const result = await auditMemoryClaims(value, model, "synthetic");
  expect(result.verdict).toBe("pass");
  const coverage = model.requests.find(
    (r) => JSON.parse(r.messages[0]!.content as string).inventory,
  )!;
  expect(
    JSON.parse(coverage.messages[0]!.content as string).inventory[0].claims[0],
  ).not.toHaveProperty("subject");
  expect(coverage.reasoningEffort).toBeUndefined();
  expect(coverage.temperature).toBe(0);
});

it("各阶段看不到标准答案或自报ID，来源核对没有自由改写的命题", async () => {
  const model = reviewer(inventory, proof);
  expect((await auditMemoryClaims(input, model, "synthetic")).verdict).toBe(
    "pass",
  );
  expect(model.requests).toHaveLength(4);
  const requests = model.requests.map((r) =>
    JSON.parse(r.messages[0]!.content as string),
  );
  expect(Object.keys(requests[0]).sort()).toEqual([
    "answer",
    "compoundScopes",
    "question",
    "segments",
  ]);
  for (const data of requests) {
    for (const field of ["memoryIds", "expectedEvidenceIds", "abstain"])
      expect(data).not.toHaveProperty(field);
    if (data.anchor) {
      expect(data.anchor).not.toHaveProperty("text");
      expect(data.deliveredEvidence).toEqual(input.facts);
    }
    if (data.inventory)
      for (const segment of data.inventory)
        for (const c of segment.claims) expect(c).not.toHaveProperty("text");
  }
});

it("评审结构最多修复一次，仍不完整保持待复核，原回答不被改写和重试", async () => {
  const before = JSON.stringify(input);
  const model = new ScriptedModel(() => response('{"segments":[]}'));
  expect((await auditMemoryClaims(input, model, "synthetic")).verdict).toBe(
    "review",
  );
  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(input)).toBe(before);
});

it("截断输出即使可解析也不能接受，失败原文和用量仍须保留", async () => {
  const raw = JSON.stringify(inventory);
  const model = new ScriptedModel(async function* () {
    yield { type: "text", text: raw };
    yield { ...finish, reason: "length" };
  });
  const result = await auditMemoryClaims(input, model, "synthetic");
  expect(result.verdict).toBe("review");
  expect(result.error).toBe("output_truncated");
  if (finish.type !== "finish") throw new Error("expected_finish_fixture");
  expect(result.stages?.[0]).toMatchObject({
    raw,
    error: "output_truncated",
    usage: finish.usage,
  });
  expect(model.requests).toHaveLength(1);
});

it("仅无可见判断的推理容量耗尽可在同一两次上限内降为非推理，不能语义重试", async () => {
  const base = reviewer(inventory, proof);
  let exhausted = false;
  const model = new ScriptedModel((request) => {
    const d = JSON.parse(request.messages[0]!.content as string);
    if (d.anchor?.id === "0.0" && !exhausted) {
      exhausted = true;
      return (async function* () {
        yield { ...finish, reason: "length" };
      })();
    }
    return base.stream(request);
  });
  const result = await auditMemoryClaims(input, model, "synthetic");
  expect(result.verdict).toBe("pass");
  const attempts = model.requests.filter(
    (r) => JSON.parse(r.messages[0]!.content as string).anchor?.id === "0.0",
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.reasoningEffort).toBe("low");
  expect(attempts[1]!.reasoningEffort).toBeUndefined();
  expect(attempts[1]!.temperature).toBe(0);
  expect(attempts[0]!.messages).toEqual(attempts[1]!.messages);
  expect(result.stages?.find((s) => s.stage === "atom:0.0:1")).toMatchObject({
    raw: "",
    error: "output_truncated",
  });
});

it("每个逻辑步骤只修复格式一次，反馈不塞标准标签，原回答不重试", async () => {
  const model = reviewer(inventory, proof, true),
    before = structuredClone(input);
  const result = await auditMemoryClaims(input, model, "synthetic");
  expect(result.verdict).toBe("pass");
  expect(result.stages).toHaveLength(8);
  expect(input).toEqual(before);
  const repairs = model.requests.filter((r) => r.messages.length > 1);
  expect(repairs).toHaveLength(4);
  for (const request of repairs)
    expect(
      Object.keys(JSON.parse(request.messages[1]!.content as string)).sort(),
    ).toEqual(["instruction", "previousReviewerOutput", "validationError"]);
});

it("实际无据、漏引和乱引不触发重试，也不按目标结果挑选评审", async () => {
  const unsupported = structuredClone(proof);
  unsupported.claims[0]!.assessment = "unsupported";
  for (const [value, p] of [
    [input, unsupported],
    [
      {
        ...input,
        answer: { ...(input.answer as object), memoryIds: ["place", "skill"] },
      },
      proof,
    ],
    [
      {
        ...input,
        answer: {
          ...(input.answer as object),
          memoryIds: ["place", "skill", "alias", "noise"],
        },
      },
      proof,
    ],
  ] as const) {
    const model = reviewer(inventory, p);
    expect((await auditMemoryClaims(value, model, "synthetic")).verdict).toBe(
      "fail",
    );
    const jobs = model.requests.map((r) =>
      JSON.parse(r.messages[0]!.content as string),
    );
    expect(jobs.filter((r) => r.anchor)).toHaveLength(2);
    const candidates = jobs
      .filter((r) => r.candidate)
      .map((r) => r.candidate.id);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.length).toBeLessThanOrEqual(
      (value.answer as { memoryIds: string[] }).memoryIds.length,
    );
    expect(model.requests.every((r) => r.messages.length === 1)).toBe(true);
  }
});

it("非目标背景也必须逐项核验，无法让评审只返回主问题那一行", async () => {
  const value = {
    ...input,
    query: {
      ...input.query,
      query: "青岚住在哪里？",
      expected: ["place", "alias"],
    },
  };
  const p = { ...proof, targetClaimIds: ["0.0"] },
    model = reviewer(inventory, p);
  expect((await auditMemoryClaims(value, model, "synthetic")).verdict).toBe(
    "pass",
  );
  const jobs = model.requests
    .map((r) => JSON.parse(r.messages[0]!.content as string))
    .filter((d) => d.anchor);
  expect(jobs.map((j) => j.anchor.id).sort()).toEqual(["0.0", "0.1"]);
  const bad = structuredClone(p);
  bad.claims[1]!.assessment = "unsupported";
  expect(
    (await auditMemoryClaims(value, reviewer(inventory, bad), "synthetic"))
      .verdict,
  ).toBe("fail");
});

it("评审选了另一条充分来源时，逐条证明原引用的支持关系而不是删引用", async () => {
  const value = {
    ...input,
    availableIds: [...input.availableIds, "named-place"],
    facts: [...input.facts, { id: "named-place", text: "青岚住在里斯本。" }],
  };
  const p = structuredClone(proof);
  p.claims[0]!.witnesses = [
    {
      evidenceId: "named-place",
      quote: "青岚住在里斯本",
      role: "direct",
      sourceSubject: "青岚",
    },
  ];
  p.claims[0]!.subjectLinks = [];
  const model = reviewer(inventory, p, false, {
    place: [
      {
        claimId: "0.0",
        witnesses: proof.claims[0]!.witnesses,
        subjectLinks: proof.claims[0]!.subjectLinks,
      },
    ],
  });
  const before = structuredClone(value.answer);
  expect((await auditMemoryClaims(value, model, "synthetic")).verdict).toBe(
    "pass",
  );
  expect(value.answer).toEqual(before);
  expect(
    model.requests
      .map((r) => JSON.parse(r.messages[0]!.content as string))
      .filter((r) => r.candidate),
  ).toHaveLength(3);
  expect(
    (await auditMemoryClaims(value, reviewer(inventory, p), "synthetic"))
      .verdict,
  ).toBe("fail");
});

it("已支持主结论的同一引用仍须检查它是否也能独立支持另一项事实", async () => {
  const value = structuredClone(input);
  value.facts.push({ id: "joint", text: "用户的合伙人住在里斯本，并会手语。" });
  value.availableIds.push("joint");
  value.query.expected = ["joint", "alias"];
  (value.answer as { memoryIds: string[] }).memoryIds = ["joint", "alias"];
  const p = structuredClone(proof);
  p.claims[1]!.witnesses[0] = {
    evidenceId: "joint",
    quote: "会手语",
    role: "direct",
    sourceSubject: "用户的合伙人",
  };
  const path = {
    claimId: "0.0",
    witnesses: [
      {
        evidenceId: "joint",
        quote: "住在里斯本",
        role: "direct",
        sourceSubject: "用户的合伙人",
      },
      proof.claims[0]!.witnesses[1]!,
    ],
    subjectLinks: proof.claims[0]!.subjectLinks,
  };
  const model = reviewer(inventory, p, false, { joint: [path] });
  expect((await auditMemoryClaims(value, model, "synthetic")).verdict).toBe(
    "pass",
  );
  expect(
    model.requests
      .map((r) => JSON.parse(r.messages[0]!.content as string))
      .some((r) => r.candidate?.id === "joint"),
  ).toBe(true);
  const unsupported = structuredClone(value);
  unsupported.facts.find((f) => f.id === "joint")!.text =
    "用户的合伙人会手语。";
  expect(
    (await auditMemoryClaims(unsupported, reviewer(inventory, p), "synthetic"))
      .verdict,
  ).toBe("fail");
  expect(
    (
      await auditMemoryClaims(
        unsupported,
        reviewer(inventory, p, false, { joint: [path] }),
        "synthetic",
      )
    ).verdict,
  ).toBe("review");
});

it("来源任务按当前原文臂投影，不把主问题和另一臂塞给背景属性", async () => {
  const cases = JSON.parse(
    readFileSync("tests/fixtures/memory-citation-incidents.json", "utf8"),
  );
  const c = cases.find((c: { id: string }) => c.id === "original-compound");
  const model = reviewer(c.inventory, c.proof);
  expect((await auditMemoryClaims(c.input, model, "synthetic")).verdict).toBe(
    "pass",
  );
  const jobs = model.requests
    .map((r) => JSON.parse(r.messages[0]!.content as string))
    .filter((r) => r.anchor);
  const background = jobs.find((r) => r.anchor.focus === "修复");
  expect(background).not.toHaveProperty("question");
  expect(background).not.toHaveProperty("answer");
  expect(background.constructionArm).toEqual([
    { relation: "additive", side: 0, quote: "修复" },
  ]);
  expect(background.contextBefore).toBe("会，");
  expect(jobs.find((r) => r.anchor.focus === "会")).toHaveProperty("question");
});

it("不能把开头已识别的个人事实降成礼貌语后放过", async () => {
  const value = {
    ...input,
    answer: {
      ...(input.answer as object),
      answer: "阿棠，青岚住在里斯本，而且会手语。",
    },
  };
  const inv: ClaimInventory = {
    segments: [
      {
        quote: "阿棠，",
        claims: [{ kind: "fact", focus: "阿棠", subject: "阿棠" }],
      },
      ...inventory.segments,
    ],
  };
  const p: ClaimProof = {
    ...proof,
    targetClaimIds: ["1.0", "1.1"],
    segments: [
      { index: 0, fullyDecomposed: true, faithful: true },
      { index: 1, fullyDecomposed: true, faithful: true },
    ],
    claims: [
      { id: "0.0", assessment: "valid_meta", witnesses: [], subjectLinks: [] },
      ...proof.claims.map((c, k) => ({ ...c, id: `1.${k}` })),
    ],
  };
  const model = reviewer(inv, p);
  expect((await auditMemoryClaims(value, model, "synthetic")).verdict).toBe(
    "fail",
  );
  expect(model.requests).toHaveLength(5);
});

it("超过评审原子上限保持待复核，不截掉后面的断言凑通过", async () => {
  const focuses = Array.from(
    { length: 25 },
    (_, i) => `项目${String(i).padStart(2, "0")}`,
  );
  const text = focuses.join("、") + "。";
  const inv: ClaimInventory = {
    segments: [
      {
        quote: text,
        claims: focuses.map((focus) => ({
          kind: "fact",
          subject: "用户",
          focus,
        })),
      },
    ],
  };
  const model = new ScriptedModel(() => response(JSON.stringify(inv)));
  const result = await auditMemoryClaims(
    { ...input, answer: { ...(input.answer as object), answer: text } },
    model,
    "synthetic",
  );
  expect(result.verdict).toBe("review");
  expect(result.error).toBe("answer_atom_limit");
  expect((result.inventory as ClaimInventory).segments[0]!.claims).toHaveLength(
    25,
  );
  expect(model.requests).toHaveLength(1);
});

// Frozen, manually adjudicated witnesses for the two reported incidents.
// These test mechanics; live held-out controls separately test the reviewers.
it("原漏引仍失败；正确补充身份来源才通过，不靠放宽引用", () => {
  const cases = JSON.parse(
    readFileSync("tests/fixtures/memory-citation-incidents.json", "utf8"),
  );
  const missing = cases.find(
    (c: { id: string }) => c.id === "original-missing-identity",
  );
  expect(
    validateClaimAudit(missing.input, missing.inventory, missing.proof).passed,
  ).toBe(false);
  const fixed = structuredClone(missing.input);
  fixed.answer.memoryIds = [
    ...new Set(
      missing.proof.claims.flatMap((c: ClaimProof["claims"][number]) =>
        c.witnesses.map((w) => w.evidenceId),
      ),
    ),
  ];
  expect(
    validateClaimAudit(fixed, missing.inventory, missing.proof).passed,
  ).toBe(true);
});

it("原复合句维持双引用，评审须拆开属性而不能靠删掉辅助引用通过", () => {
  const cases = JSON.parse(
    readFileSync("tests/fixtures/memory-citation-incidents.json", "utf8"),
  );
  const c = cases.find((c: { id: string }) => c.id === "original-compound");
  expect(validateClaimAudit(c.input, c.inventory, c.proof).passed).toBe(true);
  const lost = structuredClone(c.proof);
  lost.claims.pop();
  expect(validateClaimAudit(c.input, c.inventory, lost).passed).toBe(false);
  const merged = {
    segments: [
      {
        quote: c.input.answer.answer,
        claims: [
          {
            text: c.input.answer.answer,
            kind: "fact",
            focus: c.input.answer.answer,
            subject: "用户",
          },
        ],
      },
    ],
  };
  expect(validateClaimAudit(c.input, merged, c.proof)).toMatchObject({
    passed: false,
    reason: "compound_arm_not_decomposed",
  });
});

it.each([
  ["除了跑步之外还会游泳。", ["跑步", "会游泳"]],
  ["不仅住在鹿特丹，而且懂唇语。", ["住在鹿特丹", "懂唇语"]],
  ["既喜欢下雨，又讨厌炎热。", ["喜欢下雨", "讨厌炎热"]],
  ["虽然叫𠮷🙂，但是不会滑雪。", ["叫𠮷🙂", "不会滑雪"]],
])("句法约束跨属性、否定和字符边界：%s", (text, predicates) => {
  const scopes = compoundScopes(text);
  expect(scopes).toHaveLength(1);
  for (const arm of scopes[0]!.arms)
    expect(text.slice(arm.start, arm.end)).toBe(arm.quote);
  const raw = {
    segments: [
      {
        quote: text,
        claims: predicates.map((focus) => ({
          text: focus,
          focus,
          kind: "fact",
          subject: "用户",
        })),
      },
    ],
  };
  expect(validateInventory(text, raw).passed).toBe(true);
  raw.segments[0]!.claims.pop();
  expect(validateInventory(text, raw).passed).toBe(false);
});

it("共享来源也不能合成一项，双引用不代替复合句两侧覆盖", () => {
  const text = "不仅住在鹿特丹，而且懂唇语。";
  expect(
    validateInventory(text, {
      segments: [
        {
          quote: text,
          claims: [
            {
              text,
              kind: "fact",
              focus: "懂唇语",
            },
          ],
        },
      ],
    }).passed,
  ).toBe(false);
});

it("带复合词或逗号的书名与引语不被句法检查误拆，原文仍逐字保留", () => {
  for (const text of [
    "你喜欢《既往，又来》。",
    "你把温室称作“A,B”。",
    "你喜欢《虽然下雨但是温暖》。",
  ]) {
    expect(compoundScopes(text)).toHaveLength(0);
    expect(answerSegments(text)).toEqual([text]);
  }
});

it("同一未知命题的引入和限定留在同一原文单位，短呼语仍独立覆盖", () => {
  const text = "小岑，目前只知道背景；至于是否去过北湾，还没有依据，尚不确定。";
  expect(answerSegments(text)).toEqual([
    "小岑，",
    "目前只知道背景；",
    "至于是否去过北湾，还没有依据，尚不确定。",
  ]);
});

it("简短肯否不能藏成礼貌语后跳过事实依据", () => {
  for (const reply of ["会", "不会", "是的", "不是呀"])
    expect(
      validateInventory(`${reply}，目前没有依据。`, {
        segments: [
          {
            quote: `${reply}，`,
            claims: [{ kind: "response_meta", focus: reply }],
          },
          {
            quote: "目前没有依据。",
            claims: [{ kind: "unknown", focus: "没有依据" }],
          },
        ],
      }).passed,
    ).toBe(false);
});
