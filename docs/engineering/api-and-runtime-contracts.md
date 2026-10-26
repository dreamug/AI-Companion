# 接口、模型适配与运行合同

v0.3 · 2026-10-23 · 开工前勘误后冻结。认知状态：设计合同，未实现；数字为初始参数或估算，非测试结果。M0期间登记[实现偏差](implementation-notes.md)，复盘统一修订。[权威规则](../../README.md#文档冻结与权威规则)区分领域意图、已实现接口与已启用验收。

## 1. 身份与授权上下文

每次命令在服务端解析出 principal、ownerUserId 和 relationshipId；Thread、Run、Job、来源、记忆、通知与内容型事件均归属于同一作用域。客户端可以指定待访问对象，但不能通过请求正文声称自己是另一个 owner。

M0 只从受保护的本地会话生成一个固定用户上下文，无需做多账号系统。Repository 的读写、缓存键、幂等键和后台任务从第一天接收明确作用域。角色模板身份与某个人的关系实例分开，禁止用 companionId 全局锁住未来所有用户。

工具只能使用 Run 的授权上下文，模型不能通过参数扩大 owner 或关系范围。未来对第二个真实账号开放前，必须完成服务端鉴权与跨用户隔离验收，不能把“传了 userId”当作鉴权。

## 2. 命令与回执

命令包含 schemaVersion、commandId、idempotencyKey、目标对象、payload，以及需要防止旧状态覆盖时的 expectedRevision。用户文本中的发生时间是业务数据，不替代服务端 receivedAt。

本节是逐步完成的目标。M0只对输入持久去重、通知attempt认领和破坏性／覆盖性编辑做必要修订检查，固定owner／关系上下文；不先实现通用命令总线、所有资源的幂等回执库或自动审批系统。

- 同一作用域、命令类别和幂等键，payload 相同则返回同一持久回执；payload 不同则返回冲突。
- 业务数据与接受命令后必须执行的工作同事务提交，才返回 accepted；accepted 仅代表已接收，不代表模型或外部投递完成。
- 生成请求在接受时分配 runId，允许处于 queued；M0 可由消息行表示待运行状态，M1 转为显式 runs／jobs 记录。
- expectedRevision 不匹配时拒绝旧配置／记忆更新，不静默覆盖当前状态。
- 控制命令幂等；取消提交是线性化点。已开始的外部发送只能报告 in-flight 和后续实际回执。

幂等不是无限期免费存储。公开服务前确定键保留期和过期错误，客户端不能在过期后假设旧请求一定可去重；首版不自动清理尚未结束或具有外部副作用的键。

## 3. 冻结的 HTTP v1 接口与M0两档范围

M0按两档交付。请求／响应做基础校验；凭据不放URL或日志。运行与投递查询合入快照，减少独立端点；不减少必要的删除和取消语义。

### 3.1 首周必须：正式API

| 方法与路径 | 首周行为 |
|---|---|
| POST `/v1/threads/{threadId}/inputs` | 输入落盘、去重，返回messageId／runId；Run状态可先存消息行 |
| POST `/v1/runs/{runId}/cancel` | 停止生成，拒绝迟到输出 |
| GET `/v1/relationships/{relationshipId}/snapshot` | 消息、Run、配置、有效摘要、跟进与投递状态；不含密钥 |
| GET `/v1/relationships/{relationshipId}/events` | SSE实时更新；M0重连读快照，不做历史cursor平台 |
| PATCH `/v1/relationships/{relationshipId}/settings` | 专注、免打扰、主动关心开关；覆盖性变更检查修订 |
| POST `/v1/deliveries/{deliveryId}/events` | 浏览器attempt认领与constructed／show／click／error回执，按attempt去重 |

最后一项是通知适配器的必要控制协议，不是曝光偏好问卷。页面先请求attempt，daemon重查边界并原子认领后才给短时许可；此时标attempt_started。响应丢失或页面随即关闭可进入unknown，不能把同一通知重新弹一次。已知离线／无权限时不认领。M0只启用一个投递页面，避免多标签重复通知。

### 3.2 可手工代替：本地维护表单

| 首周操作 | 手工做法与不能省略的约束 |
|---|---|
| 日摘要更正／删除、确认记忆置顶 | 显示源范围，手动改文本或选状态；检查revision，删除后留非内容型禁重建标记 |
| 遗忘 | 手选明确来源，提交后立即失效，增加遗忘代数、清除衍生摘要和待发正文，拒绝迟到计算 |
| 跟进创建／取消 | 手工填一次性时间／内容，保留occurrence身份；取消撤销未开始的attempt |
| 曝光与喜欢／打扰反馈 | 顺手记录，可跳过；不弹额外问卷催反馈 |

使用一个仅本地可用的`POST /local/v1/maintenance`提交上述有限action，复用同一领域用例、事务和版本检查。它不是通用表编辑器，不接受任意SQL，也不能修改安全策略或凭据。浏览器不直连SQLite；命令行维护若存在也调用同一用例。暂停后台后绕过检查改行仍不能证明“删除后不恢复”，因此不采用。

删除摘要只删除该派生物；“遗忘来源”才会使原始消息与其衍生内容不可访问。界面明确区分，不能用隐藏摘要代替遗忘。

### 3.3 后续正式接口

| 阶段 | 方法与路径 | 行为 |
|---|---|---|
| M1 | GET `/v1/runs/{runId}` | 独立运行状态与终态；事件端点增加持久cursor |
| M2 | POST `/v1/persona-revisions` | 用户发布人格，模型工具无此权限 |
| M3 | GET `/v1/memory`、POST `/v1/memory/corrections`、POST `/v1/memory/forget` | 完整检索、更正与遗忘API |
| M3 | POST `/v1/episodes/{episodeId}/corrections` | 正式摘要更正API |
| M4 | POST `/v1/follow-ups`、POST `/v1/follow-ups/{id}/cancel` | 跟进正式资源API |
| M4 | GET `/v1/deliveries/{deliveryId}`、POST `/v1/deliveries/{deliveryId}/feedback` | 独立查询与用户偏好反馈API |
| M3–M5 | POST `/v1/exports`、GET `/v1/exports/{exportId}` | 私有异步导出与状态 |
| M1–M5 | GET `/v1/runs/{runId}/trace`、GET `/v1/health` | 受保护诊断与分权健康查询 |
| 测试配置 | POST `/test/v1/scenarios` | 虚拟时钟／故障注入；真实模式不注册 |

自动记忆抽取、模型工具循环、复杂确认队列和完整故障注入平台均后置。M0共享用例边界，M1再完善基础设施；首周不需要完整runner或每日canary自动化。

通用错误至少区分 validation_failed、unauthorized、not_found、revision_conflict、idempotency_conflict、budget_exceeded、rate_limited、provider_unavailable 和 unsupported_capability。未来网页对无权访问的对象避免泄露是否存在。

队列满或预算不足应在可接受时尽早拒绝。接受之后发生的失败写入终态，不以一次 HTTP 200 代替完整执行结果。未启用的能力返回明确不可用，不提供假成功。

## 4. Run 与 Step 的唯一控制者

Run正常路径为queued → running → completed／cancelled／interrupted／failed；尚在queued时也可因取消或准入失败直接终止，记录原因。终态不可被迟到输出翻转。Run存配置、Persona／Safety修订、模型标识、源水位、取消代数和预算；Step归属于Run，不独立续命。

同一 relationshipId 同时最多一个前台生成 Run，用户输入优先于尚未开始的主动候选；控制命令独立于生成排队。后台记忆计算可并行，但写入要检查最新源修订和遗忘代数。

自有执行器执行：准入 → 构建上下文 → 一次模型 Step → 校验工具请求 → 授权与事务执行 → 根据剩余预算续步或终止。每个 SDK 请求、有限重试与工具调用都归入所属预算。默认不让 SDK 自动续跑并执行领域副作用。

进程退出时普通 Run 标记 interrupted，不盲目重放工具或模型。M0 的最低保护也包含取消后拒绝迟到写入；M1 再补完整运行与恢复记录。

## 5. Model Gateway 合同

| 对象 | 必须表达的内容 |
|---|---|
| ModelRequest | 自有消息／上下文块、工具声明、生成模式、受控提供方选项、deadline、abort signal、配置版本 |
| ModelEvent | 文本增量、完整工具请求、finish、usage、规范化 error；供应方流在适配器内解析 |
| ToolRequest | toolCallId、工具名、完整参数、所属 Run／Step；参数流片段不可执行 |
| ModelResult | 输出、真实工具请求与终态、模型响应标识、请求 ID（若有）、usage及未知字段 |
| CapabilityProfile | 已验证的文本流、JSON、工具、取消、usage与缓存字段；包含验证版本和日期 |

领域与前端均不导入 AI SDK 的消息、结果、工具或流事件类型。SDK／Provider 原始对象不进入权威数据表；为协议续接必须保留的提供方私有数据单独版本化、可清除并受同一作用域保护，不作为关系记忆或公开 Trace。

错误分类至少包含认证／配置错误、限流、临时连接失败、输出无效、提供方协议错误、取消与超时。只有尚无可见输出且没有领域副作用的暂时性错误允许 Gateway 有限重试；SDK 重试显式关闭。usage 缺失不是零费用。

AI SDK Provider 是首次实现，不是唯一合法实现。替换成假模型或另一适配器后，使用同一应用构造与领域测试；替换不要求重写 Persona、Memory、Concern 或 Delivery。

## 6. 工具请求与提交

参数格式通过后，还要验证当前权限、来源、对象归属、修订和预算。模型只能提出请求；Persona 发布、授权提升和实际外部投递不通过任意工具名开放。

工具调用去重键包括作用域、Run、toolCallId；同一调用不能因模型续步或客户端重连重复提交。跨 Run 的相似请求不自动视为相同操作；业务对象另有幂等身份和修订。

先提交真实工具结果，再允许模型续步。工具已成功但模型续步失败时，保留结果，不重做副作用。未知外部结果不能被投影成成功。

## 7. 公开事件与 Trace 分离

公开事件表达已提交的用户可见状态，例如 run.accepted、run.started、message.segment、message.completed、run.cancelled、run.failed、delivery.updated、memory.invalidated。诊断 Trace 表达检索候选、预算和排除理由，使用另一读取端点与权限。

事件信封至少包含 schemaVersion、eventId、streamId、单调递增的 seq、eventType、occurredAt、关联对象和 payload。owner 由授权上下文校验；seq 只在同一持久 stream 内排序，不依赖进程自增变量或跨机器墙上时钟。

M0 可从当前消息快照恢复，实时 SSE 为尽力通知，不承诺历史增量逐条重放。M1 增加 `stream_events`：分批正文／状态与对应公开事件在同一事务提交，再发布；Trace 事件不得充当该日志。SSE 重复投递由客户端去重，重连本身不启动 Run。

cursor 绑定授权 stream。落后于保留水位时明确返回 resync_required 和快照读取方式；客户端按快照水位恢复。先取得快照水位，再补之后事件，避免订阅竞争漏消息。水位过期再次同步，不伪造缺失内容。

公开事件默认不含实际模型上下文、完整候选记忆、私有工具参数或推理数据。诊断内容可按本地用户权限展开，默认折叠；未来普通网页无调试权限。

包含正文的 stream_events 同样属于可清除数据。遗忘时删除／清除关联 payload，并使受影响的旧 cursor 转为 resync_required，通知在线客户端清除失效内容。不得为了续传而永久保留已遗忘原文；无法撤回已被用户下载的副本时如实说明范围。

## 8. 断线、曝光和投递

浏览器断线只影响连接；后台根据既有授权完成有界运行。重连读取已提交结果，显式停止才改变 Run 资格。慢客户端设置有界缓冲，落后则断开并要求续传，不无限占用内存。

对话展示和通知回执都必须分层：应用提交、渠道接受、客户端报告已展示、点击、明确曝光反馈、回应。浏览器报告可见不等于证明用户读懂，未收到回执记录 unknown。没有回应不自动视为拒绝或关系变化。

DeliveryPort表达能力、渠道在线／可用状态、attempt、取消请求、查询与回执。首周浏览器页已知离线／权限拒绝记unavailable＋not_attempted；连接证据不足为channel_unknown。创建或show成功之后实际曝光仍可unknown，onclick只记点击；系统静默压制不可由未点击推断。页面回来只读站内消息，不补弹旧通知。Outbox唯一不等于外部exactly-once，未来Web Push单独验证。

## 9. 版本、验证和实施顺序

API 主版本、事件 Schema、持久数据 Migration、Persona／Safety 和模型配置分别编号。跨版本不兼容时明确拒绝或迁移，不能静默重解释旧记录。未来共享 TS 类型仍须校验不可信网络输入。

M0只实现第3.1节正式端点和第3.2节轻量维护；M1补持久运行、完整幂等和事件续传，M2–M4再开放正式领域资源API。M5完成已启用合同。冻结期间实现路径变化记入偏差表，不能以代码碰巧能调用扩大M0验收范围。
