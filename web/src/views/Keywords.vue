<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { KeywordRule } from "@readly/shared";
import RuleEditor from "@/components/RuleEditor.vue";
import { isRuleValid } from "@/modules/keywords";
import { useAnalysisStore } from "@/stores/analysis";

const router = useRouter();
const analysis = useAnalysisStore();

const creating = ref(false);
const editing = ref<KeywordRule | null>(null);

onMounted(() => {
  // 后台接线:镜像同步与规则就绪(失败静默,不阻塞首屏)
  void analysis.init().catch(() => undefined);
});
</script>

<template>
  <div class="mx-auto min-h-full max-w-3xl bg-white px-6 py-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <button class="text-sm text-neutral-500 hover:underline dark:text-neutral-400" @click="router.push('/')">← 返回阅读器</button>
    <h1 class="mt-4 text-xl font-semibold">关键词</h1>
    <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">设置要监控的词语或正则表达式,文章列表会按规则标色;点规则名可查看命中文章。全程本地匹配,不联网、不上传。</p>

    <div class="mt-6 space-y-2">
      <div
        v-for="rule in analysis.rules"
        :key="rule.id"
        data-rule-row
        class="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800"
      >
        <span class="h-3 w-3 shrink-0 rounded-full" :style="{ background: rule.color }" />
        <RouterLink :to="`/keywords/${rule.id}`" data-rule-detail class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium hover:underline">{{ rule.name }}</p>
          <p class="mt-0.5 truncate text-xs text-neutral-500">
            {{ rule.isRegex ? "正则" : "关键词" }}:{{ rule.keyword }}
            <span v-if="!isRuleValid(rule)" class="text-red-600 dark:text-red-400"> · 正则无效</span>
          </p>
        </RouterLink>
        <span class="shrink-0 text-xs text-neutral-500">{{ analysis.hitsByRule[rule.id]?.length ?? 0 }} 篇命中</span>
        <input
          data-rule-toggle
          type="checkbox"
          class="accent-[var(--accent)]"
          :checked="rule.enabled"
          aria-label="启用规则"
          @change="analysis.updateRule(rule.id, { enabled: ($event.target as HTMLInputElement).checked })"
        />
        <button data-rule-edit class="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" @click="editing = rule">编辑</button>
        <button data-rule-delete class="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800" @click="analysis.removeRule(rule.id)">删除</button>
      </div>
    </div>

    <p
      v-if="analysis.rules.length === 0"
      class="mt-6 rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
    >
      还没有关键词规则,点下方「新建规则」开始
    </p>

    <button data-new-rule class="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white" @click="creating = true">新建规则</button>

    <p class="mt-4 text-xs text-neutral-500 dark:text-neutral-400">命中统计基于本地最近 1000 篇;规则与命中都在本机计算,不上传。</p>

    <RuleEditor v-if="creating" @close="creating = false" @save="analysis.addRule($event)" />
    <RuleEditor v-else-if="editing" :initial="editing" @close="editing = null" @save="analysis.updateRule(editing.id, $event)" />
  </div>
</template>
