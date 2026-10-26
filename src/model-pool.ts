import { DomainError } from "./domain.js";

/** Shared by provider account in this process. At most one background request;
 * foreground reviewers retain the other three slots. No extra agent or scheduler. */
export class ModelRequestPool {
  private active = 0;
  private background = 0;
  private waiting: {
    background: boolean;
    start: () => void;
    cancel: () => void;
  }[] = [];
  acquire(background: boolean, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted)
      return Promise.reject(new DomainError("cancelled", 409));
    if (this.waiting.length >= 16)
      return Promise.reject(new DomainError("model_queue_full", 429));
    return new Promise((resolve, reject) => {
      const entry = {
        background,
        start: () => {
          signal.removeEventListener("abort", entry.cancel);
          this.active++;
          if (background) this.background++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            if (background) this.background--;
            this.drain();
          });
        },
        cancel: () => {
          this.waiting = this.waiting.filter((e) => e !== entry);
          reject(new DomainError("cancelled", 409));
          this.drain();
        },
      };
      signal.addEventListener("abort", entry.cancel, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }
  private drain() {
    while (this.active < 4) {
      const index = this.waiting.findIndex((e) => !e.background);
      const eligible =
        index >= 0
          ? index
          : this.waiting.findIndex((e) => !e.background || !this.background);
      if (eligible < 0) break;
      this.waiting.splice(eligible, 1)[0]!.start();
    }
  }
}
const accounts = new Map<string, ModelRequestPool>();
export function accountModelPool(accountHash: string) {
  let pool = accounts.get(accountHash);
  if (!pool) {
    pool = new ModelRequestPool();
    accounts.set(accountHash, pool);
  }
  return pool;
}
