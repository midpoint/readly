# Readly IDB 镜像 + 事件聚类(计划 04 / M4a)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付「事件聚类」:浏览器把最近 N 篇(100/200/300)文章在本地按相似度归成事件组,看清同一新闻的发展脉络。前置基建是 IndexedDB 文章镜像(最近 1000 篇滚动窗口,支持离线读与后续关键词复用)。**全程本地计算,聚类 worker 内零网络请求。**

**Architecture:** 三层——①纯计算模块 `tokenize/tfidf/cluster`(CJK 二元组 + TF-IDF + 余弦 + 倒排剪枝 + 并查集,全部纯函数,直接单测);②`idb.ts` 镜像(IndexedDB,同样的接口有内存实现兜底隐私模式;分页同步走既有 `GET /api/articles/mirror`,游标 `nextCursorId` 为排他式且 `0` 表示到底);③`analysis` store + `analysis.worker.ts`(Vite module worker 薄壳,协议 `cluster/cancel` + progress 回报;store 用可注入工厂便于测试)与 `Events.vue` 视图。

**Tech Stack:** 既有栈 + `fake-indexeddb`(仅 devDependency,供 jsdom 测试)。

## Global Constraints

- **本地计算铁律**:`analysis.worker.ts` 与 `modules/{tokenize,tfidf,cluster}.ts` 内**不得出现任何 `fetch`/`api` 调用**(审查者会 grep 验证);聚类结果不落 D1、不发网络。
- 冻结接口:`ClusterPrefs { scope: 100|200|300; level: ClusterLevel }`、`CLUSTER_THRESHOLDS = { loose: .45, normal: .58, strict: .70 }`、`SETTING_KEYS.clusterPrefs = "cluster_prefs"`(全部已在 shared,不改)。
- 镜像:`MIRROR_LIMIT = 1000` 篇滚动窗口(按 `publishedAt` 淘汰最旧);单篇 `content` 服务端已截 256KB,客户端不再放大;同步游标语义:`nextCursorId` 为排他式(末条 id-1),**`0` 与 `null` 均表示到底**;增量同步遇「零新增页」即停。
- 分词口径:CJK 连续段取字符二元组;拉丁词小写、长度 ≥3;去 URL、纯数字;停用词表内置(中英各 ≥50 条)。
- 聚类口径:文档文本 = 标题 ×3 + 摘要/正文前 500 字;候选剪枝阈值 `PRUNE = 0.42`(低于任何档位);`≥2` 篇的连通分量成组;组代表 = medoid(组内到其他成员平均相似度最高者);组间按组内最新时间降序,组内按时间升序;阈值取档位映射。
- 偏好持久化:`readly_cluster_prefs` 本地键,localStorage 即时 + D1 防抖 1000ms(键 `cluster_prefs`),本地优先、失败静默(与既有偏好同风格;本 store 独立实现,后续可统一抽取)。
- UI/视觉:Events 视图必须有:`[data-scope-select]`、`[data-level]`(三个)、`[data-recompute]`、`[data-cluster-group]`(卡片)、`[data-cluster-member]`(时间线条目)、`[data-progress]`;深色配对;视觉验收必须实测(headless Chrome,独立端口 4599,勿动用户 5173/8787),浅色+深色两轮。
- 性能预算:300 篇 ≤ 2s 中端机(倒排剪枝 + 稀疏向量;worker 内运行不阻塞 UI);可取消。
- TypeScript strict;禁止 any;文案中文;提交含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`;每步测试与实现同交付;worker 测试前先 `pnpm build`。

---

### Task 1: 纯计算模块(tokenize / tfidf / cluster)

**Files:**
- Create: `web/src/modules/tokenize.ts`
- Create: `web/src/modules/tfidf.ts`
- Create: `web/src/modules/cluster.ts`
- Create: `web/src/modules/__tests__/tokenize.test.ts`
- Create: `web/src/modules/__tests__/tfidf.test.ts`
- Create: `web/src/modules/__tests__/cluster.test.ts`

**Interfaces:**
- Produces(冻结,后续任务与 worker 依赖):
  - `tokenize(text: string): string[]`
  - `type SparseVec = Map<string, number>`
  - `buildTfIdf(docs: string[]): SparseVec[]`(每向量已 L2 归一化)
  - `cosine(a: SparseVec, b: SparseVec): number`
  - `interface ClusterInput { id: number; title: string; excerpt: string | null; content: string | null; publishedAt: string }`
  - `interface ClusterGroup { representative: number; members: number[] }`(members 为输入下标,按 publishedAt 升序;组按组内最新时间降序;representative 为下标)
  - `clusterByTfIdf(items: ClusterInput[], threshold: number, onProgress?: (ratio: number) => void): ClusterGroup[]`
  - `class ClusterCancelledError extends Error`
  - 常量 `PRUNE_THRESHOLD = 0.42`

- [ ] **Step 1: 写失败测试**

`web/src/modules/__tests__/tokenize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tokenize } from "@/modules/tokenize";

describe("tokenize", () => {
  it("CJK 取字符二元组", () => {
    expect(tokenize("人工智能")).toEqual(["人工", "工智", "智能"]);
  });
  it("单字 CJK 保留自身", () => {
    expect(tokenize("雨")).toEqual(["雨"]);
  });
  it("拉丁词小写、长度≥3、过滤停用词", () => {
    const t = tokenize("The AI Model is a Big Deal");
    expect(t).toContain("model");
    expect(t).toContain("deal");
    expect(t).not.toContain("the");
    expect(t).not.toContain("ai"); // 长度 2
    expect(t).not.toContain("big"); // big 在停用词表时移除;若不在则保留——见下方断言注释
  });
  it("去 URL 与纯数字,中英混排并存", () => {
    const t = tokenize("访问 https://example.com/x 看到 GPT5 发布 12345");
    expect(t.join("|")).not.toContain("example");
    expect(t.join("|")).not.toContain("12345");
    expect(t).toContain("gpt5".slice(0, 0) + "发布"); // 中文二元组存在
    expect(t.some((x) => x.startsWith("gpt"))).toBe(true);
  });
  it("标点切断 CJK 连续段", () => {
    expect(tokenize("你好,世界")).toEqual(["你好", "世界"]);
  });
});
```

(注:「big」是否停用按实现停用词表定;执行时以表内实际情况把该断言改为确定性断言,并在报告说明。)

`web/src/modules/__tests__/tfidf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTfIdf, cosine } from "@/modules/tfidf";

