import { defineStore } from "pinia";
import { ref, watch } from "vue";
import {
  CLUSTER_THRESHOLDS,
  SETTING_KEYS,
  type ClusterLevel,
  type ClusterPrefs,
  type KeywordRule,
} from "@readly/shared";
import { api } from "@/api/client";
import { MIRROR_LIMIT, createMirror, syncMirror, type Mirror, type MirrorPage, type MirrorRow } from "@/modules/idb";
import type { ClusterGroup, ClusterInput } from "@/modules/cluster";
import { htmlToText, matchDocs, type KeywordsResult } from "@/modules/keywords";
import { createAnalysisWorker } from "@/modules/worker-factory";

const LS_KEY = "readly_cluster_prefs";
const RULES_LS_KEY = "readly_keyword_rules";
const DEFAULT_CLUSTER_PREFS: ClusterPrefs = { scope: 200, level: "normal" };
const PUT_DEBOUNCE_MS = 1000;
const HITS_DEBOUNCE_MS = 300;
const MAX_RULES = 100;
const DEFAULT_RULE_COLOR = "#3b82f6";

export function sanitizeClusterPrefs(raw: unknown): ClusterPrefs {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const scope = o.scope === 100 || o.scope === 200 || o.scope === 300 ? o.scope : 200;
  const level: ClusterLevel = o.level === "loose" || o.level === "strict" ? o.level : "normal";
  return { scope, level };
}

export function sanitizeKeywordRules(raw: unknown): KeywordRule[] {
  if (!Array.isArray(raw)) return [];
  const out: KeywordRule[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || seen.has(o.id)) continue;
    if (typeof o.keyword !== "string" || !o.keyword.trim()) continue;
    seen.add(o.id);
    out.push({
      id: o.id,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 40) : o.keyword.trim().slice(0, 40),
      keyword: o.keyword.trim().slice(0, 200),
      isRegex: o.isRegex === true,
      caseSensitive: o.caseSensitive === true,
      color: typeof o.color === "string" && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : DEFAULT_RULE_COLOR,
      enabled: o.enabled !== false,
    });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

export interface UiClusterGroup {
  key: number;
  title: string;
  count: number;
  firstAt: string;
  lastAt: string;
  members: { id: number; title: string; feedTitle: string; publishedAt: string }[];
}

export interface HitEntry {
  ruleId: string;
  count: number;
}

export interface HitArticle {
  id: number;
  title: string;
  feedTitle: string;
  publishedAt: string;
  count: number;
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
  const rules = ref<KeywordRule[]>([]);
  const rulesInvalid = ref<string[]>([]);
  const hits = ref<Record<number, HitEntry[]>>({});
  const hitsByRule = ref<Record<string, HitArticle[]>>({});
  const hitsState = ref<"idle" | "computing" | "done" | "error">("idle");

  let mirror: Mirror | null = null;
  let rows: MirrorRow[] = []; // 最近一次读取的镜像快照(计算时刷新)
  let worker: Worker | null = null;
  let requestSeq = 0;
  let activeRequest = 0;
  let putTimer: ReturnType<typeof setTimeout> | null = null;
  let serverCopy: string | null = null;
  let rulesServerCopy: string | null = null;
  let syncPromise: Promise<void> | null = null;
  let pendingSync = false;
  let hitsTimer: ReturnType<typeof setTimeout> | null = null;
  // 关键词通道用独立高位 id 空间(聚类 activeRequest 自 1 起递增),两条通道的 id 永不相交
  let hitsRequestId = 1_000_000;
  let hitsPendingRecalc = false; // 计算在途期间的规则变更:落地后补跑一轮(不丢失)
  let lastHitsDocs: MirrorRow[] = []; // 命中计算时的镜像快照,供 hitsByRule 关联元数据

  function hitsFor(articleId: number): HitEntry[] {
    return hits.value[articleId] ?? [];
  }

