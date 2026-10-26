import { test, expect } from "@playwright/test";

test("新建角色选择模型，创建后和刷新后使用所选模型", async ({ page }) => {
  await page.route("**/v1/speech", (route) => route.abort());
  await page.route("**/v1/voice", (route) =>
    route.fulfill({ json: { configured: false, voiceName: "测试音色" } }),
  );
  await page.goto("/");
  await expect(page.locator("#connection")).toContainText("本地已连接");
  for (const [index, model] of ["grok-4.3", "deepseek-v4-pro"].entries()) {
    await page.getByRole("button", { name: "新建角色", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("使用模型").locator("option")).toHaveText([
      "DeepSeek Flash",
      "DeepSeek Pro",
      "Grok 4.3",
    ]);
    if (index === 1)
      await expect(dialog.getByLabel("使用模型")).toHaveValue("grok-4.3");
    await dialog
      .getByLabel("名字", { exact: true })
      .fill(`模型选择测试-${index}`);
    await dialog.getByLabel("使用模型").selectOption(model);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page).toHaveURL(/bot=[a-f0-9-]{36}/);
    await expect(page.locator("#connection")).toContainText("本地已连接");
    await page.getByRole("button", { name: "人格", exact: true }).click();
    await expect(page.locator("#model")).toHaveValue(model);
    await page.reload();
    await expect(page.locator("#connection")).toContainText("本地已连接");
    await page.getByRole("button", { name: "人格", exact: true }).click();
    await expect(page.locator("#model")).toHaveValue(model);
  }
});

test("可配置 Grok 4.3 与 DS，BYOK 不回显、刷新保留、切换角色隔离", async ({
  page,
}) => {
  // This suite runs against HARNESS_MODEL=mock and never sends real model calls.
  await page.route("**/v1/speech", (route) =>
    route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } }),
  );
  await page.route("**/v1/voice", (route) =>
    route.fulfill({ json: { configured: false, voiceName: "测试音色" } }),
  );
  const boot = (await (await page.request.get("/bootstrap")).json()) as {
    csrfToken: string;
  };
  const created = await page.request.post("/v1/bots", {
    headers: { "X-Local-Token": boot.csrfToken },
    data: { name: "模型设置测试", template: "companion" },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await page.goto(`/?bot=${id}`);
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await page.getByRole("button", { name: "人格", exact: true }).click();
  await expect(page.locator("#model-provider")).toHaveValue("deepseek");
  await page.locator("#model-api-key").fill("synthetic-ds-browser-key");
  await page.getByRole("button", { name: "保存 Key", exact: true }).click();
  await expect(page.locator("#model-key-status")).toContainText(
    "已保存 BYOK Key",
  );
  await expect(page.locator("#model-api-key")).toHaveValue("");
  await page.locator("#model-api-key").fill("unsaved-ds-draft");
  await page.locator("#model-provider").selectOption("grok");
  await expect(page.locator("#model-api-key")).toHaveValue("");
  await expect(page.locator("#model")).toHaveValue("grok-4.3");
  await expect(page.locator("#model option")).toHaveText(["Grok 4.3"]);
  await page.locator("#model-api-key").fill("synthetic-grok-browser-key");
  await page.getByRole("button", { name: "保存运行设置", exact: true }).click();
  await expect(page.locator("#model-key-feedback")).toContainText(
    "运行设置已保存",
  );
  await expect(page.locator("#model-key-status")).toContainText(
    "Grok：已保存 BYOK Key",
  );
  await expect(page.locator("#model-api-key")).toHaveValue("");
  await page.reload();
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await page.getByRole("button", { name: "人格", exact: true }).click();
  await expect(page.locator("#model-provider")).toHaveValue("grok");
  await expect(page.locator("#model")).toHaveValue("grok-4.3");
  await expect(page.locator("#model-key-status")).toContainText(
    "已保存 BYOK Key",
  );
  await expect(page.locator("#model-api-key")).toHaveAttribute(
    "type",
    "password",
  );
  const visible = await page.locator("body").innerText();
  expect(visible).not.toContain("synthetic-grok-browser-key");
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  expect(stored).not.toContain("synthetic-grok-browser-key");
  await page.locator("#model-provider").selectOption("deepseek");
  await expect(page.locator("#model-key-status")).toContainText(
    "DeepSeek：已保存 BYOK Key",
  );
  await page.locator("#model").selectOption("deepseek-v4-pro");
  await page.getByRole("button", { name: "保存运行设置", exact: true }).click();
  await expect(page.locator("#model-key-feedback")).toContainText(
    "运行设置已保存",
  );
  await page.locator("#model-provider").selectOption("grok");
  await page
    .getByRole("button", { name: "移除 BYOK Key", exact: true })
    .click();
  await expect(page.locator("#model-key-feedback")).toContainText(
    "BYOK Key 已移除",
  );
  await expect(page.locator("#remove-model-key")).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .locator("#runtime-form")
    .screenshot({ path: "test-results/model-settings-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .locator("#runtime-form")
    .screenshot({ path: "test-results/model-settings-desktop.png" });
  await page.locator("#bot-select").selectOption("xiaoye");
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await page.getByRole("button", { name: "人格", exact: true }).click();
  await expect(page.locator("#model-provider")).toHaveValue("deepseek");
  await expect(page.locator("#model-key-status")).not.toContainText(
    "已保存 BYOK Key",
  );
});
