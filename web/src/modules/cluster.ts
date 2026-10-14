import { buildTfIdf, cosine, type SparseVec } from "./tfidf";

export const PRUNE_THRESHOLD = 0.42;

export interface ClusterInput {
  id: number;
  title: string;
  excerpt: string | null;
  content: string | null;
  publishedAt: string;
}

export interface ClusterGroup {
  representative: number;
  members: number[];
}

export class ClusterCancelledError extends Error {
  constructor() {
    super("聚类已取消");
    this.name = "ClusterCancelledError";
  }
}

function buildDocText(item: ClusterInput): string {
  const body = (item.excerpt ?? item.content ?? "").slice(0, 500);
  // 标题权重 ×3:重复三次参与词频
  return `${item.title} ${item.title} ${item.title} ${body}`;
}

export function clusterByTfIdf(
  items: ClusterInput[],
  threshold: number,
  onProgress?: (ratio: number) => void
): ClusterGroup[] {
  const n = items.length;
  if (n < 2) return [];

  // onProgress 抛 ClusterCancelledError 视为取消:静默中止,返回空结果;
  // 其他异常照常抛出
  const report = (ratio: number): boolean => {
    if (!onProgress) return true;
    try {
      onProgress(ratio);
      return true;
    } catch (e) {
      if (e instanceof ClusterCancelledError) return false;
      throw e;
    }
  };

  const vectors = buildTfIdf(items.map(buildDocText));

  // 倒排索引:term → 文档下标
  const inverted = new Map<string, number[]>();
  vectors.forEach((vec, idx) => {
    for (const term of vec.keys()) {
      const list = inverted.get(term);
      if (list) list.push(idx);
      else inverted.set(term, [idx]);
    }
  });

  // 候选对(共享 ≥1 词)与相似度
  const sims = new Map<number, number>(); // key = a * n + b (a < b)
  const seenPairs = new Set<number>();
  const candidates: [number, number][] = [];
  for (const list of inverted.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const key = a * n + b;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          candidates.push([a, b]);
        }
      }
    }
  }

  const total = candidates.length || 1;
  for (let k = 0; k < candidates.length; k++) {
    if (k % 512 === 0 && !report(k / total)) return [];
    const [a, b] = candidates[k]!;
    const sim = cosine(vectors[a]!, vectors[b]!);
    if (sim >= PRUNE_THRESHOLD) sims.set(a * n + b, sim);
  }
  if (!report(1)) return [];

  // 并查集
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const [key, sim] of sims) {
    if (sim >= threshold) union(Math.floor(key / n), key % n);
  }

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = buckets.get(root);
    if (list) list.push(i);
    else buckets.set(root, [i]);
  }

  const groups: ClusterGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => items[a]!.publishedAt.localeCompare(items[b]!.publishedAt));
    // medoid:组内与其余成员平均相似度最高
    let best = members[0]!;
    let bestScore = -1;
    for (const m of members) {
      let sum = 0;
      for (const other of members) {
        if (other === m) continue;
        const a = Math.min(m, other);
        const b = Math.max(m, other);
        sum += sims.get(a * n + b) ?? 0;
      }
      const score = sum / (members.length - 1);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    groups.push({ representative: best, members });
  }

  groups.sort((g1, g2) => {
    const last1 = items[g1.members[g1.members.length - 1]!]!.publishedAt;
    const last2 = items[g2.members[g2.members.length - 1]!]!.publishedAt;
    return last2.localeCompare(last1);
  });
  return groups;
}
