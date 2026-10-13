<script setup lang="ts">
import { useShortcutHelp } from "@/composables/useShortcutHelp";

const { showShortcutHelp, closeShortcutHelp } = useShortcutHelp();

const shortcuts: { keys: string; action: string }[] = [
  { keys: "j", action: "下一个未读文章" },
  { keys: "k", action: "上一个未读文章" },
  { keys: "s", action: "收藏 / 取消收藏当前文章" },
  { keys: "m", action: "切换已读 / 未读" },
  { keys: "v", action: "加入 / 移出稍后读" },
  { keys: "Esc", action: "关闭文章 / 关闭本浮层" },
  { keys: "?", action: "打开 / 关闭本浮层" },
];
</script>

<template>
  <div
    v-if="showShortcutHelp"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    data-shortcut-help
    @click.self="closeShortcutHelp"
  >
    <div class="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      <div class="flex items-center justify-between">
        <h3 class="text-base font-semibold">快捷键</h3>
        <button class="rounded-md px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800" @click="closeShortcutHelp">
          关闭
        </button>
      </div>
      <dl class="mt-4 space-y-2 text-sm">
        <div v-for="s in shortcuts" :key="s.keys" class="flex items-center justify-between gap-4">
          <dt>
            <kbd class="rounded-md border border-neutral-300 bg-neutral-100 px-2 py-0.5 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-800">{{ s.keys }}</kbd>
          </dt>
          <dd class="text-right text-neutral-600 dark:text-neutral-300">{{ s.action }}</dd>
        </div>
      </dl>
      <p class="mt-4 text-xs text-neutral-500 dark:text-neutral-400">在列表中按 j 即从当前位置跳到下一个未读。</p>
    </div>
  </div>
</template>
