# 源码证据索引

v0.3 · 研究日期2026-10-23（Asia/Shanghai）· 固定证据冻结。认知状态：以下为静态源码与测试阅读，未执行测试；不证明产品效果或容量。M0期间差异记入[实现记录](../engineering/implementation-notes.md)，冲突按[权威规则](../../README.md#文档冻结与权威规则)处理。版本、缓存与原Git blob校验见[source-lock.json](source-lock.json)。

v0.3只同步文档导航：最新选型为TS自研Harness＋可替换AI SDK接入层，见[技术决策](../engineering/architecture-decisions.md)；未来网页与规模见[演进路线](../engineering/web-and-scaling-roadmap.md)。下列57条源码证据、Kimi补充与固定版本保持原研究范围，不据此增加容量或部署结论。

## 固定版本

| 项目 | 分支 | Commit | 源码许可声明／元数据 |
|---|---|---|---|
| EverMind-AI/EverOS | main | [5b0979b1b7f3](https://github.com/EverMind-AI/EverOS/tree/5b0979b1b7f3a0cbe235756ff098515ec490753e) | Apache-2.0 |
| MemTensor/MemOS | main | [a7367d07e55d](https://github.com/MemTensor/MemOS/tree/a7367d07e55db61099f7b4e2c1108bc5831a24f3) | Apache-2.0 |
| Open-LLM-VTuber/Open-LLM-VTuber | main | [992309c0aa19](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/tree/992309c0aa19845960228f880013d4685fde93b5) | 源码 MIT；样例模型另行许可 |
| SillyTavern/SillyTavern | release | [06bde939fb1e](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127) | AGPL-3.0 |
| agnaistic/agnai | dev | [fccee00f5f76](https://github.com/agnaistic/agnai/tree/fccee00f5f7628d150760c787c4be87e6b1a652c) | AGPL-3.0 |
| earendil-works/pi | main | [906e1302f948](https://github.com/earendil-works/pi/tree/906e1302f94829ec7e228059199681c11faec0b0) | MIT |
| getzep/graphiti | main | [345e73161a61](https://github.com/getzep/graphiti/tree/345e73161a61b0a4400f80c64e5bba6a584acb7b) | Apache-2.0 |
| kwaroran/Risuai | main | [f50b5942ec6a](https://github.com/kwaroran/Risuai/tree/f50b5942ec6aa59aa3c56049ac687ca09667fec7) | GPL-3.0 |
| letta-ai/letta-code | main | [6c8b08fedfb6](https://github.com/letta-ai/letta-code/tree/6c8b08fedfb6f3fb437163ede8320a387151693f) | Apache-2.0 |
| mem0ai/mem0 | main | [2c81af3bbe27](https://github.com/mem0ai/mem0/tree/2c81af3bbe27d9bccb09c772d583df9e9be72ee5) | Apache-2.0 |
| memodb-io/memobase | main | [358c16bbc6d6](https://github.com/memodb-io/memobase/tree/358c16bbc6d687937d79bc2f984a11c3be8da901) | Apache-2.0 |
| moeru-ai/airi | main | [13240c2ff33b](https://github.com/moeru-ai/airi/tree/13240c2ff33bcef5118623a829f7c505828e5c87) | MIT |
| openclaw/openclaw | main | [ceb574b14893](https://github.com/openclaw/openclaw/tree/ceb574b148932fbf5fcefdc90d0da8da20f64259) | MIT |
| pipecat-ai/pipecat | main | [3dfcd17a112f](https://github.com/pipecat-ai/pipecat/tree/3dfcd17a112fba71c66f5b8ed5929eb2a07e74e9) | BSD-2-Clause |
| vectorize-io/hindsight | main | [80591c20b434](https://github.com/vectorize-io/hindsight/tree/80591c20b43473baf1647fd9ed8c5992d9803ea1) | MIT |
| vercel/ai | main | [e623e8c88b55](https://github.com/vercel/ai/tree/e623e8c88b55066dde769614a16ae51d424974aa) | ai 包 Apache-2.0；根 API NOASSERTION |
| screenpipe/screenpipe（源码可见） | main | [13216302a9ac](https://github.com/screenpipe/screenpipe/tree/13216302a9ac9d114ad4a798878f44ef1447e081) | 当前版本采用自定义商业许可；仅作实现参考 |

Kimi 工程参考另用本地固定快照 `9e1248416faa22d9f0b777b91ad092bbf1e19182`（2026-07-19），没有与当前上游混合。

## 实现与测试证据

### ST1 — SillyTavern/SillyTavern

[public/scripts/PromptManager.js:1](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/PromptManager.js#L1-L14)

提示词管理模块直接依赖主应用、DOM 和模板层；不是可直接导入的无界面 SDK。

### ST2 — SillyTavern/SillyTavern

[public/scripts/world-info.js:123](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L123-L150)

世界信息条目支持 sticky/cooldown；其单位与聊天激活有关，不能直接当现实时间调度。

### ST3 — SillyTavern/SillyTavern

[public/scripts/extensions/memory/index.js:350](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/memory/index.js#L350-L408)

摘要从消息 extra.memory 回找；生成后检查会话身份是否改变。

### ST4 — SillyTavern/SillyTavern

[public/scripts/extensions/memory/index.js:958](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/memory/index.js#L958-L984)

摘要保存到聊天消息附加字段，并以扩展提示注入；界面和保存逻辑混在一起。

### A1 — moeru-ai/airi

[packages/core-agent/package.json:1](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/packages/core-agent/package.json#L1-L75)

core-agent 已存在，但 private=true，依赖多个 workspace/catalog 包。

### A2 — moeru-ai/airi

[packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:217](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts#L217-L231)

持久化与会话代数通过端口注入；用户提交有持久确认，助手追加端口为同步返回。

### A3 — moeru-ai/airi

[packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:1188](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts#L1188-L1235)

等待后重查代数；通知允许静默；完成消息经宿主端口追加。

### A4 — moeru-ai/airi

[packages/core-agent/src/runtime/chat-orchestrator-runtime.test.ts:431](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/packages/core-agent/src/runtime/chat-orchestrator-runtime.test.ts#L431-L555)

测试覆盖无视 abort 的提供方、定向取消、重复消息身份和跨会话顺序。

### A5 — moeru-ai/airi

[packages/stage-ui/src/stores/memory.ts:5](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/packages/stage-ui/src/stores/memory.ts#L5-L95)

已有条目索引、角色作用域、读写和遗忘；当前 store 使用 localStorage，条目没有我们的完整来源/有效期领域字段。

### A6 — moeru-ai/airi

[packages/core-agent/src/agents/spark-notify/agent.ts:86](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/packages/core-agent/src/agents/spark-notify/agent.ts#L86-L137)

通知决策支持不响应；这是一轮平台中立决策，不等于持久关心调度服务。

### A7 — moeru-ai/airi

[packages/stage-ui/src/stores/character/orchestrator/store.ts:186](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/packages/stage-ui/src/stores/character/orchestrator/store.ts#L186-L254)

所检查的任务通知调度仍在 Vue/Pinia store，由 leader 与 setInterval 驱动。

### A8 — moeru-ai/airi

[packages/stage-ui/src/stores/character/notebook.ts:19](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/packages/stage-ui/src/stores/character/notebook.ts#L19-L35)

任务与笔记在这个 store 中是响应式数组；不能据此声称全仓不存在其他持久化。

### L1 — letta-ai/letta-code

[src/agent/personality.ts:333](https://github.com/letta-ai/letta-code/blob/6c8b08fedfb6f3fb437163ede8320a387151693f/src/agent/personality.ts#L333-L401)

切换人格会改记忆文件并提交；先检查未提交改动。

### L2 — letta-ai/letta-code

[src/backend/local/system-prompt-compilation.ts:65](https://github.com/letta-ai/letta-code/blob/6c8b08fedfb6f3fb437163ede8320a387151693f/src/backend/local/system-prompt-compilation.ts#L65-L124)

本地提示词投影读取已提交 Git 版本，避免把未提交工作区当成生效记忆。

### L3 — letta-ai/letta-code

[src/agent/memory-constraints.ts:8](https://github.com/letta-ai/letta-code/blob/6c8b08fedfb6f3fb437163ede8320a387151693f/src/agent/memory-constraints.ts#L8-L20)

记忆约束涵盖文件容量、核心总量、目录深度和只读文件。

### L4 — letta-ai/letta-code

[src/agent/memory-constraints-audit.test.ts:21](https://github.com/letta-ai/letta-code/blob/6c8b08fedfb6f3fb437163ede8320a387151693f/src/agent/memory-constraints-audit.test.ts#L21-L95)

测试区分 HEAD 与未提交变化，覆盖已提交预算错误与布局策略保持。

### L5 — letta-ai/letta-code

[src/backend/local/local-executor-factory.ts:21](https://github.com/letta-ai/letta-code/blob/6c8b08fedfb6f3fb437163ede8320a387151693f/src/backend/local/local-executor-factory.ts#L21-L73)

本地执行器支持确定性模式，并通过 PiStreamAdapter 驱动真实模型；本地 backend 确实存在。

### V1 — Open-LLM-VTuber/Open-LLM-VTuber

[src/open_llm_vtuber/agent/agents/basic_memory_agent.py:176](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/src/open_llm_vtuber/agent/agents/basic_memory_agent.py#L176-L223)

基础记忆从会话历史重建；中断时以实际听到的文本修正助手历史。

### V2 — Open-LLM-VTuber/Open-LLM-VTuber

[src/open_llm_vtuber/conversations/conversation_handler.py:35](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/src/open_llm_vtuber/conversations/conversation_handler.py#L35-L55)

主动发言信号加载提示；该触发输入带跳过记忆与历史标记。这里不能替代完整关心策略。

### V3 — Open-LLM-VTuber/Open-LLM-VTuber

[LICENSE:1](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/LICENSE#L1-L23)

源码许可为 MIT；样例 Live2D 模型另有许可，API 元数据 NOASSERTION 不能代替实际文件。

### R1 — kwaroran/Risuai

[src/ts/process/memory/hypav3.ts:505](https://github.com/kwaroran/Risuai/blob/f50b5942ec6aa59aa3c56049ac687ca09667fec7/src/ts/process/memory/hypav3.ts#L505-L575)

记忆分配包含重要摘要和近期摘要的独立预算。

### R2 — kwaroran/Risuai

[src/ts/process/memory/hypav3.ts:810](https://github.com/kwaroran/Risuai/blob/f50b5942ec6aa59aa3c56049ac687ca09667fec7/src/ts/process/memory/hypav3.ts#L810-L883)

还有随机摘要选择；适合讨论体验实验，但不纳入默认可重复回归。

### R3 — kwaroran/Risuai

[src/ts/process/memory/hypav3.ts:1650](https://github.com/kwaroran/Risuai/blob/f50b5942ec6aa59aa3c56049ac687ca09667fec7/src/ts/process/memory/hypav3.ts#L1650-L1659)

删除源聊天后清理不再有完整来源集合的孤立摘要。

### G1 — agnaistic/agnai

[common/memory.ts:195](https://github.com/agnaistic/agnai/blob/fccee00f5f7628d150760c787c4be87e6b1a652c/common/memory.ts#L195-L225)

记忆按预算筛选，并区分 priority 与 weight。

### G2 — agnaistic/agnai

[tests/prompt.spec.ts:47](https://github.com/agnaistic/agnai/blob/fccee00f5f7628d150760c787c4be87e6b1a652c/tests/prompt.spec.ts#L47-L91)

测试覆盖记忆预算、触发顺序、整词匹配及扫描深度。

### B1 — memodb-io/memobase

[src/server/api/memobase_server/controllers/modal/chat/extract.py:26](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/controllers/modal/chat/extract.py#L26-L105)

画像提取带严格模式和允许主题过滤；不会把所有任意主题都写入画像。

### B2 — memodb-io/memobase

[src/server/api/memobase_server/controllers/buffer_background.py:40](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/controllers/buffer_background.py#L40-L125)

后台缓冲先改变数据库状态，再加入 Redis 队列并使用租约锁；这提示我们单用户方案应缩小跨存储提交边界。

### B3 — memodb-io/memobase

[src/server/api/example_config/profile_for_companion/config.yaml:19](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/example_config/profile_for_companion/config.yaml#L19-L53)

陪伴画像示例包含交流风格、频率、兴趣和个性化偏好；示例不是已验证的关系模型。

### M1 — mem0ai/mem0

[mem0-ts/src/oss/src/memory/index.ts:720](https://github.com/mem0ai/mem0/blob/2c81af3bbe27d9bccb09c772d583df9e9be72ee5/mem0-ts/src/oss/src/memory/index.ts#L720-L840)

TS OSS 实现包含抽取入口和可配置推断；可以作为独立记忆候选。

### M2 — mem0ai/mem0

[mem0-ts/src/oss/tests/memory.crud.test.ts:158](https://github.com/mem0ai/mem0/blob/2c81af3bbe27d9bccb09c772d583df9e9be72ee5/mem0-ts/src/oss/tests/memory.crud.test.ts#L158-L254)

CRUD 测试包括更新时间、哈希、元数据保持和身份字段隔离。

### M3 — mem0ai/mem0

[mem0-ts/src/oss/tests/memory.crud.test.ts:496](https://github.com/mem0ai/mem0/blob/2c81af3bbe27d9bccb09c772d583df9e9be72ee5/mem0-ts/src/oss/tests/memory.crud.test.ts#L496-L552)

测试明确过期记忆在搜索/列表中隐藏，但按 ID 仍可读取；过期与删除不同。

### T1 — getzep/graphiti

[graphiti_core/edges.py:263](https://github.com/getzep/graphiti/blob/345e73161a61b0a4400f80c64e5bba6a584acb7b/graphiti_core/edges.py#L263-L285)

事实边区分来源 episodes、valid_at、invalid_at 和 expired_at。

### T2 — getzep/graphiti

[graphiti_core/utils/maintenance/temporal_edge_utils.py:39](https://github.com/getzep/graphiti/blob/345e73161a61b0a4400f80c64e5bba6a584acb7b/graphiti_core/utils/maintenance/temporal_edge_utils.py#L39-L71)

未来计划的陈述时间与未来发生时间被区分；截止日期不直接等同失效日期。

### T3 — getzep/graphiti

[tests/utils/maintenance/test_temporal_edge_utils.py:12](https://github.com/getzep/graphiti/blob/345e73161a61b0a4400f80c64e5bba6a584acb7b/tests/utils/maintenance/test_temporal_edge_utils.py#L12-L95)

测试覆盖计划、承诺、软截止日期和已完成事件；当前辅助规则含英文正则，不能直接视为中文能力证明。

### H1 — vectorize-io/hindsight

[hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py:89](https://github.com/vectorize-io/hindsight/blob/80591c20b43473baf1647fd9ed8c5992d9803ea1/hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py#L89-L107)

并行归纳失败时主动取消并等待同组任务，避免后台孤儿继续写入。

### H2 — vectorize-io/hindsight

[hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py:368](https://github.com/vectorize-io/hindsight/blob/80591c20b43473baf1647fd9ed8c5992d9803ea1/hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py#L368-L409)

归纳写入使用同一事务，并在写入时重查源事实仍然存活。

### H3 — vectorize-io/hindsight

[hindsight-api-slim/tests/test_consolidation_batch_atomicity.py:135](https://github.com/vectorize-io/hindsight/blob/80591c20b43473baf1647fd9ed8c5992d9803ea1/hindsight-api-slim/tests/test_consolidation_batch_atomicity.py#L135-L225)

回归用例覆盖 DELETE+CREATE 中途失败的回滚，以及归纳进度与写入一起提交。

### H4 — vectorize-io/hindsight

[hindsight-api-slim/tests/test_delete_document_concurrency.py:230](https://github.com/vectorize-io/hindsight/blob/80591c20b43473baf1647fd9ed8c5992d9803ea1/hindsight-api-slim/tests/test_delete_document_concurrency.py#L230-L307)

测试覆盖删除来源、重新导入与共享归纳的并发情况。

### O1 — MemTensor/MemOS

[apps/memos-local-plugin/core/feedback/subscriber.ts:70](https://github.com/MemTensor/MemOS/blob/a7367d07e55db61099f7b4e2c1108bc5831a24f3/apps/memos-local-plugin/core/feedback/subscriber.ts#L70-L119)

反馈管道串行排队并捕获入队时上下文，避免会话路由串线。

### O2 — MemTensor/MemOS

[apps/memos-local-plugin/core/feedback/feedback.ts:59](https://github.com/MemTensor/MemOS/blob/a7367d07e55db61099f7b4e2c1108bc5831a24f3/apps/memos-local-plugin/core/feedback/feedback.ts#L59-L198)

反馈修复有冷却、证据收集、门槛与持久记录；不是无条件把每次不满变成人格。

### E1 — EverMind-AI/EverOS

[src/everos/memory/cascade/reconciler.py:63](https://github.com/EverMind-AI/EverOS/blob/5b0979b1b7f3a0cbe235756ff098515ec490753e/src/everos/memory/cascade/reconciler.py#L63-L130)

文件与索引变更区分新增、修改、删除、可重试失败和已完成删除。

### E2 — EverMind-AI/EverOS

[tests/integration/test_cascade_all_kinds_consistency.py:240](https://github.com/EverMind-AI/EverOS/blob/5b0979b1b7f3a0cbe235756ff098515ec490753e/tests/integration/test_cascade_all_kinds_consistency.py#L240-L322)

集成测试核对 Markdown 条目、数据库 ID、数量和内容哈希的一致性。

### C1 — openclaw/openclaw

[src/cron/service/delivery-attempt-fence.ts:15](https://github.com/openclaw/openclaw/blob/ceb574b148932fbf5fcefdc90d0da8da20f64259/src/cron/service/delivery-attempt-fence.ts#L15-L72)

发送前重查 owner、代数与取消状态，并先记录投递尝试。

### C2 — openclaw/openclaw

[src/cron/service.restart-catchup.test.ts:318](https://github.com/openclaw/openclaw/blob/ceb574b148932fbf5fcefdc90d0da8da20f64259/src/cron/service.restart-catchup.test.ts#L318-L351)

重启时对执行中周期任务标记失败而非直接重放的回归用例。

### C3 — openclaw/openclaw

[src/cron/service/notification-intents.ts:19](https://github.com/openclaw/openclaw/blob/ceb574b148932fbf5fcefdc90d0da8da20f64259/src/cron/service/notification-intents.ts#L19-L53)

消息路由和任务执行身份有独立结构。

### P1 — pipecat-ai/pipecat

[src/pipecat/turns/user_turn_controller.py:125](https://github.com/pipecat-ai/pipecat/blob/3dfcd17a112fba71c66f5b8ed5929eb2a07e74e9/src/pipecat/turns/user_turn_controller.py#L125-L179)

语音轮次控制有显式 setup/start/stop/cleanup，并能替换策略。

### P2 — pipecat-ai/pipecat

[tests/test_user_turn_controller.py:131](https://github.com/pipecat-ai/pipecat/blob/3dfcd17a112fba71c66f5b8ed5929eb2a07e74e9/tests/test_user_turn_controller.py#L131-L153)

替换策略时检查事件处理器不会重复累积。

### D1 — vercel/ai

[packages/ai/src/generate-text/stream-text.ts:344](https://github.com/vercel/ai/blob/e623e8c88b55066dde769614a16ae51d424974aa/packages/ai/src/generate-text/stream-text.ts#L344-L448)

流式接口有取消、超时和重试控制；默认存在重试，域运行时必须明确设置。

### D2 — vercel/ai

[packages/ai/src/generate-text/output.ts:94](https://github.com/vercel/ai/blob/e623e8c88b55066dde769614a16ae51d424974aa/packages/ai/src/generate-text/output.ts#L94-L151)

对象输出提供 schema 与完成后类型验证；schema 合法不等于语义事实正确。

### D3 — vercel/ai

[packages/ai/package.json:1](https://github.com/vercel/ai/blob/e623e8c88b55066dde769614a16ae51d424974aa/packages/ai/package.json#L1-L6)

所检查的 ai 包声明 Apache-2.0；根仓 API 元数据不能代替包声明。

### I1 — earendil-works/pi

[packages/ai/src/types.ts:159](https://github.com/earendil-works/pi/blob/906e1302f94829ec7e228059199681c11faec0b0/packages/ai/src/types.ts#L159-L185)

模型接口支持取消与请求边界回调，适合作为可替代模型网关。

### I2 — earendil-works/pi

[packages/agent/src/agent-loop.ts:172](https://github.com/earendil-works/pi/blob/906e1302f94829ec7e228059199681c11faec0b0/packages/agent/src/agent-loop.ts#L172-L210)

通用 loop 包含 steering 和 prepareNextTurn；采用它仍需自有持久状态与领域约束。

### I3 — earendil-works/pi

[packages/ai/package.json:1](https://github.com/earendil-works/pi/blob/906e1302f94829ec7e228059199681c11faec0b0/packages/ai/package.json#L1-L4)

当前检查的包名已为 @earendil-works/pi-ai；不沿用旧包名猜测。

### S1 — screenpipe/screenpipe

[crates/screenpipe-engine/src/capture_exclusions.rs:1](https://github.com/screenpipe/screenpipe/blob/13216302a9ac9d114ad4a798878f44ef1447e081/crates/screenpipe-engine/src/capture_exclusions.rs#L1-L43)

屏幕存储与探测采用不同的排除信息新鲜度策略；无法确认排除窗口时，存储路径跳过像素而非采用过期信息。相关测试就在该文件。

### S2 — screenpipe/screenpipe

[crates/screenpipe-capture/src/paired_capture.rs:203](https://github.com/screenpipe/screenpipe/blob/13216302a9ac9d114ad4a798878f44ef1447e081/crates/screenpipe-capture/src/paired_capture.rs#L203-L269)

截图与可访问性树配对，并保留 frame 身份；这是桌面情境来源和时间关联的参考。

### S3 — screenpipe/screenpipe

[LICENSE.md:1](https://github.com/screenpipe/screenpipe/blob/13216302a9ac9d114ad4a798878f44ef1447e081/LICENSE.md#L1-L30)

当前源码采用 Screenpipe Commercial License，不能按 MIT 开源依赖对待；本方案不引入代码。

### A9 — moeru-ai/airi

[apps/stage-tamagotchi/src/main/services/electron/powerMonitor.ts:11](https://github.com/moeru-ai/airi/blob/13240c2ff33bcef5118623a829f7c505828e5c87/apps/stage-tamagotchi/src/main/services/electron/powerMonitor.ts#L11-L30)

休眠、恢复、锁屏、解锁映射为事件；监听器随所属窗口关闭清理，避免重复订阅。

## Kimi 固定快照补充证据

- K1：`packages/agent-core-v2/src/agent/contextProjector/contextProjectorService.ts`：存储历史与发给模型的投影分开；未完成工具结果有明确的中断投影，异常修复留记录。对应测试：`test/agent/contextProjector/projector-tool-exchanges.test.ts`。
- K2：`packages/agent-core-v2/src/agent/loop/stepRequestQueue.ts`：请求有归属、取消与合并边界。我们只采用身份明确和有界运行原则，不复制整个 DI/Scope 体系。
- K3：`packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts` 与 `test/agent/contextMemory/contextTranscript.test.ts`：持久记录与当前上下文视图分开，清空当前视图不等于遗忘数据。

## 阅读与验证边界

- 覆盖关键模块和相关测试，未审计每个项目的全部文件。
- 缓存文件已按固定 Git tree 校验 blob；校验只证明内容对应该版本，不证明实现正确。
- 未安装或运行这些项目，未执行其测试套件，未做时延、成本、人格质量或长期记忆准确率排名。
- 仓库 README 中的 benchmark 宣传不作为本方案的实测依据。
- 这些源码均未复制进产品实现；当前工作区只有调研与方案文档。
