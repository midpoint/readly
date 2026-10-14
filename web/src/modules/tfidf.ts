import { tokenize } from "./tokenize";

export type SparseVec = Map<string, number>;

export function buildTfIdf(docs: string[]): SparseVec[] {
  const tokenized = docs.map((d) => tokenize(d));
  const df = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;
  return tokenized.map((tokens) => {
    const tf = new Map<string, number>();
    for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1);
    const vec: SparseVec = new Map();
    let norm = 0;
    for (const [term, count] of tf) {
      const idf = Math.log((1 + n) / (1 + (df.get(term) ?? 0))) + 1;
      const w = (1 + Math.log(count)) * idf;
      vec.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (const [term, w] of vec) vec.set(term, w / norm);
    }
    return vec;
  });
}

export function cosine(a: SparseVec, b: SparseVec): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, w] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += w * other;
  }
  return dot; // 两侧已 L2 归一化
}
