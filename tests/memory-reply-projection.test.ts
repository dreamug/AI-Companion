import { expect, it } from "vitest";
import { projectMemoryReply } from "../src/memory/reply-contract.js";
it("按评审语义删除整句，保留emoji和已知回答，不切出孤立否定或半句", () => {
  const draft =
    "🪴这个名字很好听。你以后说的新资料，我会一直记住。今天我们先聊它的叶子。";
  const r = projectMemoryReply(draft, [
    { quote: "我会一直记住", violation: "unconfirmed_commit" },
  ]);
  expect(r?.text).toBe("🪴这个名字很好听。今天我们先聊它的叶子。");
  expect(draft.slice(r!.removed[0]!.start, r!.removed[0]!.end)).toBe(
    "你以后说的新资料，我会一直记住。",
  );
});
it("事实/读取问题不能靠删句修复，整段都是问题也不能凑固定回复", () => {
  for (const violation of [
    "unsupported_memory_absence",
    "memory_constraint_conflict",
  ])
    expect(
      projectMemoryReply("已知回答。错误句。", [
        { quote: "错误句", violation },
      ]),
    ).toBeUndefined();
  expect(
    projectMemoryReply("我已经保存了。", [
      { quote: "我已经保存了", violation: "unconfirmed_commit" },
    ]),
  ).toBeUndefined();
});
it("多次出现或仅渲染相同的引句不猜位置，回到完整重写", () => {
  expect(
    projectMemoryReply("已保存。已保存。别的内容。", [
      { quote: "已保存", violation: "unconfirmed_commit" },
    ]),
  ).toBeUndefined();
  expect(
    projectMemoryReply("答案。已经**保存**。", [
      { quote: "已经保存", violation: "unconfirmed_commit" },
    ]),
  ).toBeUndefined();
});
