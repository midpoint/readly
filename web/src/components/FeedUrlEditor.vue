<script setup lang="ts">
import { ref } from "vue";
import type { Feed } from "@readly/shared";
import { useFeedsStore } from "@/stores/feeds";

const props = defineProps<{ feed: Feed }>();
const emit = defineEmits<{ saved: []; close: [] }>();

const feedsStore = useFeedsStore();
const url = ref(props.feed.url);
const busy = ref(false);
const error = ref("");

async function save(): Promise<void> {
  const next = url.value.trim();
  if (!next || next === props.feed.url || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    // 保存即抓取校验(服务端):成功才落库;失败抛 ApiError,消息就地展示
    await feedsStore.editFeedUrl(props.feed.id, next);
    emit("saved");
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "保存失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="emit('close')">
    <div class="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      <h3 class="text-base font-semibold">编辑订阅源网址</h3>
      <p class="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">{{ feed.title }}</p>
      <label class="mt-4 block text-xs text-neutral-500 dark:text-neutral-400">
        网址
        <input
          v-model="url"
          data-feed-url
          class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
          placeholder="https://example.com/feed.xml"
          @keydown.enter="save"
        />
      </label>
      <p v-if="error" data-feed-url-error class="mt-2 text-xs text-red-600 dark:text-red-400">{{ error }}</p>
      <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">保存时会立即抓取新地址校验;失败则保持原地址不变。</p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800" @click="emit('close')">取消</button>
        <button
          data-feed-url-save
          :disabled="busy || !url.trim() || url.trim() === feed.url"
          class="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm text-white disabled:opacity-50"
          @click="save"
        >
          {{ busy ? "保存中…" : "保存" }}
        </button>
      </div>
    </div>
  </div>
</template>
