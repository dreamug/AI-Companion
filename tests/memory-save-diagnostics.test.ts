import { expect, it } from "vitest";
import { memorySaveReplyDiagnostics } from "../scripts/lib/memory-save-diagnostics.js";

it.each([
  "需要我把它作为长期记忆保存下来吗？你说要保存，我就提交确认。",
  "要不要我帮你记住这个习惯？",
  "是否需要保存你的新称呼？",
  "我把这个安排保存下来，可以吗？",
])("离线检查不再漏掉重复征求意愿：%s", (text) => {
  expect(memorySaveReplyDiagnostics(text).asksSaveConsentAgain).toBe(true);
});
it.each([
  "你的称呼是小霖。今天想聊点什么？",
  "左手写字呀，有没有用得顺手的笔？",
  "每天练十分钟，可以先练长音，再练节奏。",
])("自然内容回复不被当作保存流程：%s", (text) => {
  expect(memorySaveReplyDiagnostics(text)).toEqual({
    asksSaveConsentAgain: false,
    narratesConfirmation: false,
    claimsUnconfirmedCommit: false,
  });
});
it("流程播报与虚报保存分别保留诊断，不通过修改原文获得通过", () => {
  const raw = "我已经保存这个偏好了。确认后才会存下来。";
  expect(memorySaveReplyDiagnostics(raw)).toMatchObject({
    narratesConfirmation: true,
    claimsUnconfirmedCommit: true,
  });
  expect(raw).toBe("我已经保存这个偏好了。确认后才会存下来。");
});
it.each([
  "这一步提取和候选确认交给界面那边走。",
  "这个保存已经登记，后续整理由界面那边确认。",
  "后台会去提取处理，候选确认会在界面上完成。",
])("变换措辞的内部流程播报仍必须被发现：%s", (text) => {
  expect(memorySaveReplyDiagnostics(text).narratesConfirmation).toBe(true);
});
it("收到保存意愿不等于已保存，不混淆这两种诊断", () => {
  expect(
    memorySaveReplyDiagnostics(
      "已经收到你的保存意愿，候选确认会在界面上完成。",
    ),
  ).toMatchObject({
    claimsUnconfirmedCommit: false,
    narratesConfirmation: true,
  });
});
