# 记忆检索实验

只使用本目录虚构数据。所有 Harness/SQLite fixture 使用系统临时目录或内存数据库，不连接 `data/companion.sqlite`，不读取真实 bot 记录。未改动正式检索流程。实验结论见 [最终方案](../../docs/research/vector-memory-decision.md)。

## 数据与协议

- `make-dataset.py` 生成固定的 71 条记录／128 个问题；按主题交替分为 calibration/test，数据哈希写入每份结果。
- 首轮比较真实 `Store.search`、DeepSeek 问题改写、E5 384 维、Qwen 256/512/1024 维，以及各自混合检索。改写器只得到问题，没有目标事实或答案。
- `evaluate.py` 先在 calibration 选择，序列化 `frozen-selection.json` 后才评价 test。原始自动选择是 Qwen 256 维＋0.3 阈值；test 暴露精确匹配退化，保留这一失败证据。
- 成本与效果比较后选择 E5，不硬切相似度；`make-challenge.py` 把候选决策写入 `final-candidate-before-challenge.json`，再生成 16 个新主题、48 个新问题。确认阶段不调模型／融合参数。
- `reader.ts` 以固定 DeepSeek 阅读提示词验证检索之后是否能据来源回答或弃答，输入包含当前问题的候选，没有期望答案，也不允许跨问题借用。每批 4 个问题，因此批延迟不等于实际单轮对话延迟。
- `audit.py` 保留原始分数和模型输出，另外发布透明复核：未出发的旅行可严格推出住宿为零；“先听你说”“暖一点的水”接受为正确同义表达；关键词“当天往返”的正确事实复述不强制包含“不喜欢”。未将自动字符串分数当作人工裁定。
- 9 个索引原型契约测试使用真实 Store/Harness，检查来源修订、确认状态、生效时间、更正、遗忘、跨角色、模型版本／维度、取消和失败回退。此原型没有接入生产。

## 重跑

从项目根目录运行。需要 Python 3.11、Torch 2.9.1、macOS MPS（也可 CPU，速度不同）、Node 24+。单独建立 `.venv-memory-lab`，依赖锁在 `requirements.txt`；当前使用 `--system-site-packages` 复用既有 Torch，没有修改全局包。

模型来自官方 Hugging Face 仓库，用 `huggingface_hub.snapshot_download` 下载以下固定 revision，仅保留 config、tokenizer、`model.safetensors`；不加载远程代码：

- `intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3`
- `Qwen/Qwen3-Embedding-0.6B@97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`

```sh
python3 scripts/memory-lab/make-dataset.py
npx tsx scripts/memory-lab/lexical.ts --rewrite
.venv-memory-lab/bin/python scripts/memory-lab/embeddings.py e5
.venv-memory-lab/bin/python scripts/memory-lab/embeddings.py qwen
.venv-memory-lab/bin/python scripts/memory-lab/evaluate.py
npx tsx scripts/memory-lab/reader.ts
npx tsx scripts/memory-lab/storage.ts
npx tsx scripts/memory-lab/storage.ts e5 384
```

`--rewrite` 和 reader 会调用 `env.local` 的 DeepSeek 配置，消耗服务额度，且只发送合成数据。缓存绑定数据哈希，可续跑；若要独立测新模型／提示词，应使用新的结果目录，不混用旧缓存。向量计算阶段设置离线环境变量，只加载本地下载的固定权重。

确认新主题：

```sh
python3 scripts/memory-lab/make-challenge.py
MEMORY_LAB_DATASET=scripts/memory-lab/dataset-challenge.json MEMORY_LAB_OUT=data/reports/memory-lab/challenge npx tsx scripts/memory-lab/lexical.ts
.venv-memory-lab/bin/python scripts/memory-lab/embeddings.py e5 scripts/memory-lab/dataset-challenge.json data/reports/memory-lab/challenge
.venv-memory-lab/bin/python scripts/memory-lab/embeddings.py qwen scripts/memory-lab/dataset-challenge.json data/reports/memory-lab/challenge
python3 scripts/memory-lab/confirm.py
MEMORY_LAB_DATASET=scripts/memory-lab/dataset-challenge.json MEMORY_LAB_OUT=data/reports/memory-lab/challenge MEMORY_LAB_METHODS=keyword,hybrid-e5-384,hybrid-qwen-512 npx tsx scripts/memory-lab/reader.ts
python3 scripts/memory-lab/audit.py
npx vitest run tests/memory-index-prototype.test.ts
```

结果保存在 `data/reports/memory-lab/`，已被仓库忽略。扩展测速使用 `sqlite-vec 0.1.9` 的官方 PyPI 二进制，由 Node `better-sqlite3` 加载；当前系统 Python sqlite3 未启用扩展加载。插入 vec0 主键需绑定 BigInt，否则 Node number 会被作为 REAL 拒绝。扩展只是实验依赖，不是正式应用依赖。

## 限制

额外对照：`npx tsx scripts/memory-lab/small.ts` 生成 10 条事实的独立样本并计算 2000 Token 预算；`.venv-memory-lab/bin/python scripts/memory-lab/long-memory.py` 比较长记忆头部／尾部事实的截断、固定窗口与保留句段三种策略。两项补充未更改先前的调参／验证数据。

这些是中文个人事实的合成检索与受控阅读实验，不是长期真实陪伴准确率。没有测试完整 persona＋聊天历史＋工具回合的回答、自动事实抽取、正式服务的长文引用、生产索引迁移或备份恢复；这些属于实现阶段验收。存储压力集重复并轻微扰动真实实验向量，仅用于性能，不能用来报告语义准确率。常驻扫描测量不包含模型编码、从 SQLite 加载、缓存校验或完整聊天时间。RSS 与 MPS allocated 不应直接相加。
