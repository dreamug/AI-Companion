# 角色日常、故事系统与连续消息调研

日期：2026-10-23（Asia/Shanghai）。本轮是需求分析与源码调研，没有实现新业务功能。当前目录无 Git 元数据，因此以实际文件和本轮测试为项目基线。旧调研沿用其固定版本；新增上游另见 `story-system-source-lock.json`，不改写冻结报告。

## 结论

建议保留现有 TypeScript Harness、SQLite、模型端口和多 bot 隔离，在上层增加三项能力：

1. **角色生活与故事状态**：角色根据设定安排一天，经历事件，留下情绪与记忆，并延续少量跨天线索。
2. **主动表达决策**：从角色经历、用户的待跟进事项和对话余韵中选择值得分享的内容，再检查是否适合现在联系。
3. **连续消息发送**：一次表达可以包含几条独立消息，按顺序发送；用户插话后，暂停并重新判断未发内容。

新增项目中，Yuralume 对完整产品目标最贴近；MaiBot、AstrBot 对分条发送有具体实现；Generative Agents 和 AI Town 提供角色持续生活的研究与代码参考。它们不是可直接装进当前项目的同一种插件。

## 当前项目已经具备什么

| 能力 | 当前代码与行为 | 距离目标的缺口 |
|---|---|---|
| 静态角色设定 | `src/domain.ts` 的 Persona，`src/bots.ts` 的背景、兴趣、相处模式 | 没有动态的角色日程、当前活动和故事事件 |
| 主动关心 | `src/harness.ts` 的 `tick`、`concernRule`、`processConcern` | 主要消费已确认 FollowUp；缺少角色自身经历产生的分享动机 |
| 日程 | `src/schedule.ts`、Series、一次性 FollowUp | 是提醒／跟进日程，还不是角色世界的一天 |
| 防打扰 | 主动开关、静默时段、专注状态、发送前重检 | 多 bot 还需要面向同一用户的总额度与协调 |
| 发送可靠性 | Delivery、Outbox、尝试身份、浏览器回执、失效处理 | Delivery 是单段文本；没有逐条发送进度 |
| 流式对话 | `executeRun` 创建一个 `assistant-${runId}`，`flushSegment` 更新同一 Message | `message.segment` 是累计内容更新，不是新增聊天消息 |
| 记忆与上下文 | `src/context.ts` 投影人格、用户记忆、日摘要、历史、跟进事项 | 没有角色世界状态；主动 Delivery 也不在所选消息历史里 |
| 前端呈现 | `web/app.js` 的主聊天渲染只遍历 `s.messages`；关心在 `renderFollowups` 中另行渲染 | 主动私信需要进入主聊天，并与后续回复形成连续上下文 |
| 语音 | 已完成消息／Delivery 的朗读和播放控制 | 多条消息需要串行播放和统一停止，避免抢播 |

当前普通非承诺跟进采用每天最多 2 次、4 小时冷却；明确承诺另行处理。这是当前实现的策略，不是新故事消息必须沿用的体验参数。未来应该按“一次主动接触”计频并控制通知数量，不能把一组三个气泡算成三次打扰。

现有 `Source.kind` 只有 `message` 与 `manual`，后台 `Job.kind` 只有 `extract` 与 `summary`。故事状态不能假借一个手工来源或虚构用户消息绕进现有事实域。

本轮执行现有 `concern`、`schedule`、`runtime` 三个测试文件：**47 项通过**。这证明已有相关合同通过当前测试，不能证明新增故事系统、长期体验或外部项目运行质量。

## 故事系统的实际含义

这里最适合的是“角色有持续生活的陪伴系统”。日常与故事承担不同职责：日常提供稳定生活感，跨天故事提供尚未结束的事情。每天都安排戏剧性事件，会让陪伴逐渐变成剧情播报。

建议分为四层：

