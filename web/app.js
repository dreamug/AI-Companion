"use strict";
const $ = (id) => document.getElementById(id);
const state = {
  candidateCommands: new Map(),
  candidateBusy: new Set(),
  candidateExposures: new Set(),
  candidateObserver: null,
  snapshot: null,
  botId: new URLSearchParams(location.search).get("bot") || "xiaoye",
  bots: [],
  minimumEpoch: 0,
  privacyVersion: 0,
  refreshVersion: 0,
  activeNotifications: new Map(),
  csrf: "",
  relationshipId: "",
  threadId: "",
  events: null,
  refreshTimer: null,
  reconnectTimer: null,
  pendingInput: null,
  clientId: crypto.randomUUID(),
  liveSince: Date.now(),
  tab: "memory",
  editorSubmit: null,
  renderedPersona: 0,
  renderedSettings: 0,
  traceRun: "",
  notified: new Set(),
  displayed: new Map(),
  voice: null,
  voiceInputConfigured: false,
  voiceInputRemote: true,
  voiceSerial: 0,
  voiceController: null,
  voiceUrl: null,
  voiceTarget: null,
  voiceAutoSince: 0,
  voiceSeen: new Set(),
  voiceQueue: [],
  voiceSuppressedRuns: new Set(),
};
const labels = {
  queued: "等待中",
  running: "正在回复",
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "已中断",
  failed: "失败",
  pending: "待处理",
  active: "有效",
  superseded: "已失效",
  ready: "留在站内",
  attempt_started: "已开始尝试",
  constructed: "浏览器已创建",
  unknown: "结果未知",
  error: "投递错误",
  expired: "已过期",
  resolved: "已解决",
  skipped: "已跳过",
  generating: "生成草稿",
  confirmed: "已确认",
  stated: "用户陈述",
  inferred: "待确认推测",
  disputed: "存在冲突",
  offline: "页面离线",
  online: "渠道在线",
  permission_denied: "通知权限被拒",
  unsupported: "浏览器不支持",
  channel_unknown: "渠道状态未知",
};
function node(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onClick") n.addEventListener("click", () => safely(v));
    else if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat())
    if (c !== null && c !== undefined)
      n.append(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}
