import { parentPort } from "node:worker_threads";
const partitions = new Map(),
  DIMENSION = 384,
  TOP_K = 12;
parentPort.on("message", (r) => {
  try {
    if (r.kind === "load") {
      let ids, matrix;
      if (r.matrix) {
        ids = r.ids;
        matrix = new Float32Array(r.matrix);
        if (matrix.length !== ids.length * DIMENSION) throw Error();
      } else {
        ids = r.rows.map((row) => row.id);
        matrix = new Float32Array(ids.length * DIMENSION);
        for (let i = 0; i < r.rows.length; i++) {
          const v = new Float32Array(r.rows[i].buffer);
          if (v.length !== DIMENSION) throw Error();
          matrix.set(v, i * DIMENSION);
        }
      }
      partitions.set(r.scope, { generation: r.generation, ids, matrix });
      parentPort.postMessage({ id: r.id, generation: r.generation });
      return;
    }
    if (r.kind === "query") {
      const p = partitions.get(r.scope);
      if (!p || p.generation !== r.generation) throw Error();
      const q = new Float32Array(r.vector),
        mask = new Uint8Array(r.mask);
      if (q.length !== DIMENSION || mask.length !== Math.ceil(p.ids.length / 8))
        throw Error();
      const hits = [],
        matrix = p.matrix;
      for (let row = 0; row < p.ids.length; row++) {
        if (!(mask[row >> 3] & (1 << (row & 7)))) continue;
        let score = 0;
        const start = row * DIMENSION;
        // Keep the addition order identical to scalar cosine scoring.
        for (let i = 0; i < DIMENSION; i += 4) {
          score += q[i] * matrix[start + i];
          score += q[i + 1] * matrix[start + i + 1];
          score += q[i + 2] * matrix[start + i + 2];
          score += q[i + 3] * matrix[start + i + 3];
        }
        const id = p.ids[row],
          last = hits.at(-1);
        if (
          hits.length === TOP_K &&
          (score < last.score ||
            (score === last.score && id.localeCompare(last.id) >= 0))
        )
          continue;
        let at = hits.findIndex(
          (h) =>
            score > h.score ||
            (score === h.score && id.localeCompare(h.id) < 0),
        );
        if (at < 0) at = hits.length;
        hits.splice(at, 0, { id, score });
        if (hits.length > TOP_K) hits.pop();
      }
      parentPort.postMessage({
        id: r.id,
        generation: p.generation,
        scope: r.scope,
        hits,
      });
    }
  } catch {
    parentPort.postMessage({ id: r.id, error: "scan_failed" });
  }
});