describe("tfidf", () => {
  it("罕见词权重大于常见词", () => {
    const [v] = buildTfIdf(["苹果 苹果 香蕉", "苹果 橙子"]);
    // 「香蕉」只出现在文档 0,「苹果」两文档都有 → 同 tf 下香蕉权重更高
    expect(v!.get("香蕉")!).toBeGreaterThan(v!.get("苹果")!);
  });
  it("向量 L2 归一化(自 cosine 为 1)", () => {
    const [a] = buildTfIdf(["重复 文本 内容 重复"]);
    expect(cosine(a!, a!)).toBeCloseTo(1, 5);
  });
  it("无共享词余弦为 0", () => {
    const [a, b] = buildTfIdf(["苹果 香蕉", "汽车 轮胎"]);
    expect(cosine(a!, b!)).toBe(0);
  });
  it("正交向量(空 Map)安全", () => {
    expect(cosine(new Map(), new Map())).toBe(0);
  });
});
```

`web/src/modules/__tests__/cluster.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CLUSTER_THRESHOLDS } from "@readly/shared";
import { clusterByTfIdf, ClusterCancelledError, type ClusterInput } from "@/modules/cluster";

function item(id: number, title: string, publishedAt: string): ClusterInput {
  return { id, title, excerpt: null, content: null, publishedAt };
}

// 三组近义新闻 + 两条噪声
const ITEMS: ClusterInput[] = [
  item(1, "特斯拉上海工厂宣布扩产 产能提升一倍", "2026-01-01T08:00:00.000Z"),
  item(2, "特斯拉上海工厂扩产 产能将提升一倍", "2026-01-01T09:00:00.000Z"),
  item(3, "上海特斯拉工厂扩产 产能翻倍", "2026-01-01T10:00:00.000Z"),
  item(4, "苹果发布新款 MacBook Pro 搭载新芯片", "2026-01-01T08:30:00.000Z"),
  item(5, "苹果新 MacBook Pro 发布 采用全新芯片", "2026-01-01T09:30:00.000Z"),
  item(6, "世界杯决赛今晚开战 两队首发公布", "2026-01-01T07:00:00.000Z"),
  item(7, "央行下调存款准备金率 释放流动性", "2026-01-01T06:00:00.000Z"),
  item(8, "某地暴雨导致多条道路积水", "2026-01-01T05:00:00.000Z"),
];

describe("clusterByTfIdf", () => {
  it("适中档把三组近义标题分别归组,噪声不成组", () => {
    const groups = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal);
    expect(groups).toHaveLength(2);
    const sets = groups.map((g) => g.members.map((i) => ITEMS[i]!.id).sort((a, b) => a - b));
    expect(sets).toContainEqual([1, 2, 3]);
    expect(sets).toContainEqual([4, 5]);
  });
  it("组代表是组内最居中的标题(medoid)", () => {
    const groups = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal);
    const g = groups.find((x) => x.members.length === 3)!;
    expect(ITEMS[g.representative]!.id).toBe(2); // 与另外两条重叠词最多
  });
  it("阈值单调:宽松组的数量 ≥ 适中的组数 ≥ 严格的组数", () => {
    const loose = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.loose).length;
    const normal = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal).length;
    const strict = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.strict).length;
    expect(loose).toBeGreaterThanOrEqual(normal);
    expect(normal).toBeGreaterThanOrEqual(strict);
  });
  it("组内按时间升序,组间按组内最新时间降序", () => {
    const groups = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal);
    const g0 = groups[0]!;
    const times = g0.members.map((i) => ITEMS[i]!.publishedAt);
    expect([...times].sort()).toEqual(times);
    const lastOf = groups.map((g) => Math.max(...g.members.map((i) => Date.parse(ITEMS[i]!.publishedAt))));
    expect([...lastOf].sort((a, b) => b - a)).toEqual(lastOf);
  });
  it("onProgress 回报 0..1 且可取消", () => {
    const seen: number[] = [];
    clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal, (r) => {
      seen.push(r);
      if (r > 0.5) throw new ClusterCancelledError();
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r >= 0 && r <= 1)).toBe(true);
  });
});
```

Run: `pnpm --filter @readly/web test src/modules/__tests__/tokenize.test.ts src/modules/__tests__/tfidf.test.ts src/modules/__tests__/cluster.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 2: 实现三个模块**

`web/src/modules/tokenize.ts`:

