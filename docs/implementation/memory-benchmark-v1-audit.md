# 记忆 benchmark 定义与 25 个未接受项复核

日期：2026-10-24。所有模型试验使用隔离合成资料；正式库、正式向量、正式服务开关均未改动。

**当前 benchmark 是工程代理编写的内部回归集，不是公开标准或经过独立标注验证的产品 benchmark。**我写题、静态参照和评分器，评审也使用同一提供方的模型；没有独立标注人或来自真实用户分布的抽样。因此它能定位工程问题，不能据此宣称 chatbot 的长期记忆准确率。此前“人工证明”应理解为代理编写的静态参照，不能称为独立人工金标。

原始 25/50 是严格流程的自动接受数，混合回答、引用、合成 JSON 合同和评审失败。对同一份原始答卷重评后，最终为 **39 通过、7 失败、4 待复核**。没有改写旧回答，也没有把待复核算通过。新生成答卷另记，不覆盖这个结果。

## 1 当前题集怎么定的

依据项目风险编写事实世界及问题，先固定事实和问题，再运行；每题用独立对话历史，直接插入确认记忆。自动提取和对话摘要关闭。50 题使用相同 DeepSeek Flash 配置，实验向量仅在临时库启用；36 题走 hybrid、14 题走 all。

| 题集 | 题数 | 测什么 |
| --- | ---: | --- |
| query-regression | 24 | 日常改写、称呼、他人属性、未知属性 |
| answer-boundaries | 12 | 日常属性与正式精确属性、部分已知、主体区别 |
| open-world | 3 | 没有记录不能推出不存在，相关能力不能互推 |
| positive-attributes | 3 | 给出额外明确证据后必须作肯定回答，避免一律弃答 |
| citation-generalization | 8 | 身份桥、非人物别名、并列事实和未知额外属性 |

50 行只有 **45 个不同问题字符串**；其中有意用同一问题配不同证据做正反对照，也有很多问法共享同一事实。它们不是 50 个独立用户或独立故事。旧 holdout 已反复看过，应归为回归集。新 12 题在本轮提示改动前固定，但作者仍相同，只称跨领域保留检查，不称外部独立留出集。

缺口包括真实对话自然提取、用户确认率、长期更新、跨数百轮演进、真实用户用语分布。单元和浏览器测试能验证相应工程合同，不能替代这些产品质量证据。

## 2 指标与门槛

| 层 | 定义 | 当前证据和限制 |
| --- | --- | --- |
| 资格／生命周期 | 未确认、遗忘、过期、域、版本、展示和取消是否遵守合同 | 领域／API／浏览器测试，非自然语言正确率 |
| 完整来源召回 | 已知题的全部必需来源是否真正交付到最终模型请求 | 188/188 题；74 未知题单列，不能理解成全部返回空 |
| 有序检索 Recall@5 | 只在有排序检索的已知题上，计算每题前五条覆盖必需来源的比例，再求平均 | 178 题；全量模式的10道已知题不冒充top5 |
| 回答语义 | 所问属性、主体、时间、范围、肯否与每个附带断言均有依据 | 模型评审仍需校准，不能将其 verdict 当客观真值 |
| 引用 | 每个断言有完整实际引用路径，每个引用确实用于回答；必要身份桥不可省 | 未交付、漏引、乱引和多属性均保留严格检查 |
| 合成协议 | JSON恰有answer/abstain/memoryIds，标记正确，原文原字段不修复 | 只是合成测试任务；普通产品聊天不要求输出这份JSON |
| 评审可靠性 | 正例不误拒，反例不误接，格式／证明失败单列 | 校准12例只是控制检查，不是统计验证的评审准确率 |
| 延迟和成本 | 来源读取、生成、评审分别记；推理预留计预算 | 不把评审的额外请求算作日常记忆检索延迟 |

旧字段 recallAt5 实际使用全部已交付条目，并只判断命中任一预期，在全量和多来源题上名称不准确。新报告使用 sourceHitRate、completeRecall 和仅对 rankedQuestions 计算的 rankedRecallAt5。完整来源 gate 不变；旧报告保留，不用新分母美化旧数字。

