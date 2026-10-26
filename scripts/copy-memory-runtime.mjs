import { copyFileSync } from "node:fs";
for (const file of ["embedding-worker.py", "scan-worker.mjs"])
  copyFileSync(
    new URL(`../src/memory/${file}`, import.meta.url),
    new URL(`../dist/memory/${file}`, import.meta.url),
  );
