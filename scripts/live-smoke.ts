import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  ProviderModel,
  collect,
  modelEvents,
  parseJson,
} from "../src/model.js";
import { DomainError } from "../src/domain.js";

const config = loadConfig();
const model = new ProviderModel(config, () => config.model);
const report: {
  at: string;
  model: string;
  checks: { name: string; passed: boolean; detail: unknown }[];
} = { at: new Date().toISOString(), model: config.model, checks: [] };
try {
  const basic = {
    purpose: "eval" as const,
    model: config.model,
    system: "你是中文测试助手。只处理合成测试，不涉及用户真实数据。",
    signal: AbortSignal.timeout(30000),
    maxOutputTokens: 120,
  };
  const text = await collect(model, {
    ...basic,
    messages: [{ role: "user", content: "请只回复：连接成功" }],
  });
  report.checks.push({
    name: "stream_text",
    passed: text.text.includes("连接成功"),
    detail: { text: text.text, usage: text.usage },
  });
  const json = await collect(model, {
    ...basic,
    purpose: "extract",
    system:
      '仅输出合法json。格式为{"assertions":[],"openLoops":[]}，两个数组都为空。',
    messages: [
      { role: "user", content: "这是合成协议测试，没有需要记住的事实。" },
    ],
  });
  const parsed = parseJson(json.text);
  report.checks.push({
    name: "json_output",
    passed: !!parsed && typeof parsed === "object" && "assertions" in parsed,
    detail: { usage: json.usage },
  });
  let calls = 0;
  for await (const event of modelEvents(model, {
    ...basic,
    messages: [
      {
        role: "user",
        content:
          "不要直接回答。请先调用search_memory工具，query参数为合成测试。",
      },
    ],
    tools: [
      {
        name: "search_memory",
        description: "查询测试记忆。",
        schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
  }))
    if (event.type === "tool") calls++;
  report.checks.push({
    name: "tool_request_without_auto_execution",
    passed: calls > 0,
    detail: { toolRequests: calls },
  });
} catch (error) {
  report.checks.push({
    name: "provider_access",
    passed: false,
    detail: {
      code: error instanceof DomainError ? error.code : "smoke_failed",
    },
  });
}
mkdirSync(join(config.dataDir, "reports"), { recursive: true, mode: 0o700 });
writeFileSync(
  join(config.dataDir, "reports", "live-smoke.json"),
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
if (report.checks.some((c) => !c.passed)) process.exitCode = 1;
