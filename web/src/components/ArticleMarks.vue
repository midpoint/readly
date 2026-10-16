<script setup lang="ts">
import { computed } from "vue";
import type { ArticleListItem } from "@readly/shared";
import { useAnalysisStore } from "@/stores/analysis";

const props = defineProps<{ item: ArticleListItem }>();
const analysis = useAnalysisStore();
const hitDots = computed(() => analysis.hitsFor(props.item.id).slice(0, 3));
const hitMore = computed(() => Math.max(0, analysis.hitsFor(props.item.id).length - 3));
const FALLBACK_DOT_COLOR = "#94a3b8";

function dotColor(ruleId: string): string {
  return analysis.rules.find((r) => r.id === ruleId)?.color ?? FALLBACK_DOT_COLOR;
}
function dotTitle(ruleId: string): string {
  return analysis.rules.find((r) => r.id === ruleId)?.name ?? ruleId;
}
</script>

<template>
  <!-- 状态标记聚簇:命中色点(≤3)+ 溢出数 + ★ + 🕘;卡片/列表双布局共用(gap-2 与外层一致,卡片逐像素等价) -->
  <span class="flex shrink-0 items-center gap-2 text-xs">
    <span
      v-for="h in hitDots"
      :key="h.ruleId"
      data-hit-dot
      :data-rule-id="h.ruleId"
      :title="dotTitle(h.ruleId)"
      class="h-2 w-2 shrink-0 rounded-full"
      :style="{ background: dotColor(h.ruleId) }"
    />
    <span v-if="hitMore > 0" class="shrink-0 text-[10px] text-neutral-400">+{{ hitMore }}</span>
    <span v-if="item.isStarred" class="shrink-0 text-amber-500">★</span>
    <span v-if="item.isLater" class="shrink-0 text-sky-500">🕘</span>
  </span>
</template>
