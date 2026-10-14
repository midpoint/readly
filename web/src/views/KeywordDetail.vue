<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isRuleValid } from "@/modules/keywords";
import { useAnalysisStore } from "@/stores/analysis";

const route = useRoute();
const router = useRouter();
const analysis = useAnalysisStore();

onMounted(() => {
  // 深链进入时规则可能尚未加载(本地 LS / 服务端),后台接线(失败静默)
  void analysis.init().catch(() => undefined);
});

const ruleId = computed(() => String(route.params.id ?? ""));
const rule = computed(() => analysis.rules.find((r) => r.id === ruleId.value) ?? null);
const hits = computed(() => (rule.value ? analysis.hitsByRule[rule.value.id] ?? [] : []));

function openArticle(id: number): void {
  void router.push({ path: "/", query: { a: String(id) } });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
</script>

<template>
  <div class="mx-auto min-h-full max-w-3xl bg-white px-6 py-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <button class="text-sm text-neutral-500 hover:underline dark:text-neutral-400" @click="router.push('/keywords')">← 返回关键词</button>

    <template v-if="rule">
      <div class="mt-4 flex items-center gap-3">
        <span class="h-3 w-3 shrink-0 rounded-full" :style="{ background: rule.color }" />
        <h1 class="text-xl font-semibold">{{ rule.name }}</h1>
      </div>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {{ rule.isRegex ? "正则" : "关键词" }}:{{ rule.keyword }} · {{ rule.enabled ? "已启用" : "已停用" }}
        <span v-if="!isRuleValid(rule)" class="text-red-600 dark:text-red-400"> · 正则无效</span>
      </p>
      <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">命中统计基于本地最近 1000 篇。</p>

      <p v-if="hits.length === 0" class="mt-8 text-center text-sm text-neutral-500 dark:text-neutral-400">暂无命中</p>
      <ul v-else class="mt-6 space-y-1">
        <li
          v-for="h in hits"
          :key="h.id"
          data-matched-article
          class="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800"
        >
          <button class="min-w-0 flex-1 truncate text-left text-sm hover:underline" @click="openArticle(h.id)">{{ h.title }}</button>
          <span class="w-24 shrink-0 truncate text-xs text-neutral-500 dark:text-neutral-400">{{ h.feedTitle }}</span>
          <span class="w-24 shrink-0 text-xs text-neutral-500 dark:text-neutral-400">{{ fmtTime(h.publishedAt) }}</span>
          <span class="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">×{{ h.count }}</span>
        </li>
      </ul>
    </template>

    <div
      v-else
      class="mt-8 rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center dark:border-neutral-700"
    >
      <p class="text-sm text-neutral-500 dark:text-neutral-400">规则不存在或已被删除</p>
      <button class="mt-3 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white" @click="router.push('/keywords')">返回关键词列表</button>
    </div>
  </div>
</template>
