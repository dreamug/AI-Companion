import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const context = { window: {} as Record<string, (...args: any[]) => string> };
runInNewContext(readFileSync("web/run-status.js", "utf8"), context);
const status = (phase: string, elapsed = 1000) =>
  context.window.companionRunStatus!(
    { status: "running", createdAt: 100, config: {}, progress: { phase } },
    "小野",
    100 + elapsed,
  );
it.each(["intake", "context", "generating", "unknown"])(
  "%s is not presented as a memory search",
  (phase) => {
    expect(status(phase)).toBe("小野正在想怎么回应…");
  },
);
it("only a real read stage says recalling; check/repair says arranging the reply", () => {
  expect(status("memory_read")).toBe("小野正在回想相关的事…");
  expect(status("reviewing")).toBe("小野正在整理回复…");
  expect(status("repairing")).toBe("小野正在整理回复…");
});
it("800ms and 8s thresholds preserve the actual phase and never add chat content", () => {
  expect(status("memory_read", 799)).toBe("已收到");
  expect(status("memory_read", 800)).toContain("回想");
  expect(status("reviewing", 7999)).not.toContain("慢");
  expect(status("reviewing", 8000)).toBe(
    "小野正在整理回复… 这次有点慢，你可以继续等待或停止。",
  );
  expect(
    context.window.companionRunStatus!(
      { status: "queued", createdAt: 0, config: {} },
      "小野",
      9000,
    ),
  ).toBe("正在等待回复…");
});
it("timing summary keeps overlapping checks separate and does not invent historical measurements", () => {
  expect(context.window.companionTimingSummary!(undefined)).toContain(
    "没有分段耗时",
  );
  const text = context.window.companionTimingSummary!({
    queueMs: 2,
    elapsedMs: 120,
    firstDraftMs: 20,
    replyReadyMs: 119,
    spans: [
      { stage: "facts_check", durationMs: 80 },
      { stage: "operations_check", durationMs: 100 },
      { stage: "review_batch", durationMs: 101 },
    ],
  });
  expect(text).toContain("并行检查等待 101 ms");
  expect(text).toContain("事实检查 80 ms");
  expect(text).toContain("操作检查 100 ms");
  expect(text).toContain("不能相加");
  expect(text).toContain("不等于用户已读");
});