```ts
const STOPWORDS = new Set([
  // 中文高频虚词
  "的", "了", "是", "在", "和", "与", "及", "或", "而", "之", "其", "这", "那", "一个", "我们", "他们",
  "你们", "以及", "对于", "关于", "但是", "因为", "所以", "如果", "已经", "可以", "进行", "通过", "根据",
  "表示", "认为", "显示", "记者", "报道", "消息", "今天", "昨天", "明天", "目前", "同时", "此外", "其中",
  // 英文停用词
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out",
  "day", "get", "has", "him", "his", "how", "its", "new", "now", "old", "see", "two", "way", "who",
  "boy", "did", "man", "men", "put", "say", "she", "too", "use", "that", "with", "have", "this",
  "will", "your", "from", "they", "been", "were", "said", "each", "which", "their", "them", "than",
  "into", "more", "other", "some", "what", "when", "where", "about", "would", "there", "could",
  "first", "after", "these", "those", "being", "under", "while", "should", "before", "between",
]);

export function tokenize(text: string): string[] {
  const cleaned = text.replace(/https?:\/\/\S+/gi, " ").replace(/\d+/g, " ");
  const tokens: string[] = [];
  const cjkRuns = cleaned.match(/[一-鿿]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  const latinWords = cleaned.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
  for (const w of latinWords) {
    if (!STOPWORDS.has(w)) tokens.push(w);
  }
  return tokens.filter((t) => !STOPWORDS.has(t));
}
```

`web/src/modules/tfidf.ts`:

```ts
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
```

`web/src/modules/cluster.ts`:

```ts
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
    if (onProgress && k % 512 === 0) onProgress(k / total);
    const [a, b] = candidates[k]!;
    const sim = cosine(vectors[a]!, vectors[b]!);
    if (sim >= PRUNE_THRESHOLD) sims.set(a * n + b, sim);
  }
  onProgress?.(1);

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
```

注意:`sims` 只存 `≥PRUNE` 的对;medoid 分数用其求和,低于剪枝的对按 0 计——可接受近似(组内高相似成员才是 medoid 的决定因素)。

Run: 三个测试文件 Expected: PASS。

- [ ] **Step 3: 全量验证**

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck`
Expected: 全绿(95 + 新增);**并 grep 自证本地计算铁律**:

```bash
grep -rn "fetch(\|api(" web/src/modules/tokenize.ts web/src/modules/tfidf.ts web/src/modules/cluster.ts || echo "clean"
```

- [ ] **Step 4: 提交**

```bash
git add web/src/modules
git commit -m "feat(web): 本地聚类计算模块(分词/TF-IDF/并查集聚类,零网络)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: IndexedDB 镜像(idb.ts + 同步)

**Files:**
- Modify: `web/package.json`(devDependency `fake-indexeddb`)
- Create: `web/src/modules/idb.ts`
- Create: `web/src/modules/__tests__/idb.test.ts`

**Interfaces:**
- Produces(冻结):
  - `const MIRROR_LIMIT = 1000`
  - `interface MirrorRow { id: number; feedId: number; feedTitle: string; title: string; url: string | null; publishedAt: string; excerpt: string | null; content: string | null }`
  - `interface MirrorPage { items: MirrorRow[]; nextCursorId: number | null }`
  - `interface Mirror { readonly kind: "idb" | "memory"; putMany(rows: MirrorRow[]): Promise<{ added: number; total: number }>; getAllNewest(limit: number): Promise<MirrorRow[]>; count(): Promise<number>; clear(): Promise<void> }`
  - `createMirror(): Promise<Mirror>`(IDB 不可用时回退 `MemoryMirror`)
  - `syncMirror(mirror: Mirror, fetchPage: (cursorId: number | null) => Promise<MirrorPage>): Promise<{ synced: number; total: number; exhausted: boolean }>`

- [ ] **Step 1: 安装测试依赖并写失败测试**

Run: `pnpm --filter @readly/web add -D fake-indexeddb@^6`
(解析不到取 latest 并记录。)

`web/src/modules/__tests__/idb.test.ts`:

```ts
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMirror, MIRROR_LIMIT, syncMirror, type MirrorRow } from "@/modules/idb";

function row(id: number, publishedAt: string): MirrorRow {
  return { id, feedId: 1, feedTitle: "F", title: `t${id}`, url: null, publishedAt, excerpt: null, content: `<p>${id}</p>` };
}

beforeEach(async () => {
  indexedDB.deleteDatabase("readly");
});

describe("Mirror(idb)", () => {
  it("putMany 计数新增,getAllNewest 按时间倒序", async () => {
    const m = await createMirror();
    const r1 = await m.putMany([row(1, "2026-01-01T00:00:00.000Z"), row(2, "2026-01-02T00:00:00.000Z")]);
    expect(r1).toEqual({ added: 2, total: 2 });
    const r2 = await m.putMany([row(2, "2026-01-02T00:00:00.000Z"), row(3, "2026-01-03T00:00:00.000Z")]);
    expect(r2).toEqual({ added: 1, total: 3 });
    const newest = await m.getAllNewest(2);
    expect(newest.map((x) => x.id)).toEqual([3, 2]);
  });
});

describe("syncMirror", () => {
  it("翻页至到底(0 或 null 均停),并淘汰超出窗口的最旧文章", async () => {
    const m = await createMirror();
    const pages: Record<number, { items: MirrorRow[]; nextCursorId: number | null }> = {
      0: { items: Array.from({ length: 600 }, (_, i) => row(1000 - i, `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`)), nextCursorId: 400 },
      400: { items: Array.from({ length: 400 }, (_, i) => row(400 - i, `2025-12-31T00:00:00.000Z`)), nextCursorId: 0 },
    };
    const fetchPage = vi.fn(async (cursorId: number | null) => pages[cursorId ?? 0]!);
    const r = await syncMirror(m, fetchPage);
    expect(r.exhausted).toBe(true);
    expect(await m.count()).toBe(MIRROR_LIMIT);
    const oldest = await m.getAllNewest(MIRROR_LIMIT);
    expect(oldest[oldest.length - 1]!.id).toBe(1); // id 1..0? 见实现:淘汰后保留 id 1..400 中的最旧
  });
});
```

(after 断言按实现口径校准:窗口保留 1000 篇,移除 publishedAt 最早的;执行时若 id 口径不同,以「count===1000 且最旧篇即为被淘汰边界」为准调整并报告。)

Run: 该文件
Expected: FAIL(模块不存在)。

