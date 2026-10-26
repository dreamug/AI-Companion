# 语音输入交付与验证

2026-10-23。已接入浏览器录音、本地 Whisper／Fish Audio ASR 与当前 bot 的输入框。当前电脑已改为本地 Whisper large-v3-turbo，绕开本机到 Fish Audio 的连接故障。正常录音不落盘、不进入聊天或记忆；识别文字先成为可编辑草稿，用户点发送后才进入现有聊天流程。

## 当前修复：本地识别

本机 HTTPS 直连与现有系统代理访问 Fish Audio 均在 TLS 阶段失败，其他服务仍可访问。没有修改系统代理、TLS 验证或凭据。复用本机已有的 Whisper MLX 模型缓存，安装项目内 `.venv-asr`；仅将语音输入切到本地，朗读配置不变。使用 MLX 官方维护的 Whisper 实现，支持本地模型目录：[官方说明](https://github.com/ml-explore/mlx-examples/tree/main/whisper)。

- 固定 5.72 秒中文 MP3 经真实本地模型识别成功，约 3.96 秒返回，识别到「你好呀，我是小野……」。
- 完整网页实测通过：固定合成音源经浏览器真实 MediaRecorder 产生录音，经实际本地模型返回草稿；不替换识别接口，也不写入聊天。
- 全项目 208 项单元／集成测试通过；浏览器回归 28 项通过，另有 1 项显式开启的真实本地识别测试通过。
- 本地 worker 通过管道接收音频，ffmpeg 在内存解码，最多解码 63 秒；拒绝超过 62 秒的输入，45 秒截止。取消／退出杀死包含解码子进程的进程组；限制输出体积，不记录 stderr 或原始异常。配置离线环境变量，识别不请求模型下载或远程服务。
- 本地识别不要求远程录音外发许可，仍校验会话、CSRF、角色和来源代数。识别文字点击发送后，继续按聊天原有的模型设置处理；“本地”只指语音转文字。

后台 `env.local` 配置（路径按部署环境填写）：

```dotenv
TRANSCRIPTION_MODE=local
LOCAL_ASR_PYTHON=/absolute/project/.venv-asr/bin/python
LOCAL_ASR_FFMPEG=/opt/homebrew/bin/ffmpeg
LOCAL_ASR_MODEL=/absolute/path/to/mlx-whisper-model
```

Apple Silicon 可使用 `python3 -m venv .venv-asr` 和 `.venv-asr/bin/python -m pip install -r requirements-asr.txt` 安装；当前机器使用系统依赖可见的隔离环境，已有 numpy、torch 等依赖未被修改。模型目录需包含 `config.json` 与 `weights.npz` 或 `weights.safetensors`。改成 `TRANSCRIPTION_MODE=fish` 并重启可选回 Fish Audio；没有自动把本地失败的录音转发给远程服务。

部署后正式接口识别 WebM 成功，约 3.43 秒返回；小野与小棠的消息、记忆、人格及来源代数均与更新前一致。当前网页已刷新并显示「本地识别已就绪」。

当前证据：[真实本地识别](../../data/reports/voice-input-local-live.json)、[真实网页识别](../../data/reports/voice-input-local-live-browser.json)、[浏览器回归](../../data/reports/voice-input-local-regression-browser.json)、[全项目单元](../../data/reports/voice-input-local-all-unit.json)、[部署及数据保留](../../data/reports/voice-input-local-upgrade.json)。下方保留首次 Fish 接入时的历史实测，不能当作当前运行后端。

## 使用方式

在聊天输入框下面点击「语音输入」，允许麦克风，讲话后点「结束录音」。识别完成可编辑文字，再点「发送」。支持随时取消，单次页面录音最多 60 秒；开始录音会停止当前朗读。

切换角色、离开页面、页面进入后台或来源遗忘会中止当前录音／识别；远程模式下撤回外发许可也会中止。识别返回时再次核对角色与来源代数。每个角色的未发送文字仍按原有标签会话草稿机制保存。

第一次使用麦克风需要用户在浏览器允许。网页没有自动打开麦克风，也没有新增持续监听、自动发送、语音唤醒或实时双向通话。

## 首次 Fish 接入实现（历史）

- 浏览器使用原生 MediaRecorder，优先 WebM/Opus，并按支持情况选择 MP4 或 Ogg。运行时检测录音能力，权限被拒或设备不可用时显示中文提示，文字输入继续可用。[MediaRecorder 格式检测](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static)
- 后台复用已有 Fish Audio 凭据，调用 `/v1/asr`，在请求头显式选择 `transcribe-1-pro`；二进制录音通过 multipart 转发，指定中文提示、关闭时间戳与音频事件标签。服务支持浏览器 WebM 等格式；响应中的说话人标记去除后形成草稿。[Fish Audio 官方协议](https://docs.fish.audio/api-reference/endpoint/openapi-v1/speech-to-text)
- 浏览器到本地的 JSON/base64 上限为 6 MiB 请求体、4 MiB 原音频；验证规范 base64、允许的媒体类型和文件头。识别响应大小、文本长度、等待时间有界；页面限制录音时长，提供方返回超过限制的时长也拒绝形成草稿。
- 识别 API 仍检查本地会话、CSRF、bot、当前来源代数及外发许可。每 bot 最多一个在途识别，整个进程最多两个；45 秒截止，收费调用不自动重试。停止、断开、归档或退出会取消等待，迟到文本不能跨角色写入。
- 原录音与识别响应只在内存处理，不写入消息、记忆、Trace、导出或备份。固定的虚构诊断样本例外保留；用户实际录音没有用于本轮测试。

## 首次 Fish 接入验证与外部限制（历史）

| 项目 | 结果 |
|---|---|
| 全项目类型检查、生产构建 | 通过 |
| 单元／集成 | 198 / 198，其中新增语音输入 15 项 |
| 完整浏览器回归 | 28 / 28，其中语音输入 6 项 |
| 浏览器真实录音器 | 使用假的麦克风音源，实际 MediaRecorder 产生 WebM，验证录音、转草稿、编辑发送、取消释放音轨、迟到返回、角色切换、拒绝授权及错误提示 |
| 真实 Fish Audio 首次固定样本 | 成功：5.72 秒中文固定 TTS 预览，约 3.40 秒返回正确文字 |
| 部署后真实接口复测 | 后续请求出现外部连接失败；当前不能宣称正式本地 API 到外部 ASR 持续可用 |
| 角色数据保留 | 两位角色的消息、记忆、人格和遗忘代数与升级前一致；识别测试未新增消息或记忆 |

新增单元测试覆盖 Multipart／模型请求头、错误归一、无自动重试、非法／超限录音、静音／异常响应、取消、不合作提供方、许可与来源变化、并发和归档取消。

首次实网成功返回「你好呀，我是小野，今天也会陪你聊聊天，一起把手边的事情慢慢做好。」。部署后复测时，匿名 HTTPS 请求也遇到连接超时或连接重置，其他服务的 HTTPS 仍可访问，问题发生在本机到 Fish Audio 的连接阶段。没有改变用户网络设置、关闭 TLS 验证或更换凭据。页面会保留原草稿并提示稍后重试；实际设备的麦克风权限、口音与噪声识别效果仍需用户使用验证。

机器证据：[全项目单元](../../data/reports/voice-input-all-unit.json)、[新增单元](../../data/reports/voice-input-unit.json)、[浏览器](../../data/reports/voice-input-browser.json)、[首次实网成功](../../data/reports/voice-input-live-first-success.json)、[后续直接调用](../../data/reports/voice-input-live.json)、[部署及本地 API](../../data/reports/voice-input-upgrade.json)、[WebM 复测](../../data/reports/voice-input-webm-live.json)。

可重跑：`npx tsx scripts/transcription-smoke.ts` 使用已有固定诊断 MP3，可能消耗提供方额度；`npx playwright test --config=playwright.voice-input.config.ts` 使用独立端口及假的麦克风音源，转写请求由测试替身处理，不外发测试麦克风内容。识别测试的成功不代表所有真实口音、噪声或网络条件均可靠。

工程适配沿用固定 Kimi 快照 `9e1248416faa22d9f0b777b91ad092bbf1e19182` 的生命周期不变量：资源随拥有者释放。Adapt 为页面录音／请求所属 bot 和 epoch，取消后再次核对提交资格；未引入其 DI 或会话框架。参考 `src/_base/di/lifecycle.ts` 与 `test/_base/di/scope-tree.test.ts`（均位于 `packages/agent-core-v2`）。
