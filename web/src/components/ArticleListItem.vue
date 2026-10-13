<script setup lang="ts">
import type { ArticleListItem } from "@readly/shared";

defineProps<{ item: ArticleListItem; active: boolean }>();
defineEmits<{ select: [id: number] }>();

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
    class="flex w-full gap-3 border-b border-neutral-100 px-4 py-3 text-left transition-colors dark:border-neutral-800"
    :class="active ? 'bg-[var(--accent)]/10' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'"
    @click="$emit('select', item.id)"
  >
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 text-xs text-neutral-500">
        <span v-if="!item.isRead" class="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
        <span class="truncate">{{ item.feedTitle }}</span>
        <span class="shrink-0">·</span>
        <span class="shrink-0">{{ relative(item.publishedAt) }}</span>
        <span v-if="item.isStarred" class="shrink-0 text-amber-500">★</span>
        <span v-if="item.isLater" class="shrink-0 text-sky-500">🕘</span>
      </div>
      <h3 class="mt-1 line-clamp-2 text-sm font-medium" :class="item.isRead ? 'text-neutral-500' : 'text-neutral-900 dark:text-neutral-100'">
        {{ item.title }}
      </h3>
      <p v-if="item.excerpt" class="mt-1 line-clamp-1 text-xs text-neutral-500">{{ item.excerpt }}</p>
    </div>
    <img v-if="item.imageUrl" :src="item.imageUrl" alt="" loading="lazy" class="h-14 w-14 shrink-0 rounded-lg object-cover" />
  </button>
</template>
