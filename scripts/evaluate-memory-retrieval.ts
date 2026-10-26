import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { MockModel } from "../src/model.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { loadConfig } from "../src/config.js";
import { writePrivateJson } from "../src/files.js";

const facts = [
  {
    key: "drink",
    text: "测试用户喜欢无糖乌龙茶，不喝咖啡。",
    exact: "乌龙茶",
    paraphrase: "我想喝点清爽的、没有甜味的饮品，有什么适合我的？",
  },
  {
    key: "pet",
    text: "测试用户养了一只叫团子的橘猫。",
    exact: "橘猫",
    paraphrase: "家里那位喵星人的名字是什么？",
  },
  {
    key: "food",
    text: "测试用户对花生过敏，点餐时需要避开。",
    exact: "花生",
    paraphrase: "挑餐厅前，我有哪些食物不能碰？",
  },
  {
    key: "work",
    text: "测试用户从事动画分镜设计。",
    exact: "分镜设计",
    paraphrase: "我的职业是做什么的？",
  },
  {
    key: "sleep",
    text: "测试用户平日晚上十一点半准备睡觉。",
    exact: "睡觉",
    paraphrase: "通常几点该跟我道晚安？",
  },
  {
    key: "movie",
    text: "测试用户最喜欢的电影是《海上钢琴师》。",
    exact: "钢琴师",
    paraphrase: "我心目中的银幕佳作是哪一部？",
  },
  {
    key: "address",
    text: "测试用户希望被称呼为阿舟。",
    exact: "阿舟",
    paraphrase: "你该怎么叫我才合我心意？",
  },
  {
    key: "weekend",
    text: "测试用户周末喜欢去公园骑自行车。",
    exact: "自行车",
    paraphrase: "休息日我一般有什么户外爱好？",
  },
  {
    key: "family",
    text: "测试用户姐姐住在成都。",
    exact: "成都",
    paraphrase: "我家那位年长的姐妹在哪座城市定居？",
  },
  {
    key: "focus",
    text: "测试用户工作专注时不希望收到主动消息。",
    exact: "专注",
    paraphrase: "忙着赶稿的时候，我对打扰有什么要求？",
  },
  {
    key: "music",
    text: "测试用户最近在练习木吉他。",
    exact: "木吉他",
    paraphrase: "我最近学的那件六弦乐器是什么？",
  },
  {
    key: "trip",
    text: "测试用户计划下个月去青岛旅行，尚未出发。",
    exact: "青岛",
    paraphrase: "下一次出游我打算去哪里？",
  },
];
const dir = mkdtempSync(join(tmpdir(), "companion-retrieval-"));
const config = loadConfig({ dataDir: dir, modelMode: "mock" });
const store = new Store(dir, LOCAL_SCOPE),
  h = new Harness(store, new MockModel(), config);
const ids = new Map<string, string>();
const results: {
  kind: string;
  query: string;
  expectedKey: string;
  hitAt5: boolean;
  returnedKeys: string[];
}[] = [];
try {
  for (const f of facts) ids.set(h.addMemory({ text: f.text }).id, f.key);
  for (const f of facts)
    for (const kind of ["exact", "paraphrase"] as const) {
      const query = f[kind];
      const hits = store
        .search(query, Date.now(), 5)
        .map((m) => ids.get(m.id) ?? "unknown");
      results.push({
        kind,
        query,
        expectedKey: f.key,
        hitAt5: hits.includes(f.key),
        returnedKeys: hits,
      });
    }
  const safety = h.addMemory({ text: "合成旧偏好：曾喜欢拿铁。" });
  h.forget(
    safety.sources.map((s) => s.id),
    [],
  );
  const report = {
    at: new Date().toISOString(),
    scope: "synthetic_12_facts_24_queries_no_embedding_baseline",
    method: "current_store_search_top5",
    results,
    summary: Object.fromEntries(
      ["exact", "paraphrase"].map((kind) => {
        const rows = results.filter((r) => r.kind === kind);
        return [
          kind,
          {
            queries: rows.length,
            hits: rows.filter((r) => r.hitAt5).length,
            recallAt5: rows.filter((r) => r.hitAt5).length / rows.length,
          },
        ];
      }),
    ),
    forgottenExcluded: !store
      .search("拿铁", Date.now())
      .some((m) => m.id === safety.id),
    vectorMeasured: false,
  };
  mkdirSync(resolve("data/reports"), { recursive: true, mode: 0o700 });
  writePrivateJson(
    resolve("data/reports/memory-retrieval-baseline.json"),
    report,
  );
  console.log(JSON.stringify(report.summary));
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
}
