import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { restoreBackup } from "../src/backup.js";
import { setup } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanups.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

describe("M5 恢复、故障切点与持久事实", () => {
  it("重启只中断运行中的Run，已接受的queued仍可继续准入", async () => {
    const x = make();
    const at = x.clock.now();
    for (const status of ["running", "queued"] as const) {
      const id = `restart-${status}`;
      x.store.put("messages", {
        id: `input-${id}`,
        threadId: "local-thread",
        role: "user",
        content: "合成恢复测试",
        revision: 1,
        status: "complete",
        runId: id,
        createdAt: at,
        deleted: false,
        displayed: 7,
      });
      x.store.put("sources", {
        id: `input-${id}`,
        text: "合成恢复测试",
        revision: 1,
        kind: "message",
        deleted: false,
        createdAt: at,
      });
      x.store.put("runs", {
        id,
        inputId: `input-${id}`,
        status,
        generation: 1,
        epoch: 1,
        personaRevision: 1,
        model: "deepseek-flash",
        createdAt: at,
        updatedAt: at,
        steps: 0,
        usage: { calls: 0, estimated: true },
        config: { enqueueSeq: 1 },
      });
    }
    x.store.recover(at);
    expect(x.store.require("runs", "restart-running").status).toBe(
      "interrupted",
    );
    expect(x.store.require("runs", "restart-queued").status).toBe("queued");
  });
  it("投递已开始但回执丢失，恢复为unknown而非重发", () => {
    const x = make();
    x.store.put("deliveries", {
      id: "lost-receipt",
      followUpId: "f",
      text: "合成消息",
      status: "attempt_started",
      availability: "online",
      exposure: "unknown",
      revision: 1,
      attemptId: "a",
      createdAt: x.clock.now(),
      sources: [],
    });
    x.store.recover(x.clock.now());
    expect(x.store.require("deliveries", "lost-receipt").status).toBe(
      "unknown",
    );
  });
  it("在线一致性备份可恢复历史与人格，索引仍可检索", async () => {
    const x = make();
    const m = x.h.addMemory({ text: "备份测试记忆", pinned: true });
    const receipt = await x.h.backup();
    const target = join(mkdtempSync(join(tmpdir(), "restore-parent-")), "new");
    const restored = restoreBackup(
      join(x.dir, "backups", `${receipt.id}.sqlite`),
      target,
      LOCAL_SCOPE,
      [x.store.ledgerPath],
    );
    try {
      expect(restored.require("memories", m.id).text).toBe("备份测试记忆");
      expect(restored.search("测试记忆", x.clock.now())).toHaveLength(1);
      expect(restored.settings().persona.name).toBe("小野");
    } finally {
      restored.close();
      rmSync(join(target, ".."), { recursive: true, force: true });
    }
  });
  it("遗忘后恢复旧备份，先应用最新删除清单，不复活内容", async () => {
    const x = make();
    const m = x.h.addMemory({ text: "恢复时绝不能复活的秘密" });
    const receipt = await x.h.backup();
    x.h.forget([], [m.id]);
    const parent = mkdtempSync(join(tmpdir(), "restore-deletion-"));
    const restored = restoreBackup(
      join(x.dir, "backups", `${receipt.id}.sqlite`),
      join(parent, "new"),
      LOCAL_SCOPE,
      [
        join(x.dir, "backups", `${receipt.id}.deletions.json`),
        x.store.ledgerPath,
      ],
    );
    try {
      expect(restored.require("memories", m.id).status).toBe("deleted");
      expect(restored.require("memories", m.id).text).toBe("");
      expect(restored.search("秘密", x.clock.now())).toHaveLength(0);
    } finally {
      restored.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });
  it("恢复拒绝覆盖已有活动目录", async () => {
    const x = make();
    const b = await x.h.backup();
    expect(() =>
      restoreBackup(
        join(x.dir, "backups", `${b.id}.sqlite`),
        x.dir,
        LOCAL_SCOPE,
        [],
      ),
    ).toThrow("restore_target_not_empty");
  });
  it("删除台账已提交但数据库事务失败，重开自动完成删除", () => {
    let armed = true;
    const x = make({
      faults: {
        hit(point) {
          if (armed && point === "forget.before_commit") {
            armed = false;
            throw new Error("crash");
          }
        },
      },
    });
    const m = x.h.addMemory({ text: "合成敏感信息" });
    expect(() => x.h.forget([], [m.id])).toThrow("crash");
    const other = new Store(x.dir, LOCAL_SCOPE);
    try {
      expect(other.require("memories", m.id).status).toBe("deleted");
    } finally {
      other.close();
    }
  });
  it("存储事务本身原子回滚，提交后错误不撤销事实", () => {
    let cut = "";
    const x = make({
      faults: {
        hit(p) {
          if (p === cut) throw new Error("injected");
        },
      },
    });
    const record = {
      id: "atomic",
      text: "原子测试",
      kind: "manual" as const,
      revision: 1,
      deleted: false,
      createdAt: x.clock.now(),
    };
    cut = "storage.before_commit";
    expect(() =>
      x.store.tx("storage", () => x.store.put("sources", record)),
    ).toThrow();
    expect(x.store.get("sources", record.id)).toBeUndefined();
    cut = "storage.after_commit";
    expect(() =>
      x.store.tx("storage", () => x.store.put("sources", record)),
    ).toThrow();
    expect(x.store.require("sources", record.id).text).toBe("原子测试");
  });
  it("诊断订阅者抛错不改变已提交消息和Run终态", async () => {
    const x = make();
    x.h.signals.on("change", () => {
      throw new Error("observer failure");
    });
    const r = x.h.submit("你好", "observer");
    await x.h.waitForIdle();
    expect(x.store.require("runs", r.runId).status).toBe("completed");
  });
  it("旧cursor在遗忘后要求重新同步，不能回放旧正文", async () => {
    const x = make();
    const r = x.h.submit("合成测试文本", "cursor");
    await x.h.waitForIdle();
    const cursor = x.store.cursor();
    x.h.forget([r.messageId], []);
    expect(() => x.store.events(cursor)).toThrow("resync_required");
  });
  it("公开事件保留有上限，落后cursor要求快照同步", () => {
    const x = make();
    for (let i = 0; i < 4200; i++) x.store.event("test", { i }, x.clock.now());
    expect(() => x.store.events("1:1")).toThrow("resync_required");
    expect(x.store.events()).toHaveLength(500);
  });
  it("高于当前schema的数据库拒绝启动，不在半迁移状态服务", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-test-"));
    const db = new Database(join(dir, "companion.sqlite"));
    db.pragma("user_version=999");
    db.close();
    try {
      expect(() => new Store(dir, LOCAL_SCOPE)).toThrow("unsupported_schema");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
