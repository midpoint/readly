import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { CLUSTER_THRESHOLDS, SETTING_KEYS, type ClusterLevel, type ClusterPrefs } from "@readly/shared";
import { api } from "@/api/client";
import { createMirror, syncMirror, type Mirror, type MirrorPage, type MirrorRow } from "@/modules/idb";
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
  let rows: MirrorRow[] = []; // 最近一次读取的镜像快照(计算时刷新)
  let worker: Worker | null = null;
  let requestSeq = 0;
  let activeRequest = 0;
  let putTimer: ReturnType<typeof setTimeout> | null = null;
  let serverCopy: string | null = null;
  let syncPromise: Promise<void> | null = null;
  let pendingSync = false;

  async function fetchPage(cursorId: number | null): Promise<MirrorPage> {
    return api("/api/articles/mirror", { query: { cursor_id: cursorId ?? undefined, limit: 200 } });
  }

  // 镜像连接可能因 onversionchange(其它标签页升级/清库)被关闭,之后任何操作抛 InvalidStateError。
  // 包裹访问:操作抛错时丢弃旧连接、重建一次,再以新连接重试该操作一次;
  // 仍失败则原样抛出,由调用方走既有 error 路径(syncState=error / computeError)。
  async function withMirror<T>(op: (m: Mirror) => Promise<T>): Promise<T> {
    const cur = mirror;
    if (!cur) throw new Error("镜像未就绪");
    try {
      return await op(cur);
    } catch (err) {
      if (mirror !== cur) throw err; // 已被并发重建,不重复重建
      mirror = null;
      const next = await createMirror();
      mirror = next;
      mirrorKind.value = next.kind;
      return op(next);
    }
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

  // 在途复用 + 排队补跑:同步进行中再被触发(如刷新订阅、进入事件视图)不丢失,
  // 复用同一 promise 返回,并在当前一轮结束后自动补跑一轮(合并并发触发,至多多跑一次)。
  function syncIncremental(): Promise<void> {
    if (!mirror) return Promise.resolve();
    if (syncPromise) {
      pendingSync = true;
      return syncPromise;
    }
    syncState.value = "syncing";
    syncPromise = (async () => {
      try {
        await withMirror((m) => syncMirror(m, fetchPage));
        syncState.value = "done";
      } catch {
        syncState.value = "error";
      } finally {
        syncPromise = null;
        if (pendingSync) {
          pendingSync = false;
          void syncIncremental();
        }
      }
    })();
    return syncPromise;
  }

  function updateClusterPrefs(patch: Partial<ClusterPrefs>): void {
    clusterPrefs.value = sanitizeClusterPrefs({ ...clusterPrefs.value, ...patch });
  }

  async function pushRemote(): Promise<void> {
    const serialized = JSON.stringify(clusterPrefs.value);
    if (serialized === serverCopy) return;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: { kv: { [SETTING_KEYS.clusterPrefs]: clusterPrefs.value } },
      });
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
      rows = await withMirror((m) => m.getAllNewest(clusterPrefs.value.scope));
      // 读取期间被取消(cancel 置 computing=false):不再发消息,避免取消后又落地一轮结果
      if (!computing.value) return;
      if (rows.length < 2) {
        groups.value = [];
        computing.value = false;
        return;
      }
      const items: ClusterInput[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        excerpt: r.excerpt,
        // 截断到 500 字(与 worker 侧 buildDocText 的 500 字口径一致),
        // 消除大 body 结构化克隆的传输开销
        content: r.content ? r.content.slice(0, 500) : null,
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

  // 取消是 UI 级丢弃:worker 计算同步执行、无法被消息打断,
  // 这里发 cancel 通知 worker(其 requestId 复核会忽略迟到结果),本地立即复位,
  // 并把 activeRequest 归零使在途 result 不再落地。
  function cancel(): void {
    if (!computing.value) return;
    getWorker().postMessage({ type: "cancel", requestId: activeRequest });
    activeRequest = 0;
    computing.value = false;
  }

  return {
    ready,
    mirrorKind,
    syncState,
    clusterPrefs,
    groups,
    computing,
    progress,
    computeError,
    init,
    syncIncremental,
    updateClusterPrefs,
    compute,
    cancel,
  };
});
