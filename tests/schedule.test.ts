import { afterEach, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";
import { nextOccurrence } from "../src/schedule.js";

const cleanups: (() => Promise<void>)[] = [];
function make() {
  const x = setup();
  cleanups.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
describe("有限日／周习惯与时区", () => {
  it("每日习惯经明确创建，单次有稳定身份，重复tick不重复生成", async () => {
    const x = make();
    const s = x.h.createSeries({
      text: "每天问问合成项目进展",
      frequency: "daily",
      timezone: "Asia/Shanghai",
      hour: 12,
      minute: 1,
    });
    x.clock.advance(60000);
    await x.h.tick();
    await x.h.tick();
    expect(
      x.store.list("followups").filter((f) => f.seriesId === s.id),
    ).toHaveLength(1);
    expect(x.store.require("series", s.id).nextAt).toBe(s.nextAt + 86400000);
  });
  it("取消习惯使未发送的实例失效，后续不再排程", async () => {
    const x = make();
    const s = x.h.createSeries({
      text: "可关闭的习惯",
      frequency: "daily",
      timezone: "Asia/Shanghai",
      hour: 12,
      minute: 1,
    });
    x.clock.advance(60000);
    await x.h.tick();
    x.h.cancelSeries(s.id, s.revision);
    x.clock.advance(86400000);
    await x.h.tick();
    expect(x.store.require("series", s.id).status).toBe("cancelled");
    expect(
      x.store
        .list("followups")
        .filter((f) => f.seriesId === s.id && f.status === "pending"),
    ).toHaveLength(0);
    expect(x.store.list("deliveries")[0]?.status).toBe("cancelled");
  });
  it("关机多天跳过过期习惯，不追赶所有漏发实例", async () => {
    const x = make();
    const s = x.h.createSeries({
      text: "不补发旧习惯",
      frequency: "daily",
      timezone: "Asia/Shanghai",
      hour: 12,
      minute: 1,
    });
    x.clock.advance(4 * 86400000);
    await x.h.tick();
    expect(x.store.list("followups")).toHaveLength(0);
    expect(x.store.require("series", s.id).nextAt).toBeGreaterThan(
      x.clock.now(),
    );
  });
  it("每周按用户时区和星期计算，时钟后跳不重复实例", async () => {
    const x = make();
    const s = x.h.createSeries({
      text: "周一习惯",
      frequency: "weekly",
      timezone: "Asia/Shanghai",
      hour: 9,
      minute: 0,
      weekDay: 1,
    });
    expect(new Date(s.nextAt).toISOString()).toBe("2026-10-26T01:00:00.000Z");
    x.clock.time = s.nextAt;
    await x.h.tick();
    const count = x.store.list("followups").length;
    x.clock.advance(-3600000);
    await x.h.tick();
    expect(x.store.list("followups")).toHaveLength(count);
  });
  it("春季不存在的当地时间采用compatible向后移，不手写DST", () => {
    const next = nextOccurrence(Date.parse("2026-03-08T05:00:00Z"), {
      frequency: "daily",
      timezone: "America/New_York",
      hour: 2,
      minute: 30,
      weekDay: 1,
    });
    expect(new Date(next).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  it("秋季重复的当地时间采用较早一次，之后不发第二遍", () => {
    const rule = {
      frequency: "daily" as const,
      timezone: "America/New_York",
      hour: 1,
      minute: 30,
      weekDay: 1,
    };
    expect(
      new Date(
        nextOccurrence(Date.parse("2026-11-01T04:00:00Z"), rule),
      ).toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
    expect(
      new Date(
        nextOccurrence(Date.parse("2026-11-01T05:45:00Z"), rule),
      ).toISOString(),
    ).toBe("2026-11-02T06:30:00.000Z");
  });
});