function btn(text, fn) {
  return node("button", { type: "button", text, onClick: fn });
}
function showError(error) {
  $("error").hidden = false;
  $("error").textContent =
    error instanceof Error ? error.message : String(error);
}
async function safely(fn) {
  try {
    $("error").hidden = true;
    return await fn();
  } catch (e) {
    showError(e);
  }
}
const errorLabels = {
  bot_not_found: "这个角色不存在，请切换到其他角色。",
  bot_archived: "这个角色已归档，可切换角色或从归档列表恢复。",
  original_bot_protected: "原来的小野会一直保留，不能归档。",
  bot_busy: "角色正在结束运行，请稍后重试。",
  bot_limit: "当前最多保留24个角色（含归档角色）。",
  candidate_unavailable: "这条候选已失效，请刷新后查看。",
  idempotency_conflict: "操作内容已变化，请刷新后重新处理。",
  speech_key_missing: "尚未配置 Fish Audio 后台密钥。",
  speech_authentication_failed: "Fish Audio 凭据未通过验证。",
  speech_balance_insufficient: "Fish Audio 账户余额不足。",
  speech_rate_limited: "Fish Audio 正在限流，请稍后手动重试。",
  speech_provider_unavailable: "Fish Audio 暂时不可用，请稍后手动重试。",
  speech_busy: "上一段语音仍在结束，请稍后重试。",
  speech_source_invalidated: "这条内容已变化或被遗忘，请刷新后重试。",
  speech_text_too_long: "这段回复超过单次朗读的 4000 字上限。",
  speech_cancelled: "语音已取消。",
  speech_timeout: "语音生成超时，请稍后手动重试。",
  remote_disclosure_required: "请先阅读并确认远程模型外发范围。",
  memory_reply_contract_failed: "这次回复没能完成，你可以重新发送。",
  provider_authentication_failed:
    "模型凭据未通过验证，请在人格 → 运行设置中检查对应服务商的 Key。",
  provider_balance_insufficient: "模型账户余额不足。",
  provider_rate_limited: "提供方正在限流，稍后再试。",
  model_key_missing: "尚未配置所选服务商的 Key，请在人格 → 运行设置中填写。",
  model_credentials_invalid: "本地模型密钥文件无法读取，请检查文件格式。",
  revision_conflict: "状态刚刚发生变化，请刷新后重试。",
  follow_up_terminal: "这条跟进已结束或失效，需要重新建立。",
  tool_call_conflict: "模型重复使用了不同参数的工具请求，本轮已停止。",
  budget_exceeded: "今天的模型预算已用完，可在运行设置中调整。",
  channel_unavailable: "通知渠道当前不可用。",
  in_app_only: "这条消息只保留在站内，不再补弹通知。",
  input_revoked: "这次输入已因遗忘失效，请使用新消息。",
};
async function api(path, method = "GET", body, retried = false) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Bot-Id": state.botId,
      ...(["GET", "HEAD"].includes(method)
        ? {}
        : { "X-Local-Token": state.csrf }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (
    !retried &&
    path !== "/bootstrap" &&
    (response.status === 401 || data.error === "csrf_required")
  ) {
    const boot = await api("/bootstrap");
    state.csrf = boot.csrfToken;
    return api(path, method, body, true);
  }
  if (!response.ok)
    throw new Error(
      errorLabels[data.error] || data.error || `请求失败（${response.status}）`,
    );
  return data;
}
function time(at) {
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}
function short(id) {
  return id.slice(0, 8);
}
function stopSpeech(status = "已停止朗读", preserveQueue = false) {
  if (!preserveQueue) state.voiceQueue = [];
  state.voiceSerial++;
  state.voiceController?.abort();
  state.voiceController = null;
  state.voiceTarget = null;
  const player = $("voice-player");
  player.pause();
  player.removeAttribute("src");
  player.load();
  player.hidden = true;
  if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  state.voiceUrl = null;
  $("voice-stop").disabled = true;
  $("voice-status").textContent = status;
}
// Register before changing src/appending: these events can arrive immediately.
function mediaEvent(target, name, signal, action) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(name, done);
      target.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("音频解码失败，请重新朗读"));
    };
    const aborted = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) return aborted();
    target.addEventListener(name, done, { once: true });
    target.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    try {
      action();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
async function playSpeech(kind, id, revision, fromQueue = false) {
  if (!state.snapshot) return;
  stopSpeech("正在生成语音…", fromQueue);
  const serial = state.voiceSerial,
    epoch = state.snapshot.settings.epoch;
  const controller = new AbortController();
  state.voiceController = controller;
  const item = (
    kind === "message" ? state.snapshot.messages : state.snapshot.deliveries
  ).find((m) => m.id === id);
  state.voiceTarget = {
    kind,
    id,
    revision,
    epoch,
    text: item?.content ?? item?.text,
    queued: fromQueue,
  };
  $("voice-stop").disabled = false;
  try {
    const request = () =>
      fetch("/v1/speech", {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Local-Token": state.csrf,
          "X-Bot-Id": state.botId,
        },
        body: JSON.stringify({
          kind,
          id,
          expectedEpoch: epoch,
          expectedRevision: revision,
        }),
      });
    let response = await request();
    if (response.status === 401 || response.status === 403) {
      const boot = await api("/bootstrap");
      state.csrf = boot.csrfToken;
      if (controller.signal.aborted || serial !== state.voiceSerial) return;
      response = await request();
    }
    if (!response.ok) {
      const data = await response.json();
      throw new Error(errorLabels[data.error] || data.error || "语音生成失败");
    }
    if (
      !/^audio\/mpeg(?:;|$)/i.test(
        response.headers.get("content-type") || "",
      ) ||
      !response.body
    )
      throw new Error("语音服务没有返回可播放音频");
    const current = () =>
      serial === state.voiceSerial &&
      !controller.signal.aborted &&
      state.snapshot?.settings.epoch === epoch;
    if (!current()) return;
    const player = $("voice-player");
    const startPlayback = () => {
      void player.play().catch((error) => {
        if (!current()) return;
        if (error.name === "NotAllowedError") {
          $("voice-status").textContent =
            "浏览器需要一次点击，请点击播放器播放；自动朗读仍已开启。";
        } else {
          stopSpeech("音频播放失败，请重新朗读");
          showError(error);
        }
      });
    };
    const reader = response.body.getReader();
    let complete = false,
      total = 0;
    try {
      if (window.MediaSource?.isTypeSupported("audio/mpeg")) {
        const media = new MediaSource();
        state.voiceUrl = URL.createObjectURL(media);
        await mediaEvent(media, "sourceopen", controller.signal, () => {
          player.src = state.voiceUrl;
          player.hidden = false;
        });
        const buffer = media.addSourceBuffer("audio/mpeg");
        let playing = false;
        while (true) {
          const part = await reader.read();
          if (!current()) return;
          if (part.done) break;
          total += part.value.byteLength;
          if (total > 10 * 1024 * 1024) throw new Error("语音音频超过大小限制");
          if (!part.value.byteLength) continue;
          await mediaEvent(buffer, "updateend", controller.signal, () =>
            buffer.appendBuffer(part.value),
          );
          if (!playing) {
            playing = true;
            startPlayback();
          }
        }
        if (!total) throw new Error("语音服务返回了空音频");
        if (media.readyState === "open") media.endOfStream();
      } else {
        // Browsers without MP3 MediaSource support keep the same request and
        // fall back to a bounded in-memory file; never issue another synthesis.
        $("voice-status").textContent = "此浏览器使用兼容播放，正在接收语音…";
        const parts = [];
        while (true) {
          const part = await reader.read();
          if (!current()) return;
          if (part.done) break;
          total += part.value.byteLength;
          if (total > 10 * 1024 * 1024) throw new Error("语音音频超过大小限制");
          parts.push(part.value);
        }
        if (!total) throw new Error("语音服务返回了空音频");
        state.voiceUrl = URL.createObjectURL(
          new Blob(parts, { type: "audio/mpeg" }),
        );
        player.src = state.voiceUrl;
        player.hidden = false;
        startPlayback();
      }
      complete = true;
    } finally {
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (serial !== state.voiceSerial || controller.signal.aborted) return;
    stopSpeech(error.message || "语音生成失败");
    showError(error);
  }
}
function playNextSpeech() {
  if (state.voiceTarget || !state.voiceAutoSince || !state.snapshot) return;
  const next = state.voiceQueue.shift();
  if (!next) return;
  void playSpeech("message", next.id, next.revision, true);
}
function refreshSpeech(s) {
  const newestRun = s.runs[0]?.id;
  state.voiceQueue = state.voiceQueue.filter(
    (m) =>
      m.runId === newestRun &&
      !state.voiceSuppressedRuns.has(m.runId) &&
      !["cancelled", "interrupted", "failed"].includes(
        s.runs.find((r) => r.id === m.runId)?.status,
      ) &&
      s.messages.some((current) => current.id === m.id && !current.deleted),
  );
  if (state.voiceTarget && state.voiceTarget.kind !== "preview") {
    const target = state.voiceTarget;
    const item = (target.kind === "message" ? s.messages : s.deliveries).find(
      (m) => m.id === target.id,
    );
    if (
      !item ||
      (item.content ?? item.text) !== target.text ||
      target.epoch !== s.settings.epoch ||
      item.deleted ||
      (target.queued &&
        item.replyIndex !== undefined &&
        (item.runId !== newestRun ||
          s.runs.find((r) => r.id === item.runId)?.status === "cancelled")) ||
      ["cancelled", "expired"].includes(item.status)
    )
      stopSpeech("来源已变化，停止朗读");
  }
  for (const m of s.messages) {
    if (
      m.role !== "assistant" ||
      m.status !== "completed" ||
      state.voiceSeen.has(m.id)
    )
      continue;
    state.voiceSeen.add(m.id);
    if (state.voiceSeen.size > 1000)
      state.voiceSeen.delete(state.voiceSeen.values().next().value);
    if (
      state.voiceAutoSince &&
      m.createdAt >= state.voiceAutoSince &&
      m.runId === newestRun &&
      Date.now() - m.createdAt < 120000
    ) {
      const run = s.runs.find((r) => r.id === m.runId);
      if (m.replyIndex !== undefined) {
        if (
          !state.voiceSuppressedRuns.has(m.runId) &&
          !["cancelled", "interrupted", "failed"].includes(run?.status)
        )
          state.voiceQueue.push(m);
      } else void playSpeech("message", m.id, m.revision);
    }
  }
  playNextSpeech();
}
function clearSensitiveViews(epoch = state.minimumEpoch) {
  voiceInput.cancel("来源已变化，语音输入已停止。");
  stopSpeech(state.minimumEpoch ? "已同步来源变化，旧语音已清理" : "尚未播放");
  state.minimumEpoch = Math.max(state.minimumEpoch, epoch);
  state.privacyVersion++;
  state.refreshVersion++;
  state.snapshot = null;
  state.traceRun = "";
  state.editorSubmit = null;
  state.displayed.clear();
  state.candidateCommands.clear();
  state.candidateBusy.clear();
  state.candidateExposures.clear();
  state.candidateObserver?.disconnect();
  state.notified.clear();
  for (const notification of state.activeNotifications.values())
    notification.close();
  state.activeNotifications.clear();
  for (const id of [
    "trace-content",
    "editor-fields",
    "messages",
    "memory-candidate",
    "memory-result",
    "conversation-summary-list",
    "memory-list",
    "followup-list",
    "series-list",
    "delivery-list",
    "maintenance-result",
    "jobs",
    "trace-run",
  ])
    $(id).replaceChildren();
  $("editor").close();
  $("memory-search").value = "";
}
async function refresh() {
  const version = ++state.refreshVersion;
  const next = await api(`/v1/relationships/${state.relationshipId}/snapshot`);
  if (
    version !== state.refreshVersion ||
    next.settings.epoch < state.minimumEpoch
  )
    return;
  if (next.settings.epoch > state.minimumEpoch)
    clearSensitiveViews(next.settings.epoch);
  state.snapshot = next;
  voiceInput.contextChanged();
  render();
}
function requestRefresh() {
  if (!state.refreshTimer)
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void safely(refresh);
    }, 70);
}
function permission() {
  return "Notification" in window ? Notification.permission : "unsupported";
}
async function heartbeat() {
  return api("/v1/channel", "POST", {
    clientId: state.clientId,
    permission: permission(),
  });
}
function connect(cursor) {
  state.events?.close();
  const stream = new EventSource(
    `/v1/relationships/${state.relationshipId}/events?botId=${encodeURIComponent(state.botId)}&cursor=${encodeURIComponent(cursor)}`,
  );
  state.events = stream;
  stream.onopen = () => {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.liveSince = Date.now();
    $("connection").textContent = "本地已连接 · 请保持标签常驻";
    void safely(heartbeat);
  };
  stream.onerror = () => {
    $("connection").textContent = "连接中断，正在重连；不会重新生成对话";
    if (!state.reconnectTimer)
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        void connectAfterSnapshot();
      }, 1500);
  };
  stream.addEventListener("update", (event) => {
    const data = JSON.parse(event.data);
    requestRefresh();
    if (data.type === "delivery.ready" && data.at >= state.liveSince - 250)
      void safely(() => notifyDelivery(data.payload.deliveryId));
    if (data.type === "memory.invalidated") {
      clearSensitiveViews(
        Number(event.lastEventId.split(":")[0]) || state.minimumEpoch,
      );
      void connectAfterSnapshot();
    }
  });
  stream.addEventListener("resync", (event) => {
    clearSensitiveViews(JSON.parse(event.data).epoch || state.minimumEpoch);
    void connectAfterSnapshot();
  });
}
async function connectAfterSnapshot() {
  await safely(async () => {
    await refresh();
    if (state.snapshot) connect(state.snapshot.cursor);
  });
}
async function notifyDelivery(id) {
  const privacyVersion = state.privacyVersion;
  if (state.notified.has(id) || permission() !== "granted") return;
  state.notified.add(id);
  await heartbeat();
  let permit;
  try {
    permit = await api(`/v1/deliveries/${id}/events`, "POST", {
      event: "attempt",
      clientId: state.clientId,
    });
  } catch (e) {
    if (
      [
        "这条消息只保留在站内，不再补弹通知。",
        "delivery_already_attempted",
      ].includes(e.message)
    )
      return;
    throw e;
  }
  if (
    Date.now() > permit.permitUntil ||
    privacyVersion !== state.privacyVersion ||
    !state.snapshot
  )
    return;
  let notification;
  const receipt = (event) =>
    api(`/v1/deliveries/${id}/events`, "POST", {
      event,
      clientId: state.clientId,
      attemptId: permit.attemptId,
    }).catch(() => {});
  try {
    notification = new Notification(state.snapshot.settings.persona.name, {
      body: permit.text,
      tag: `companion-${id}`,
    });
    state.activeNotifications.set(id, notification);
    notification.onclose = () => state.activeNotifications.delete(id);
    notification.onshow = () => void receipt("show");
    notification.onclick = () => {
      window.focus();
      setTab("followups");
      void receipt("click");
      notification.close();
    };
    notification.onerror = () => void receipt("error");
    await receipt("constructed");
  } catch {
    await receipt("error");
  }
}
function setTab(tab) {
  state.tab = tab;
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === tab)),
    );
  for (const id of ["memory", "followups", "persona", "trace"])
    $(`tab-${id}`).hidden = id !== tab;
  renderPanels();
}
function renderRunStatus(s) {
  if (!s) return;
  const active =
    s.runs.find((r) => r.status === "running") ||
    s.runs.find((r) => r.status === "queued");
  const visible =
    active &&
    s.messages.some(
      (m) => m.runId === active.id && m.role === "assistant" && m.content,
    );
  const elapsed = active ? Date.now() - active.createdAt : 0;
  const value = active
    ? s.companionMemory
      ? window.companionRunStatus(active, s.settings.persona.name, Date.now())
      : active.config.replyPhase === "sending"
        ? `${s.settings.persona.name}正在输入… · 已发送 ${active.config.replySent} / ${active.config.replyCount}`
        : active.status === "running" && !visible && elapsed >= 8000
          ? "这次回复有点慢，你可以继续等待或停止。"
          : active.status === "running" && !visible && elapsed >= 800
            ? `${s.settings.persona.name}正在输入…`
            : `${labels[active.status]} · ${short(active.id)}`
    : s.runs[0]
      ? `${labels[s.runs[0].status]}${s.runs[0].reason ? " · " + (errorLabels[s.runs[0].reason] || s.runs[0].reason) : ""}`
      : "还没有对话";
  if ($("run-status").textContent !== value)
    $("run-status").textContent = value;
}
setInterval(() => {
  if (document.visibilityState === "visible") renderRunStatus(state.snapshot);
}, 250);
function render() {
  const s = state.snapshot;
  if (!s) return;
  $("model-status").textContent =
    `${s.model.adapter === "mock" ? "本地测试模型" : s.model.model}${s.model.configured ? "" : " · 未配置 Key"} · 人格 v${s.settings.personaRevision}`;
  $("disclosure").hidden =
    s.settings.remoteDisclosureAcknowledged ||
    (s.model.adapter === "mock" &&
      !(state.voiceInputConfigured && state.voiceInputRemote));
  $("model-review").hidden = !s.settings.modelReview;
  $("model-review-text").textContent = s.settings.modelReview
    ? `模型响应身份从 ${s.settings.modelReview.previous} 变为 ${s.settings.modelReview.observed}。新的自发关心已暂停，普通对话和明确约定仍可使用。请先运行人格／安全回归并复核。`
    : "";
  $("focused").checked = s.settings.focused;
  $("muted").checked = s.settings.muted;
  $("proactive").checked = s.settings.proactiveEnabled;
  $("auto-extract").checked = s.settings.autoExtract;
  if (s.companionMemory) {
    $("auto-extract").parentElement.lastChild.textContent = "自动记住日常信息";
    $("proactive").disabled = true;
    $("add-memory").hidden = true;
    if ($("memory-help"))
      $("memory-help").textContent =
        "日常信息会自动记住；明确保存、更正和遗忘按实际结果回应。聊天记录可以保留。受限私人事件暂未开放。";
    $("chat-note").textContent = s.conversationExperiment
      ? "交流节奏试聊：自然分条与末条接话；主动发送关闭。"
      : "新版记忆已接入；主动发送关闭。";
    if (!$("cm3-reset-context")) {
      const reset = btn("只清模型近期上下文", async () => {
        await api("/v1/memory/context-reset", "POST", {});
        $("memory-result").textContent =
          "模型近期对话和摘要已清空；聊天记录与长期记忆保留。";
        await refresh();
      });
      reset.id = "cm3-reset-context";
      reset.title =
        "保留界面聊天与长期记忆，仅重置模型近期对话和摘要，用于验证召回。";
      $("memory-result").after(reset);
    }
  }

  $("split-replies").checked = s.settings.splitReplies;
  $("message-pacing").checked = s.settings.messagePacing;
  $("message-pacing").disabled = !s.settings.splitReplies;
  $("settings-revision").textContent = `配置 v${s.settings.revision}`;
  const active =
    s.runs.find((r) => r.status === "running") ||
    s.runs.find((r) => r.status === "queued");
  $("cancel-run").disabled = !active;
  renderRunStatus(s);
  const list = $("messages"),
    nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 110;
  list.replaceChildren(
    ...s.messages.map((m) =>
      node(
        "article",
        {
          class: `message ${m.role}`,
          "data-message-id": m.id,
          "data-run-id": m.runId,
        },
        node(
          "div",
          { class: "meta" },
          node("span", {
            text: `${m.role === "user" ? "你" : s.settings.persona.name} · ${time(m.createdAt)}${m.role === "assistant" ? " · " + (labels[m.status] || m.status) : ""}`,
          }),
          m.role === "user"
            ? btn("遗忘这条原始发言", async () => {
                if (
                  !confirm(
                    "将使这条来源、相关记忆和待发内容失效。为避免引用残留，当前助手回复也会清理。远端副本无法撤回。继续？",
                  )
                )
                  return;
                const result = await api("/v1/memory/forget", "POST", {
                  sourceIds: [m.id],
                });
                clearSensitiveViews(result.epoch);
                await refresh();
              })
            : m.status === "completed" && m.content
              ? btn("朗读", () => playSpeech("message", m.id, m.revision))
              : null,
        ),
        node("div", { class: "message-text", text: m.content || "…" }),
      ),
    ),
  );
  if (nearBottom) list.scrollTop = list.scrollHeight;
  if (document.visibilityState === "visible")
    for (const m of s.messages)
      if (
        m.role === "assistant" &&
        m.content.length > (state.displayed.get(m.id) || 0)
      ) {
        state.displayed.set(m.id, m.content.length);
        void api(`/v1/messages/${m.id}/exposure`, "POST", {
          chars: m.content.length,
        }).catch(() => {});
      }
  refreshSpeech(s);
  renderCandidateOffer();
  const memory = s.memoryStatus;
  $("memory-status").textContent = memory?.enabled
    ? memory.ready
      ? "语义查找可用；未完成的索引会自动补齐。"
      : "记忆可用，语义查找暂未就绪，会使用基础查找。"
    : "基础记忆查找可用。";
  $("conversation-summary-list").replaceChildren(
    ...(s.conversationSummaries ?? []).map((summary) =>
      node(
        "article",
        { class: "card" },
        node("p", { text: summary.text }),
        btn("查看摘要来源", async () => {
          const version = state.privacyVersion;
          const sources = await api(
            `/v1/memory/summaries/${summary.id}/sources`,
          );
          if (version !== state.privacyVersion) return;
          openEditor(
            "摘要来源",
            sources.map((s) =>
              node("p", {
                text: `${s.role === "assistant" ? "助手已展示内容" : "用户发言"}：${s.text}`,
              }),
            ),
            async () => {},
          );
        }),
        btn("删除这块摘要", async () => {
          const result = await api("/v1/memory/forget", "POST", {
            summaryIds: [summary.id],
          });
          clearSensitiveViews(result.epoch);
          await refresh();
        }),
      ),
    ),
  );
  renderPanels();
}
function renderPanels() {
  if (!state.snapshot) return;
  const s = state.snapshot;
  if (!s) return;
  if (state.tab === "memory") void safely(renderMemories);
  if (state.tab === "followups") renderFollowups();
  if (state.tab === "persona") renderPersona();
  if (state.tab === "trace") renderTraceSummary();
}
async function candidateDecision(m, decision, text) {
  if (state.candidateBusy.has(m.id)) return;
  const version = state.privacyVersion;
  const changes = { decision, ...(text === undefined ? {} : { text }) };
  const command = JSON.stringify([m.id, m.revision, changes]);
  if (!state.candidateCommands.has(command))
    state.candidateCommands.set(command, crypto.randomUUID());
  state.candidateBusy.add(m.id);
  for (const button of $("memory-candidate").querySelectorAll("button"))
    button.disabled = true;
  try {
    await api("/v1/memory/corrections", "POST", {
      id: m.id,
      expectedRevision: m.revision,
      changes,
      idempotencyKey: state.candidateCommands.get(command),
    });
    if (version !== state.privacyVersion) return;
    $("memory-result").textContent =
      decision === "confirm"
        ? "已保存这条记忆。"
        : decision === "later"
          ? "已暂缓，可以在记忆页继续处理。"
          : "这条候选不再保存，原始对话保留。";
    await refresh();
  } finally {
    state.candidateBusy.delete(m.id);
    for (const button of $("memory-candidate").querySelectorAll("button"))
      button.disabled = false;
  }
}
function renderCandidateOffer() {
  const host = $("memory-candidate"),
    offer = state.snapshot?.candidateOffer;
  if (!offer) {
    host.hidden = true;
    host.replaceChildren();
    host.removeAttribute("data-offer-key");
    state.candidateObserver?.disconnect();
    return;
  }
  const m = offer.memory,
    key = `${offer.offerId}:${m.revision}`;
  if (host.dataset.offerKey !== key) {
    host.dataset.offerKey = key;
    host.replaceChildren(
      node("strong", { text: "要记住这件事吗？" }),
      node("p", { text: m.text.slice(0, 256) }),
      m.text.length > 256
        ? node(
            "details",
            {},
            node("summary", { text: "查看完整内容" }),
            node("p", { text: m.text }),
          )
        : "",
      node(
        "div",
        { class: "actions" },
        btn("记住", () => candidateDecision(m, "confirm")),
        btn("更正后记住", () => {
          const version = state.privacyVersion;
          editText("更正后记住", m.text, (text) =>
            version === state.privacyVersion
              ? candidateDecision(m, "confirm", text)
              : undefined,
          );
        }),
        btn("稍后", () => candidateDecision(m, "later")),
        btn("不保存", () => candidateDecision(m, "discard")),
        btn("查看来源", () => showSources(m.sources)),
      ),
    );
  }
  host.hidden = false;
  state.candidateObserver?.disconnect();
  state.candidateObserver = new IntersectionObserver((entries) => {
    if (
      !entries.some((e) => e.isIntersecting) ||
      document.visibilityState !== "visible" ||
      state.candidateExposures.has(offer.offerId) ||
      state.snapshot?.candidateOffer?.offerId !== offer.offerId
    )
      return;
    state.candidateExposures.add(offer.offerId);
    void api(`/v1/memory/${m.id}/exposure`, "POST", {
      offerId: offer.offerId,
    }).catch(() => state.candidateExposures.delete(offer.offerId));
  });
  state.candidateObserver.observe(host);
}
function memoryCard(m) {
  return node(
    "article",
    { class: "card" },
    node(
      "div",
      {},
      node("span", {
        class: "tag",
        text:
          m.kind === "episode"
            ? m.day
              ? `日摘要 ${m.day}`
              : "共同经历"
            : m.category === "preference"
              ? "偏好"
              : m.category === "interpretation"
                ? "解释"
                : "事实",
      }),
      node("span", {
        class: "tag",
        text: `${labels[m.status] || m.status} · ${labels[m.certainty] || m.certainty}${m.pinned ? " · 已置顶" : ""} · v${m.revision}`,
      }),
    ),
    node("p", { text: m.text }),
    node(
      "div",
      { class: "actions" },
      btn("来源", () => showSources(m.sources)),
      m.previousId
        ? btn("上一修订", async () => {
            const version = state.privacyVersion;
            const old = await api(`/v1/memory/${m.previousId}`);
            if (version !== state.privacyVersion) return;
            openEditor(
              "历史修订（不作为当前事实）",
              [node("pre", { text: JSON.stringify(old, null, 2) })],
              async () => {},
            );
          })
        : null,
      btn(state.snapshot?.companionMemory ? "在聊天中更正" : "更正", () =>
        state.snapshot?.companionMemory
          ? $("chat-input").focus()
          : editText("更正记忆", m.text, async (text) => {
              if (m.status === "pending")
                return candidateDecision(m, "confirm", text);
              await api("/v1/memory/corrections", "POST", {
                id: m.id,
                expectedRevision: m.revision,
                changes: { text },
              });
              await refresh();
            }),
      ),
      btn(m.pinned ? "取消置顶" : "置顶", async () => {
        await api("/v1/memory/corrections", "POST", {
          id: m.id,
          expectedRevision: m.revision,
          changes: { pinned: !m.pinned },
        });
        await refresh();
      }),
      m.status === "pending" && !state.snapshot?.companionMemory
        ? node(
            "span",
            { class: "actions" },
            btn("确认", () => candidateDecision(m, "confirm")),
            btn("稍后", () => candidateDecision(m, "later")),
            btn("不保存", () => candidateDecision(m, "discard")),
          )
        : null,
      btn("移除记忆，保留来源", async () => {
        if (
          !confirm(
            "移除这条记忆；原始对话来源保留。日摘要删除后不会自动重建。继续？",
          )
        )
          return;
        const result = await api("/v1/memory/forget", "POST", {
          memoryIds: [m.id],
        });
        clearSensitiveViews(result.epoch);
        await refresh();
      }),
    ),
  );
}
async function renderMemories() {
  if (!state.snapshot) return;
  const version = state.privacyVersion;
  const q = $("memory-search").value.trim();
  const list = q
    ? await api(`/v1/memory?q=${encodeURIComponent(q)}`)
    : state.snapshot.memories.filter(
        (m) => m.status === "active" || m.status === "pending",
      );
  if (
    state.tab !== "memory" ||
    version !== state.privacyVersion ||
    q !== $("memory-search").value.trim()
  )
    return;
  $("memory-list").replaceChildren(
    ...(list.length
      ? list.map(memoryCard)
      : [
          node("p", {
            class: "help",
            text: state.snapshot.companionMemory
              ? "这里会显示自动记住的日常信息，你可以直接在聊天里更正或要求忘记。"
              : "这里会出现你确认的记忆、日摘要，以及等待你判断的建议。",
          }),
        ]),
  );
}
function renderFollowups() {
  const s = state.snapshot;
  $("channel-status").textContent =
    `本页权限：${permission()}；只有本页在线且获授权时才尝试通知。`;
  $("series-list").replaceChildren(
    ...(s.series || []).map((item) =>
      node(
        "article",
        { class: "card" },
        node("p", { text: item.text }),
        node("div", {
          class: "meta",
          text: `${item.frequency === "daily" ? "每日" : "每周（周" + item.weekDay + "）"} ${String(item.hour).padStart(2, "0")}:${String(item.minute).padStart(2, "0")} · ${item.timezone} · ${item.status === "active" ? "下次 " + time(item.nextAt) : "已停止"}`,
        }),
        item.status === "active"
          ? btn("停止这个习惯", async () => {
              await api(`/v1/follow-up-series/${item.id}/cancel`, "POST", {
                expectedRevision: item.revision,
              });
              await refresh();
            })
          : null,
      ),
    ),
  );
  $("followup-list").replaceChildren(
    ...s.followUps.map((f) =>
      node(
        "article",
        { class: "card" },
        node("p", { text: f.text }),
        node("div", {
          class: "meta",
          text: `${labels[f.status] || f.status} · ${f.confirmed ? "已确认" : "需你确认"} · ${time(f.dueAt)} — ${time(f.latestAt)}${f.reason ? " · " + f.reason : ""}`,
        }),
        node(
          "div",
          { class: "actions" },
          !f.confirmed && f.status === "pending"
            ? btn("确认跟进", () => followAction(f, "confirm"))
            : null,
          !["cancelled", "resolved", "expired"].includes(f.status)
            ? btn("取消", () => followAction(f, "cancel"))
            : null,
          !["cancelled", "resolved"].includes(f.status)
            ? btn("已解决", () => followAction(f, "resolve"))
            : null,
        ),
      ),
    ),
  );
  $("delivery-list").replaceChildren(
    ...s.deliveries.map((d) =>
      node(
        "article",
        { class: "card" },
        node("p", { text: d.text || "内容已清理" }),
        node("div", {
          class: "meta",
          text: `${labels[d.status] || d.status} · ${labels[d.availability] || d.availability} · ${d.clickedAt ? "有点击回执" : "没有点击回执"} · ${d.exposure === "reported" ? "你已确认看到" : "曝光未知"}${d.feedback ? " · " + { liked: "喜欢", disturbed: "打扰", not_seen: "没看到" }[d.feedback] : ""}`,
        }),
        node(
          "div",
          { class: "actions" },
          d.text && !["cancelled", "expired"].includes(d.status)
            ? btn("朗读关心消息", () =>
                playSpeech("delivery", d.id, d.revision),
              )
            : null,
          ...["liked", "disturbed", "not_seen"].map((value) =>
            btn(
              {
                liked: "看到了，喜欢",
                disturbed: "看到了，打扰",
                not_seen: "没有看到",
              }[value],
              async () => {
                await api(`/v1/deliveries/${d.id}/feedback`, "POST", {
                  feedback: value,
                });
                await refresh();
              },
            ),
          ),
        ),
      ),
    ),
  );
}
async function followAction(f, action) {
  const result = await api(`/v1/follow-ups/${f.id}/action`, "POST", {
    expectedRevision: f.revision,
    action,
  });
  if (result.inFlight)
    showError("取消已记录，但通知尝试已经开始，可能无法撤回。");
  await refresh();
}
const providerModels = {
  deepseek: [
    ["deepseek-flash", "DeepSeek Flash"],
    ["deepseek-v4-pro", "DeepSeek Pro"],
  ],
  grok: [["grok-4.3", "Grok 4.3"]],
};
function renderModelOptions(model) {
  const options = providerModels[$("model-provider").value];
  $("model").replaceChildren(
    ...options.map(([value, text]) => node("option", { value, text })),
  );
  if (options.some(([value]) => value === model)) $("model").value = model;
}
function renderModelKeyStatus() {
  const provider = $("model-provider").value;
  const status = state.snapshot?.model.providers?.[provider];
  const name = provider === "grok" ? "Grok" : "DeepSeek";
  $("model-key-status").textContent =
    `${name}：${status?.source === "byok" ? "已保存 BYOK Key" : status?.source === "environment" ? "使用后台配置的 Key" : "尚未配置 Key"}${state.snapshot?.model.adapter === "mock" ? "（当前为本地测试模式）" : ""}`;
  $("remove-model-key").disabled = !status?.hasByok;
}
async function saveModelKey() {
  const provider = $("model-provider").value;
  const input = $("model-api-key");
  const key = input.value.trim();
  if (!key) throw new Error("请先输入要保存的 API Key。");
  await api(`/v1/model-credentials/${provider}`, "PUT", { apiKey: key });
  if ($("model-provider").value === provider && input.value.trim() === key)
    input.value = "";
  $("model-key-feedback").textContent =
    `${provider === "grok" ? "Grok" : "DeepSeek"} Key 已保存。`;
  await refresh();
}
$("model-provider").addEventListener("change", () => {
  $("model-api-key").value = "";
  $("model-key-feedback").textContent = "";
  renderModelOptions();
  renderModelKeyStatus();
});
$("save-model-key").addEventListener("click", () => void safely(saveModelKey));
$("remove-model-key").addEventListener(
  "click",
  () =>
    void safely(async () => {
      const provider = $("model-provider").value;
      await api(`/v1/model-credentials/${provider}`, "DELETE");
      $("model-api-key").value = "";
      $("model-key-feedback").textContent = "BYOK Key 已移除。";
      await refresh();
    }),
);
function renderPersona() {
  const s = state.snapshot.settings;
  if (state.renderedPersona !== s.personaRevision) {
    $("persona-name").value = s.persona.name;
    $("persona-identity").value = s.persona.identity;
    $("persona-style").value = s.persona.style;
    $("persona-examples").value = s.persona.examples;
    $("persona-background").value = s.persona.background ?? "";
    $("persona-interests").value = s.persona.interests ?? "";
    const r = s.persona.relationship ?? {};
    $("relationship-mode").value = r.mode ?? "companion";
    $("relationship-user").value = r.userAddress ?? "你";
    $("relationship-bot").value = r.botAddress ?? s.persona.name;
    $("relationship-interaction").value =
      r.interaction ?? "亲近自然地交流，尊重彼此的判断。";
    $("relationship-boundaries").value =
      r.boundaries ?? "尊重用户的现实生活和离开，不制造内疚或排他依赖。";
    state.renderedPersona = s.personaRevision;
  }
  if (
    state.renderedSettings !== s.revision &&
    !$("runtime-form").contains(document.activeElement)
  ) {
    $("model-provider").value = state.snapshot.model.provider;
    renderModelOptions(s.model);
    $("timezone").value = s.timezone;
    $("quiet-start").value = s.quietStart;
    $("quiet-end").value = s.quietEnd;
    $("daily-budget").value = s.dailyTokenBudget;
    state.renderedSettings = s.revision;
  }
  renderModelKeyStatus();
  $("persona-history").textContent =
    `人格版本记录：${state.snapshot.personaHistory.map((p) => "v" + p.revision).join("、")}`;
}
function renderTraceSummary() {
  const select = $("trace-run"),
    previous = select.value;
  const items = [
    ...state.snapshot.runs.map((r) => ({
      id: r.id,
      label: `对话 · ${time(r.createdAt)} · ${short(r.id)} · ${labels[r.status] || r.status}`,
    })),
    ...state.snapshot.followUps.map((f) => ({
      id: f.id,
      label: `跟进 · ${f.text.slice(0, 20)} · ${labels[f.status] || f.status}`,
    })),
    ...state.snapshot.jobs.map((j) => ({
      id: j.id,
      label: `整理 · ${j.kind} · ${labels[j.status] || j.status}`,
    })),
  ];
  select.replaceChildren(
    ...items.map((r) => node("option", { value: r.id, text: r.label })),
  );
  if ([...select.options].some((o) => o.value === previous))
    select.value = previous;
  $("jobs").replaceChildren(
    ...state.snapshot.jobs.map((j) =>
      node(
        "div",
        { class: "card" },
        node("p", {
          text: `${j.kind} · ${labels[j.status] || j.status}${j.day ? " · " + j.day : ""}`,
        }),
        node("span", { class: "meta", text: j.reason || j.id }),
        j.status === "failed"
          ? btn("重试有效来源任务", async () => {
              await api("/local/v1/maintenance", "POST", {
                action: "job.retry",
                id: j.id,
              });
              await refresh();
            })
          : null,
      ),
    ),
  );
  const rows = state.snapshot.usage,
    total = rows.reduce((n, r) => n + Number(r.data.totalTokens || 0), 0);
  $("usage").textContent =
    `最近 ${rows.length} 次模型调用：${total} Token（含未获用量时的保守预留）。费用未知，不视为免费。`;
}
function openEditor(title, fields, submit) {
  $("editor-title").textContent = title;
  $("editor-fields").replaceChildren(...fields);
  state.editorSubmit = submit;
  $("editor").showModal();
}
function editText(title, value, submit) {
  const field = node("textarea", {
    rows: "7",
    maxlength: "4000",
    required: "",
  });
  field.value = value;
  openEditor(title, [node("label", {}, "内容", field)], () =>
    submit(field.value),
  );
}
async function showSources(refs) {
  const version = state.privacyVersion;
  const data = [];
  for (const ref of refs) {
    try {
      const source = await api(`/v1/sources/${ref.id}`);
      data.push({ ...ref, source });
    } catch {
      data.push({ ...ref, status: "来源已不可访问" });
    }
  }
  if (version !== state.privacyVersion) return;
  openEditor(
    "来源证据",
    [node("pre", { text: JSON.stringify(data, null, 2) })],
    async () => {},
  );
}
async function updateSettings(changes) {
  await api(`/v1/relationships/${state.relationshipId}/settings`, "PATCH", {
    expectedRevision: state.snapshot.settings.revision,
    ...changes,
  });
  await refresh();
}
document
  .querySelectorAll("[data-tab]")
  .forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