原严格 gate 仍要求全部案例通过；fail 与 review 都阻断。没有新增 85% 或 90% 门槛让新成绩变通过，也不拿语义分抵消协议或引用失败。产品上线门槛应建立在独立参照与代表性场景上，不能从这批成绩倒推及格线。

## 3 为什么从以前的数字变成25/50

1. 19/24 是字面命中与固定ID规则，不能正确识别全部同义表达及必要的额外引用；它和后来的语义检查不是同一指标。
2. 旧“语义42/42”路径曾按参照改未知标记、关闭引用检查；该路径已删除，不再作为验收成绩。
3. 42题与50题、重新采样与旧答卷重放不能直接作前后对比。
4. 恢复原始JSON后，三个答卷的额外type字段被发现。其中一条从已接受变失败，另两条原本已失败或待复核。严格重放由26降至25，不能据此说生成正确率下降。
5. 评审存在未知类型、身份、范围与证明结构错误，多阶段任何一步失败都会阻断，放大了评审问题。

对原25项的静态归因：**2个真实回答判断、3个引用问题、2个仅格式问题、13个评审误判、5个评审执行／证明失败**。额外type字段实际有3条，其中1条也有真实语义错误，不能重复计成第26题。原先把unknown-0和employee-id当作范围越界，是用了全库事实而非实际交付，现明确纠正。

## 4 原20条失败逐项复核

以下静态参照由本代理编写，未经独立人工复核，且不会传入模型或覆写自动结果。完整原回答、实际交付资料、原hash及当前结果见测试fixture和JSON汇总。