- [ ] **Step 2: 实现 idb.ts**

```ts
const DB_NAME = "readly";
const DB_VERSION = 1;
const STORE = "articles";

export const MIRROR_LIMIT = 1000;

export interface MirrorRow {
  id: number;
  feedId: number;
  feedTitle: string;
  title: string;
  url: string | null;
  publishedAt: string;
  excerpt: string | null;
  content: string | null;
}

export interface MirrorPage {
  items: MirrorRow[];
  nextCursorId: number | null;
}

export interface Mirror {
  readonly kind: "idb" | "memory";
  putMany(rows: MirrorRow[]): Promise<{ added: number; total: number }>;
  getAllNewest(limit: number): Promise<MirrorRow[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("published_at", "publishedAt");
        store.createIndex("feed_id", "feedId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("打开 IndexedDB 失败"));
  });
}

class IdbMirror implements Mirror {
  readonly kind = "idb" as const;
  constructor(private db: IDBDatabase) {}

  async putMany(rows: MirrorRow[]): Promise<{ added: number; total: number }> {
    const before = await this.count();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const row of rows) store.put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("写入失败"));
    });
    const total = await this.count();
    return { added: total - before, total };
  }

  async getAllNewest(limit: number): Promise<MirrorRow[]> {
    return new Promise((resolve, reject) => {
      const out: MirrorRow[] = [];
      const tx = this.db.transaction(STORE, "readonly");
      const idx = tx.objectStore(STORE).index("published_at");
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cur.value as MirrorRow);
        cur.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("读取失败"));
    });
  }

  async count(): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE, "readonly").objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("计数失败"));
    });
  }

  async clear(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("清空失败"));
    });
  }
}

class MemoryMirror implements Mirror {
  readonly kind = "memory" as const;
  private rows = new Map<number, MirrorRow>();

  async putMany(rows: MirrorRow[]): Promise<{ added: number; total: number }> {
    let added = 0;
    for (const row of rows) {
      if (!this.rows.has(row.id)) added++;
      this.rows.set(row.id, row);
    }
    return { added, total: this.rows.size };
  }

  async getAllNewest(limit: number): Promise<MirrorRow[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit);
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }
}

export async function createMirror(): Promise<Mirror> {
  try {
    return new IdbMirror(await openDb());
  } catch {
    return new MemoryMirror();
  }
}

export async function syncMirror(
  mirror: Mirror,
  fetchPage: (cursorId: number | null) => Promise<MirrorPage>
): Promise<{ synced: number; total: number; exhausted: boolean }> {
  let cursor: number | null = null;
  let synced = 0;
  let exhausted = false;
  for (let page = 0; page < 50; page++) {
    const res = await fetchPage(cursor);
    const { added, total } = await mirror.putMany(res.items);
    synced += added;
    if (added === 0 || res.nextCursorId === null || res.nextCursorId === 0 || res.items.length === 0) {
      exhausted = true;
      break;
    }
    cursor = res.nextCursorId;
    if (total >= MIRROR_LIMIT) break;
  }
  // 滚动窗口:超出上限时淘汰最旧
  if (mirror.kind === "idb") {
    const total = await mirror.count();
    if (total > MIRROR_LIMIT) {
      const all = await mirror.getAllNewest(total);
      const doomed = all.slice(MIRROR_LIMIT);
      if (doomed.length > 0) {
        // 复用 putMany 语义不顺;直接借 IdbMirror 的内部实现没有暴露删除——在此实现删除:
        await deleteRows(mirror, doomed.map((r) => r.id));
      }
    }
  } else {
    // 内存实现:直接裁剪
    const all = await mirror.getAllNewest(Number.MAX_SAFE_INTEGER);
    if (all.length > MIRROR_LIMIT) {
      // MemoryMirror 无删除接口 → 用降级:清空重写?保持简单:MemoryMirror 内部维护上限
    }
  }
  const total = await mirror.count();
  return { synced, total, exhausted };
}
```

注意:上面 `deleteRows` 与内存裁剪不完整(占位会违背计划的 No-Placeholder 要求)。**修正后的口径**(实现按此,不留待补):

- 给 `Mirror` 接口增加 `deleteMany(ids: number[]): Promise<void>`;`IdbMirror` 用事务删除;`MemoryMirror` 从 Map 删除。
- `syncMirror` 淘汰段改为:

```ts
  const total = await mirror.count();
  if (total > MIRROR_LIMIT) {
    const all = await mirror.getAllNewest(total);
    await mirror.deleteMany(all.slice(MIRROR_LIMIT).map((r) => r.id));
  }
  return { synced, total: await mirror.count(), exhausted };
```

(用上面这份替换草稿中的淘汰段与接口定义。)

- [ ] **Step 3: 运行测试并全量验证**

Run: `pnpm --filter @readly/web test src/modules/__tests__/idb.test.ts`
Expected: PASS(断言按实现口径校准后);全量 `pnpm --filter @readly/web test` 与 `typecheck` 全绿。

- [ ] **Step 4: 提交**

