import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/speech", (route) =>
    route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } }),
  );
  await page.route("**/v1/voice", (route) =>
    route.fulfill({ json: { configured: false, voiceName: "测试音色" } }),
  );
  await page.goto("/");
  await expect(page.locator("#connection")).toContainText("本地已连接");
});
async function propose(page: Page, text: string) {
  await page.locator("#chat-input").fill(`合成确认：请记住，${text}`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("#memory-candidate")).toContainText(text);
  await expect(page.locator("#run-status")).toContainText("已完成");
}
async function metrics(page: Page) {
  return page.evaluate(async () => {
    const b = await (await fetch("/bootstrap")).json();
    return (
      await fetch("/v1/memory/metrics?traffic=synthetic", {
        headers: { "X-Local-Token": b.csrfToken, "X-Bot-Id": "xiaoye" },
      })
    ).json();
  });
}

test("后台提取→可见卡片→展示回执→确认→下一轮全量读取，刷新不重复", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const before = await metrics(page);
  await propose(page, "合成饮品偏好是乌龙茶");
  const card = page.locator("#memory-candidate");
  expect(await card.locator(".message").count()).toBe(0);
  await expect(card).not.toContainText("null");
  await expect
    .poll(async () => (await metrics(page)).displayed)
    .toBe(before.displayed + 1);
  await card.getByRole("button", { name: "记住", exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.locator("#memory-result")).toContainText("已保存");
  await expect
    .poll(async () => (await metrics(page)).confirmed)
    .toBe(before.confirmed + 1);
  await page.reload();
  await expect(card).toBeHidden();
  expect((await metrics(page)).confirmed).toBe(before.confirmed + 1);
  await page.locator("#chat-input").fill("午后解渴准备些什么？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("#run-status")).toContainText("已完成");
  await page.getByRole("button", { name: "Trace / 维护", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 Trace 和上下文", exact: true })
    .click();
  await expect(page.locator("#trace-content")).toContainText(
    "合成饮品偏好是乌龙茶",
  );
  expect(errors).toEqual([]);
});
test("关闭自动整理时明确保存也直接产生候选，界面确认前不升级为长期事实", async ({
  page,
}) => {
  await page.locator("#auto-extract").uncheck();
  await propose(page, "合成明确保存：偏爱手风琴");
  const memory = page
    .locator("#memory-list .card")
    .filter({ hasText: "合成明确保存：偏爱手风琴" });
  await expect(memory).toContainText("待处理");
  await expect(memory).not.toContainText("已确认");
  await page
    .locator("#memory-candidate")
    .getByRole("button", { name: "记住", exact: true })
    .click();
  await expect(memory).toContainText("已确认");
  await page.reload();
  await expect(memory).toContainText("已确认");
  await expect(page.locator("#memory-candidate")).toBeHidden();
  await page.locator("#auto-extract").check();
});
test("普通偏好同一天连续两轮都有聊天内确认入口，每条只生成一个候选", async ({
  page,
}) => {
  for (const preference of ["合成爱好是天文摄影", "合成偏好是听爵士乐"]) {
    await page.locator("#chat-input").fill(`合成偏好：${preference}`);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const card = page.locator("#memory-candidate");
    await expect(card).toContainText(preference);
    await expect(
      page.locator("#memory-list .card").filter({ hasText: preference }),
    ).toHaveCount(1);
    await card.getByRole("button", { name: "记住", exact: true }).click();
    await expect(card).toBeHidden();
    await page.reload();
    await expect(card).toBeHidden();
    await expect(
      page.locator("#memory-list .card").filter({ hasText: preference }),
    ).toHaveCount(1);
  }
});
test("更正后记住与维护页共用修订，安全显示文本，移动端无横向溢出", async ({
  page,
}) => {
  await propose(page, "合成更正：绿茶 <img src=x onerror=alert(1)>");
  const card = page.locator("#memory-candidate");
  expect(await card.locator("img").count()).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/memory-confirmation-mobile.png",
    fullPage: true,
  });
  await card.getByRole("button", { name: "更正后记住" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("textarea").fill("合成更正：实际更喜欢红茶");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.locator("#memory-list")).toContainText(
    "合成更正：实际更喜欢红茶",
  );
});
test("稍后不重现卡片、维护页仍可确认；不保存保留原始发言", async ({ page }) => {
  await propose(page, "合成暂缓：周末爬山");
  const card = page.locator("#memory-candidate");
  await card.getByRole("button", { name: "稍后", exact: true }).click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(card).toBeHidden();
  const pending = page
    .locator("#memory-list .card")
    .filter({ has: page.locator("p", { hasText: "合成暂缓：周末爬山" }) });
  await pending.getByRole("button", { name: "确认", exact: true }).click();
  await expect(pending).toContainText("已确认");
  await propose(page, "合成丢弃：这条只聊一次");
  await card.getByRole("button", { name: "不保存", exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.locator("#messages .message.user").last()).toContainText(
    "合成丢弃：这条只聊一次",
  );
  await expect(page.locator("#memory-list")).not.toContainText(
    "合成丢弃：这条只聊一次",
  );
});
test("刷新、专注和切角色不串卡片；卡片不会触发语音请求", async ({ page }) => {
  const speech: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/speech")) speech.push(r.postData() ?? "");
  });
  await propose(page, "合成隔离：只属于当前角色");
  const card = page.locator("#memory-candidate");
  await page.locator("#focused").check();
  await expect(card).toBeHidden();
  await page.locator("#focused").uncheck();
  await expect(card).toBeVisible();
  const ownURL = page.url();
  await page.goto("/?bot=xiaotang");
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await expect(card).toBeHidden();
  await expect(page.locator("#messages")).not.toContainText(
    "合成隔离：只属于当前角色",
  );
  await page.goto(ownURL);
  await expect(card).toContainText("合成隔离：只属于当前角色");
  expect(
    speech.every(
      (body) => !body.includes("candidate") && !body.includes("要记住这件事吗"),
    ),
  ).toBe(true);
});

test("等待两档由界面计时，取消后清理，状态不写入消息", async ({ page }) => {
  await page.clock.install();
  await page.locator("#chat-input").fill("合成等待：测试慢回复");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("#messages .user").last()).toContainText(
    "合成等待：测试慢回复",
  );
  await page.clock.fastForward(1200);
  await expect(page.locator("#run-status")).toContainText("正在输入");
  await page.clock.fastForward(8000);
  await expect(page.locator("#run-status")).toContainText("有点慢");
  await page.locator("#cancel-run").click();
  await page.clock.resume();
  await expect(page.locator("#run-status")).toContainText("已取消");
  await expect(page.locator("#messages")).not.toContainText("正在输入");
  await expect(page.locator("#messages")).not.toContainText("这次回复有点慢");
});