for (const [id, key] of [
  ["focused", "focused"],
  ["muted", "muted"],
  ["proactive", "proactiveEnabled"],
  ["auto-extract", "autoExtract"],
  ["split-replies", "splitReplies"],
  ["message-pacing", "messagePacing"],
])
  $(id).addEventListener(
    "change",
    () => void safely(() => updateSettings({ [key]: $(id).checked })),
  );
$("acknowledge").addEventListener(
  "click",
  () =>
    void safely(() => updateSettings({ remoteDisclosureAcknowledged: true })),
);
$("ack-model-review").addEventListener(
  "click",
  () => void safely(() => updateSettings({ acknowledgeModelReview: true })),
);
$("notification-permission").addEventListener(
  "click",
  () =>
    void safely(async () => {
      if (!("Notification" in window))
        throw new Error("这个浏览器不支持通知。");
      await Notification.requestPermission();
      await heartbeat();
      await refresh();
    }),
);
$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void safely(async () => {
    const text = $("chat-input").value.trim();
    if (!text) return;
    voiceInput.cancel("开始发送消息，已停止语音输入。");
    stopSpeech("开始新一轮对话，已停止朗读");
    if (!state.pendingInput || state.pendingInput.text !== text)
      state.pendingInput = { text, key: crypto.randomUUID() };
    $("send").disabled = true;
    try {
      await api(`/v1/threads/${state.threadId}/inputs`, "POST", {
        text,
        idempotencyKey: state.pendingInput.key,
      });
      state.pendingInput = null;
      $("chat-input").value = "";
      saveDraft();
      await refresh();
    } finally {
      $("send").disabled = false;
    }
  });
});
$("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("cancel-run").addEventListener(
  "click",
  () =>
    void safely(async () => {
      const r = state.snapshot.runs.find(
        (r) => r.status === "running" || r.status === "queued",
      );
      if (r) {
        if (r.config.splitReplies) stopSpeech("已停止本轮回复和朗读");
        await api(`/v1/runs/${r.id}/cancel`, "POST", {});
        await refresh();
      }
    }),
);
$("memory-search").addEventListener("input", () => void safely(renderMemories));
$("add-memory").addEventListener("click", () => {
  const text = node("textarea", { rows: "5", required: "", maxlength: "4000" }),
    kind = node(
      "select",
      {},
      node("option", { value: "assertion", text: "事实／偏好" }),
      node("option", { value: "episode", text: "共同经历" }),
    ),
    category = node(
      "select",
      {},
      node("option", { value: "fact", text: "事实" }),
      node("option", { value: "preference", text: "偏好" }),
    ),
    occurred = node("input", { type: "datetime-local" });
  openEditor(
    "添加一条你确认的记忆",
    [
      node("label", {}, "内容", text),
      node("label", {}, "类型", kind),
      node("label", {}, "事实类别", category),
      node(
        "label",
        {},
        "经历发生时间（可留空；不要把计划当作已发生）",
        occurred,
      ),
    ],
    async () => {
      await api("/v1/memory", "POST", {
        text: text.value,
        kind: kind.value,
        category: category.value,
        pinned: true,
        ...(occurred.value
          ? { occurredAt: new Date(occurred.value).getTime() }
          : {}),
      });
      await refresh();
    },
  );
});
$("new-followup").addEventListener("click", () => {
  const text = node("textarea", { rows: "3", required: "" }),
    due = node("input", { type: "datetime-local", required: "" }),
    end = node("input", { type: "datetime-local", required: "" }),
    interrupt = node("input", { type: "checkbox" });
  function local(at) {
    const d = new Date(at);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  due.value = local(Date.now() + 5 * 60000);
  end.value = local(Date.now() + 65 * 60000);
  openEditor(
    "一次性跟进",
    [
      node("label", {}, "希望关心什么", text),
      node("label", {}, "最早时间（浏览器本地时间）", due),
      node("label", {}, "最晚时间", end),
      node("label", {}, interrupt, " 明确允许打断专注／静默时段"),
    ],
    async () => {
      await api("/v1/follow-ups", "POST", {
        text: text.value,
        dueAt: new Date(due.value).getTime(),
        latestAt: new Date(end.value).getTime(),
        allowInterrupt: interrupt.checked,
      });
      await refresh();
    },
  );
});
$("new-series").addEventListener("click", () => {
  const text = node("textarea", { rows: "3", required: "" }),
    frequency = node(
      "select",
      {},
      node("option", { value: "daily", text: "每日" }),
      node("option", { value: "weekly", text: "每周" }),
    ),
    clock = node("input", { type: "time", required: "" }),
    timezone = node("input", { required: "" }),
    weekDay = node(
      "select",
      {},
      ...[1, 2, 3, 4, 5, 6, 7].map((d) =>
        node("option", { value: String(d), text: "星期" + d }),
      ),
    );
  clock.value = "18:00";
  timezone.value = state.snapshot.settings.timezone;
  openEditor(
    "确认一个相处习惯",
    [
      node("label", {}, "允许跟进的主题", text),
      node("label", {}, "频率", frequency),
      node("label", {}, "当地时间", clock),
      node("label", {}, "IANA时区", timezone),
      node("label", {}, "每周使用的星期", weekDay),
      node("p", {
        class: "help",
        text: "每次仍会判断是否合适；遵守专注、静默、频率和无回应规则。错过的过期时段不批量补发，可随时停止。",
      }),
    ],
    async () => {
      const [hour, minute] = clock.value.split(":").map(Number);
      await api("/v1/follow-up-series", "POST", {
        text: text.value,
        frequency: frequency.value,
        timezone: timezone.value,
        hour,
        minute,
        weekDay: Number(weekDay.value),
      });
      await refresh();
    },
  );
});
$("editor-close").addEventListener("click", () => $("editor").close());
$("editor-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void safely(async () => {
    await state.editorSubmit?.();
    $("editor").close();
  });
});
$("persona-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void safely(async () => {
    await api("/v1/persona-revisions", "POST", {
      expectedRevision: state.snapshot.settings.revision,
      persona: {
        name: $("persona-name").value,
        identity: $("persona-identity").value,
        style: $("persona-style").value,
        examples: $("persona-examples").value,
        background: $("persona-background").value,
        interests: $("persona-interests").value,
        relationship: {
          mode: $("relationship-mode").value,
          userAddress: $("relationship-user").value,
          botAddress: $("relationship-bot").value,
          interaction: $("relationship-interaction").value,
          boundaries: $("relationship-boundaries").value,
        },
        ...(state.snapshot.settings.persona.memoryScope
          ? { memoryScope: state.snapshot.settings.persona.memoryScope }
          : {}),
      },
    });
    await refresh();
    state.bots = await api("/v1/bots");
    renderBots();
  });
});
$("runtime-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void safely(async () => {
    const changes = {
      model: $("model").value,
      timezone: $("timezone").value,
      quietStart: Number($("quiet-start").value),
      quietEnd: Number($("quiet-end").value),
      dailyTokenBudget: Number($("daily-budget").value),
    };
    if ($("model-api-key").value.trim()) await saveModelKey();
    await updateSettings(changes);
    $("model-key-feedback").textContent =
      "运行设置已保存，新对话将使用所选模型。";
  });
});
$("load-trace").addEventListener(
  "click",
  () =>
    void safely(async () => {
      const id = $("trace-run").value;
      if (!id) return;
      const version = state.privacyVersion;
      const data = await api(`/v1/trace?entityId=${encodeURIComponent(id)}`);
      if (version !== state.privacyVersion) return;
      $("trace-content").replaceChildren(
        node("p", {
          class: "help",
          text: window.companionTimingSummary(
            state.snapshot.runs.find((run) => run.id === id)?.timings,
          ),
        }),
        node(
          "details",
          { open: "" },
          node("summary", { text: "程序 Trace" }),
          node("pre", { text: JSON.stringify(data.trace, null, 2) }),
        ),
        node(
          "details",
          {},
          node("summary", { text: "模型请求上下文（本地敏感内容）" }),
          node("pre", { text: JSON.stringify(data.context, null, 2) }),
        ),
      );
    }),
);
$("rebuild-summary").addEventListener(
  "click",
  () =>
    void safely(async () => {
      if (!$("summary-day").value) throw new Error("先选一个已结束日期。");
      const value = await api("/local/v1/maintenance", "POST", {
        action: "summary.rebuild",
        day: $("summary-day").value,
      });
      $("maintenance-result").textContent = JSON.stringify(value, null, 2);
      await refresh();
    }),
);
$("export").addEventListener(
  "click",
  () =>
    void safely(async () => {
      const version = state.privacyVersion;
      const receipt = await api("/v1/exports", "POST", {}),
        data = await api(`/v1/exports/${receipt.id}`);
      if (
        version !== state.privacyVersion ||
        data.epoch !== state.snapshot?.settings.epoch
      )
        return;
      const blob = new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        }),
        url = URL.createObjectURL(blob),
        a = node("a", {
          href: url,
          download: `companion-${new Date().toISOString().slice(0, 10)}.json`,
        });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $("maintenance-result").textContent =
        "已下载当前有效数据。下载副本需要你自行保管和删除。";
    }),
);
$("backup").addEventListener(
  "click",
  () =>
    void safely(async () => {
      $("maintenance-result").textContent = JSON.stringify(
        await api("/v1/backups", "POST", {}),
        null,
        2,
      );
    }),
);
$("health").addEventListener(
  "click",
  () =>
    void safely(async () => {
      $("maintenance-result").textContent = JSON.stringify(
        await api("/v1/health"),
        null,
        2,
      );
    }),
);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden")
    voiceInput.cancel("页面已离开，语音输入已停止。");
  if (document.visibilityState === "visible") {
    void safely(heartbeat);
    requestRefresh();
  }
});
function saveDraft() {
  try {
    sessionStorage.setItem(
      `companion-draft:${state.botId}`,
      $("chat-input").value,
    );
  } catch {}
}
$("chat-input").addEventListener("input", saveDraft);
window.addEventListener("pagehide", () => {
  voiceInput.cancel();
  saveDraft();
  stopSpeech();
  state.events?.close();
  for (const notification of state.activeNotifications.values())
    notification.close();
  void fetch("/v1/channel", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      "X-Local-Token": state.csrf,
      "X-Bot-Id": state.botId,
    },
    body: JSON.stringify({ clientId: state.clientId, permission: "offline" }),
  }).catch(() => {});
});
function switchBot(id) {
  if (id === state.botId) return;
  voiceInput.cancel("正在切换角色，语音输入已停止。");
  stopSpeech("正在切换角色");
  state.events?.close();
  location.assign(`/?bot=${encodeURIComponent(id)}`);
}
function renderBots() {
  $("bot-select").replaceChildren(
    ...state.bots
      .filter((b) => b.status !== "archived")
      .map((b) =>
        node("option", {
          value: b.id,
          text: `${b.name}${b.original ? " · 原角色" : b.id === "mio" ? " · 色情女友" : b.mode === "romantic" ? " · AI小女友" : ""}`,
        }),
      ),
  );
  $("bot-select").value = state.botId;
  const current = state.bots.find((b) => b.id === state.botId);
  $("archive-bot").disabled = !current || current.original;
  $("bot-description").textContent = "聊天、记忆和跟进按角色独立保存";
  $("archived-bots").replaceChildren(
    ...state.bots
      .filter((b) => b.status === "archived")
      .map((b) =>
        node(
          "div",
          { class: "card" },
          b.name,
          btn("恢复", async () => {
            await api(`/v1/bots/${b.id}/restore`, "POST", {});
            state.bots = await api("/v1/bots");
            renderBots();
          }),
        ),
      ),
  );
}
$("bot-select").addEventListener("change", () =>
  switchBot($("bot-select").value),
);
$("new-bot").addEventListener("click", () => {
  const name = node("input", {
    required: "",
    maxlength: "40",
    placeholder: "给新角色起个名字",
  });
  const template = node(
    "select",
    { id: "new-bot-template" },
    node("option", { value: "companion", text: "日常陪伴" }),
    node("option", { value: "romantic", text: "成年AI恋爱陪伴" }),
    node("option", { value: "erotic", text: "色情女友" }),
  );
  const model = node(
    "select",
    { id: "new-bot-model", required: "" },
    ...Object.values(providerModels)
      .flat()
      .map(([value, text]) => node("option", { value, text })),
  );
  const currentModel = state.snapshot?.settings.model;
  if (
    Object.values(providerModels)
      .flat()
      .some(([value]) => value === currentModel)
  )
    model.value = currentModel;
  openEditor(
    "新建角色",
    [
      node("label", {}, "名字", name),
      node("label", {}, "初始相处模式", template),
      node("label", {}, "使用模型", model),
      node("p", {
        class: "help",
        text: "从空白聊天和记忆开始。使用所选服务商的后台默认 Key，创建后可在「人格 → 运行设置」更换模型或配置独立 BYOK。角色背景、称呼、互动方式与边界也可在人格面板编辑。",
      }),
    ],
    async () => {
      const created = await api("/v1/bots", "POST", {
        name: name.value,
        template: template.value,
        model: model.value,
      });
      switchBot(created.id);
    },
  );
});
$("archive-bot").addEventListener("click", () => {
  openEditor(
    "归档当前角色",
    [
      node("p", {
        text: "归档后暂停此角色的任务与主动关心，聊天和记忆保留，可随时恢复。",
      }),
    ],
    async () => {
      await api(`/v1/bots/${state.botId}/archive`, "POST", {});
      switchBot("xiaoye");
    },
  );
});
$("voice-preview").addEventListener("click", () => void playSpeech("preview"));
$("voice-stop").addEventListener("click", () => {
  const message = state.snapshot?.messages.find(
    (m) => m.id === state.voiceTarget?.id,
  );
  if (message?.replyIndex !== undefined) {
    state.voiceSuppressedRuns.add(message.runId);
    if (state.voiceSuppressedRuns.size > 1000)
      state.voiceSuppressedRuns.delete(
        state.voiceSuppressedRuns.values().next().value,
      );
  }
  stopSpeech();
});
$("voice-auto").addEventListener("change", () => {
  state.voiceAutoSince = $("voice-auto").checked ? Date.now() : 0;
  if (!state.voiceAutoSince) stopSpeech();
});
$("voice-player").addEventListener("playing", () => {
  if (state.voiceTarget)
    $("voice-status").textContent =
      `正在朗读 · ${state.voice?.voiceName ?? "甜妹"}`;
});
$("voice-player").addEventListener("ended", () => {
  stopSpeech("朗读结束", true);
  playNextSpeech();
});
$("voice-player").addEventListener("error", () => {
  if (state.voiceUrl) stopSpeech("音频解码失败，请重新朗读");
});
const voiceInput = window.createVoiceInput({
  getContext: () =>
    state.snapshot
      ? {
          botId: state.botId,
          epoch: state.snapshot.settings.epoch,
          csrf: state.csrf,
          allowed:
            !state.voiceInputRemote ||
            state.snapshot.settings.remoteDisclosureAcknowledged,
        }
      : null,
  stopPlayback: () => stopSpeech("开始录音，已停止朗读。"),
  appendText: (text) => {
    const existing = $("chat-input").value;
    const combined = existing ? `${existing.trimEnd()}\n${text}` : text;
    if (combined.length > 12000)
      throw new Error("输入框已满，请先发送现有内容再录音。");
    $("chat-input").value = combined;
    saveDraft();
    $("chat-input").focus();
  },
});
void safely(async () => {
  const boot = await api("/bootstrap");
  state.csrf = boot.csrfToken;
  state.botId = boot.botId ?? "xiaoye";
  state.bots = boot.bots ?? [];
  renderBots();
  state.relationshipId = boot.relationshipId;
  state.threadId = boot.threadId;
  try {
    $("chat-input").value =
      sessionStorage.getItem(`companion-draft:${state.botId}`) ?? "";
  } catch {}
  await refresh();
  try {
    state.voice = await api("/v1/voice");
    $("voice-name").textContent =
      `Fish Audio · ${state.voice.voiceName} · ${state.voice.configured ? "已配置" : "未配置后台密钥"}`;
    $("voice-preview").disabled = !state.voice.configured;
    $("voice-auto").disabled = !state.voice.configured;
    state.voiceAutoSince =
      state.voice.configured && $("voice-auto").checked ? Date.now() : 0;
  } catch {
    $("voice-name").textContent = "语音暂不可用，文字聊天仍可使用";
    $("voice-auto").disabled = true;
  }
  try {
    const inputSettings = await api("/v1/voice-input");
    state.voiceInputConfigured = Boolean(inputSettings.configured);
    state.voiceInputRemote = inputSettings.remote !== false;
    voiceInput.configure(inputSettings);
    render();
  } catch {
    voiceInput.configure(null);
  }
  await heartbeat();
  connect(state.snapshot.cursor);
  setInterval(() => void safely(heartbeat), 15000);
});