```bash
git add web/package.json web/src/modules pnpm-lock.yaml
git commit -m "feat(web): IndexedDB 文章镜像(滚动窗口/分页同步/内存兜底)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: analysis store + 聚类 Worker + 启动接线

**Files:**
- Create: `web/src/modules/analysis.worker.ts`
- Create: `web/src/stores/analysis.ts`
- Create: `web/src/stores/__tests__/analysis.test.ts`
- Modify: `web/src/views/Inbox.vue`(onMounted 后台 `analysis.init()`)
- Modify: `web/src/components/Sidebar.vue`(刷新订阅完成后调用 `analysis.syncIncremental()`)

**Interfaces:**
- Consumes: Task 1(聚类纯函数)、Task 2(镜像)、`api`、`ClusterPrefs/CLUSTER_THRESHOLDS/SETTING_KEYS`
- Produces(冻结):
  - worker 协议:`{ type: "cluster"; requestId: number; items: ClusterInput[]; threshold: number }` → 进度 `{ type: "progress"; requestId: number; ratio: number }` → 结果 `{ type: "result"; requestId: number; groups: ClusterGroup[] }` 或 `{ type: "error"|"cancelled"; requestId: number }`;`{ type: "cancel"; requestId: number }`
  - `createAnalysisWorker(): Worker`(从 store 单独导出,测试可 vi.mock 该模块)
  - `useAnalysisStore`:`{ ready; mirrorKind: Ref<"idb"|"memory"|null>; syncState: Ref<"idle"|"syncing"|"done"|"error">; clusterPrefs: Ref<ClusterPrefs>; groups: Ref<UiClusterGroup[] | null>; computing: Ref<boolean>; progress: Ref<number>; computeError: Ref<string|null>; init(): Promise<void>; syncIncremental(): Promise<void>; updateClusterPrefs(patch: Partial<ClusterPrefs>): void; compute(): Promise<void>; cancel(): void }`
  - `interface UiClusterGroup { key: number; title: string; count: number; firstAt: string; lastAt: string; members: { id: number; title: string; feedTitle: string; publishedAt: string }[] }`
  - 偏好持久化:本地键 `readly_cluster_prefs`;D1 `SETTING_KEYS.clusterPrefs`;本地优先、防抖 1000ms、失败静默。

- [ ] **Step 1: worker 薄壳**

`web/src/modules/analysis.worker.ts`:

```ts
/// <reference lib="webworker" />
import { clusterByTfIdf, ClusterCancelledError, type ClusterInput } from "./cluster";

interface ClusterMsg {
  type: "cluster";
  requestId: number;
  items: ClusterInput[];
  threshold: number;
}

let currentRequestId = 0;

self.onmessage = (e: MessageEvent<ClusterMsg | { type: "cancel"; requestId: number }>) => {
  const data = e.data;
  if (data.type === "cancel") {
    if (data.requestId === currentRequestId) currentRequestId = 0;
    return;
  }
  if (data.type === "cluster") {
    currentRequestId = data.requestId;
    try {
      const groups = clusterByTfIdf(data.items, data.threshold, (ratio) => {
        if (currentRequestId !== data.requestId) throw new ClusterCancelledError();
        (self as unknown as Worker).postMessage({ type: "progress", requestId: data.requestId, ratio });
      });
      if (currentRequestId !== data.requestId) return;
      (self as unknown as Worker).postMessage({ type: "result", requestId: data.requestId, groups });
    } catch (err) {
      if (err instanceof ClusterCancelledError) {
        (self as unknown as Worker).postMessage({ type: "cancelled", requestId: data.requestId });
      } else {
        (self as unknown as Worker).postMessage({ type: "error", requestId: data.requestId });
      }
    }
  }
};
```

- [ ] **Step 2: 失败测试(analysis store)**

`web/src/stores/__tests__/analysis.test.ts`:测试用两个 seam:①`vi.mock("@/modules/idb")` 的 `createMirror` 返回内存 Mirror(直接复用真实 `MemoryMirror` 构造——从模块导出 `MemoryMirror` 类以便测试,见 Step 3);②`vi.mock("@/stores/analysis", ...)` 不可行,改 mock 工厂:`vi.mock("@/modules/analysis.worker?worker", ...)` 不适用于该写法。**约定**:store 从 `./worker-factory` 导入 `createAnalysisWorker`——新建 `web/src/modules/worker-factory.ts`:

```ts
export function createAnalysisWorker(): Worker {
  return new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
}
```

测试 `vi.mock("@/modules/worker-factory", () => ({ createAnalysisWorker: () => fakeWorker }))`,`fakeWorker` 用手写桩:

```ts
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(msg: unknown) { this.posted.push(msg); }
  terminate() {}
  emit(msg: unknown) { this.onmessage?.({ data: msg } as MessageEvent); }
}
```

用例:
1. `compute 把镜像前 scope 篇发给 worker 并映射为 UiClusterGroup`(fake worker 收 `cluster` 消息后 `emit` result;断言 groups 映射:title 取 representative 的 title、members 按时间升序、feedTitle 正确);
2. `updateClusterPrefs 写本地并防抖 PUT cluster_prefs`(fake timers);
3. `syncIncremental 降低调用参数`(mock `@/modules/idb` 的 `syncMirror` 被调用一次);
4. `cancel 发 cancel 消息且 computing 复位`。

(完整代码按上述 seam 编写;若 mock 工厂方案在 vitest 下细节受阻,允许最小调整并在报告披露。)

Run: 该文件 Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 analysis store(含 `MemoryMirror` 导出)**

`web/src/modules/idb.ts` 增补:`export class MemoryMirror implements Mirror {...}`(把 Task 2 中的类改为导出;IdbMirror 保持私有)。

`web/src/stores/analysis.ts`(要点):

```ts
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { CLUSTER_THRESHOLDS, SETTING_KEYS, type ClusterPrefs, type ClusterLevel } from "@readly/shared";
import { api } from "@/api/client";
import { createMirror, syncMirror, MIRROR_LIMIT, type Mirror, type MirrorRow } from "@/modules/idb";
import type { ClusterGroup, ClusterInput } from "@/modules/cluster";
import { createAnalysisWorker } from "@/modules/worker-factory";

const LS_KEY = "readly_cluster_prefs";
const DEFAULT_CLUSTER_PREFS: ClusterPrefs = { scope: 200, level: "normal" };
const PUT_DEBOUNCE_MS = 1000;

