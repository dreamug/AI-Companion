# Grok 4.3 与 BYOK

2026-10-23，已部署到本机服务 `http://127.0.0.1:4317`。

## 使用

选择角色，打开「人格 → 运行设置」，选择 DeepSeek（DS）或 xAI（Grok），输入对应服务商的 API Key，再点击「保存运行设置」。Grok 使用 `grok-4.3`（关闭 reasoning、流式输出），DS 保留 Flash 和 Pro。模型与两家的 Key 按角色独立保存，刷新和重启后保留。

可以单独保存 Key；留空保留已有值。移除 BYOK Key 后回退到该服务商的后台环境配置（如有）。服务端只返回配置状态，输入框保存后清空，不使用浏览器持久存储保存 Key。Key 以明文保存于当前角色数据目录的 `model-keys.json`，权限为 0600，不写入 SQLite、日志事件、Trace、导出或数据库备份。迁移机器后需要重新填写或安全迁移凭据文件。

## 接入与边界

通过固定版本 `@ai-sdk/xai@5.0.29` 接入官方 Responses API，默认地址 `https://api.x.ai/v1`，使用 `store: false`、`reasoningEffort: none`。DeepSeek 继续使用原 SDK 和关闭 thinking 的配置。两者共用消息、工具历史、流式输出、用量、取消和错误分类逻辑。工具声明不带自动执行函数，仍由 Harness 校验和执行。

新运行捕获模型标识，模型端口按每次请求捕获的标识选择服务商和对应 Key，正在执行的旧运行不受页面模型选择变化影响。模型身份和用量的服务商记录也按请求模型归属，避免切换时错记。

后台兼容 `DEEPSEEK_API_KEY`，新增 `XAI_API_KEY`（兼容 `GROK_API_KEY`）、`XAI_BASE_URL`。`HARNESS_MODEL=grok` 可设置新角色的默认模型。已有角色保留已保存的模型选择。真实模型评估、协议检查和集成脚本也使用相同的服务商路由。

参考 [Grok 4.3 官方模型说明](https://docs.x.ai/developers/models/grok-4.3)、[AI SDK xAI 接入说明](https://ai-sdk.dev/providers/ai-sdk-providers/xai)。

工程参考采用本地 Kimi 快照 `9e1248416faa22d9f0b777b91ad092bbf1e19182` 的 `llmProtocol/provider.ts` 和 `providers/provider-errors.test.ts`：保留独立的模型协议边界及限流重试元数据。决策为 Adapt：沿用现有 ModelPort，在模型端口中选择服务商；凭据归当前角色所有，不引入新的 Agent 生命周期或编排机制。

## 验证

- 类型检查、构建通过；17 个测试文件、219 项测试通过。
- 浏览器全站回归 29 项通过；1 项需要显式启用真实本地语音模型的测试按原规则跳过。
- 新增 Grok SDK 协议测试：JSON、工具调用及历史回传、身份及用量、认证失败、限流、服务不可用、取消，以及切换后的请求路由。
- 新增 BYOK 接口与浏览器验证：角色及服务商隔离、覆盖及移除、环境配置回退、重启保留、0600 权限、CSRF／跨站拒绝、非法输入、凭据不进入数据库、导出及备份。
- 已为原小野和小棠创建升级前一致性备份，并在重启后核对聊天、记忆和设置指纹，均一致。核对报告在 `data/reports/provider-upgrade.json`，正式页面截图在 `data/reports/grok-byok-ready.png`。

本地模型协议测试使用真实 SDK 和本地合成服务，不发送用户内容、不消耗模型额度。随后用户提供临时测试 Key，已保存到权限 0600 的 `env.local`（`XAI_API_KEY`）并重启服务。使用默认环境 Key、未配置 BYOK 的真实 Grok 4.5 文本、JSON、工具请求三项测试均通过，返回模型身份均为 `grok-4.5`；仅发送合成测试内容。报告在 `data/reports/grok-live-smoke.json`。

重启后已核对两位角色均可从环境配置获得 Grok 和 DS 的默认 Key，原模型选择、聊天、记忆和设置指纹保持一致。核对结果在 `data/reports/grok-env-reload.json`。报告不包含 Key；销毁远程临时 Key 后，应删除或替换 `env.local` 中的 `XAI_API_KEY`，并重启服务。保存新 Key 仍只确认本地保存成功，不代表自动执行提供方认证测试。

## Grok 4.3 无推理与流式输出更新

按用户要求将 Grok 的当前模型改为 `grok-4.3`，请求显式设置 `reasoning.effort: none`、`stream: true`，沿用现有默认 Key／BYOK 规则。旧角色保存的 `grok-4.5` 在下次打开时迁移为 4.3；历史运行记录不改写。

真实合成请求返回模型身份 `grok-4.3`，39 个文字增量，reasoning token 为 0，没有 reasoning 事件；首段文字早于响应完成到达。报告在 `data/reports/grok43-streaming-live.json`。新增本地测试验证响应尚未结束时文字增量已到达，以及默认模型和旧设置迁移。网页设置回归通过，报告在 `data/reports/grok43-browser.json`。

本轮类型检查、构建及 242 项测试通过；Grok 4.3 网页设置回归通过。已重启本地服务，并将当前小野角色切到 Grok 4.3、关闭分条回复，采用逐段流式显示。原聊天、记忆指纹核对一致，小棠继续保留原模型选择。升级核对见 `data/reports/grok43-upgrade.json`。

## 新建角色时选择模型

「新建角色」新增「使用模型」选项：Grok 4.3、DeepSeek Flash、DeepSeek Pro，默认选中当前角色使用的模型。创建接口接受可选的 `model`；旧客户端省略时继续使用后台默认模型。显式选择在角色数据库中持久保存，即使尚未开始聊天，重启及归档恢复后仍保留。新角色使用服务商默认 Key，不复制其他角色的 BYOK。

类型检查、构建、245 项测试通过；创建时选型、刷新保留、现有配置和角色创建／编辑／归档／恢复浏览器回归 3 项通过，见 `data/reports/create-model-browser.json`。