| 题集／题号 | 原问题与回答要点 | 根因 | 修复后的旧答卷结果 |
| --- | --- | --- |
| `query-regression.json / work-4` | 靠什么工作谋生？ → 资料里没有直接写明用户“靠什么谋生”。有一条记录说用户现在是陶瓷修复师、在博物馆修复陶瓷文物，这可能是收入来源，但记录没写是否以此谋生。 | 真实回答判断：把职业同义问法当作收入证明，过度弃答；原abstain保持true并判失败。 | fail：original_protocol_rejected |
| `query-regression.json / address-1` | 怎么称呼我比较合适？ → 叫你小栖最合适，你也说过不喜欢被叫老板。 | 评审误判：资料支持偏好称呼；覆盖评审又要求把“最合适”拆成新的独立个人属性。 | pass：strict_atomic_evidence_closure |
| `query-regression.json / address-3` | 我的昵称是什么？ → 你让我平时称呼你为小栖。 | 评审误判：原文和来源均表达用户要求平时这样称呼；focus未重复请求措辞被覆盖评审误当遗漏。 | pass：strict_atomic_evidence_closure |
| `query-regression.json / family-address-0` | 我姐姐想让别人怎么称呼她？ → 你姐姐希望别人称呼她为蓝老师。 | 真实引用：只回答姐姐的称呼，却附加未用于任何事实的职业引用。 | fail：citation_closure_mismatch |
| `query-regression.json / unknown-0` | 我的工号是多少？ → 我不知道你的工号——本轮提供的记忆里没有关于工号的记录，我只能看到几个合成角色的工作研究和散步偏好。 | 评审误判：上一轮用全库职业事实误判本轮范围；实际交付只有5条干扰资料。该原回答的范围概括有据，应修评审而非判为用户回答越界。 | review：missing_subject_bridge |
| `query-regression.json / unknown-1` | 你知道我公司的具体地址吗？ → 不知道。本轮没有你公司地址的相关记录。 | 评审误判：未知声明的subject是所问属性所属用户，不应被理解成用户自己不知道。 | pass：strict_atomic_evidence_closure |
| `query-regression.json / unknown-4` | 我入职的具体日期是哪天？ → 我这边没有你入职具体日期的记录，本轮记忆里也没有能支持的条目。 | 评审误判：把本轮无该属性记录的未知说明误判为必须另有主体的否定性事实。 | pass：strict_atomic_evidence_closure |
| `query-regression.json / unknown-5` | 鹦鹉的生日是哪天？ → 我查了当前提供的记忆，里面只记着用户养的鹦鹉叫松子，没有关于它生日的记录；所以鹦鹉生日是哪天，本轮记忆里未知。 | 评审误判：只记录鹦鹉名字在上下文指向该动物的相关资料，不是声称整份上下文没有其他记录；生日未知未越界。 | pass：strict_atomic_evidence_closure |
| `answer-boundaries.json / occupation-scope` | 说说我现在的职业和工作内容。 → 你是陶瓷修复师，在博物馆修复陶瓷文物。 | 仅合成格式：原JSON多出type字段；旧投影漏报，现从raw重建后严格失败。 | fail：original_protocol_rejected |
| `answer-boundaries.json / partial-title` | 我的工作做什么，正式合同职位名称也有记录吗？ → 你现在的职业是陶瓷修复师，在博物馆修复陶瓷文物。正式合同上的职位名称本轮没有已提供的记录，我不能确定。 | 评审误判：已分别回答职业已知与正式合同名未知；覆盖评审要求把无记录解释另拆为否定事实。 | review：incomplete_decomposition |
| `answer-boundaries.json / grade` | 我的正式职级是多少？ → 关于你的正式职级，本轮记忆里没有相关资料；现有的记录只提到你的职业是博物馆陶瓷修复师。 | 真实引用：回答附带职业事实却没有任何引用。 | fail：citation_closure_mismatch |
| `answer-boundaries.json / employee-id` | 我的工号是多少？ → 你的工号我这边没有记录，本轮记忆里只有一些合成角色的工作研究信息，没有你的工号。可以告诉我吗？ | 评审误判：上一轮同样误用全库信息。实际交付只有合成角色资料；未知工号和本轮范围说明成立。 | review：missing_subject_bridge |
| `answer-boundaries.json / company-address` | 我公司的完整地址是什么？ → 本轮提供的记忆里没有你公司地址的记录，所以我不知道完整地址是什么。 | 评审误判：把同一未知命题的无记录说明要求拆成新事实，并误解subject。 | pass：strict_atomic_evidence_closure |
| `answer-boundaries.json / legal-name` | 我证件上的姓名是什么？ → 这件事我这边没有记录，没法回答——记忆里没有你证件上的姓名。 | 评审误判：把助手承认未知的subject字段理解成用户行为，错误否定原文忠实性。 | pass：strict_atomic_evidence_closure |
| `open-world.json / sibling-coemployment` | 我姐姐是航天工程师，我也从事航天工程吗？ → 不知道。你姐姐是航天工程师这一点有记录，但你自己是否也从事航天工程，本轮记忆里没有相关信息。 | 仅合成格式：内容正确区分姐姐与用户，但原JSON多出type字段；严格协议失败，旧截断评审也保留。 | fail：original_protocol_rejected |
| `open-world.json / unrecorded-secondary-job` | 除了陶瓷修复，我还兼任讲师吗？ → 记忆里没有记载你兼任讲师这件事，只记录了你现在的职业是陶瓷修复师、在博物馆修复陶瓷文物。所以兼任讲师这一点，我这边没有依据。 | 评审误判：围绕职业资料的局部概括，后续明确讲师未知；不把只记录了当前职业扩大解释为全库无其他个人信息。 | pass：strict_atomic_evidence_closure |
| `open-world.json / adjacent-skill` | 我还会制作陶瓷吗？ → 会。你是陶瓷修复师，在博物馆修复陶瓷文物。 | 真实回答判断：从修复职业肯定制作技能，缺乏该技能证据；同时原JSON有额外type字段。 | fail：original_protocol_rejected |
| `positive-attributes.json / sibling-coemployment` | 我姐姐是航天工程师，我也从事航天工程吗？ → 是，记忆里有：你除陶瓷修复之外，也从事航天工程的兼职研究。 | 评审误判：同一引用可支持两项属性；盲评为背景选择另一来源后，原调度跳过已用于主结论的候选。已新增跨领域单元回归并补调度，但本次保留旧模型证明的失败，没有人工补路径或再采样追分。 | pass：strict_atomic_evidence_closure |
| `positive-attributes.json / unrecorded-secondary-job` | 除了陶瓷修复，我还兼任讲师吗？ → 是的，你兼任讲师，教授文物修复课程。 | 真实引用：讲师及授课资料足够；附加职业记录未支持额外回答属性。 | fail：citation_closure_mismatch |
| `citation-generalization.json / compound-relationship` | 我的合伙人住在哪里，有什么交流技能？ → 你的合伙人青岚住在里斯本，会手语。 | 评审误判：身份关系已由引用路径证明，覆盖评审又要求独立拆成一项身份事实；不覆写自动失败。 | pass：strict_atomic_evidence_closure |

