import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "companion-crash-"));
const children: ChildProcess[] = [];
async function start() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HARNESS_MODEL: "mock",
      HARNESS_DATA_DIR: dir,
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  const address = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("startup_timeout")),
      10000,
    );
    child.stdout!.on("data", (data) => {
      out += String(data);
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`child_exit_${code}`));
    });
  });
  const b = await fetch(`${address}/bootstrap`);
  const boot = (await b.json()) as { csrfToken: string };
  const cookie = b.headers.get("set-cookie")!.split(";")[0]!;
  return {
    child,
    address,
    headers: {
      cookie,
      "x-local-token": boot.csrfToken,
      "content-type": "application/json",
    },
  };
}
async function request(
  server: Awaited<ReturnType<typeof start>>,
  path: string,
  body?: unknown,
) {
  const r = await fetch(server.address + path, {
    method: body === undefined ? "GET" : "POST",
    headers: server.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}
async function wait(check: () => Promise<boolean>) {
  const until = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("condition_timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function cli(args: string[]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/backup.ts", ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, HARNESS_DATA_DIR: dir, HARNESS_MODEL: "mock" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let output = "";
  child.stdout!.on("data", (data) => (output += String(data)));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("cli_timeout"));
    }, 10000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  return { code, output };
}
const checks: { name: string; passed: boolean }[] = [];
try {
  const first = await start();
  const a = await request(first, "/v1/threads/local-thread/inputs", {
    text: "真实进程崩溃恢复的合成测试文本，请继续回应。",
    idempotencyKey: "crash-a",
  });
  const b = await request(first, "/v1/threads/local-thread/inputs", {
    text: "崩溃前已接受但排队的合成输入。",
    idempotencyKey: "crash-b",
  });
  await wait(async () => {
    const s = await request(
      first,
      "/v1/relationships/local-relationship/snapshot",
    );
    return (
      s.messages as { runId: string; role: string; content: string }[]
    ).some(
      (m) =>
        m.runId === a.runId && m.role === "assistant" && m.content.length > 0,
    );
  });
  const exited = new Promise((resolve) => first.child.once("exit", resolve));
  first.child.kill("SIGKILL");
  await exited;
  const second = await start();
  await wait(async () => {
    const r = await request(second, `/v1/runs/${b.runId}`);
    return r.status === "completed";
  });
  const ra = await request(second, `/v1/runs/${a.runId}`),
    rb = await request(second, `/v1/runs/${b.runId}`);
  checks.push(
    {
      name: "running_interrupted_after_sigkill",
      passed: ra.status === "interrupted",
    },
    {
      name: "queued_input_runs_once_after_restart",
      passed: rb.status === "completed",
    },
  );
  const duplicate = await request(second, "/v1/threads/local-thread/inputs", {
    text: "崩溃前已接受但排队的合成输入。",
    idempotencyKey: "crash-b",
  });
  checks.push({
    name: "idempotency_survives_process_restart",
    passed: duplicate.runId === b.runId && duplicate.duplicate === true,
  });
  const backupCLI = await cli([]);
  const backup =
    backupCLI.code === 0
      ? (JSON.parse(backupCLI.output) as { id: string })
      : undefined;
  checks.push({
    name: "live_cli_backup_uses_daemon",
    passed:
      backupCLI.code === 0 &&
      !!backup?.id &&
      existsSync(join(dir, "backups", `${backup.id}.sqlite`)),
  });
  const target = join(dir, "restored");
  const refused = await cli([
    "--restore",
    backup?.id ?? "missing",
    "--to",
    target,
  ]);
  checks.push({
    name: "restore_refuses_while_daemon_live",
    passed: refused.code !== 0 && !existsSync(target),
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("shutdown_timeout")),
      10000,
    );
    second.child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  second.child.kill("SIGTERM");
  const result = await exit;
  checks.push({
    name: "graceful_shutdown",
    passed: result.code === 0 && result.signal === null,
  });
  const restored = await cli([
    "--restore",
    backup?.id ?? "missing",
    "--to",
    target,
  ]);
  checks.push({
    name: "offline_cli_restore",
    passed: restored.code === 0 && existsSync(join(target, "companion.sqlite")),
  });
} catch {
  checks.push({ name: "crash_smoke_complete", passed: false });
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
const report = {
  at: new Date().toISOString(),
  scope: "real_process_mock_provider",
  checks,
};
const out = join(process.cwd(), "data", "reports");
mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(join(out, "crash-smoke.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(report, null, 2));
if (checks.some((c) => !c.passed)) process.exitCode = 1;
