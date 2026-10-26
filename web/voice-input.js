"use strict";

// One recording belongs to one page, bot and privacy epoch. Nothing is sent as chat here.
window.createVoiceInput = function ({ getContext, stopPlayback, appendText }) {
  const recordButton = document.getElementById("voice-record");
  const cancelButton = document.getElementById("voice-record-cancel");
  const status = document.getElementById("voice-input-status");
  let serial = 0,
    phase = "idle",
    stream = null,
    recorder = null,
    controller = null;
  let chunks = [],
    bytes = 0,
    timer = null,
    ticker = null,
    began = 0,
    context = null;
  let configured = false,
    maxSeconds = 60,
    maxBytes = 4 * 1024 * 1024;
  const supported = Boolean(
    navigator.mediaDevices?.getUserMedia && window.MediaRecorder,
  );
  const labels = {
    transcription_authentication_failed: "语音识别凭据未通过验证。",
    transcription_balance_insufficient: "语音识别账户余额不足。",
    transcription_rate_limited: "语音识别服务繁忙，请稍后再试。",
    transcription_busy: "上一段录音仍在处理，请稍后再试。",
    transcription_no_speech: "没有听清说话内容，请再试一次。",
    transcription_timeout: "识别等待超时，请重新录一段短一些的话。",
    transcription_key_missing: "尚未配置语音识别服务。",
    transcription_provider_unavailable: "暂时连接不上 Fish Audio，请稍后重试。",
    transcription_local_unavailable: "本地语音识别未能启动，请检查服务配置。",
    recording_invalid_audio: "这段录音无法识别，请重新录制。",
    recording_too_large: "录音太大，请缩短后重试。",
    recording_too_long: "录音超过一分钟，请分段录制。",
    transcription_text_too_long: "识别文字过长，请分段录制。",
    remote_disclosure_required: "请先确认页面的远程服务外发说明。",
    bot_archived: "这个角色已归档，请切换角色后再录音。",
  };
  function controls() {
    recordButton.textContent =
      phase === "recording"
        ? "结束录音"
        : phase === "permission"
          ? "等待麦克风…"
          : phase === "transcribing"
            ? "正在识别…"
            : "语音输入";
    recordButton.disabled =
      !supported || !configured || !["idle", "recording"].includes(phase);
    cancelButton.hidden = phase === "idle";
  }
  function stopTracks() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  function clearTimers() {
    clearTimeout(timer);
    clearInterval(ticker);
    timer = ticker = null;
  }
  function cancel(message = "已取消语音输入") {
    const active = phase !== "idle";
    serial++;
    controller?.abort();
    controller = null;
    if (recorder) {
      recorder.onstop = recorder.ondataavailable = recorder.onerror = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {}
      }
    }
    recorder = null;
    stopTracks();
    clearTimers();
    chunks = [];
    bytes = 0;
    phase = "idle";
    context = null;
    controls();
    if (active) status.textContent = message;
  }
  function current(c) {
    const now = getContext();
    return now && now.botId === c.botId && now.epoch === c.epoch && now.allowed;
  }
  async function encode(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  }
  async function transcribe(blob, token, c) {
    if (token !== serial || !current(c)) return;
    phase = "transcribing";
    controls();
    status.textContent = "正在转成文字，可随时取消…";
    const abort = new AbortController();
    controller = abort;
    const deadline = setTimeout(() => abort.abort("timeout"), 50000);
    try {
      const audio = await encode(blob);
      if (token !== serial || abort.signal.aborted || !current(c)) return;
      const response = await fetch("/v1/transcriptions", {
        method: "POST",
        credentials: "same-origin",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Local-Token": c.csrf,
          "X-Bot-Id": c.botId,
        },
        body: JSON.stringify({
          audio,
          mimeType: blob.type.split(";")[0].toLowerCase(),
          expectedEpoch: c.epoch,
        }),
      });
      const data = await response.json().catch(() => {
        throw new Error("语音识别暂时不可用，请稍后重试。");
      });
      if (token !== serial || abort.signal.aborted || !current(c)) return;
      if (!response.ok)
        throw new Error(
          labels[data.error] ??
            (response.status === 401 || response.status === 403
              ? "会话已更新，请刷新页面后重新录音。"
              : "语音识别暂时不可用，请稍后重试。"),
        );
      if (
        data.botId !== c.botId ||
        data.epoch !== c.epoch ||
        typeof data.text !== "string" ||
        !data.text.trim()
      )
        throw new Error("录音结果已失效，请重新录制。");
      appendText(data.text.trim());
      status.textContent = "已转成文字，可编辑后点发送。";
    } catch (error) {
      if (token !== serial) return;
      status.textContent = abort.signal.aborted
        ? "语音输入已停止，请重新录音。"
        : error instanceof TypeError
          ? "语音识别连接失败，请检查网络后重试。"
          : error instanceof Error
            ? error.message
            : "识别失败，请重试。";
    } finally {
      clearTimeout(deadline);
      if (token === serial) {
        controller = null;
        context = null;
        phase = "idle";
        controls();
      }
    }
  }
  function finish() {
    if (phase !== "recording" || !recorder) return;
    phase = "stopping";
    clearTimers();
    controls();
    try {
      recorder.stop();
    } catch {
      cancel("录音结束失败，请重试。");
    }
    stopTracks();
  }
  async function start() {
    const c = getContext();
    if (!c) {
      status.textContent = "请等待聊天连接后再录音。";
      return;
    }
    if (!c.allowed) {
      status.textContent = labels.remote_disclosure_required;
      return;
    }
    cancel();
    const token = serial;
    context = c;
    phase = "permission";
    controls();
    status.textContent = "请允许使用麦克风，开始后最多录制一分钟。";
    stopPlayback();
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (token !== serial || !current(c)) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/ogg;codecs=opus",
        "audio/webm",
      ].find((t) => MediaRecorder.isTypeSupported(t));
      recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined,
      );
      chunks = [];
      bytes = 0;
      const recording = recorder;
      recorder.ondataavailable = (event) => {
        if (token !== serial || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > maxBytes) {
          cancel(labels.recording_too_large);
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => cancel("麦克风录音失败，请检查设备后重试。");
      recorder.onstop = () => {
        stopTracks();
        clearTimers();
        if (token !== serial) return;
        const blob = new Blob(chunks, {
          type:
            recording.mimeType || mimeType || chunks[0]?.type || "audio/webm",
        });
        chunks = [];
        recorder = null;
        if (!blob.size) {
          cancel("没有录到声音，请重新录音。");
          return;
        }
        void transcribe(blob, token, c);
      };
      recorder.start(250);
      began = Date.now();
      phase = "recording";
      controls();
      status.textContent = "正在录音 · 0 秒，点击结束后转文字。";
      ticker = setInterval(() => {
        status.textContent = `正在录音 · ${Math.min(maxSeconds, Math.floor((Date.now() - began) / 1000))} 秒，点击结束后转文字。`;
      }, 250);
      timer = setTimeout(finish, maxSeconds * 1000);
    } catch (error) {
      if (token !== serial) return;
      const name = error?.name;
      cancel();
      status.textContent =
        name === "NotAllowedError" || name === "SecurityError"
          ? "麦克风权限未开启，请在浏览器中允许后重试。"
          : name === "NotFoundError"
            ? "没有找到麦克风，请连接设备后重试。"
            : name === "NotReadableError"
              ? "麦克风可能被其他程序占用，请检查后重试。"
              : "无法开始录音，请检查麦克风和浏览器支持。";
    }
  }
  recordButton.addEventListener("click", () => {
    if (phase === "recording") finish();
    else if (phase === "idle") void start();
  });
  cancelButton.addEventListener("click", () => cancel());
  controls();
  return {
    configure(settings) {
      configured = Boolean(settings?.configured);
      const help = document.getElementById("voice-input-help");
      if (help)
        help.textContent =
          settings?.remote === false
            ? "录音在本机转成文字，不上传语音服务，原录音不保存。文字可编辑，点发送后才进入聊天。"
            : "录音结束后会发给 Fish Audio 转文字，原录音不保存。文字可编辑，点发送后才进入聊天。";
      maxSeconds = settings?.maxSeconds ?? 60;
      maxBytes = settings?.maxBytes ?? maxBytes;
      controls();
      status.textContent = !supported
        ? "此浏览器不支持麦克风录音，请使用支持录音的浏览器。"
        : configured
          ? `${settings?.remote === false ? "本地识别已就绪。" : ""}点击语音输入开始录音，结束后可编辑再发送。`
          : "语音识别暂未配置，仍可输入文字。";
    },
    cancel,
    contextChanged() {
      if (context && !current(context))
        cancel("设置或来源已变化，语音输入已停止。");
    },
  };
};