## 5 原5条待复核逐项复核

| 题集／题号 | 原失败机制 | 修复后的旧答卷结果 |
| --- | --- | --- |
| `query-regression.json / unknown-3` | 来源核对解释承认姐姐职业有据，但主体证明的指称未统一，missing_subject_bridge；不是实际漏召回。 | pass：strict_atomic_evidence_closure |
| `answer-boundaries.json / formal-title` | 原回答不重采样；评审输出截断，保留待复核。 | pass：strict_atomic_evidence_closure |
| `citation-generalization.json / nonperson-location` | 非人物指称的subject路径未闭合，保留missing_subject_bridge而非认定模型回答错误。 | pass：strict_atomic_evidence_closure |
| `citation-generalization.json / nonperson-name` | 主体连接结构非法，保留invalid_subject_link，不自动补桥。 | review：missing_subject_bridge |
| `citation-generalization.json / parallel-entities` | 固定的有限结构修复后仍不符合证明合同，保持待复核。 | pass：strict_atomic_evidence_closure |

18项评审问题中，14项在最终旧答卷重放中恢复通过，4项仍待复核：unknown-0、employee-id、partial-title、nonperson-name。当前资料范围概括被误当个人属性集合、未知说明漏拆误判、指称路径未闭合仍会发生；不能将它们判作真实漏召回，也不能手工补证明凑通过。

## 6 本轮工程修复

- 未知声明不再把属性所属人当作“本人不知道”的认知行为；来源引导、当前资料范围及个人属性的合同进一步区分。
- 关系主体的完整解析与证明／覆盖使用同一值；代词先按回答中的明确称呼消歧，跨资料称呼必须有实际身份边。同位语必须消耗身份边，不能因职业或地点记录可用而漏掉姓名依据。
- 明确历史披露不存在不能借当前未知标记通过；必须有相应历史证据。范围语法检查不含题目实体或属性，保留引用、疑问、否定推断的反例回归。它是有限中文覆盖检查，不是通用语义真值。
- 覆盖阶段用温度0的非推理请求；推理调用若无任何可见判断且因输出容量耗尽，仅在同一两次上限内允许一次非推理恢复。有部分JSON或完整语义判定则不重试，截断结果绝不接受。
- 非法／不完整评审证明归为review，实际漏引、无据断言和协议错误归为fail；两者都阻断同一个gate。
- 合成输出合同明确三个键及最小充分引用；运行时提示保持通用规则，没有为职业、人物、技能问法新增分支或标准答案。
- 新增默认关闭的HARNESS_MEMORY_ANSWER_REASONING选项，显式开启且本轮使用合格记忆时才给聊天请求低档推理；在接受Run时捕获，预留4096 token先计预算，普通请求、提取和正式配置不被全局改变。参考来源与取舍记于独立ADR。

## 7 新答卷与真实聊天检查

| 批次 | 自动严格结果 | 解释 |
| --- | --- | --- |
| 原50条旧答卷，最终重放 | 39通过／7失败／4待复核 | 同一原文；7条真实／协议错误全部保留 |
| 新50条，隔离低档推理路径 | 43通过／5失败／2待复核 | 新采样，不是旧答卷被修成43；gate仍false |
| 保留12题，快速生成 | 6通过／5失败／1待复核 | 含真实引用问题及评审误判 |
| 同12题，低档推理 | 11通过／0失败／1待复核 | 原文正确但focus锚点校验失败的待复核仍不算通过 |
| 普通聊天，同12题，无向量、无JSON合同 | 12次完成，未给自动语义分 | 仍观察到无依据的能力评价与来源措辞，不宣称全文12/12准确 |