export function sanitizeClusterPrefs(raw: unknown): ClusterPrefs {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const scope = o.scope === 100 || o.scope === 200 || o.scope === 300 ? o.scope : 200;
  const level: ClusterLevel = o.level === "loose" || o.level === "strict" ? o.level : "normal";
  return { scope, level };
}

export interface UiClusterGroup {
  key: number;
  title: string;
  count: number;
  firstAt: string;
  lastAt: string;
  members: { id: number; title: string; feedTitle: string; publishedAt: string }[];
}

export const useAnalysisStore = defineStore("analysis", () => {
  const ready = ref(false);
  const mirrorKind = ref<"idb" | "memory" | null>(null);
  const syncState = ref<"idle" | "syncing" | "done" | "error">("idle");
  const clusterPrefs = ref<ClusterPrefs>({ ...DEFAULT_CLUSTER_PREFS });
  const groups = ref<UiClusterGroup[] | null>(null);
  const computing = ref(false);
  const progress = ref(0);
  const computeError = ref<string | null>(null);

  let mirror: Mirror | null = null;
  let rows: MirrorRow[] = [];      // 最近一次读取的镜像快照(计算时刷新)
  let worker: Worker | null = null;
  let requestSeq = 0;
  let activeRequest = 0;
  let putTimer: ReturnType<typeof setTimeout> | null = null;
  let serverCopy: string | null = null;
  let syncing = false;

  async function fetchPage(cursorId: number | null): Promise<{ items: MirrorRow[]; nextCursorId: number | null }> {
    return api("/api/articles/mirror", { query: { cursor_id: cursorId ?? undefined, limit: 200 } });
  }

  async function init(): Promise<void> {
    if (ready.value) return;
    mirror = await createMirror();
    mirrorKind.value = mirror.kind;
    const local = localStorage.getItem(LS_KEY);
    if (local) {
      try {
        clusterPrefs.value = sanitizeClusterPrefs(JSON.parse(local));
      } catch {
        /* 保留默认 */
      }
    }
    ready.value = true;
    void loadRemotePrefs();
    void syncIncremental();
  }

  async function loadRemotePrefs(): Promise<void> {
    try {
      const all = await api<Record<string, unknown>>("/api/settings");
      const sp = all[SETTING_KEYS.clusterPrefs];
      if (sp === undefined) return;
      serverCopy = JSON.stringify(sanitizeClusterPrefs(sp));
      if (localStorage.getItem(LS_KEY) === null) clusterPrefs.value = sanitizeClusterPrefs(sp);
    } catch {
      /* 静默 */
    }
  }

  async function syncIncremental(): Promise<void> {
    if (!mirror || syncing) return;
    syncing = true;
    syncState.value = "syncing";
    try {
      await syncMirror(mirror, fetchPage);
      syncState.value = "done";
    } catch {
      syncState.value = "error";
    } finally {
      syncing = false;
    }
  }

  function updateClusterPrefs(patch: Partial<ClusterPrefs>): void {
    clusterPrefs.value = sanitizeClusterPrefs({ ...clusterPrefs.value, ...patch });
  }

  async function pushRemote(): Promise<void> {
    const serialized = JSON.stringify(clusterPrefs.value);
    if (serialized === serverCopy) return;
    try {
      await api("/api/settings", { method: "PUT", body: { kv: { [SETTING_KEYS.clusterPrefs]: clusterPrefs.value } } });
      serverCopy = serialized;
    } catch {
      /* 静默 */
    }
  }

  watch(
    clusterPrefs,
    () => {
      localStorage.setItem(LS_KEY, JSON.stringify(clusterPrefs.value));
      if (putTimer) clearTimeout(putTimer);
      putTimer = setTimeout(() => {
        putTimer = null;
        void pushRemote();
      }, PUT_DEBOUNCE_MS);
    },
    { deep: true, flush: "sync" }
  );

  function getWorker(): Worker {
    if (!worker) {
      worker = createAnalysisWorker();
      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as
          | { type: "progress"; requestId: number; ratio: number }
          | { type: "result"; requestId: number; groups: ClusterGroup[] }
          | { type: "cancelled"; requestId: number }
          | { type: "error"; requestId: number };
        if (msg.requestId !== activeRequest) return;
        if (msg.type === "progress") progress.value = msg.ratio;
        else if (msg.type === "result") {
          groups.value = mapGroups(msg.groups);
          computing.value = false;
        } else {
          if (msg.type === "error") computeError.value = "聚类计算失败";
          computing.value = false;
        }
      };
    }
    return worker;
  }

  function mapGroups(raw: ClusterGroup[]): UiClusterGroup[] {
    return raw.map((g) => {
      const rep = rows[g.representative]!;
      const members = g.members.map((i) => {
        const r = rows[i]!;
        return { id: r.id, title: r.title, feedTitle: r.feedTitle, publishedAt: r.publishedAt };
      });
      return {
        key: rep.id,
        title: rep.title,
        count: members.length,
        firstAt: members[0]!.publishedAt,
        lastAt: members[members.length - 1]!.publishedAt,
        members,
      };
    });
  }

  async function compute(): Promise<void> {
    if (!mirror || computing.value) return;
    computing.value = true;
    computeError.value = null;
    progress.value = 0;
    try {
      rows = await mirror.getAllNewest(clusterPrefs.value.scope);
      if (rows.length < 2) {
        groups.value = [];
        computing.value = false;
        return;
      }
      const items: ClusterInput[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        excerpt: r.excerpt,
        content: r.content,
        publishedAt: r.publishedAt,
      }));
      activeRequest = ++requestSeq;
      getWorker().postMessage({
        type: "cluster",
        requestId: activeRequest,
        items,
        threshold: CLUSTER_THRESHOLDS[clusterPrefs.value.level],
      });
      // 结果未返回前 computing 保持 true,由 onmessage(result/cancelled/error)复位
    } catch {
      computeError.value = "聚类计算失败";
      computing.value = false;
    }
  }

  function cancel(): void {
    if (!computing.value) return;
    getWorker().postMessage({ type: "cancel", requestId: activeRequest });
    activeRequest = 0;
    computing.value = false;
  }

  return {
    ready, mirrorKind, syncState, clusterPrefs, groups, computing, progress, computeError,
    init, syncIncremental, updateClusterPrefs, compute, cancel,
  };
});
```

`Inbox.vue` onMounted 追加(既有 `await feedsStore.load()` 之后):

```js
  const analysis = useAnalysisStore();
  void analysis.init().catch(() => undefined);