test("较早摘要可查看用户和已展示助手来源；只删摘要保留原始聊天且不自动重建", async ({
  page,
}) => {
  for (let i = 0; i < 15; i++) {
    const text = i === 0 ? "合成历史项目采用紫檀代号" : `合成历史过渡闲聊${i}`;
    await page.locator("#chat-input").fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator("#messages .user").last()).toContainText(text);
    await expect(page.locator("#run-status")).toContainText("已完成");
  }
  await page.getByText("较早的对话摘要", { exact: true }).click();
  const card = page
    .locator("#conversation-summary-list .card")
    .filter({ hasText: "合成历史项目采用紫檀代号" })
    .first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "查看摘要来源" }).click();
  await expect(page.getByRole("dialog")).toContainText("用户发言");
  await expect(page.getByRole("dialog")).toContainText("助手已展示内容");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await card.getByRole("button", { name: "删除这块摘要" }).click();
  await expect(page.locator("#conversation-summary-list")).not.toContainText(
    "合成历史项目采用紫檀代号",
  );
  await expect(page.locator("#messages")).toContainText(
    "合成历史项目采用紫檀代号",
  );
  await page.reload();
  await expect(page.locator("#conversation-summary-list")).not.toContainText(
    "合成历史项目采用紫檀代号",
  );
});
