"use strict";

// Status belongs to the UI, never to the character's chat transcript.
window.companionRunStatus = function (run, name, now) {
  const elapsed = Math.max(
    0,
    Number.isFinite(now - run.createdAt) ? now - run.createdAt : 0,
  );
  if (run.status === "queued") return "正在等待回复…";
  if (run.config.replyPhase === "sending")
    return `${name}正在输入… · 已发送 ${run.config.replySent} / ${run.config.replyCount}`;
  if (elapsed < 800) return "已收到";
  const phase = run.progress?.phase;
  const action =
    phase === "memory_read"
      ? "正在回想相关的事…"
      : phase === "reviewing" || phase === "repairing"
        ? "正在整理回复…"
        : phase === "sending"
          ? "正在回复…"
          : "正在想怎么回应…";
  return `${name}${action}${elapsed >= 8000 ? " 这次有点慢，你可以继续等待或停止。" : ""}`;
};

window.companionTimingSummary = function (timings) {
  if (!timings) return "这一回合没有分段耗时记录。";
  const ms = (value) =>
    value === undefined ? "未完成" : `${Math.round(Math.max(0, value))} ms`;
  const stages = new Map();
  for (const span of timings.spans)
    stages.set(span.stage, (stages.get(span.stage) || 0) + span.durationMs);
  const labels = [
    ["intake", "记忆准入与提交"],
    ["intake_background", "后台记忆解析（与回复重叠）"],
    ["memory_read", "本地记忆读取"],
    ["context", "上下文组装"],
    ["generation", "回复生成"],
    ["facts_check", "事实检查"],
    ["operations_check", "操作检查"],
    ["name_binding", "称呼指代解析"],
    ["review_batch", "并行检查等待"],
    ["repair", "回复重写"],
    ["memory_tool", "记忆工具"],
    ["tool", "其他工具"],
  ];
  return (
    `排队 ${ms(timings.queueMs)}；处理 ${ms(timings.elapsedMs)}；首稿 ${ms(timings.firstDraftMs)}；回复可发布 ${ms(timings.replyReadyMs)}。\n` +
    labels
      .filter(([key]) => stages.has(key))
      .map(([key, label]) => `${label} ${ms(stages.get(key))}`)
      .join("；") +
    "。检查等待与单项检查存在重叠，不能相加为总耗时；可发布不等于用户已读。"
  );
};