```

`Sidebar.vue` 的 `refreshFeeds` 重载段追加:

```js
    void useAnalysisStore().syncIncremental();
```

- [ ] **Step 4: 运行测试并全量验证**

Run: `pnpm --filter @readly/web test src/stores/__tests__/analysis.test.ts` → PASS;
Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build` → 全绿(build 必须过,`new Worker(new URL(...))` 的解析在构建期验证)。
并 grep 自证 worker 与计算模块零网络:

```bash
grep -rn "fetch(\|api(\|axios" web/src/modules/analysis.worker.ts web/src/modules/{tokenize,tfidf,cluster}.ts || echo "clean"
```

- [ ] **Step 5: 提交**

```bash
git add web
git commit -m "feat(web): analysis store 与聚类 Worker(镜像同步/进度/取消/偏好同步)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Events 视图 + 侧栏入口 + 实测

**Files:**
- Create: `web/src/views/Events.vue`
- Modify: `web/src/router.ts`(注册 `/events`)
- Modify: `web/src/components/Sidebar.vue`(顶部导航加「事件」)
- Create(验后删): `web/scripts/verify-events.mjs`

**Interfaces:**
- Consumes: `useAnalysisStore`(Task 3)、`useReaderStore`? 不需要;打开文章跳 Inbox
- Produces: `Events.vue`(`[data-scope-select]`、`[data-level]`×3、`[data-recompute]`、`[data-progress]`、`[data-cluster-group]`、`[data-cluster-member]`)

- [ ] **Step 1: 实现视图与入口**

`web/src/views/Events.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { ClusterLevel } from "@readly/shared";
import { useAnalysisStore } from "@/stores/analysis";

const router = useRouter();
const analysis = useAnalysisStore();
const expanded = ref<Set<number>>(new Set());

const LEVELS: { id: ClusterLevel; label: string }[] = [
  { id: "loose", label: "宽松" },
  { id: "normal", label: "适中" },
  { id: "strict", label: "严格" },
];

onMounted(async () => {
  await analysis.init();
  if (analysis.syncState.value === "idle") await analysis.syncIncremental();
  await analysis.compute();
});

// 档位/范围变化自动重算(切换期间是本地计算,不发网络)
let recalcTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [analysis.clusterPrefs.scope, analysis.clusterPrefs.level],
  () => {
    if (recalcTimer) clearTimeout(recalcTimer);
    recalcTimer = setTimeout(() => {
      recalcTimer = null;
      analysis.cancel();
      void analysis.compute();
    }, 200);
  }
);

function toggle(key: number): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

