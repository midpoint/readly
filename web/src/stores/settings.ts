import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { DEFAULT_READER_PREFS, SETTING_KEYS, type FetchPrefs, type ReaderPrefs } from "@readly/shared";
import { api } from "@/api/client";
import { applyTheme, isHexColor, isReadingTheme, watchSystemTheme } from "@/modules/theme";

const LS_KEY = "readly_prefs";
const FETCH_LS_KEY = "readly_fetch_prefs";
const PUT_DEBOUNCE_MS = 1000;
const NUM_RANGES = {
  fontSize: [14, 24],
  lineHeight: [1.4, 2.2],
  contentWidth: [560, 900],
} as const;

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function sanitizePrefs(raw: unknown): ReaderPrefs {
  const d = DEFAULT_READER_PREFS;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    themeMode:
      o.themeMode === "light" || o.themeMode === "dark" || o.themeMode === "system" ? o.themeMode : d.themeMode,
    accent: isHexColor(o.accent) ? o.accent : d.accent,
    readingTheme: isReadingTheme(o.readingTheme) ? o.readingTheme : d.readingTheme,
    fontSize: clampNumber(o.fontSize, NUM_RANGES.fontSize[0], NUM_RANGES.fontSize[1], d.fontSize),
    lineHeight: clampNumber(o.lineHeight, NUM_RANGES.lineHeight[0], NUM_RANGES.lineHeight[1], d.lineHeight),
    contentWidth: clampNumber(o.contentWidth, NUM_RANGES.contentWidth[0], NUM_RANGES.contentWidth[1], d.contentWidth),
    fontFamily: o.fontFamily === "serif" ? "serif" : "system",
    autoMarkReadOnOpen: o.autoMarkReadOnOpen !== false,
    autoMarkReadOnScroll: o.autoMarkReadOnScroll !== false,
    unreadOnly: o.unreadOnly === true,
    collapsedCategoryIds: Array.isArray(o.collapsedCategoryIds)
      ? [...new Set(o.collapsedCategoryIds.filter((v): v is number => typeof v === "number" && Number.isInteger(v)))].slice(0, 200)
      : [],
    sidebarWidth: clampNumber(o.sidebarWidth, 200, 420, d.sidebarWidth),
    listWidth: clampNumber(o.listWidth, 300, 600, d.listWidth),
    articleLayout: o.articleLayout === "list" ? "list" : "card",
  };
}

export const DEFAULT_FETCH_PREFS: FetchPrefs = { auto: true, minChars: 300 };

export function sanitizeFetchPrefs(raw: unknown): FetchPrefs {
  const d = DEFAULT_FETCH_PREFS;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    auto: o.auto !== false,
    minChars: clampNumber(o.minChars, 50, 5000, d.minChars),
  };
}

function readLocal(): ReaderPrefs | null {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try {
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readLocalFetch(): FetchPrefs | null {
  const raw = localStorage.getItem(FETCH_LS_KEY);
  if (!raw) return null;
  try {
    return sanitizeFetchPrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}

export const useSettingsStore = defineStore("settings", () => {
  const prefs = ref<ReaderPrefs>({ ...DEFAULT_READER_PREFS });
  const fetchPrefs = ref<FetchPrefs>({ ...DEFAULT_FETCH_PREFS });
  const ready = ref(false);
  let serverCopy: string | null = null;
  let fetchServerCopy: string | null = null;
  let putTimer: ReturnType<typeof setTimeout> | null = null;
  let disposeSystem: (() => void) | null = null;

  function apply(): void {
    applyTheme(prefs.value);
  }

  function initLocal(): void {
    const local = readLocal();
    if (local) prefs.value = local;
    apply();
    const localFetch = readLocalFetch();
    if (localFetch) fetchPrefs.value = localFetch;
    ready.value = true;
  }

  async function initRemote(): Promise<void> {
    // 本地两侧偏好全有:本地为真源,不拉取服务端、不回写;任一侧缺失才拉取
    if (readLocal() !== null && readLocalFetch() !== null) {
      serverCopy = JSON.stringify(readLocal());
      fetchServerCopy = JSON.stringify(readLocalFetch());
      return;
    }
    const all = await api<Record<string, unknown>>("/api/settings");
    if (readLocal() === null) {
      const serverPrefs = all[SETTING_KEYS.readerPrefs];
      if (serverPrefs !== undefined) {
        serverCopy = JSON.stringify(sanitizePrefs(serverPrefs));
        // GET 在途期间本地被写入(如另一处 updatePrefs)时,本地为真源,不再套用服务端快照
        if (readLocal() === null) {
          prefs.value = sanitizePrefs(serverPrefs);
          apply();
        }
      }
    }
    if (readLocalFetch() === null) {
      const serverFetch = all[SETTING_KEYS.fetchPrefs];
      if (serverFetch !== undefined) {
        fetchServerCopy = JSON.stringify(sanitizeFetchPrefs(serverFetch));
        if (readLocalFetch() === null) {
          fetchPrefs.value = sanitizeFetchPrefs(serverFetch);
        }
      }
    }
  }

  function initSystemWatch(): void {
    disposeSystem?.();
    disposeSystem = watchSystemTheme(() => {
      if (prefs.value.themeMode === "system") apply();
    });
  }

  function updatePrefs(patch: Partial<ReaderPrefs>): void {
    prefs.value = sanitizePrefs({ ...prefs.value, ...patch });
  }

  function updateFetchPrefs(patch: Partial<FetchPrefs>): void {
    fetchPrefs.value = sanitizeFetchPrefs({ ...fetchPrefs.value, ...patch });
  }

  function resetPrefs(): void {
    prefs.value = { ...DEFAULT_READER_PREFS };
    fetchPrefs.value = { ...DEFAULT_FETCH_PREFS };
  }

  async function pushRemote(): Promise<void> {
    const serialized = JSON.stringify(prefs.value);
    const serializedFetch = JSON.stringify(fetchPrefs.value);
    if (serialized === serverCopy && serializedFetch === fetchServerCopy) return;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: {
          kv: {
            [SETTING_KEYS.readerPrefs]: prefs.value,
            [SETTING_KEYS.fetchPrefs]: fetchPrefs.value,
          },
        },
      });
      serverCopy = serialized;
      fetchServerCopy = serializedFetch;
    } catch {
      // 静默:本地为真源,下次变更再试
    }
  }

  async function flushPrefs(): Promise<void> {
    if (putTimer) {
      clearTimeout(putTimer);
      putTimer = null;
    }
    await pushRemote();
  }

  watch(
    prefs,
    () => {
      localStorage.setItem(LS_KEY, JSON.stringify(prefs.value));
      apply();
      if (putTimer) clearTimeout(putTimer);
      putTimer = setTimeout(() => {
        putTimer = null;
        void pushRemote();
      }, PUT_DEBOUNCE_MS);
    },
    { deep: true, flush: "sync" }
  );

  watch(
    fetchPrefs,
    () => {
      localStorage.setItem(FETCH_LS_KEY, JSON.stringify(fetchPrefs.value));
      if (putTimer) clearTimeout(putTimer);
      putTimer = setTimeout(() => {
        putTimer = null;
        void pushRemote();
      }, PUT_DEBOUNCE_MS);
    },
    { deep: true, flush: "sync" }
  );

  return { prefs, fetchPrefs, ready, initLocal, initRemote, initSystemWatch, updatePrefs, updateFetchPrefs, resetPrefs, flushPrefs };
});
