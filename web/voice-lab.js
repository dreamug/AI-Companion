"use strict";
const $ = (id) => document.getElementById(id);
const records = new Map();
let config,
  csrf = "",
  busy = false,
  token = 0,
  controller = null,
  active = null;
const labels = {
  speech_busy: "聊天或另一页面正在生成语音，请稍后再试。",
  speech_authentication_failed: "Fish Audio 凭据未通过验证。",
  speech_balance_insufficient: "Fish Audio 余额不足。",
  speech_rate_limited: "Fish Audio 正在限流，请稍后手动重试。",
  speech_provider_unavailable: "Fish Audio 暂时不可用。",
  speech_source_invalidated: "本地状态已变化，请刷新本页后再试。",
  speech_timeout: "合成超时，请稍后手动重试。",
  speech_key_missing: "尚未配置 Fish Audio 后台密钥。",
};
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function json(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("本地服务连接失败，请刷新重试。");
  return response.json();
}
function controls() {
  $("generate-all").disabled = busy || !config?.configured;
  $("stop").disabled =
    !busy && ![...records.values()].some((r) => !r.audio.paused);
  for (const r of records.values()) {
    r.generate.disabled = busy || !config?.configured;
    r.replay.disabled = busy || !(r.cachedUrl || r.preparedUrl);
  }
}
function releaseSource(r) {
  r.audio.pause();
  r.audio.removeAttribute("src");
  r.audio.load();
  if (r.mediaUrl) URL.revokeObjectURL(r.mediaUrl);
  r.mediaUrl = null;
}
function stop(message = "已停止生成与播放；已完成的样本仍可重听。") {
  token++;
  controller?.abort();
  controller = null;
  if (active) {
    active.result.textContent = "生成已停止，不保留未完成音频";
    releaseSource(active);
  }
  active = null;
  for (const r of records.values()) r.audio.pause();
  busy = false;
  $("status").textContent = message;
  controls();
}
function waitEvent(target, name, signal, action) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(name, done);
      target.removeEventListener("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("音频解码失败，请手动重新生成。"));
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) return abort();
    target.addEventListener(name, done, { once: true });
    target.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    try {
      action();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
function timing(r) {
  const m = r.metrics;
  r.timing.textContent = `收到首块 ${m.first == null ? "—" : m.first + " ms"} · 开始播放 ${m.play == null ? "—" : m.play + " ms"} · 收齐 ${m.total == null ? "—" : m.total + " ms"} · ${m.chunks} 块`;
}
async function generate(r, autoplay, operation) {
  controller = new AbortController();
  const requestController = controller;
  const signal = controller.signal;
  active = r;
  releaseSource(r);
  if (r.cachedUrl) URL.revokeObjectURL(r.cachedUrl);
  r.cachedUrl = null;
  r.metrics = { first: null, play: null, total: null, chunks: 0 };
  r.started = performance.now();
  r.measurePlayback = autoplay;
  r.blocked = false;
  r.result.textContent = "正在请求语音…";
  timing(r);
  const request = () =>
    fetch("/v1/voice-comparison/speech", {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: { "Content-Type": "application/json", "X-Local-Token": csrf },
      body: JSON.stringify({
        variantId: r.variant.id,
        expectedEpoch: config.expectedEpoch,
      }),
    });
  try {
    let response = await request();
    if (response.status === 401 || response.status === 403) {
      csrf = (await json("/bootstrap")).csrfToken;
      if (signal.aborted || token !== operation) return;
      response = await request();
    }
    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        labels[error.error] || `合成失败（${error.error || response.status}）`,
      );
    }
    if (
      !response.body ||
      !/^audio\/mpeg(?:;|$)/i.test(response.headers.get("content-type") || "")
    )
      throw new Error("服务没有返回 MP3 音频。");
    const parts = [];
    let size = 0,
      complete = false,
      played = false;
    const reader = response.body.getReader();
    const streaming = window.MediaSource?.isTypeSupported("audio/mpeg");
    let media, buffer;
    const play = () => {
      if (!autoplay || played) return;
      played = true;
      void r.audio.play().catch((error) => {
        if (signal.aborted || token !== operation) return;
        if (error.name === "NotAllowedError") {
          r.blocked = true;
          r.result.textContent =
            "浏览器需要一次点击，请点击播放器；不会重复合成。";
        } else stop("音频播放失败，请手动重试。");
      });
    };
    try {
      if (streaming) {
        media = new MediaSource();
        r.mediaUrl = URL.createObjectURL(media);
        await waitEvent(media, "sourceopen", signal, () => {
          r.audio.src = r.mediaUrl;
        });
        buffer = media.addSourceBuffer("audio/mpeg");
      } else r.result.textContent = "兼容模式：收齐后播放，仍只请求一次合成。";
      while (true) {
        const part = await reader.read();
        if (signal.aborted || token !== operation) return;
        if (part.done) break;
        if (!part.value.byteLength) continue;
        size += part.value.byteLength;
        if (size > 10 * 1024 * 1024) throw new Error("音频超过大小限制。");
        r.metrics.first ??= Math.round(performance.now() - r.started);
        r.metrics.chunks++;
        parts.push(part.value);
        if (buffer)
          await waitEvent(buffer, "updateend", signal, () =>
            buffer.appendBuffer(part.value),
          );
        timing(r);
        if (buffer) play();
      }
      if (!size) throw new Error("服务返回了空音频。");
      if (media?.readyState === "open") media.endOfStream();
      r.cachedUrl = URL.createObjectURL(
        new Blob(parts, { type: "audio/mpeg" }),
      );
      if (!streaming) {
        r.audio.src = r.cachedUrl;
        played = false;
        play();
      }
      r.metrics.total = Math.round(performance.now() - r.started);
      timing(r);
      r.result.textContent = r.blocked
        ? "浏览器需要一次点击，请点击播放器；不会重复合成。"
        : autoplay
          ? "已接收完整音频，可以重听。"
          : "生成完成，点击重听即可试听。";
      r.generate.textContent = "重新生成（再次调用）";
      r.replay.textContent = "重听（不再合成）";
      complete = true;
    } finally {
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (signal.aborted || token !== operation) return;
    r.result.textContent = error.message || "合成失败，请手动重试。";
    releaseSource(r);
  } finally {
    if (controller === requestController) {
      controller = null;
      active = null;
    }
  }
}
async function run(variants, autoplay) {
  if (busy) return;
  stop(
    variants.length === 1
      ? "正在生成所选试听…"
      : "正在依次生成四组，生成后可分别重听。 ",
  );
  busy = true;
  const operation = token;
  controls();
  try {
    for (const r of variants) {
      if (token !== operation) return;
      await generate(r, autoplay, operation);
    }
  } finally {
    if (token === operation) {
      busy = false;
      controls();
      $("status").textContent =
        "本次生成已结束，各组结果见下方；选择只在本页标记。";
    }
  }
}
function render() {
  $("voice-identity").textContent =
    `${config.voiceName} · ${config.author} · HTTP Streaming · ${config.configured ? "已连接" : "未配置密钥"}`;
  $("sample-text").textContent = config.text;
  $("parameters").textContent = JSON.stringify(
    { voiceId: config.voiceId, ...config.parameters },
    null,
    2,
  );
  for (const variant of config.variants) {
    const card = element("article", "", "variant");
    card.dataset.variant = variant.id;
    card.append(
      element("h2", variant.name),
      element(
        "p",
        variant.cue ? `指令：${variant.cue}` : "不添加语气指令",
        "cue",
      ),
    );
    const actions = element("div", "", "actions");
    const generateButton = element("button", "生成并试听");
    const replay = element("button", "重听（不再合成）");
    const choose = element("button", "标记喜欢");
    choose.setAttribute("aria-pressed", "false");
    actions.append(generateButton, replay, choose);
    const audio = element("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.setAttribute("aria-label", `${variant.name}播放器`);
    const result = element("p", "尚未生成", "result");
    result.setAttribute("role", "status");
    const time = element("p", "", "timing");
    const r = {
      variant,
      card,
      audio,
      result,
      timing: time,
      generate: generateButton,
      replay,
      cachedUrl: null,
      mediaUrl: null,
      preparedUrl:
        config.preparedSamples?.find((s) => s.id === variant.id)?.url ?? null,
      metrics: {},
      started: 0,
    };
    if (r.preparedUrl) {
      replay.textContent = "试听已备样本";
      result.textContent = "已备好真实合成样本，试听无需再次生成。";
      const sample = config.preparedSamples.find((s) => s.id === variant.id);
      time.textContent = `预生成记录：首块 ${sample.firstChunkMs} ms · 收齐 ${sample.totalMs} ms`;
    }
    records.set(variant.id, r);
    generateButton.addEventListener("click", () => void run([r], true));
    replay.addEventListener("click", () => {
      stop(`重听 ${variant.name}，使用已生成音频。`);
      if (!(r.cachedUrl || r.preparedUrl)) return;
      releaseSource(r);
      r.measurePlayback = false;
      r.audio.src = r.cachedUrl || r.preparedUrl;
      void r.audio.play().catch(() => {
        r.result.textContent = "请点击播放器播放。";
      });
    });
    audio.addEventListener("play", () => {
      for (const other of records.values())
        if (other !== r) other.audio.pause();
      controls();
    });
    audio.addEventListener("playing", () => {
      if (r.measurePlayback && r.started && r.metrics.play == null) {
        r.metrics.play = Math.round(performance.now() - r.started);
        timing(r);
      }
      controls();
    });
    audio.addEventListener("pause", controls);
    audio.addEventListener("ended", controls);
    audio.addEventListener("error", () => {
      if (audio.getAttribute("src"))
        r.result.textContent = "音频解码失败，请手动重新生成。";
    });
    choose.addEventListener("click", () => {
      for (const other of records.values()) {
        const selected = other === r;
        other.card.classList.toggle("chosen", selected);
        other.card
          .querySelector("[aria-pressed]")
          .setAttribute("aria-pressed", String(selected));
      }
      $("preference").textContent =
        `已标记：${variant.name}。聊天配置保持原样，等你决定后再切换。`;
    });
    card.append(actions, audio, result, time);
    $("variants").append(card);
  }
  $("status").textContent = "准备好了，逐组生成并试听，或一次准备四组。";
  controls();
}
$("stop").addEventListener("click", () => stop());
$("generate-all").addEventListener(
  "click",
  () => void run([...records.values()], false),
);
$("clear").addEventListener("click", () => {
  stop("本页音频已清除。");
  for (const r of records.values()) {
    releaseSource(r);
    if (r.cachedUrl) URL.revokeObjectURL(r.cachedUrl);
    r.cachedUrl = null;
    r.result.textContent = "尚未生成";
    r.timing.textContent = "";
    r.generate.textContent = "生成并试听";
  }
  controls();
});
window.addEventListener("pagehide", () => {
  $("clear").click();
});
void (async () => {
  try {
    csrf = (await json("/bootstrap")).csrfToken;
    config = await json("/v1/voice-comparison");
    render();
  } catch (error) {
    $("status").textContent = error.message;
  }
})();
