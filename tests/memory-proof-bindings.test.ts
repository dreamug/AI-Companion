import { expect, it } from "vitest";
import {
  validateSubjectBindings,
  resolveAnchoredSubject,
  type BindingWitness,
  type SubjectLink,
} from "../scripts/lib/memory-proof-bindings.js";

it("关系补全与代词消歧只能使用回答原文，不能将来源里的新身份反灌进去", () => {
  expect(
    resolveAnchoredSubject("同伴", "用户的同伴", "你同伴住在海岸城。"),
  ).toBe("用户的同伴");
  expect(
    resolveAnchoredSubject("它", "南圃", "南圃是花房的名字，它有两扇窗。"),
  ).toBe("南圃");
  expect(
    resolveAnchoredSubject("这座花房", "南圃", "花房叫南圃，这座花房有窗。"),
  ).toBe("南圃");
  expect(
    resolveAnchoredSubject("同伴", "用户的同伴", "某位同伴住在海岸城。"),
  ).toBe("同伴");
  expect(
    resolveAnchoredSubject("用户", "用户的同伴", "你和你的同伴都在场。"),
  ).toBe("用户");
  expect(resolveAnchoredSubject("阿岚", "阿临", "阿岚和阿临都在场。")).toBe(
    "阿岚",
  );
  expect(resolveAnchoredSubject("它", "未出现的名字", "它有窗。")).toBe("它");
});

it("代词可沿已给出的身份证明回到回答中的名字，不能不带桥跨向资料实体", () => {
  const bridge = [
    {
      from: "南圃",
      to: "用户的花房",
      evidenceId: "n",
      quote: "用户的花房叫南圃。",
    },
  ];
  expect(
    resolveAnchoredSubject(
      "它",
      "用户的花房",
      "你把它叫南圃，它在山脚。",
      bridge,
    ),
  ).toBe("南圃");
  expect(
    resolveAnchoredSubject("它", "用户的花房", "你把它叫南圃，它在山脚。"),
  ).toBe("它");
});

it("关系与名字的同位语仍消耗真实身份边，不能因关系来源已够而省略姓名依据", () => {
  const evidence = [
    { id: "n", text: "用户的同伴叫阿林。" },
    { id: "p", text: "用户的同伴住在海岸城。" },
  ];
  const path: BindingWitness[] = [
    { evidenceId: "n", role: "identity" },
    { evidenceId: "p", role: "direct", sourceSubject: "用户的同伴" },
  ];
  const edges = [
    {
      from: "用户的同伴",
      to: "阿林",
      evidenceId: "n",
      quote: evidence[0]!.text,
    },
  ];
  expect(
    validateSubjectBindings("用户的同伴阿林", path, edges, evidence),
  ).toBeUndefined();
  expect(
    validateSubjectBindings("用户的同伴阿林", path.slice(1), [], evidence),
  ).toBe("missing_subject_bridge");
  expect(validateSubjectBindings("用户的同伴阿宁", path, edges, evidence)).toBe(
    "missing_subject_bridge",
  );
});

const facts = [
  { id: "a", text: "海棠是用户的试验棚。" },
  { id: "b", text: "用户的试验棚也称作北棚。" },
  { id: "c", text: "北棚位于鹿港。" },
  { id: "n", text: "用户喜欢桂花。" },
];
const witnesses: BindingWitness[] = [
  { evidenceId: "a", role: "identity" },
  { evidenceId: "b", role: "identity" },
  { evidenceId: "c", role: "direct", sourceSubject: "北棚" },
];
const links: SubjectLink[] = [
  {
    from: "海棠",
    to: "用户的试验棚",
    evidenceId: "a",
    quote: "海棠是用户的试验棚。",
  },
  {
    from: "用户的试验棚",
    to: "北棚",
    evidenceId: "b",
    quote: "用户的试验棚也称作北棚。",
  },
];

it("非人物别名可跨两条身份记录连接，漏任一连接都拒绝", () => {
  expect(
    validateSubjectBindings("海棠", witnesses, links, facts),
  ).toBeUndefined();
  expect(
    validateSubjectBindings("海棠", witnesses, links.slice(1), facts),
  ).toBe("missing_subject_bridge");
  expect(
    validateSubjectBindings("海棠", witnesses.slice(2), links, facts),
  ).toBeUndefined();
});

it("评审解释中提到身份来源，却未在证明表登记身份边，不能闭合", () => {
  expect(validateSubjectBindings("海棠", witnesses, [], facts)).toBe(
    "missing_subject_bridge",
  );
});

it("伪造主体映射、无关身份引用、与原文不同的主体均不通过", () => {
  expect(
    validateSubjectBindings(
      "海棠",
      witnesses,
      [{ ...links[0]!, from: "青山" }, links[1]!],
      facts,
    ),
  ).toBe("invalid_subject_link");
  expect(validateSubjectBindings("北棚", witnesses, links, facts)).toBe(
    "irrelevant_subject_bridge",
  );
  expect(
    validateSubjectBindings(
      "海棠",
      [...witnesses.slice(0, 2), { ...witnesses[2]!, sourceSubject: "青山" }],
      links,
      facts,
    ),
  ).toBe("invalid_source_subject");
});

it("主体已在直接资料中出现时不用身份来源，第二人称与用户及属格规范化", () => {
  expect(
    validateSubjectBindings("北棚", [witnesses[2]!], [], facts),
  ).toBeUndefined();
  expect(
    validateSubjectBindings(
      "你的同伴",
      [{ evidenceId: "x", role: "direct", sourceSubject: "用户的同伴" }],
      [],
      [{ id: "x", text: "用户的同伴喜欢读书。" }],
    ),
  ).toBeUndefined();
});

it("不能通过删掉姓名里的字伪造同一主体，也不能伪造身份证据引文", () => {
  expect(
    validateSubjectBindings(
      "王宁",
      [{ evidenceId: "p", role: "direct", sourceSubject: "王宁" }],
      [],
      [{ id: "p", text: "王的宁喜欢滑冰。" }],
    ),
  ).toBe("invalid_source_subject");
  expect(
    validateSubjectBindings(
      "海棠",
      witnesses,
      [{ ...links[0]!, quote: "不存在的原文" }, links[1]!],
      facts,
    ),
  ).toBe("invalid_subject_link");
});

it("用户属格可跨把字结构定位，命名实体仍需真实连续出现", () => {
  const evidence = [
    { id: "name", text: "用户把庭院的暖房叫作鹿舍。" },
    { id: "place", text: "用户庭院的暖房位于南湾。" },
  ];
  expect(
    validateSubjectBindings(
      "鹿舍",
      [
        {
          evidenceId: "place",
          role: "direct",
          sourceSubject: "用户庭院的暖房",
        },
      ],
      [
        {
          from: "鹿舍",
          to: "用户庭院的暖房",
          evidenceId: "name",
          quote: evidence[0]!.text,
        },
      ],
      evidence,
    ),
  ).toBeUndefined();
  expect(
    validateSubjectBindings(
      "鹿舍",
      [
        {
          evidenceId: "place",
          role: "direct",
          sourceSubject: "用户庭院的暖房",
        },
      ],
      [
        {
          from: "鹿的舍",
          to: "用户庭院的暖房",
          evidenceId: "name",
          quote: evidence[0]!.text,
        },
      ],
      evidence,
    ),
  ).toBe("invalid_subject_link");
});
