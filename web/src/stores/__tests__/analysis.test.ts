import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTER_THRESHOLDS, SETTING_KEYS, type KeywordRule } from "@readly/shared";
import { api } from "@/api/client";
import { MemoryMirror, createMirror, syncMirror, type Mirror, type MirrorRow } from "@/modules/idb";
import { matchDocs, type MatchDoc } from "@/modules/keywords";
import { createAnalysisWorker } from "@/modules/worker-factory";
import { sanitizeClusterPrefs, useAnalysisStore } from "@/stores/analysis";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

// 真实 MemoryMirror 保留(测试直接构造),仅把 createMirror/syncMirror 换成桩
vi.mock("@/modules/idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/idb")>();
  return { ...actual, createMirror: vi.fn(), syncMirror: vi.fn() };
});

// 手写 worker 桩:vi.hoisted 让工厂在 vi.mock 提升后仍能拿到「当前用例」的桩实例
const hoisted = vi.hoisted(() => ({ worker: null as FakeWorker | null }));

vi.mock("@/modules/worker-factory", () => ({
  createAnalysisWorker: vi.fn(() => hoisted.worker),
}));

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {}
  emit(msg: unknown): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
}

const LS_KEY = "readly_cluster_prefs";
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
const T3 = "2026-01-03T00:00:00.000Z";

function row(id: number, publishedAt: string, overrides: Partial<MirrorRow> = {}): MirrorRow {
  return {
    id,
    feedId: 1,
    feedTitle: `源${id}`,
    title: `标题${id}`,
    url: null,
    publishedAt,
    excerpt: null,
    content: `<p>${id}</p>`,
    ...overrides,
  };
}

// 三篇:镜像按 publishedAt 倒序返回 → 下标 0/1/2 依次为 id 3/2/1
const ROWS: MirrorRow[] = [
  row(1, T1, { title: "事件标题", feedTitle: "源A" }),
  row(2, T2, { title: "无关文章", feedTitle: "源B" }),
  row(3, T3, { title: "同一事件后续", feedTitle: "源C" }),
];

async function seededMirror(): Promise<MemoryMirror> {
  const mirror = new MemoryMirror();
  await mirror.putMany(ROWS);
  return mirror;
}

// 走完整 init(mirror 已就绪),并排空 init 内部的两个 void 任务
async function readyStore(mirror: Mirror): Promise<ReturnType<typeof useAnalysisStore>> {
  vi.mocked(createMirror).mockResolvedValue(mirror);
  const store = useAnalysisStore();
  await store.init();
  await vi.advanceTimersByTimeAsync(0);
  return store;
}

