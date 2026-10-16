<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useShortcutHelp } from "@/composables/useShortcutHelp";

// 显隐由 MobileNav 的本地 ref 管理(不引全局态);本组件只负责渲染与关闭通知
const emit = defineEmits<{ close: [] }>();

const router = useRouter();
const { openShortcutHelp } = useShortcutHelp();

type MoreKey = "events" | "keywords" | "settings" | "shortcuts";

const items: { key: MoreKey; label: string; icon: string }[] = [
  { key: "events", label: "事件", icon: "⚡" },
  { key: "keywords", label: "关键词", icon: "✦" },
  { key: "settings", label: "设置", icon: "⚙" },
  { key: "shortcuts", label: "快捷键", icon: "⌨" },
];

function pick(key: MoreKey): void {
  if (key === "shortcuts") {
    openShortcutHelp(); // 与 Inbox 内 ? 快捷键共用模块级单例链路(浮层由 Inbox/设置页宿主渲染)
  } else {
    void router.push(`/${key}`);
  }
  emit("close"); // 移动端:选中即关,避免返回后残留浮层
}

// Esc 关闭:弹层无全局态可挂,自持 document 级监听;卸载时撤除
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") emit("close");
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onUnmounted(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-end bg-black/40"
    data-more-sheet
    @click.self="emit('close')"
  >
    <div
      role="dialog"
      aria-label="更多"
      class="w-full rounded-t-2xl border-t border-neutral-200 bg-white pb-2 text-neutral-900 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <button
        v-for="item in items"
        :key="item.key"
        :data-more-item="item.key"
        class="flex w-full items-center gap-3 px-5 py-3.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
        @click="pick(item.key)"
      >
        <span aria-hidden="true" class="w-6 shrink-0 text-center">{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </button>
    </div>
  </div>
</template>