12题的系统提示hash相同，事实与问题相同；两次采样的原ID不同但映射可追踪。生成总耗时中位数约1.74秒与1.86秒，只是本机单次顺序试验，未随机交替、未重复估计；不能据此断言性能代价只有0.12秒或质量提升具有统计显著性。

新50条仍有5个真实拒绝项：unknown-4与hiring-date复述职业却漏引；sibling-coemployment把不同职业误当不能兼任；positive-attributes/unrecorded-secondary-job复述另一项职业却漏引；parallel-entities漏掉姓名身份依据。另有unknown-0和partial-title待复核。这些失败没有删除、重采样或手工改分。

普通聊天的unknown-extra还把“会装帧”说成“装帧做得好”，属于未经支持的能力评价；若干回答说“你之前提过”，而测试只写入了手工确认记录，无法证明原话来源。它们是需要继续处理的生成／来源表达边界。不会为了完成任务把这种输出当全文事实正确。

新校准v1为9/12，其中一题“几位角色”却仅一条资料有数量歧义；v1.1补第二条资料消歧，原题和原失败保留。v1.1为12/12，历史范围反例与身份漏引反例得到拒绝；v1.2又将wrong-person的可回答参照从朋友住址纠正为未知，原问题、被评回答、事实和预期fail均不变。对v1.1保存的证明严格重验仍为12/12，没有重新调用模型或修改原答卷；这不是新增一轮模型准确率。全部校准均由同一代理编写，不能推广为评审100%准确。

## 8 过拟合与后续benchmark要求

运行时没有出现测试姓名、书名、职业答案或题号，没有新加按问法返回答案的分支。现存query.ts仍只有职业和称呼两类人工词汇扩展，且是在已知漏题上开发；没有本轮新增主题词，也没有做新的消融证明，不能据这些题的召回推广为所有领域的语义能力。

下一版产品benchmark需要先定义代表性的故事／用户／时间线分组，再按组隔离开发和留出；同一事实的换问法不能分散到两边。参照应包含可接受语义、必要证据路径及禁止推断，由独立复核者确认；评审必须在正反校准集上测误接、误拒及失败率。提取确认、更新遗忘、长聊回问和普通聊天需各自单列。所有题集、模型、提示、预算、读取模式、评分版本和原输出先固定再测，不能看到43/50再改门槛或继续补同题词表。

## 9 验证与复现

类型检查、520项测试（35文件）及构建通过；记忆浏览器6/6。固定来源读取262次，其中188道已知题全部必需来源齐全；178道有序检索题的真实宏平均Recall@5为1，全量模式10道已知题不计入该指标。74道未知题只从来源召回分母排除，不代表返回空或回答正确。

没有重跑2.5万条完整性能压测；全套测试包含既有真实25000行的冷读／热扫描／取消／失效回归。本轮未改检索加载或扫描实现，不能把旧性能数据当新测量。

```sh
npm run verify
npm run test:memory:web
MEMORY_EVAL_OUT=test-results/replay npx tsx scripts/memory-answer-replay.ts --input test-results/memory-citation-final-capture/results.json --rejudge
MEMORY_EVAL_OUT=test-results/calibration npx tsx scripts/memory-citation-audit.ts --live --fixture tests/fixtures/memory-judge-calibration-v1.2.json
MEMORY_EVAL_OUT=test-results/prospective npx tsx scripts/memory-evaluate.ts --live --dataset acceptance-v1.json --independent --assert --grounded-reasoning
MEMORY_EVAL_OUT=test-results/plain npx tsx scripts/memory-answer-plain.ts --fixture tests/fixtures/memory-acceptance-v1.json --grounded-reasoning
```

--live、--rejudge和普通聊天捕获会调用远程模型，仅发送合成资料；--assert只验来源，不是回答通过。新推理选项没有写入env.local，也未迁移正式库或开启正式向量。

完整机器报告：`test-results/memory-benchmark-v1-audit-summary.json`。旧原文、静态逐题诊断、各阶段失败与不同版本校准均保留。
