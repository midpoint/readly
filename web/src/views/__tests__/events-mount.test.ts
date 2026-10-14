import { createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { MemoryMirror, createMirror, syncMirror, type MirrorRow } from "@/modules/idb";
import { createAnalysisWorker } from "@/modules/worker-factory";
import Events from "@/views/Events.vue";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

// 真实 MemoryMirror 保留(测试直接构造),仅把 createMirror/syncMirror 换成桩
vi.mock("@/modules/idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/idb")>();
  return { ...actual, createMirror: vi.fn(), syncMirror: vi.fn() };
});

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

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";
// 镜像按 publishedAt 倒序返回 → 下标 0/1 依次为 id 2/1;worker 结果 members 按时间升序 = [1, 0](id 1、id 2)
const ROWS: MirrorRow[] = [
  { id: 1, feedId: 1, feedTitle: "源A", title: "事件一", url: null, publishedAt: T1, excerpt: null, content: null },
  { id: 2, feedId: 1, feedTitle: "源A", title: "事件二", url: null, publishedAt: T2, excerpt: null, content: null },
];

function clusterMsgs(): unknown[] {
  return hoisted.worker!.posted.filter((m) => (m as { type: string }).type === "cluster");
}

let mounted: { app: App; container: HTMLElement } | null = null;

// 宏任务 + nextTick 排空微任务链(store 初始化 → 计算 → 渲染)
async function flush(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountEvents(): Promise<{ router: Router; container: HTMLElement }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div>inbox</div>" } },
      { path: "/events", component: Events },
    ],
  });
  await router.push("/events");
  await router.isReady();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(Events);
  app.use(createPinia());
  app.use(router);
  app.mount(container);
  mounted = { app, container };
  return { router, container };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({});
  vi.mocked(createMirror).mockReset();
  vi.mocked(syncMirror).mockReset();
  vi.mocked(createAnalysisWorker).mockClear();
  hoisted.worker = new FakeWorker();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted?.container.remove();
  mounted = null;
});

describe("Events 挂载", () => {
  it("同步在途时不提前计算,落定后自动出组(首屏空镜像竞态守卫)", async () => {
    const mirror = new MemoryMirror();
    await mirror.putMany(ROWS);
    vi.mocked(createMirror).mockResolvedValue(mirror);
    let release!: () => void;
    vi.mocked(syncMirror).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ synced: ROWS.length, total: ROWS.length, exhausted: true });
        })
    );

    const { container } = await mountEvents();
    // 同步仍在途:等待若干轮视图轮询(25ms/轮)后,计算不得先发
    await sleep(120);
    expect(clusterMsgs()).toHaveLength(0);
    expect(container.querySelectorAll("[data-cluster-group]")).toHaveLength(0);

    release(); // 同步落定
    await sleep(120); // 视图轮询感知 syncState=done 后触发 compute
    expect(clusterMsgs()).toHaveLength(1);

    // 首条消息 requestId=1;回结果 → 渲染出组
    const msg = clusterMsgs()[0] as { requestId: number; items: { id: number }[] };
    expect(msg.items.map((i) => i.id)).toEqual([2, 1]);
    hoisted.worker!.emit({ type: "result", requestId: msg.requestId, groups: [{ representative: 0, members: [1, 0] }] });
    await flush();
    expect(container.querySelectorAll("[data-cluster-group]")).toHaveLength(1);
    expect(container.querySelector("[data-cluster-group]")!.textContent).toContain("2 篇");
  });

  it("点时间线条目跳转带 ?a=(跳回阅读器)", async () => {
    const mirror = new MemoryMirror();
    await mirror.putMany(ROWS);
    vi.mocked(createMirror).mockResolvedValue(mirror);
    vi.mocked(syncMirror).mockResolvedValue({ synced: ROWS.length, total: ROWS.length, exhausted: true });

    const { router, container } = await mountEvents();
    await sleep(120); // 同步落定 + 轮询 + compute
    expect(clusterMsgs()).toHaveLength(1);
    const msg = clusterMsgs()[0] as { requestId: number };
    hoisted.worker!.emit({ type: "result", requestId: msg.requestId, groups: [{ representative: 0, members: [1, 0] }] });
    await flush();

    (container.querySelector("[data-cluster-group] button") as HTMLButtonElement).click(); // 展开组
    await nextTick();
    const memberButtons = container.querySelectorAll("[data-cluster-member] button");
    expect(memberButtons).toHaveLength(2);

    (memberButtons[0] as HTMLButtonElement).click(); // 第一条 = id 1(时间升序)
    await flush();
    expect(router.currentRoute.value.path).toBe("/");
    expect(router.currentRoute.value.query.a).toBe("1");
  });
});
