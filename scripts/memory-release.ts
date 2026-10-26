import { resolve } from "node:path";
import { releaseMemory } from "../src/memory/release.js";
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw Error(`${name} is required`);
  return resolve(args[index + 1]!);
};
const report = await releaseMemory(
  option("--data-dir"),
  option("--artifacts"),
  args.includes("--apply"),
);
console.log(
  JSON.stringify({
    status: report.status,
    roles: report.bots.length,
    allPreserved: report.bots.every((b) => b.preserved),
    embeddingPerformed: false,
    modelCalls: 0,
  }),
);