| 层 | 内容 | 更新方式 |
|---|---|---|
| 稳定设定 | 角色身份、世界规则、工作／兴趣、固定人物地点 | 用户配置或版本化修改 |
| 日常安排 | 今天几个活动时段、当前活动、忙碌程度 | 一天规划一次，必要时调整 |
| 已发生事件 | 活动结果、一个小插曲、留下的情绪和可回忆细节 | 到事件边界时推进并持久化 |
| 跨天线索 | 想学会一道菜、准备一个作品、与某个配角的未完事件 | 少量线索持续推进，保留因果 |

例如小棠喜欢做饭：上午打算尝试番茄炖牛腩；下午实际尝试，发现汤汁收得太干；傍晚分享一个具体片段；明天再尝试调整。隔天再聊时，她应记得上次的问题，而不是重新抽一条毫无关系的日常。

世界里的事件与“告诉用户”应独立记录。至少区分：**计划、世界中已发生、已向用户表达、用户是否参与、是否有展示回执**。角色今天自己尝试做饭，可以成为角色经历；“你陪我一起做饭”必须有实际互动证据。未来计划也不能因到了时间就自动变成共同回忆。

按当前 AI 角色设定，生活可以发生在明确的虚构角色世界中，日常交流不必每句反复解释；同时不能把角色经历写入用户现实履历。`buildSystem` 和小棠当前“未知经历不编造”的规则要做定向扩展：允许引用已提交的角色世界事件，继续限制没有依据的用户经历。不能简单删除整条边界。

## 之前调研过的项目如何重新使用

以下使用 [原源码证据](source-evidence.md) 的固定版本，不声称逐个重新审计了当前上游。

| 项目 | 对本需求的价值 | 适配判断 |
|---|---|---|
| SillyTavern／RisuAI／Agnai | 角色卡、World Info／Lorebook、上下文预算与来源 | 适合设定与知识激活；不能把按聊天触发的条目当成持续时间模拟 |
| AIRI | Spark Notify 可选择不回应；core-agent 的队列、取消、会话身份与部分输出 | 继续作为主动决策、桌面和语音边界参考；此次尚无引入整套运行时的必要 |
| OpenClaw | 调度、发送前校验、尝试身份、重启与未知投递状态 | 延续现有 Harness 已采用的原则；不为故事系统引入第二套完整宿主 |
| Open-LLM-VTuber／Pipecat | 主动发言入口、打断、实际播放内容、语音轮次 | 适合表现和语音层；主动信号本身不生成一条持续故事 |
| Letta／Mem0／Graphiti／Hindsight 等 | 持久身份、记忆整理、来源、有效时间与纠错 | 能保存故事结果，但不替代故事生成和表达时机决策 |

原先“自有小 Harness，按边界借鉴”的选择仍然适合本项目；新增研究改变的是上层产品设计参考的优先级。

## 本次新增的互联网项目与方案

### Yuralume：最贴近完整目标的产品参考