// 连接失效的镜像:所有读操作抛 InvalidStateError(模拟 onversionchange 后旧连接被关闭)
function closedMirror(counter: { calls: number }): Mirror {
  return {
    kind: "idb",
    putMany: async () => ({ added: 0, total: 0 }),
    count: async () => 0,
    clear: async () => {},
    deleteMany: async () => {},
    getAllNewest: async () => {
      counter.calls++;
      throw new DOMException("database connection is closing", "InvalidStateError");
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
  vi.mocked(createMirror).mockReset();
  vi.mocked(syncMirror).mockReset();
  vi.mocked(syncMirror).mockResolvedValue({ synced: 0, total: 0, exhausted: true });
  vi.mocked(createAnalysisWorker).mockClear();
  hoisted.worker = new FakeWorker();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sanitizeClusterPrefs", () => {
  it("非法值回退默认,合法值原样保留", () => {
    expect(sanitizeClusterPrefs({ scope: 250, level: "bogus" })).toEqual({ scope: 200, level: "normal" });
    expect(sanitizeClusterPrefs(null)).toEqual({ scope: 200, level: "normal" });
    expect(sanitizeClusterPrefs("junk")).toEqual({ scope: 200, level: "normal" });
    expect(sanitizeClusterPrefs({ scope: 100, level: "strict" })).toEqual({ scope: 100, level: "strict" });
  });
});

describe("analysis store", () => {
  it("compute 把镜像前 scope 篇发给 worker,结果映射为 UiClusterGroup", async () => {
    const mirror = await seededMirror();
    const spy = vi.spyOn(mirror, "getAllNewest");
    const store = await readyStore(mirror);

    // 不 await 结果:compute 在 postMessage 后返回,computing 由 worker 消息复位
    await store.compute();
    expect(spy).toHaveBeenCalledWith(200);
    expect(store.computing).toBe(true);

    const worker = hoisted.worker!;
    expect(worker.posted).toEqual([
      {
        type: "cluster",
        requestId: 1,
        threshold: CLUSTER_THRESHOLDS.normal,
        items: [
          { id: 3, title: "同一事件后续", excerpt: null, content: "<p>3</p>", publishedAt: T3 },
          { id: 2, title: "无关文章", excerpt: null, content: "<p>2</p>", publishedAt: T2 },
          { id: 1, title: "事件标题", excerpt: null, content: "<p>1</p>", publishedAt: T1 },
        ],
      },
    ]);

    worker.emit({ type: "progress", requestId: 1, ratio: 0.5 });
    expect(store.progress).toBe(0.5);

    // 组内成员下标(镜像顺序:0=id3、1=id2、2=id1),medoid 取 0,成员已按时间升序
    worker.emit({ type: "result", requestId: 1, groups: [{ representative: 0, members: [2, 0] }] });
    expect(store.computing).toBe(false);
    expect(store.computeError).toBeNull();
    expect(store.groups).toEqual([
      {
        key: 3,
        title: "同一事件后续",
        count: 2,
        firstAt: T1,
        lastAt: T3,
        members: [
          { id: 1, title: "事件标题", feedTitle: "源A", publishedAt: T1 },
          { id: 3, title: "同一事件后续", feedTitle: "源C", publishedAt: T3 },
        ],
      },
    ]);
  });

  it("镜像不足 2 篇:直接置空结果,不发 worker 消息", async () => {
    const mirror = new MemoryMirror();
    await mirror.putMany([row(1, T1)]);
    const store = await readyStore(mirror);

    await store.compute();
    expect(store.groups).toEqual([]);
    expect(store.computing).toBe(false);
    expect(hoisted.worker!.posted).toHaveLength(0);
  });

  it("worker 回 error:computeError 置位、computing 复位", async () => {
    const store = await readyStore(await seededMirror());
    await store.compute();

    hoisted.worker!.emit({ type: "error", requestId: 1 });
    expect(store.computeError).toBe("聚类计算失败");
    expect(store.computing).toBe(false);
    expect(store.groups).toBeNull();
  });

  it("updateClusterPrefs 写本地并防抖 PUT cluster_prefs", async () => {
    const store = await readyStore(await seededMirror());
    const puts = () =>
      vi.mocked(api).mock.calls.filter(([p, o]) => p === "/api/settings" && o?.method === "PUT");

    store.updateClusterPrefs({ scope: 300 });
    expect(JSON.parse(localStorage.getItem(LS_KEY)!)).toEqual({ scope: 300, level: "normal" });
    store.updateClusterPrefs({ level: "strict" });
    expect(JSON.parse(localStorage.getItem(LS_KEY)!)).toEqual({ scope: 300, level: "strict" });
    expect(puts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1100);
    expect(puts()).toHaveLength(1);
    // 计划 05 起为单次 kv 双键(cluster_prefs + keyword_rules 各自基线比对),cluster 断言语义不变
    expect(puts()[0]![1]!.body).toEqual({
      kv: {
        [SETTING_KEYS.clusterPrefs]: { scope: 300, level: "strict" },
        [SETTING_KEYS.keywordRules]: [],
      },
    });
  });

  it("偏好本地优先:无本地时采用服务端 cluster_prefs,采用后不回写", async () => {
    vi.mocked(api).mockResolvedValue({ [SETTING_KEYS.clusterPrefs]: { scope: 100, level: "strict" } });
    const store = await readyStore(await seededMirror());
    expect(store.clusterPrefs).toEqual({ scope: 100, level: "strict" });
    // 服务端快照即 serverCopy:采用后 1 秒内不产生回写 PUT
    await vi.advanceTimersByTimeAsync(1100);
    expect(
      vi.mocked(api).mock.calls.filter(([p, o]) => p === "/api/settings" && o?.method === "PUT")
    ).toHaveLength(0);

    // 本地已有偏好:服务端值不得覆盖
    localStorage.setItem(LS_KEY, JSON.stringify({ scope: 300, level: "loose" }));
    setActivePinia(createPinia());
    const second = await readyStore(await seededMirror());
    expect(second.clusterPrefs).toEqual({ scope: 300, level: "loose" });
  });

  it("syncIncremental 调 syncMirror 一次,并拉取 /api/articles/mirror(limit 200)", async () => {
    const mirror = await seededMirror();
    const store = await readyStore(mirror);

    expect(vi.mocked(syncMirror)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncMirror).mock.calls[0]![0]).toBe(mirror);
    expect(store.syncState).toBe("done");

    const fetchPage = vi.mocked(syncMirror).mock.calls[0]![1];
    await fetchPage(null);
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/articles/mirror", {
      query: { cursor_id: undefined, limit: 200 },
    });

    // 顺序调用不互斥(守卫只挡并发),再次同步照常执行
    await store.syncIncremental();
    expect(vi.mocked(syncMirror)).toHaveBeenCalledTimes(2);
  });

  it("syncIncremental 失败置 syncState=error(不抛)", async () => {
    const store = await readyStore(await seededMirror());
    vi.mocked(syncMirror).mockRejectedValue(new Error("boom"));
    await store.syncIncremental();
    expect(store.syncState).toBe("error");
  });

  it("cancel 发 cancel 消息并把 computing 复位,迟到的 result 被丢弃", async () => {
    const store = await readyStore(await seededMirror());
    await store.compute();
    expect(store.computing).toBe(true);
    const worker = hoisted.worker!;

    store.cancel();
    expect(worker.posted.at(-1)).toEqual({ type: "cancel", requestId: 1 });
    expect(store.computing).toBe(false);

    // 取消是 UI 级丢弃:同名 requestId 的迟到结果不再落地
    worker.emit({ type: "result", requestId: 1, groups: [{ representative: 0, members: [0, 1] }] });
    expect(store.groups).toBeNull();
    expect(store.computing).toBe(false);
  });

  it("镜像连接失效时重建一次并重试该操作", async () => {
    const counter = { calls: 0 };
    const broken = closedMirror(counter);
    const healthy = await seededMirror();
    let first = true;
    vi.mocked(createMirror).mockImplementation(async () => {
      if (first) {
        first = false;
        return broken;
      }
      return healthy;
    });

    const store = useAnalysisStore();
    await store.init();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.mirrorKind).toBe("idb");

    await store.compute();
    expect(vi.mocked(createMirror)).toHaveBeenCalledTimes(2);
    expect(store.mirrorKind).toBe("memory");
    expect(counter.calls).toBe(1);
    expect(store.computeError).toBeNull();
    const msg = hoisted.worker!.posted[0] as { type: string; items: unknown[] };
    expect(msg.type).toBe("cluster");
    expect(msg.items).toHaveLength(3);
  });

  it("重建后仍失败:走既有 error 路径(computeError 置位、computing 复位)", async () => {
    const counter = { calls: 0 };
    vi.mocked(createMirror).mockResolvedValue(closedMirror(counter));
    const store = useAnalysisStore();
    await store.init();
    await vi.advanceTimersByTimeAsync(0);

    await store.compute();
    // init 1 次 + 重建 1 次;读操作:原调用 + 重试各 1 次
    expect(vi.mocked(createMirror)).toHaveBeenCalledTimes(2);
    expect(counter.calls).toBe(2);
    expect(store.computeError).toBe("聚类计算失败");
    expect(store.computing).toBe(false);
    expect(store.groups).toBeNull();
    expect(hoisted.worker!.posted).toHaveLength(0);
  });

  it("syncIncremental 遇镜像失效:重建一次并以新连接重试,最终 done", async () => {
    const broken = closedMirror({ calls: 0 });
    const healthy = await seededMirror();
    let first = true;
    vi.mocked(createMirror).mockImplementation(async () => {
      if (first) {
        first = false;
        return broken;
      }
      return healthy;
    });
    // 桩:旧连接上的同步抛错(等价于真实 IdbMirror 连接关闭后抛 InvalidStateError)
    vi.mocked(syncMirror).mockImplementation(async (m) => {
      if (m === broken) throw new DOMException("database connection is closing", "InvalidStateError");
      return { synced: 0, total: 0, exhausted: true };
    });

    const store = useAnalysisStore();
    await store.init();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(createMirror)).toHaveBeenCalledTimes(2);
    expect(store.mirrorKind).toBe("memory");
    expect(store.syncState).toBe("done");
    expect(vi.mocked(syncMirror)).toHaveBeenCalledTimes(2); // 原调用 + 重试
  });

  it("createAnalysisWorker 未就绪时不构造:compute 前不碰 Worker 工厂", async () => {
    await readyStore(await seededMirror());
    expect(vi.mocked(createAnalysisWorker)).not.toHaveBeenCalled();
  });

  it("syncIncremental 在途时复用同一 promise,完成后补跑一轮(触发不丢失)", async () => {
    const mirror = await seededMirror();
    vi.mocked(createMirror).mockResolvedValue(mirror);
    const releases: (() => void)[] = [];
    vi.mocked(syncMirror).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ synced: 0, total: ROWS.length, exhausted: true }));
        })
    );

    const store = useAnalysisStore();
    await store.init(); // init 内部已触发第一轮(在途)
    expect(store.syncState).toBe("syncing");

    const p2 = store.syncIncremental(); // 在途再触发:复用同一轮
    const p3 = store.syncIncremental(); // 重复触发仍复用
    expect(vi.mocked(syncMirror)).toHaveBeenCalledTimes(1); // 未新开一轮

    releases.shift()!(); // 只完成第一轮
    // 两个调用都由第一轮完成(若各自新开一轮,这里会因无第二个 release 而挂起)
    await Promise.all([p2, p3]);
    // 排队补跑:自动再触发一轮(多次触发合并,只补跑一次)
    expect(vi.mocked(syncMirror)).toHaveBeenCalledTimes(2);
    expect(store.syncState).toBe("syncing");

    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.syncState).toBe("done");
    expect(vi.mocked(syncMirror)).toHaveBeenCalledTimes(2);
  });

  it("compute 把 content 截断到 500 字(与 worker 侧 buildDocText 口径一致)", async () => {
    const long = "甲".repeat(1200);
    const mirror = new MemoryMirror();
    await mirror.putMany([row(1, T1, { content: long }), row(2, T2)]);
    const store = await readyStore(mirror);

    await store.compute();
    const msg = hoisted.worker!.posted.at(-1) as { items: { id: number; content: string | null }[] };
    const item = msg.items.find((i) => i.id === 1)!;
    expect(item.content).toBe(long.slice(0, 500));
    expect(msg.items.find((i) => i.id === 2)!.content).toBe("<p>2</p>");
  });

  it("镜像读取期间取消:读取返回后不再发送 cluster 消息", async () => {
    const mirror = await seededMirror();
    let releaseRead!: () => void;
    vi.spyOn(mirror, "getAllNewest").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = () => resolve([...ROWS].reverse());
        })
    );
    const store = await readyStore(mirror);

    const pending = store.compute();
    expect(store.computing).toBe(true);
    store.cancel(); // 读取在途时取消
    releaseRead();
    await pending;

    const clusterMsgs = hoisted.worker!.posted.filter((m) => (m as { type: string }).type === "cluster");
    expect(clusterMsgs).toHaveLength(0);
    expect(store.groups).toBeNull();
    expect(store.computing).toBe(false);
  });
});

