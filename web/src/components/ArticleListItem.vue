<script setup lang="ts">
import { computed } from "vue";
import type { ArticleListItem } from "@readly/shared";
import { useSettingsStore } from "@/stores/settings";
import ArticleMarks from "./ArticleMarks.vue";

const props = defineProps<{ item: ArticleListItem; active: boolean }>();
defineEmits<{ select: [id: number] }>();

const settings = useSettingsStore();
// 布局偏好(卡片/紧凑列表):组件自读 store,切换即时生效,无需父级重载
const layout = computed(() => settings.prefs.articleLayout);

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}
</script>

<template>
  <button
    data-article-row
    :data-layout="layout"
    class="flex w-full gap-3 border-b border-neutral-100 px-4 text-left transition-colors dark:border-neutral-800"
    :class="[layout === 'list' ? 'items-center py-1.5' : 'py-3', active ? 'bg-[var(--accent)]/10' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900']"
    @click="$emit('select', item.id)"
  >
    <!-- 列表模式:单行——标题 + 右侧状态标记;不再渲染源名与时间 -->
    <template v-if="layout === 'list'">
      <span v-if="!item.isRead" class="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
      <h3
        class="min-w-0 flex-1 text-sm font-medium line-clamp-1"
        :class="item.isRead ? 'text-neutral-500' : 'text-neutral-900 dark:text-neutral-100'"
      >
        {{ item.title }}
      </h3>
      <ArticleMarks :item="item" />
    </template>

    <!-- 卡片模式:副信息行(源·时间)· 标题两行 · 摘要 · 缩略图(结构不变) -->
    <template v-else>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span v-if="!item.isRead" class="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
          <span class="truncate">{{ item.feedTitle }}</span>
          <span class="shrink-0">·</span>
          <span class="shrink-0">{{ relative(item.publishedAt) }}</span>
          <ArticleMarks :item="item" />
        </div>
        <h3
          class="mt-1 text-sm font-medium line-clamp-2"
          :class="item.isRead ? 'text-neutral-500' : 'text-neutral-900 dark:text-neutral-100'"
        >
          {{ item.title }}
        </h3>
        <p v-if="item.excerpt" class="mt-1 line-clamp-1 text-xs text-neutral-500">{{ item.excerpt }}</p>
      </div>
      <img
        v-if="item.imageUrl"
        :src="item.imageUrl"
        alt=""
        loading="lazy"
        class="h-14 w-14 shrink-0 rounded-lg object-cover"
      />
    </template>
  </button>
</template>
