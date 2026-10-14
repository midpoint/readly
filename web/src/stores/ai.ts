import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { SETTING_KEYS, type AiProvider } from "@readly/shared";
import { api } from "@/api/client";
import { PROVIDER_PRESETS } from "@/modules/ai";

const LS_KEY = "readly_ai";
const PUT_DEBOUNCE_MS = 1000;
const MAX_PROVIDERS = 20;

export interface AiState {
  providers: AiProvider[];
  activeId: string | null;
  syncKeys: boolean;
}

const EMPTY: AiState = { providers: [], activeId: null, syncKeys: false };

// 逐字段清洗:非法形状整条丢弃;本地与 D1 两侧共用(服务端值同样不可信)
export function sanitizeAi(raw: unknown): AiState {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY, providers: [] };
  const o = raw as Record<string, unknown>;
  const providers: AiProvider[] = [];
  const seen = new Set<string>();
  if (Array.isArray(o.providers)) {
    for (const item of o.providers) {
      if (typeof item !== "object" || item === null) continue;
      const p = item as Record<string, unknown>;
      if (typeof p.id !== "string" || !p.id || seen.has(p.id)) continue;
      if (typeof p.baseUrl !== "string" || !p.baseUrl.trim()) continue;
      if (typeof p.model !== "string" || !p.model.trim()) continue;
      seen.add(p.id);
      const model = p.model.trim().slice(0, 120);
      const provider: AiProvider = {
        id: p.id,
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : model.slice(0, 60),
        baseUrl: p.baseUrl.trim().slice(0, 300),
        model,
        useProxy: p.useProxy === true,
      };
      if (typeof p.apiKey === "string" && p.apiKey) provider.apiKey = p.apiKey.trim().slice(0, 300);
      providers.push(provider);
      if (providers.length >= MAX_PROVIDERS) break;
    }
  }
  return {
    providers,
    activeId: typeof o.activeId === "string" && seen.has(o.activeId) ? o.activeId : null,
    syncKeys: o.syncKeys === true,
  };
}

// D1 副本:syncKeys=false 时剥离 apiKey(密钥默认不出本机);本地副本始终全量
function redact(state: AiState, syncKeys: boolean): AiState {
  return {
    providers: state.providers.map((p) => {
      const out: AiProvider = {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        useProxy: p.useProxy,
      };
      if (syncKeys && p.apiKey) out.apiKey = p.apiKey;
      return out;
    }),
    activeId: state.activeId,
    syncKeys,
  };
}

export const useAiStore = defineStore("ai", () => {
  const providers = ref<AiProvider[]>([]);
  const activeId = ref<string | null>(null);
  const syncKeys = ref(false);
  const ready = ref(false);

  let putTimer: ReturnType<typeof setTimeout> | null = null;
  let serverCopy: string | null = null;

  const active = computed<AiProvider | null>(() => providers.value.find((p) => p.id === activeId.value) ?? null);
  const configured = computed(() => active.value !== null);

  function state(): AiState {
    return { providers: providers.value, activeId: activeId.value, syncKeys: syncKeys.value };
  }

  function apply(next: AiState): void {
    providers.value = next.providers;
    activeId.value = next.activeId;
    syncKeys.value = next.syncKeys;
  }

  function addProvider(patch?: Partial<AiProvider>): string {
    const id = `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const preset = PROVIDER_PRESETS[0]!;
    // 默认填预设第一条;patch 覆盖(含 apiKey/useProxy)
    const next = sanitizeAi({
      providers: [...providers.value, { id, name: preset.name, baseUrl: preset.baseUrl, model: preset.model, useProxy: false, ...patch }],
      activeId: activeId.value,
      syncKeys: syncKeys.value,
    });
    providers.value = next.providers;
    return id;
  }

  function updateProvider(id: string, patch: Partial<AiProvider>): void {
    // 注意:patch 清洗后不合法(如 model 置空)会整条被 sanitize 丢弃(静默删除),
    // 编辑器层必须挡住(与关键词规则同口径)
    providers.value = sanitizeAi({
      providers: providers.value.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      activeId: activeId.value,
      syncKeys: syncKeys.value,
    }).providers;
  }

  function removeProvider(id: string): void {
    const next = sanitizeAi({
      providers: providers.value.filter((p) => p.id !== id),
      activeId: activeId.value,
      syncKeys: syncKeys.value,
    });
    apply(next);
  }

  function setActive(id: string | null): void {
    activeId.value = sanitizeAi({
      providers: providers.value,
      activeId: id,
      syncKeys: syncKeys.value,
    }).activeId;
  }

  function updateSyncKeys(v: boolean): void {
    syncKeys.value = v === true;
  }

  async function pushRemote(): Promise<void> {
    const payload = redact(state(), syncKeys.value);
    const serialized = JSON.stringify(payload);
    if (serialized === serverCopy) return;
    try {
      await api("/api/settings", { method: "PUT", body: { kv: { [SETTING_KEYS.aiProviders]: payload } } });
      serverCopy = serialized;
    } catch {
      // 静默:本地为真源,下次变更再试
    }
  }

  async function initRemote(): Promise<void> {
    try {
      const all = await api<Record<string, unknown>>("/api/settings");
      const raw = all[SETTING_KEYS.aiProviders];
      const server = sanitizeAi(raw);
      // 服务端缺该键时按空集登记基线(本端同样为空则不触发无意义回写)
      serverCopy = JSON.stringify(redact(server, server.syncKeys));
      if (raw !== undefined && localStorage.getItem(LS_KEY) === null) {
        // GET 在途期间本地被写入(如另一处 addProvider)时,本地为真源,不再套用服务端快照
        apply(server);
      }
    } catch {
      // 静默:离线时本地可用
    }
  }

  function init(): void {
    if (ready.value) return;
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      try {
        apply(sanitizeAi(JSON.parse(raw)));
      } catch {
        /* 保留默认 */
      }
    }
    ready.value = true;
    void initRemote();
  }

  watch(
    [providers, activeId, syncKeys],
    () => {
      // 本地副本始终全量(含密钥),不受 syncKeys 影响
      localStorage.setItem(LS_KEY, JSON.stringify(state()));
    },
    { deep: true, flush: "sync" }
  );

  watch(
    [providers, activeId, syncKeys],
    () => {
      if (putTimer) clearTimeout(putTimer);
      putTimer = setTimeout(() => {
        putTimer = null;
        void pushRemote();
      }, PUT_DEBOUNCE_MS);
    },
    { deep: true, flush: "sync" }
  );

  return {
    providers,
    activeId,
    syncKeys,
    ready,
    active,
    configured,
    addProvider,
    updateProvider,
    removeProvider,
    setActive,
    updateSyncKeys,
    init,
  };
});