const RULES_LS_KEY = "readly_keyword_rules";

const OPENAI_RULE: Omit<KeywordRule, "id"> = {
  name: "",
  keyword: "openai",
  isRegex: false,
  caseSensitive: false,
  color: "#f59e0b",
  enabled: true,
};

interface PostedKeywords {
  type: "keywords";
  requestId: number;
  docs: MatchDoc[];
  rules: KeywordRule[];
}

function postedKeywords(): PostedKeywords[] {
  return hoisted.worker!.posted.filter((m) => (m as { type: string }).type === "keywords") as PostedKeywords[];
}

describe("关键词规则与命中", () => {
  it("sanitizeKeywordRules:过滤非法形状、上限 100、id 去重(名称回退关键词/颜色校验/enabled 语义)", async () => {
    const { sanitizeKeywordRules } = await import("@/stores/analysis");
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `r${i}`, name: `n${i}`, keyword: "x", isRegex: false, caseSensitive: false, color: "#3b82f6", enabled: true,
    }));
    expect(sanitizeKeywordRules(many)).toHaveLength(100);
    expect(sanitizeKeywordRules([{ id: "a" }, many[0], many[0]])).toHaveLength(1); // 非法形状丢弃 + 去重
    expect(sanitizeKeywordRules("junk")).toEqual([]);

    // 名称回退关键词、非法颜色回退默认、enabled 仅显式 false 关闭、布尔缺省为 false
    expect(sanitizeKeywordRules([{ id: "a", keyword: "  Open AI  ", color: "red", enabled: false }])).toEqual([
      { id: "a", name: "Open AI", keyword: "Open AI", isRegex: false, caseSensitive: false, color: "#3b82f6", enabled: false },
    ]);
    expect(sanitizeKeywordRules([{ id: "b", keyword: "x" }])[0]!.enabled).toBe(true);
  });

  it("addRule/updateRule/removeRule 写本地并触发 keyword_rules 防抖 PUT(与 cluster_prefs 同一 PUT)", async () => {
    const store = await readyStore(await seededMirror());
    const puts = () => vi.mocked(api).mock.calls.filter(([p, o]) => p === "/api/settings" && o?.method === "PUT");
    const lsRules = () => JSON.parse(localStorage.getItem(RULES_LS_KEY)!) as KeywordRule[];

    store.addRule(OPENAI_RULE); // name 为空 → 回退关键词
    const id = store.rules[0]!.id;
    expect(store.rules[0]!.name).toBe("openai");
    expect(lsRules()).toEqual(store.rules); // watch flush sync:本地即时落盘

    store.updateRule(id, { name: "OpenAI 动态", enabled: false });
    expect(store.rules[0]!.name).toBe("OpenAI 动态");
    expect(store.rules[0]!.enabled).toBe(false);
    expect(lsRules()).toEqual(store.rules);
    expect(puts()).toHaveLength(0); // 防抖未到期

    await vi.advanceTimersByTimeAsync(1100);
    expect(puts()).toHaveLength(1);
    const kv = (puts()[0]![1]!.body as { kv: Record<string, unknown> }).kv;
    expect(kv[SETTING_KEYS.keywordRules]).toEqual(store.rules);
    expect(kv[SETTING_KEYS.clusterPrefs]).toEqual({ scope: 200, level: "normal" }); // 双键同 PUT

    store.removeRule(id);
    expect(lsRules()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(puts()).toHaveLength(2);
    expect((puts()[1]![1]!.body as { kv: Record<string, unknown> }).kv[SETTING_KEYS.keywordRules]).toEqual([]);
  });

  it("同步完成后自动算命中:worker 收 keywords 消息并按 docs 回传,hits/hitsByRule 落地", async () => {
    const mirror = new MemoryMirror();
    await mirror.putMany([
      row(1, T1, { title: "OpenAI 发布新模型", content: "<p>openai 真香</p>" }),
      row(2, T2, { title: "竞品分析", content: "<p>openai 才是关键</p>" }),
    ]);
    const store = await readyStore(mirror); // init 内同步完成 → 防抖 300ms 后自动算
    store.addRule(OPENAI_RULE);
    const ruleId = store.rules[0]!.id;

    expect(postedKeywords()).toHaveLength(0); // 防抖未到期不发
    await vi.advanceTimersByTimeAsync(400);
    const msgs = postedKeywords();
    expect(msgs).toHaveLength(1);
    const msg = msgs[0]!;
    expect(msg.rules).toEqual([{ ...OPENAI_RULE, id: ruleId, name: "openai" }]);
    expect(msg.docs.map((d) => d.id)).toEqual([2, 1]); // 镜像时间倒序
    expect(msg.docs.find((d) => d.id === 1)!.text).toBe("openai 真香"); // text=htmlToText(content)
    expect(store.hitsState).toBe("computing");

    // seam 手写回传:以真实 matchDocs 跑同一 payload(等价于 worker 内计算),结果落地
    const result = matchDocs(msg.docs, msg.rules);
    hoisted.worker!.emit({ type: "keywordsResult", requestId: msg.requestId, result });
    expect(store.hitsState).toBe("done");
    expect(store.rulesInvalid).toEqual([]);
    expect(store.hits[1]).toEqual([{ ruleId, count: 2 }]); // 标题 + 正文各 1 处
    expect(store.hits[2]).toEqual([{ ruleId, count: 1 }]);
    expect(store.hitsFor(1)).toEqual([{ ruleId, count: 2 }]);
    // hitsByRule 元数据取镜像快照(标题/来源/时间),按 publishedAt 倒序
    expect(store.hitsByRule[ruleId]).toEqual([
      { id: 2, title: "竞品分析", feedTitle: "源2", publishedAt: T2, count: 1 },
      { id: 1, title: "OpenAI 发布新模型", feedTitle: "源1", publishedAt: T1, count: 2 },
    ]);
  });

  it("hitsFor 无命中返回空数组", async () => {
    const store = await readyStore(await seededMirror());
    expect(store.hitsFor(1)).toEqual([]);
    expect(store.hitsFor(999)).toEqual([]);
  });

  it("计算在途时的规则变更:不并发发送,当前一轮落地后补跑(变更不丢失)", async () => {
    const mirror = new MemoryMirror();
    await mirror.putMany([
      row(1, T1, { title: "OpenAI 发布", content: "<p>openai</p>" }),
      row(2, T2, { title: "竞品分析", content: "<p>openai 也够用</p>" }),
    ]);
    const store = await readyStore(mirror);
    store.addRule(OPENAI_RULE); // 第一次变更
    await vi.advanceTimersByTimeAsync(400);
    const first = postedKeywords()[0]!;
    expect(postedKeywords()).toHaveLength(1);
    expect(store.hitsState).toBe("computing"); // 在途:seam 不自动回

    store.updateRule(first.rules[0]!.id, { caseSensitive: true }); // 在途期间的第二次变更
    await vi.advanceTimersByTimeAsync(400); // 防抖到期,但计算在途 → 不并发发送
    expect(postedKeywords()).toHaveLength(1);
    expect(store.hitsState).toBe("computing");

    // 第一条结果落地 → 补跑;推进防抖后发出第二条(携带变更后的规则集)
    hoisted.worker!.emit({ type: "keywordsResult", requestId: first.requestId, result: matchDocs(first.docs, first.rules) });
    expect(store.hitsState).toBe("done");
    expect(store.hits[1]).toEqual([{ ruleId: first.rules[0]!.id, count: 2 }]); // 旧规则:大小写不敏感,标题+正文
    await vi.advanceTimersByTimeAsync(400);
    const msgs = postedKeywords();
    expect(msgs).toHaveLength(2);
    const second = msgs[1]!;
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.rules).toEqual([{ ...OPENAI_RULE, id: first.rules[0]!.id, name: "openai", caseSensitive: true }]);

    hoisted.worker!.emit({ type: "keywordsResult", requestId: second.requestId, result: matchDocs(second.docs, second.rules) });
    // 命中反映最终规则集:大小写敏感后标题 "OpenAI" 不再命中,仅正文 1 处
    expect(store.hits[1]).toEqual([{ ruleId: first.rules[0]!.id, count: 1 }]);
    await vi.advanceTimersByTimeAsync(400); // 补跑已消费,不再有第三条
    expect(postedKeywords()).toHaveLength(2);
  });

  it("在途计算回 error:同样补跑一次(dirty 标记消费即止)", async () => {
    const store = await readyStore(await seededMirror());
    store.addRule(OPENAI_RULE);
    await vi.advanceTimersByTimeAsync(400);
    const first = postedKeywords()[0]!;

    store.updateRule(first.rules[0]!.id, { name: "改名" });
    await vi.advanceTimersByTimeAsync(400); // 在途 → 仅置 dirty
    expect(postedKeywords()).toHaveLength(1);

    hoisted.worker!.emit({ type: "error", requestId: first.requestId });
    expect(store.hitsState).toBe("error");
    await vi.advanceTimersByTimeAsync(400); // 错误后补跑一次
    const msgs = postedKeywords();
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.rules[0]!.name).toBe("改名");
    expect(msgs[1]!.requestId).not.toBe(first.requestId);
  });

  it("无 enabled 规则时清空命中并复位 rulesInvalid(不发消息)", async () => {
    const mirror = new MemoryMirror();
    await mirror.putMany([row(1, T1, { title: "OpenAI 发布", content: "<p>openai</p>" })]);
    const store = await readyStore(mirror);
    store.addRule(OPENAI_RULE);
    const goodId = store.rules[0]!.id;
    store.addRule({ ...OPENAI_RULE, keyword: "([", isRegex: true, name: "坏正则" }); // 编译失败 → worker 回报 invalidRuleIds
    const badId = store.rules[1]!.id;

    await vi.advanceTimersByTimeAsync(400);
    const msg = postedKeywords()[0]!;
    hoisted.worker!.emit({ type: "keywordsResult", requestId: msg.requestId, result: matchDocs(msg.docs, msg.rules) });
    expect(store.hits[1]).toEqual([{ ruleId: goodId, count: 2 }]);
    expect(store.rulesInvalid).toEqual([badId]);

    store.updateRule(goodId, { enabled: false });
    store.updateRule(badId, { enabled: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(store.hits).toEqual({});
    expect(store.hitsByRule).toEqual({});
    expect(store.rulesInvalid).toEqual([]); // 清空分支复位
    expect(store.hitsState).toBe("done");
    expect(postedKeywords()).toHaveLength(1); // 清空分支不发消息
  });
});
