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

// 等镜像同步(若在途)结束:进入即算要算「已同步的镜像」,否则首屏会对空/半镜像聚类。
// init() 内部已后台触发一次同步(不等待),这里轮询 syncState 直到不再 syncing(上限 10s,超时照算)。
async function waitSyncSettled(): Promise<void> {
  for (let i = 0; i < 400 && analysis.syncState === "syncing"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

onMounted(async () => {
  await analysis.init();
  if (analysis.syncState === "idle") await analysis.syncIncremental();
  await waitSyncSettled();
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
    <button class="text-sm text-neutral-500 hover:underline dark:text-neutral-400" @click="router.push('/')">← 返回阅读器</button>
    <h1 class="mt-4 text-xl font-semibold">事件</h1>
    <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">把内容相近的新闻自动归为事件组,一眼看清同一事件的发展脉络。全程本地计算,不联网、不上传。</p>

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
        <div class="h-full bg-[var(--accent-strong)] transition-[width]" :style="{ width: `${Math.round(analysis.progress * 100)}%` }" />
      </div>
      <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">本地计算中… {{ Math.round(analysis.progress * 100) }}%</p>
    </div>

    <p v-if="analysis.computeError" class="mt-4 text-sm text-red-600 dark:text-red-400">{{ analysis.computeError }}</p>
    <p v-else-if="analysis.syncState === 'syncing'" class="mt-4 text-sm text-neutral-500 dark:text-neutral-400">正在同步最近文章到本地…</p>
    <p v-else-if="analysis.syncState === 'error'" class="mt-4 text-sm text-neutral-500 dark:text-neutral-400">本地文章同步失败,可稍后在阅读器刷新后重试。</p>

    <div v-if="analysis.groups && analysis.groups.length === 0 && !analysis.computing" class="mt-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
      当前范围没有找到相近的新闻
      <span class="block mt-1 text-xs text-neutral-500 dark:text-neutral-400">可尝试把相似度调为「宽松」或扩大范围</span>
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
            <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              {{ fmtTime(g.firstAt) }} – {{ fmtTime(g.lastAt) }} · {{ new Set(g.members.map((m) => m.feedTitle)).size }} 个来源
            </p>
          </div>
          <span class="shrink-0 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-medium text-[var(--accent-strong)]">{{ g.count }} 篇</span>
        </button>
        <ul v-if="expanded.has(g.key)" class="border-t border-neutral-100 dark:border-neutral-800">
          <li v-for="m in g.members" :key="m.id" data-cluster-member class="flex items-center gap-3 px-4 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900">
            <span class="w-24 shrink-0 text-xs text-neutral-500 dark:text-neutral-400">{{ fmtTime(m.publishedAt) }}</span>
            <span class="w-24 shrink-0 truncate text-xs text-neutral-500 dark:text-neutral-400">{{ m.feedTitle }}</span>
            <button class="min-w-0 flex-1 truncate text-left hover:underline" @click="openArticle(m.id)">{{ m.title }}</button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
