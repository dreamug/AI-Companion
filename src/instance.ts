import {
  readFileSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DomainError } from "./domain.js";

export function runningInstance(
  dataDir: string,
): { pid: number; address?: string } | undefined {
  try {
    const lock = JSON.parse(
      readFileSync(join(dataDir, "daemon.lock"), "utf8"),
    ) as { pid: number; address?: string };
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0)
      throw new DomainError("instance_lock_invalid", 500);
    try {
      process.kill(lock.pid, 0);
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export function acquireInstance(dataDir: string): () => void {
  const path = join(dataDir, "daemon.lock");
  const create = () => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      );
    } finally {
      closeSync(fd);
    }
  };
  try {
    create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (runningInstance(dataDir))
      throw new DomainError("instance_running", 409);
    // Recheck staleness after owning an exclusive recovery guard; never remove a fresh winner's lock.
    const guard = `${path}.recovery`;
    let fd: number;
    try {
      fd = openSync(guard, "wx", 0o600);
    } catch {
      throw new DomainError("instance_recovery_busy", 409);
    }
    try {
      if (runningInstance(dataDir))
        throw new DomainError("instance_running", 409);
      try {
        unlinkSync(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      create();
    } finally {
      closeSync(fd);
      unlinkSync(guard);
    }
  }
  return () => {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
      if (data.pid === process.pid) unlinkSync(path);
    } catch {}
  };
}
