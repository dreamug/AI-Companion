import { afterEach, expect, it } from "vitest";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalTranscription } from "../src/local-transcription.js";
import { setup, until } from "./helpers.js";
import { createApp } from "../src/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
const audio = Buffer.from("RIFF0000WAVEsynthetic-audio");
function worker(body: string) {
  const x = setup();
  cleanups.push(x.dispose);
  writeFileSync(join(x.dir, "config.json"), "{}");
  writeFileSync(join(x.dir, "weights.npz"), "test-placeholder");
  const runner = join(x.dir, "worker.mjs");
  writeFileSync(runner, body);
  x.config.localAsrPython = process.execPath;
  x.config.localAsrFfmpeg = process.execPath;
  x.config.localAsrModel = x.dir;
  return { ...x, adapter: new LocalTranscription(x.config, runner) };
}
it("本地worker只经管道接收音频，离线环境生效并返回草稿", async () => {
  const x =
    worker(`let chunks=[]; for await (const c of process.stdin) chunks.push(c);
    if (Buffer.concat(chunks).toString() !== 'RIFF0000WAVEsynthetic-audio' || process.env.HF_HUB_OFFLINE !== '1') process.exit(1);
    console.log(JSON.stringify({text:' 本地合成文本 ',duration:1}));`);
  expect(x.adapter.remote).toBe(false);
  expect(
    await x.adapter.transcribe(
      audio,
      "audio/wav",
      new AbortController().signal,
    ),
  ).toEqual({ text: "本地合成文本", duration: 1 });
});
it.each([
  [
    "console.log(JSON.stringify({text:'',duration:1}))",
    "transcription_no_speech",
  ],
  ["console.log('raw-private-output')", "transcription_invalid_response"],
  [
    "process.stdout.write('x'.repeat(200000))",
    "transcription_invalid_response",
  ],
  ["process.exit(2)", "recording_invalid_audio"],
  ["process.exit(3)", "recording_too_long"],
  ["process.exit(1)", "transcription_local_unavailable"],
])("异常worker不泄露原输出：%s", async (body, code) => {
  const x = worker(body);
  await expect(
    x.adapter.transcribe(audio, "audio/wav", new AbortController().signal),
  ).rejects.toThrow(code);
});
it("取消识别杀死worker进程，预取消不启动", async () => {
  const x =
    worker(`import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
    writeFileSync(join(process.argv[2], 'pid'), String(process.pid)); process.stdin.resume(); setInterval(()=>{},1000);`);
  const pre = new AbortController();
  pre.abort();
  await expect(
    x.adapter.transcribe(audio, "audio/wav", pre.signal),
  ).rejects.toThrow("transcription_cancelled");
  expect(existsSync(join(x.dir, "pid"))).toBe(false);
  const c = new AbortController();
  const pending = x.adapter.transcribe(audio, "audio/wav", c.signal);
  await until(() => existsSync(join(x.dir, "pid")));
  const pid = Number(readFileSync(join(x.dir, "pid"), "utf8"));
  const rejected = expect(pending).rejects.toThrow("transcription_cancelled");
  c.abort();
  await rejected;
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});
it("缺本地模型不外发且返回明确配置错误", async () => {
  const x = setup();
  cleanups.push(x.dispose);
  await expect(
    new LocalTranscription(x.config).transcribe(
      audio,
      "audio/wav",
      new AbortController().signal,
    ),
  ).rejects.toThrow("transcription_local_unavailable");
});
it("本地识别无需远程录音许可，仍核对来源且不保存消息", async () => {
  const x = worker("console.log(JSON.stringify({text:'本地草稿',duration:1}))");
  const s = x.store.settings();
  x.store.saveSettings({ ...s, remoteDisclosureAcknowledged: false });
  const app = await createApp(x.h, { transcription: x.adapter });
  cleanups.push(() => app.close());
  const b = await app.inject({ url: "/bootstrap" });
  const headers = {
    cookie: `harness_session=${b.cookies[0]!.value}`,
    "x-local-token": b.json().csrfToken,
  };
  expect(
    (await app.inject({ url: "/v1/voice-input", headers })).json(),
  ).toMatchObject({
    configured: true,
    remote: false,
    provider: "local-whisper",
  });
  const payload = {
    audio: audio.toString("base64"),
    mimeType: "audio/wav",
    expectedEpoch: s.epoch,
  };
  const r = await app.inject({
    method: "POST",
    url: "/v1/transcriptions",
    headers,
    payload,
  });
  expect(r.statusCode).toBe(200);
  expect(r.json().text).toBe("本地草稿");
  expect(x.h.snapshot().messages).toHaveLength(0);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/transcriptions",
        headers,
        payload: { ...payload, expectedEpoch: s.epoch + 1 },
      })
    ).statusCode,
  ).toBe(409);
});