  function addRule(partial: Omit<KeywordRule, "id">): void {
    const id = `kr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    rules.value = sanitizeKeywordRules([...rules.value, { ...partial, id }]);
  }

  function updateRule(id: string, patch: Partial<KeywordRule>): void {
    rules.value = sanitizeKeywordRules(rules.value.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRule(id: string): void {
    rules.value = sanitizeKeywordRules(rules.value.filter((r) => r.id !== id));
  }

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
    const localRules = localStorage.getItem(RULES_LS_KEY);
    if (localRules) {
      try {
        rules.value = sanitizeKeywordRules(JSON.parse(localRules));
      } catch {
        /* 保留空集 */
      }
    }
    ready.value = true;
    void loadRemotePrefs();
    void syncIncremental();
  }

  async function loadRemotePrefs(): Promise<void> {
    try {
      const all = await api<Record<string, unknown>>("/api/settings");
      const sr = all[SETTING_KEYS.keywordRules];
      // 服务端缺该键时按空集登记基线:本端无本地规则则不触发无意义回写
      rulesServerCopy = JSON.stringify(sanitizeKeywordRules(sr));
      if (sr !== undefined && localStorage.getItem(RULES_LS_KEY) === null) rules.value = sanitizeKeywordRules(sr);
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
        // 镜像落定后规则可能有新命中:防抖重算(与规则变更共用同一入口)
        if (syncState.value === "done") scheduleHits();
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

  // 双键同 PUT:cluster_prefs 与 keyword_rules 各自 serverCopy 基线,任一变化即推送
  async function pushRemote(): Promise<void> {
    const serialized = JSON.stringify(clusterPrefs.value);
    const serializedRules = JSON.stringify(rules.value);
    if (serialized === serverCopy && serializedRules === rulesServerCopy) return;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: {
          kv: {
            [SETTING_KEYS.clusterPrefs]: clusterPrefs.value,
            [SETTING_KEYS.keywordRules]: rules.value,
          },
        },
      });
      serverCopy = serialized;
      rulesServerCopy = serializedRules;
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

  watch(
    rules,
    () => {
      localStorage.setItem(RULES_LS_KEY, JSON.stringify(rules.value));
      scheduleHits();
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
      // 按 type 分流:聚类通道(progress/result/cancelled)沿用 activeRequest 校验,
      // 关键词通道(keywordsResult)用独立 hitsRequestId;error 无通道标记,按 requestId 判定来源。
      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as
          | { type: "progress"; requestId: number; ratio: number }
          | { type: "result"; requestId: number; groups: ClusterGroup[] }
          | { type: "cancelled"; requestId: number }
          | { type: "keywordsResult"; requestId: number; result: KeywordsResult }
          | { type: "error"; requestId: number };
        if (msg.type === "keywordsResult") {
          if (msg.requestId !== hitsRequestId) return;
          rulesInvalid.value = msg.result.invalidRuleIds;
          applyHits(msg.result, lastHitsDocs);
          hitsState.value = "done";
          flushHitsRecalc();
          return;
        }
        if (msg.type === "error") {
          // 聚类在前:与既有 activeRequest 语义保持一致(取消后 activeRequest=0,迟到结果仍被丢弃)。
          // 关键词通道已用高位 id 空间(1_000_000 起),error 归属不再可能碰撞;此处仍按聚类优先兜底。
          if (msg.requestId === activeRequest) {
            computeError.value = "聚类计算失败";
            computing.value = false;
          } else if (msg.requestId === hitsRequestId) {
            hitsState.value = "error";
            flushHitsRecalc();
          }
          return;
        }
        if (msg.requestId !== activeRequest) return;
        if (msg.type === "progress") progress.value = msg.ratio;
        else if (msg.type === "result") {
          groups.value = mapGroups(msg.groups);
          computing.value = false;
        } else {
          computing.value = false;
        }
      };
    }
    return worker;
  }

  function scheduleHits(): void {
    if (hitsTimer) clearTimeout(hitsTimer);
    hitsTimer = setTimeout(() => {
      hitsTimer = null;
      void computeHits();
    }, HITS_DEBOUNCE_MS);
  }

  // 计算在途期间的规则变更不并发:置 dirty 标记,当前一轮落地(done/error)后补跑一次
  function flushHitsRecalc(): void {
    if (!hitsPendingRecalc) return;
    hitsPendingRecalc = false;
    scheduleHits();
  }

  async function computeHits(): Promise<void> {
    if (!mirror) return;
    if (hitsState.value === "computing") {
      hitsPendingRecalc = true;
      return;
    }
    if (rules.value.filter((r) => r.enabled).length === 0) {
      hits.value = {};
      hitsByRule.value = {};
      rulesInvalid.value = [];
      hitsState.value = "done";
      return;
    }
    hitsState.value = "computing";
    try {
      const docs = await withMirror((m) => m.getAllNewest(MIRROR_LIMIT));
      const payload = docs.map((d) => ({
        id: d.id,
        title: d.title,
        text: htmlToText(d.content ?? d.excerpt),
      }));
      lastHitsDocs = docs;
      hitsRequestId += 1;
      getWorker().postMessage({
        type: "keywords",
        requestId: hitsRequestId,
        docs: payload,
        rules: rules.value.map((r) => ({ ...r })),
      });
      // 结果在 onmessage 的 keywordsResult 分支落地
    } catch {
      hitsState.value = "error";
      flushHitsRecalc(); // 错误也允许一次补跑(dirty 标记消费即止,不会循环)
    }
  }

  function applyHits(result: KeywordsResult, docs: MirrorRow[]): void {
    const byId = new Map(docs.map((d) => [d.id, d]));
    const h: Record<number, HitEntry[]> = {};
    const byRule: Record<string, HitArticle[]> = {};
    for (const m of result.matches) {
      (h[m.articleId] ??= []).push({ ruleId: m.ruleId, count: m.count });
      const d = byId.get(m.articleId);
      if (d) {
        (byRule[m.ruleId] ??= []).push({
          id: d.id,
          title: d.title,
          feedTitle: d.feedTitle,
          publishedAt: d.publishedAt,
          count: m.count,
        });
      }
    }
    for (const list of Object.values(byRule)) list.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    hits.value = h;
    hitsByRule.value = byRule;
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
    rules,
    rulesInvalid,
    hits,
    hitsByRule,
    hitsState,
    hitsFor,
    addRule,
    updateRule,
    removeRule,
    computeHits,
    init,
    syncIncremental,
    updateClusterPrefs,
    compute,
    cancel,
  };
});