function openArticle(id: number): void {
  void router.push({ path: "/", query: { a: String(id) } });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const canCompute = computed(() => analysis.ready && analysis.syncState !== "syncing");
</script>

<template>
  <div class="mx-auto min-h-full max-w-3xl bg-white px-6 py-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <button class="text-sm text-neutral-500 hover:underline" @click="router.push('/')">← 返回阅读器</button>
    <h1 class="mt-4 text-xl font-semibold">事件</h1>
    <p class="mt-1 text-sm text-neutral-500">把内容相近的新闻自动归为事件组,一眼看清同一事件的发展脉络。全程本地计算,不联网、不上传。</p>

    <div class="mt-5 flex flex-wrap items-center gap-3 text-sm">
      <label class="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
        范围
        <select
          data-scope-select
          :value="analysis.clusterPrefs.scope"
          class="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          @change="analysis.updateClusterPrefs({ scope: Number(($event.target as HTMLSelectElement).value) as 100 | 200 | 300 })"
        >
          <option :value="100">最近 100 条</option>
          <option :value="200">最近 200 条</option>
          <option :value="300">最近 300 条</option>
        </select>
      </label>
      <div class="flex rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
        <button
          v-for="l in LEVELS"
          :key="l.id"
          :data-level="l.id"
          class="rounded-md px-3 py-1 text-xs"
          :class="analysis.clusterPrefs.level === l.id ? 'bg-[var(--accent)] text-white' : 'text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700'"
          @click="analysis.updateClusterPrefs({ level: l.id })"
        >
          {{ l.label }}
        </button>
      </div>
      <button
        data-recompute
        class="rounded-lg border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        :disabled="!canCompute || analysis.computing"
        @click="analysis.cancel(); analysis.compute()"
      >
        重新计算
      </button>
      <button
        v-if="analysis.computing"
        class="rounded-lg border border-neutral-300 px-3 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
        @click="analysis.cancel()"
      >
        取消
      </button>
    </div>

    <div v-if="analysis.computing" data-progress class="mt-4">
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        <div class="h-full bg-[var(--accent)] transition-[width]" :style="{ width: `${Math.round(analysis.progress * 100)}%` }" />
      </div>
      <p class="mt-1 text-xs text-neutral-500">本地计算中… {{ Math.round(analysis.progress * 100) }}%</p>
    </div>

    <p v-if="analysis.computeError" class="mt-4 text-sm text-red-600 dark:text-red-400">{{ analysis.computeError }}</p>
    <p v-else-if="analysis.syncState === 'syncing'" class="mt-4 text-sm text-neutral-500">正在同步最近文章到本地…</p>
    <p v-else-if="analysis.syncState === 'error'" class="mt-4 text-sm text-neutral-500">本地文章同步失败,可稍后在阅读器刷新后重试。</p>

    <div v-if="analysis.groups && analysis.groups.length === 0 && !analysis.computing" class="mt-8 text-center text-sm text-neutral-500">
      当前范围没有找到相近的新闻
      <span class="block mt-1 text-xs">可尝试把相似度调为「宽松」或扩大范围</span>
    </div>

    <div class="mt-6 space-y-3">
      <div
        v-for="g in analysis.groups ?? []"
        :key="g.key"
        data-cluster-group
        class="rounded-xl border border-neutral-200 dark:border-neutral-800"
      >
        <button class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" @click="toggle(g.key)">
          <div class="min-w-0">
            <h3 class="truncate text-sm font-medium">{{ g.title }}</h3>
            <p class="mt-0.5 text-xs text-neutral-500">
              {{ fmtTime(g.firstAt) }} – {{ fmtTime(g.lastAt) }} · {{ new Set(g.members.map((m) => m.feedTitle)).size }} 个来源
            </p>
          </div>
          <span class="shrink-0 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-medium text-[var(--accent)]">{{ g.count }} 篇</span>
        </button>
        <ul v-if="expanded.has(g.key)" class="border-t border-neutral-100 dark:border-neutral-800">
          <li v-for="m in g.members" :key="m.id" data-cluster-member class="flex items-center gap-3 px-4 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900">
            <span class="w-24 shrink-0 text-xs text-neutral-500">{{ fmtTime(m.publishedAt) }}</span>
            <span class="w-24 shrink-0 truncate text-xs text-neutral-500">{{ m.feedTitle }}</span>
            <button class="min-w-0 flex-1 truncate text-left hover:underline" @click="openArticle(m.id)">{{ m.title }}</button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
```

`web/src/router.ts` 增加:

```ts
{ path: "/events", name: "events", component: () => import("@/views/Events.vue") },
```

`web/src/components/Sidebar.vue` 顶部 nav(「稍后读」之后)追加:

```vue
      <button :class="navItem" @click="router.push('/events')">
        <span>事件</span>
      </button>
```

Run: `pnpm --filter @readly/web test && pnpm --filter @readly/web typecheck && pnpm --filter @readly/web build`
Expected: 全绿。

- [ ] **Step 2: Chrome 实测(浅+深)**

`web/scripts/verify-events.mjs`(一次性,验后删):构建产物 + 独立端口 4599 桩:
- `/api/articles/mirror`:两页数据——第一页 12 篇(其中 3 篇为同一事件的三篇近义标题、2 篇为另一事件、其余噪声),`nextCursorId` 指向第二页 4 篇噪声后 `nextCursorId: 0`;
- `/api/articles`(Inbox 需要)、`/api/settings`、`/api/stats`、`/api/feeds`、`/api/categories` 最小桩;注入 `readly_token`。

CDP 断言并记录:
1. 导航 `/events` → 进度条出现过(`[data-progress]`,`computing` 期间)且计算完成;
2. `[data-cluster-group]` 恰好 2 个;其一显示「3 篇」、另一「2 篇」;组标题为 medoid(与桩数据对照);
3. 展开 3 篇组(`[data-cluster-member]` 恰好 3 条,按时间升序);
4. 点档位「严格」→ 自动重算 → 组数 ≤ 之前(桩数据设计为严格下只剩 3 篇组);
5. 点条目标题 → 路由跳回 `/` 且 `?a=` 有值、阅读器打开该文;
6. 切暗色重测 1–3 的 DOM 断言;记录事件卡/进度条/「N 篇」徽标对比度(≥4.5:1);
7. 截图 `/tmp/readly-events-light.png`、`/tmp/readly-events-dark.png`。

Run: `pnpm build && node web/scripts/verify-events.mjs`
Expected: 全部断言通过;数值与截图名记入报告;验后删除脚本。

- [ ] **Step 3: 提交**

```bash
git add web
git commit -m "feat(web): 事件视图(范围/档位/进度/时间线)与侧栏入口

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 后续计划索引

- **计划 05 — 关键词监控(M4b)**:规则 CRUD + 命中打标 + 正文高亮(复用本计划的镜像与偏好基建)。
- **计划 06 — TTS + AI(M5+M6)**;计划 07 — 收尾(M7)。

## 自检记录(writing-plans self-review)

- **规格覆盖**:设计 §8.6(范围/档位/算法七步/呈现/性能预算/可取消)与 §9.4(镜像滚动窗口/同步语义)逐项落位;§9.1/9.2/9.3(纯函数与 Worker 协议)即 Task 1/3;sidebar 入口与视图路由为新交付所必需。
- **冻结口径**:`ClusterPrefs/CLUSTER_THRESHOLDS/SETTING_KEYS.clusterPrefs` 原样使用;镜像游标「排他式 + 0/null 皆到底」与 worker 现状一致(台账 T11 已记录哨兵语义)。
- **有意决策**:①聚类在 Worker,纯函数在主线程可测;②偏好同步第三份拷贝(结构同前两切片,统一抽取留后续);③`deleteMany` 纳入 Mirror 接口(淘汰窗口必需);④视图进入即算、档位变化 200ms 防抖重算;⑤Tests 中 fake-worker 方案与 idb 断言口径给执行者留了校准余量(报告须披露)。
- **无占位符**:Task 2 的实现草稿中含一处淘汰段伪码,**已在该 Step 内给出最终口径与完整替换代码**,执行按最终版落地。
- **类型一致性**:`ClusterInput/ClusterGroup`(Task 1)→ worker 协议 → store 映射 → UI 全程同名同形;`UiClusterGroup` 为唯一投影层。