[项目主页](https://github.com/Yuralume/yuralume-core)自述仍处 alpha，覆盖角色日程、记忆、故事和主动联系。本轮固定到 `6996b152604e83a1cf6344cd236a9b9456f47bba`，对所列源码和测试做静态阅读，没有部署或运行上游测试。

值得借鉴的具体路径：

- [ScheduleMemorializer](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/src/kokoro_link/application/services/schedule_memorializer.py)：处理完成活动的经历记录，明确区分计划、共同活动证据和故事事件的唯一写入责任。
- [ActivityAftermath](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/src/kokoro_link/contracts/activity_aftermath.py)及[测试](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/tests/unit/test_schedule_memorializer_aftermath.py)：活动可以留下短期情绪余韵，再影响后续交流。
- [ProactiveDispatcher](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/src/kokoro_link/application/services/proactive_dispatcher.py)：先检查准入，再判断表达动机、生成主动内容；具有日程、刚结束活动及近期对话等上下文。
- [StoryArc](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/src/kokoro_link/domain/entities/story_arc.py)：故事有节拍、状态以及用户在事件中的位置；可参考“事件不是一段自由文本”的建模方式。
- [OutboundMessageSegments](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/src/kokoro_link/application/services/outbound_message_segments.py)及[测试](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/tests/unit/test_outbound_message_segments.py)：按空行将一个逻辑回复拆为多个平台气泡，附件放最后一条，引用上下文只放第一条，并把整组交给适配器。

分段辅助模块本身不实现打字间隔，也不证明支持用户插话后的未发消息重排；这些要另验。不能把“多气泡”直接等同于完整的人类消息节奏。

它也不是适合整套移植的轻量模块：当前依赖声明包含 Python 3.13、FastAPI、SQLAlchemy、PostgreSQL／pgvector 等，与当前项目的 TS／SQLite 运行形态不同。只研究机制、按自有接口重新设计，比再接一套后端更合适。

[仓库 LICENSE](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/LICENSE)为 BUSL-1.1，附加授权限定非商业生产使用，商业生产使用要求另行授权。应归类为源码可见参考，不能按 MIT 类依赖直接复制接入。

另外，[未回复次数测试](https://github.com/Yuralume/yuralume-core/blob/6996b152604e83a1cf6344cd236a9b9456f47bba/tests/unit/test_proactive_unanswered_streak.py)体现了其让角色对持续未回复产生情绪变化的产品选择。我们的已有角色规则不以离开制造内疚，因此只借鉴“记录未回复状态”，采用降频或暂停，不能照搬情绪升级策略。

### MaiBot：语义分条与实际发送的具体参考

[项目](https://github.com/Mai-with-u/MaiBot)，固定版本 `c602a2780f4f4dda4a6be46d67abc1cfb1ad420c`。

- [LLM 分句器](https://github.com/Mai-with-u/MaiBot/blob/c602a2780f4f4dda4a6be46d67abc1cfb1ad420c/src/chat/utils/llm_sentence_splitter.py)要求按自然语义拆分；短文本、代码和适合整体阅读的内容可以不拆；重建比较后映射回原文，限制模型在拆分时改写内容。
- [相应测试](https://github.com/Mai-with-u/MaiBot/blob/c602a2780f4f4dda4a6be46d67abc1cfb1ad420c/pytests/chat_test/test_llm_sentence_splitter.py)覆盖改写拒绝、不同不拆分标记、空白与标点归一。
- [reply 工具](https://github.com/Mai-with-u/MaiBot/blob/c602a2780f4f4dda4a6be46d67abc1cfb1ad420c/src/maisaka/builtin_tool/reply.py)逐段调用发送服务，后续段启用 typing，失败后停止后面的发送。
- [底层发送器](https://github.com/Mai-with-u/MaiBot/blob/c602a2780f4f4dda4a6be46d67abc1cfb1ad420c/src/chat/message_receive/uni_message_sender.py)包含根据消息计算等待时间再发送的路径。

很适合借鉴表达与发送分离，但无需为当前系统整套换用 MaiBot。它的群聊参与／触发机制也不自动等同于“用户没发消息时，角色因自身经历主动私聊”。代码为 GPL-3.0，研究机制与复制代码分开考虑。

### AstrBot：配置化分段的直接参考

[官方配置文档](https://docs.astrbot.app/dev/astrbot-config.html)列出分段开关、随机／按长度相关间隔、阈值和切分正则。默认随机间隔配置是 1.5–3.5 秒，这是上游默认值，不是本项目实测出的最佳值。

固定版本 `0cd42bd4dd216d8810da4e3f5fb2e381d3c6817e` 的 [respond stage](https://github.com/AstrBotDevs/AstrBot/blob/0cd42bd4dd216d8810da4e3f5fb2e381d3c6817e/astrbot/core/pipeline/respond/stage.py)确实按消息组件计算等待并逐条发送。[主动型能力官方文档](https://docs.astrbot.app/use/proactive-agent.html)提供定时任务、心跳等入口。

可借鉴少量发送节奏设置；角色生活与跨天因果仍要自行实现。本轮没有证明它的分段链路具备我们所需的逐条持久恢复与插话调整。代码为 AGPL-3.0。

### Generative Agents／AI Town：角色生活的基础参考

[Generative Agents 论文](https://arxiv.org/abs/2304.03442)研究记忆、观察、规划与反思如何形成可信的持续行为；[官方研究仓库](https://github.com/joonspk-research/generative_agents)提供小镇系统。这里采用的是论文架构证据与仓库信息，没有把全仓列为源码审计对象。

[AI Town](https://github.com/a16z-infra/ai-town)是 MIT 许可的 TS 小镇起点。本轮固定到 `8e05997f2409275669c8344b84a51692e83f3f33`，检查了 [agent](https://github.com/a16z-infra/ai-town/blob/8e05997f2409275669c8344b84a51692e83f3f33/convex/aiTown/agent.ts) 和 [memory](https://github.com/a16z-infra/ai-town/blob/8e05997f2409275669c8344b84a51692e83f3f33/convex/agent/memory.ts)，后者可见相关性、近期性、重要性组合检索及反思路径。

适合参考“经历影响下一次行为”，但地图、移动和多角色社会模拟都超出当前陪伴聊天需求；不建议从完整小镇开始。

### 主动交流的研究补充

[Proactive Conversational Agents with Inner Thoughts](https://arxiv.org/abs/2501.00383)将表达动机与发言时机分开，是主动参与对话的有用研究。研究主要针对多方交谈，不直接证明一对一跨天陪伴的效果，也不意味着必须让模型全天持续思考。

## 建议接入方式

### 角色世界：结构化状态，小步推进

推荐新增 `CharacterLifeState`、`DayPlan`、`LifeEvent`，需要跨天情节时再增加轻量 `StoryArc`。这些是建议类型名，并未实现。

事件至少保存 bot／世界身份、角色设定版本、发生时间、状态、参与者、前因、结果、情绪余韵及修订号。向用户说过什么由消息记录关联表达，不能用一个 `shared=true` 同时表示“用户参与”和“已告诉用户”。

模型负责提出活动与故事内容，程序校验时间、参与者、设定版本和状态转换后提交。后续聊天仅注入当前活动、近期已发生事件和少量未完线索，不能把全部未来剧情塞进 Prompt，导致提前剧透或把计划说成事实。

对话可改变尚未发生的计划，并在后续体现用户的建议；已提交的过去事件不随每次模型调用重写。先做跨天目标即可，复杂分支和大量配角推迟。

### 主动联系：增加来源，沿用发送准入

建议流程：事件发生／用户事项到期 → 表达候选 → 时机检查 → 生成消息组 → 逐条发送前重检。

角色分享候选应有自身来源类型及授权范围；用户开启角色日常后，可授权该范围内的自主事件，不需要逐条审批虚构日常。当前 FollowUp 的“未确认不可发送”规则服务于用户事项，不应为了角色自主生活直接全局放宽。

共用主动开关、免打扰、冷却、来源有效性与人格版本检查；新增长期未回复降频、话题去重、同一用户多 bot 总额度。检查近期真实对话，避免“你刚说过今天很忙，她却继续问在干吗”。

所有主动消息进入主聊天和后续上下文，保留 `origin=proactive`、事件／候选来源及发送回执；不要伪造一条用户发言来触发现有 `submit`。角色在世界里做过某件事，也不等于用户已经知道。

浏览器页面关闭时，现有通知通道不能主动触达。若期望关页后手机也能收到，另选 Web Push、桌面常驻或 IM 适配器；这是通知渠道扩展，不由故事引擎自动解决。进程本身也须持续运行。

### 连续消息：一次生成，若干次发送

默认一次模型调用产出一个有界消息组，例如 1–4 条；模型选择语义边界，发送器决定间隔。先完整验证后发送最容易落地；后续如需降低第一条延迟，再做有完整边界校验的逐段流式输出。

不要每发一句就重新调用一次模型，也不要固定按字数强切。短回应允许只有一条；代码、长解释和正式内容允许保持完整。

可先试用几秒内的短间隔，第一条完成后尽快送出；具体值需真实体验调整。“正在输入”仅覆盖当前确实存在的待发表达。一次消息组默认最多发一次外部提醒，后面气泡静默追加。

建议分离 `generationStatus` 和 `sendStatus`，消息组内每条拥有稳定 ID、序号、`notBefore`、修订／代数、发送状态与展示状态。当前数据库按 run 排序的查询也需加入消息组内序号，不能依赖 UUID 顺序。

用户插话时，暂停未发部分，结合新消息决定保留、改写或取消；已经发送的气泡保持原记录。下一次上下文只能引用已发送的内容，并沿用现有展示回执的保守投影，不能让未发草稿成为“你刚刚听我说了”的依据。

刷新、重连与重启读取持久进度，不能靠浏览器定时器重演整组内容。发送结果不明保持 unknown；外部平台没有幂等能力时不能承诺 exactly-once。过时内容可以取消，不能恢复后不加判断地连发。

语音按实际发布的消息串行排队，用户停止或插话时取消未播放部分，保留已播放／已展示进度。

### 成本与离线时间

建议每日一次规划，只在活动边界或明确触发时生成少量事件；不按分钟调用模型续写生活。模型调用应有日预算、单次截止时间和失败后退避。

后台常驻时正常推进；应用关闭多天再打开时，采用有界时间跳跃：少量摘要衔接当前状态，跳过过期私信，不逐分钟补演。不把恢复时合成的离线日常冒充为后台当时确实执行过的记录。

当前 `tick` 在前台运行时直接返回，新故事任务不能把这个检查简单删掉；应让交谈优先，后台任务在空闲时按持久游标追赶必要的时间边界。

## 工程参考决策

本轮应用 `engineer-agents-with-kimi` 技能，仅参考恢复与记录边界。固定快照来自 `/Users/kuanyu/Projects/story-creation-agent/README.md`，Kimi commit 为 `9e1248416faa22d9f0b777b91ad092bbf1e19182`，快照日期 2026-07-19。

检查 `wireService.ts`、`record.ts` 与 `test/wire/resume.test.ts`。恢复测试明确验证历史重放不重新调用模型或工具。

**适配（Adapt）**：角色事件、消息组和逐条发送结果持久化；恢复状态不等于重新生成或重发；应用在恢复后单独决定哪些未发送内容仍有效。沿用 SQLite 事务，不引入 Kimi 的 DI、wire 格式或整套循环。事件流用于展示更新，权威故事与发送状态另行存储。

## 实施顺序与验收

1. **先做聊天消息组与主动消息入主线程**：统一普通回复和主动分享的消息协议；支持语义分段、短间隔、停止、插话、稳定排序和语音串行。
2. **再做角色一天的生活**：角色独立的活动计划、事件结果、记忆与当前状态；能主动分享，也能回答“你今天做了什么”。
3. **再做少量跨天故事**：有前因后果，能采纳用户建议调整未来，避免每日重新随机开局。
4. **按实际使用接离线通知渠道**：若页面常关闭，则增加可持续触达的通道。

核心验收场景：

- 同一角色上午、下午、隔天对已发生事情的叙述一致；未来计划不变成既成事实。
- 用户未参与的活动不出现“我们一起做过”的记忆；角色经历不进入用户现实画像。
- 用户建议改变未发生事件，之后的日常能体现变化。
- 用户不说话时可收到有具体缘由的主动内容；持续不回复会降频。
- 两个 bot 同时运行仍受同一用户的整体防打扰约束，生活记忆互不串线。
- 普通闲聊可为 1–4 条，长解释允许完整呈现，不重复逐句调用模型。
- 第二条发出前用户插话，旧第三条不会不经检查继续发出。
- 刷新、断线与重启不重复已发内容，未发草稿不混入已表达历史。
- 故事关闭、设定修改、bot 归档或遗忘来源后，相关待发内容失效。
- 文字顺序、通知数量和语音播放顺序一致。

以上是下一轮建议实施和验证的范围，本轮只完成调研及现有 47 项测试。
