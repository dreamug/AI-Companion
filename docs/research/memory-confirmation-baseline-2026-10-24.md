# 记忆候选确认漏斗基线

日期：2026-10-24，Asia/Shanghai。状态：正式数据库的只读聚合快照，不是自然使用转化率实验。

## 1 结论

当前 6 个活跃角色库合计有 23 条待确认断言、0 条有效已确认断言。因此先补聊天内确认和可识别漏斗，再决定正式迁移和 E5 服务优先级。该快照支持识别产品风险，不能证明真实用户确认率为零，也不能代替 7 天自然使用观察。

## 2 采集范围与结果

根据 data/bots.json 的未归档角色选择现有数据库，不扫描 backups、实验临时库或已归档角色。SQLite 以 URI mode=ro 打开、设置 query_only，并在每个库的只读事务内聚合。不同库不是全局同时快照；只提取数值、状态、时间和来源资格，不选择、显示或外发对话／记忆正文，不实例化会 recover 的 Store，不做迁移或数据库写入。

| 指标                                      |   数值 | 口径                                                           |
| ----------------------------------------- | -----: | -------------------------------------------------------------- |
| 活跃角色数据库                            |      6 | 当前 manifest 中未归档且数据库存在                             |
| 保留的用户消息                            |     62 | role=user 且未删除                                             |
| 当前 assertion 记录                       |     23 | 包括所有现存状态，非全历史产量                                 |
| pending 断言                              |     23 | 当前 status=pending                                            |
| pending 且到期时间已过                    |      0 | 统计时刻 expiresAt≤now，非历史过期总量                         |
| active/confirmed 断言                     |      0 | 当前状态和 certainty 同时匹配                                  |
| 来源有效且当前生效的 confirmed 断言       |      0 | 上项加非空来源、source revision、删除与 validFrom/validTo 检查 |
| superseded、未确认且仍有 expiresAt 的断言 |      0 | 只是退出代理指标，不能据此判定退出原因                         |
| 当前 deleted 断言                         |      0 | 不代表过去从未遗忘或清理                                       |
| 现存 extract Job                          |     62 | 全部现存提取任务                                               |
| extract completed / failed                | 62 / 0 | 当前任务状态，不等于成功提取了多少候选                         |

最早保留用户消息为 2026-10-23 19:58:43，最晚为 2026-10-24 03:39:07；约 7 小时 40 分钟的记录跨度，不是 7 个自然日的持续观测。单用户开发库可能混有冒烟／合成记录，历史没有可靠 trafficOrigin，不得把这些记录全标为自然使用。

## 3 哪些指标目前算不出来

| 指标                   | 结果 | 原因                                                                         |
| ---------------------- | ---- | ---------------------------------------------------------------------------- |
| 自动候选历史生产量     | 未知 | 已确认候选的 manual 会变成 true；更正与删除可能覆盖原记录，origin 未独立保留 |
| 候选展示率             | 未知 | 没有候选卡片机会和实际展示回执                                               |
| 确认率及确认耗时       | 未知 | 没有稳定的候选 origin、confirmedAt 和 cohort 轨迹                            |
| 历史过期率／超量退出率 | 未知 | trimPending 都写 superseded，没有终态 reason                                 |
| 自然使用转化率         | 未知 | 缺 trafficOrigin，观察不足且单用户样本有限                                   |

不能用 `activeConfirmed / (activeConfirmed + pending)` 当作确认率，也不能把现存 pending 数当历史生产量。公开事件会截断、遗忘时会清空，且 memory.updated 未记录完整转换理由，不能补造生命周期。

## 4 重复核对方法

对 manifest 中每个活跃数据库，只执行下类元数据聚合并求和；不要打开 Store/Harness，不查询 content/text，也不在只读诊断中运行 tick 或 trimPending。

```sql
PRAGMA query_only = ON;
BEGIN;
SELECT json_extract(data, '$.status') AS status,
       json_extract(data, '$.certainty') AS certainty,
       COUNT(*) AS records
FROM memories
WHERE json_extract(data, '$.kind') = 'assertion'
GROUP BY status, certainty;

SELECT json_extract(data, '$.status') AS status, COUNT(*) AS jobs
FROM jobs
WHERE json_extract(data, '$.kind') = 'extract'
GROUP BY status;
ROLLBACK;
```

确认有效资格需额外用 json_each(sources) 按 scope 连接 sources，检查存在、未删除、revision 一致和当前有效期；计数前排除空来源。时间、待确认年龄只取整数元数据。更新报告须注明时刻、作用域选择和新旧快照差异，不能将多次累计数相加成独立用户样本。

## 5 接下来收集什么

按[工程方案 6.4–6.5](../engineering/memory-engineering-plan.md#64-聊天内确认是独立交付)实施聊天卡片和 lifecycleMetadata，先在旧 JSON 兼容字段中记录，不需要 v2 表。origin 不被 manual 覆盖；按候选记录 proposed、实际 offered、confirmed、discarded、expired、overflow、replaced、invalidated；自然／合成／未知流量分开。

7 天成熟 cohort 的转化、实际展示后的转化和无展示就到期的比例分别报告；不足 10 个实际展示的自然候选时，明确样本不足。产品门槛由这些结果决定，不以提高候选生产量或降低确认要求来制造向量需求。当前没有启用统计埋点、聊天卡片或定时观察任务，本次只完成了上述只读快照与方案修订。
