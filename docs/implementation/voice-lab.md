# 四组语音对比调试页

用户试听后选择 **C：S2.1-Pro／原始语气**，现已作为聊天的默认 TTS 配置；保留同一音色和 HTTP Streaming。下文四组实验与原始测量保留用于复核。

入口：`http://127.0.0.1:4317/voice-lab`。聊天测试台的语音区也有独立页面入口。

本页固定使用「甜妹」／`shi9444woyi334390`，音色 ID `5b50d7ae59f24c0cb447599df8ae34ab`。同一句台词：

> 你回来啦，今天辛苦了。先歇一会儿吧，我在这里陪你，等你想说的时候，我们再慢慢聊。

| 组别 | 模型 | 唯一新增语气指令 | 实网首块 | 实网收齐 |
|---|---|---|---:|---:|
| A | S1 | 无 | 1622 ms | 3815 ms |
| B | S1 | `(soft tone)` | 849 ms | 3045 ms |
| C | S2.1-Pro | 无 | 505 ms | 3580 ms |
| D | S2.1-Pro | `[soft tone]` | 670 ms | 4077 ms |

以上是固定台词各一次的提供方 HTTP Streaming 实测，不是多轮性能统计；不能据此判断某组稳定更快。四份 MP3 均通过完整 ffmpeg 解码。试听自然度、甜软感和是否念出指令仍由用户听感验收。

共同设置：`latency: balanced`、`chunk_length: 100`、`temperature: 0.7`、`top_p: 0.7`、语速 1、音量增益 0、normalize true、MP3 128kbps。温柔指令按[官方情绪文档](https://docs.fish.audio/developer-guide/core-features/emotions)使用对应模型语法，其余参数依据[HTTP API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)。实验生成时未覆盖普通聊天配置；随后用户明确选择 C 组，已另行切换默认模型。

## 使用

- 四份真实样本已保存为明确的固定诊断音频，通过认证后可「试听已备样本」，无需再次合成。入口会验证实验正文、音色、组别、模型、指令和文件大小匹配。
- 「生成并试听」重新调用所选模型，MP3 使用同一 HTTP 流式后端、MediaSource 边接收边播放；不支持该格式时单请求收齐后播放。每组生成期间维持与聊天共用的单并发限制。
- 「生成四组，稍后试听」逐组生成并缓存在本页内存，然后分别点击重听。重听不再请求合成；重新生成会再次调用收费 API。失败不自动重试，认证前置失败可刷新令牌后重试一次。
- 「停止」中断当前生成、停止播放，未完成样本不保留；「清除本页音频」释放播放器和临时 URL。固定诊断文件仍留在后台报告目录，页面刷新可以再次读取；新生成的页面缓存刷新即清空。
- 「标记喜欢」只在本页标记，不自动更改任何角色、人格、聊天配置或记忆。
- 页面显示本轮收到首块、收齐和开始播放时间。批量静默生成不测开始播放时间；已备样本展示的是预生成实测记录。播放事件不等于硬件实际出声测量，也可能受浏览器权限影响。

## 工程与验证

仅允许四个服务器预设 ID，前端不能提交任意正文、模型或音色。沿用 cookie／CSRF／Host／Origin、防缓存、停止／关闭／服务退出取消与安全错误边界。API key 始终只在后台读取。调试页不读取私人聊天／记忆，也不创建 Agent Run。

语音预设：[speech-comparison.ts](../../src/speech-comparison.ts)；固定样本：[speech-samples.ts](../../src/speech-samples.ts)；页面：[voice-lab.html](../../web/voice-lab.html)。本轮 strict 检查、生产构建通过，单元／集成 **183／183**、浏览器 **22／22**；正式服务四份样本均返回 200，已有角色历史与聊天语音默认配置核对通过。机器汇总见[验收记录](../../data/reports/voice-lab-acceptance.json)。本轮自动验证证据见 [单元／集成](../../test-results/unit.json)、[浏览器](../../test-results/browser.json)，固定实网证据见 [报告](../../data/reports/voice-comparison/report.json)。新增覆盖四组参数、配置不变、鉴权与禁止任意覆盖、固定样本失配拒绝、真实浏览器提前播放、取消、重听不重复合成、错误不重试、兼容回退和播放权限。

`npm run smoke:speech-comparison` 可重新生成四个诊断样本，会调用四次真实 API，结果位于 `data/reports/voice-comparison/`。这些例外保存的固定语音没有私人对话，普通运行时聊天音频仍不落盘。
