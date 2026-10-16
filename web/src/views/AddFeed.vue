<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";

const router = useRouter();
const store = useFeedsStore();

const tab = ref<"single" | "batch">("single");
const singleUrl = ref("");
const candidates = ref<{ url: string; title: string; type: string }[]>([]);
const batchText = ref("");
const categoryId = ref<number | null>(null);
const busy = ref(false);
const message = ref("");
const failures = ref<{ url: string; error: string }[]>([]);

async function discover() {
  if (!singleUrl.value.trim()) return;
  busy.value = true;
  message.value = "";
  try {
    candidates.value = await store.discover(singleUrl.value.trim());
    if (candidates.value.length === 0) message.value = "没有找到订阅源,可直接填写 feed 地址重试";
  } catch (e) {
    message.value = e instanceof Error ? e.message : "发现失败";
  } finally {
    busy.value = false;
  }
}

// 订阅集合已变(加源 / OPML 导入):标记列表失效,返回阅读器时由 Inbox 自动重拉新文章
// (UI 层标记,避免 store 间新依赖)
function markListStale(): void {
  useArticlesStore().markStale();
}

async function subscribe(urls: string[]) {
  const clean = urls.map((u) => u.trim()).filter(Boolean);
  if (clean.length === 0) return;
  busy.value = true;
  message.value = "";
  failures.value = [];
  try {
    const r = await store.addFeeds(clean, categoryId.value);
    markListStale();
    message.value = `成功添加 ${r.created} 个源`;
    failures.value = r.failed;
    candidates.value = [];
    singleUrl.value = "";
    batchText.value = "";
  } catch (e) {
    message.value = e instanceof Error ? e.message : "添加失败";
  } finally {
    busy.value = false;
  }
}

const tabCls = (active: boolean) =>
  `rounded-lg px-3 py-1.5 text-sm ${active ? "bg-[var(--accent)] text-white" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"}`;
</script>

<template>
  <div class="min-h-full bg-white dark:bg-neutral-950 dark:text-neutral-100">
    <div class="mx-auto max-w-2xl px-6 py-8">
      <button class="mb-6 text-sm text-neutral-500 hover:underline dark:text-neutral-400" @click="router.push('/')">← 返回阅读器</button>
      <h1 class="text-xl font-semibold">添加订阅</h1>

      <div class="mt-4 flex gap-2">
        <button :class="tabCls(tab === 'single')" @click="tab = 'single'">单个添加</button>
        <button :class="tabCls(tab === 'batch')" @click="tab = 'batch'">批量添加</button>
      </div>

      <div v-if="tab === 'single'" class="mt-6 space-y-3">
        <p class="text-sm text-neutral-500 dark:text-neutral-400">输入网站地址自动发现订阅源,或直接填写 feed 地址</p>
        <div class="flex gap-2">
          <input v-model="singleUrl" placeholder="https://example.com 或 https://example.com/feed.xml" class="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100" @keydown.enter="discover" />
          <button :disabled="busy" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50" @click="discover">发现</button>
        </div>
        <div v-if="candidates.length" class="space-y-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
          <label v-for="c in candidates" :key="c.url" class="flex items-center justify-between gap-3 text-sm">
            <span class="min-w-0 truncate">{{ c.title || c.url }}</span>
            <button class="shrink-0 rounded-lg border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700" @click="subscribe([c.url])">订阅</button>
          </label>
        </div>
        <button class="text-xs text-neutral-500 underline dark:text-neutral-400" @click="subscribe([singleUrl])">直接作为 feed 地址订阅</button>
      </div>

      <div v-else-if="tab === 'batch'" class="mt-6 space-y-3">
        <p class="text-sm text-neutral-500 dark:text-neutral-400">每行一个 feed 地址(自动分批提交)</p>
        <textarea v-model="batchText" rows="8" class="w-full rounded-lg border border-neutral-300 px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100" placeholder="https://a.com/feed&#10;https://b.com/rss" />
        <button :disabled="busy" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50" @click="subscribe(batchText.split('\n').map((s) => s.trim()).filter(Boolean))">
          批量订阅
        </button>
      </div>

      <div v-if="message" class="mt-4 rounded-lg bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-900 dark:text-neutral-100">{{ message }}</div>
      <ul v-if="failures.length" class="mt-2 space-y-1 text-xs text-red-600 dark:text-red-400">
        <li v-for="f in failures" :key="f.url">{{ f.url }}:{{ f.error }}</li>
      </ul>
    </div>
  </div>
</template>
