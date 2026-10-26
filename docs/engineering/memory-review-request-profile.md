# ADR：离线引用评审的请求级模型选项

日期：2026-10-24。决策：Adapt。作用域限于显式模型请求；不修改正式服务设置或默认聊天模式。

引用核对需要保留原回答、独立请求快照及可复核输出。评审任务和聊天任务共享模型适配器，因此推理与温度必须随请求传递，不能通过修改全局配置开启。提取使用温度 0；涉及其他主体的身份关系、待核引用使用低档推理；覆盖检查使用温度0的非推理请求。其理由是任务需要关系推导，不是某道题应当通过。

按 `engineer-agents-with-kimi` 技能核对本地只读参考快照：MoonshotAI/kimi-code，commit `9e1248416faa22d9f0b777b91ad092bbf1e19182`，快照日期 2026-07-19。身份由参考工程 README 的快照登记确认；包含该目录的工程 HEAD 不能代替上游 revision。

| 阅读证据 | 提炼的不变量 | 本项目取舍 |
| --- | --- | --- |
| `packages/agent-core-v2/src/agent/llmRequester/llmRequester.ts` 的请求覆盖接口；`llmRequesterService.ts:499–527` | 请求显式解析选项，复制消息与工具列表，单次调用不污染其他请求 | `ModelRequest` 增加可选 `reasoningEffort`、`temperature`；评审每次复制消息数组 |
| `test/agent/llmRequester/llmRequester.test.ts:99–140` 的两次直接请求；`llmRequesterService.test.ts:235–254` 的 thinking 配置传递 | 请求参数与思考配置的归属可单独验证 | 本项目使用真实 SDK 的本地 HTTP/SSE 合同测试，不依赖线上评分证明配置正确 |

参考根目录：`/Users/kuanyu/Projects/story-creation-agent/kimi-cli/`。只阅读源码和测试，未运行、也未声称通过 Kimi 自身测试。采用请求边界原则，不引入其 DI、profile 框架或配置服务。

本项目落点：

- `src/model.ts`：显式请求才开启低档推理；缺省 DeepSeek 仍发送 thinking disabled，Grok 仍为 none；推理流不进入可见回答。
- `scripts/lib/memory-claim-audit.ts`：任务角色决定请求选项，记录实际选项和原输出；不改用户回答，也不尝试直到通过。
- `tests/provider-contract.test.ts`：验证默认请求、显式低档请求、后续普通请求之间互不污染；验证温度 0 的实际请求体以及隐藏推理不进入文本。
- `tests/memory-claim-audit.test.ts`：验证消息快照、有限格式修复、截断原文保留及无标准标签泄漏。

DeepSeek 参数按已安装 `@ai-sdk/deepseek@3.0.72` 的类型与实现核对；HTTP 合同测试验证实际序列化，不凭其他提供商的参数名字类推。新选项不写入 `env.local`，不触发服务重启或记忆数据迁移。


## 2026-10-24 benchmark复核后的补充

目标：有依据的回答不能因模型请求选项在异步步骤间串用而失真，模型能力对照也不能偷偷改变正式聊天默认。继续采用前述固定Kimi快照的请求捕获、明确选项和输出预算原则，**Adapt**，不复制profile或DI框架。

最小落点为 `AppConfig.memoryAnswerReasoning`（环境开关 `HARNESS_MEMORY_ANSWER_REASONING`，默认false）。Harness在接受Run时捕获该值；每次请求仅当本轮确有合格记忆且不是危机请求时传low。输出上限增加4096，并在相同reserve中先计完整预算。普通请求、提取／摘要和后续关闭选项的Run不继承该值；正式env未修改。

4096是容量工程初值，不是实验得出的最优推理长度。超时仍受Run取消和截止约束，未为了测试延长正式运行时限。验证：`memory-grounded-profile.test.ts`覆盖显式选择、无证据／旧库关闭、Run快照、后续不继承与预算预检；`provider-contract.test.ts`验证实际SDK请求体与隐藏推理不进入可见文本。只读参考Kimi源码和合同测试，未执行Kimi测试。

离线评审另将覆盖改为温度0非推理请求；无可见输出的推理容量耗尽允许在同一两次总上限内切换一次非推理请求，保留失败用量。完成的语义判定、部分可见JSON和用户答卷不重试。该恢复仅在离线审计器，不增加前台模型调用次数。

实际普通聊天与合成引用仍有失败，不能只因开启推理就声称正确。对照结果及边界见[benchmark复核](../implementation/memory-benchmark-v1-audit.md)。
