<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { exportOpml, parseOpml, type OpmlFeed } from "@/modules/opml";
import { useFeedsStore } from "@/stores/feeds";

const router = useRouter();
const store = useFeedsStore();

const tab = ref<"single" | "batch" | "opml">("single");
const singleUrl = ref("");
const candidates = ref<{ url: string; title: string; type: string }[]>([]);
const batchText = ref("");
const categoryId = ref<number | null>(null);
const busy = ref(false);
const message = ref("");
const failures = ref<{ url: string; error: string }[]>([]);

onMounted(() => {
  void store.load().catch(() => {
    message.value = "订阅列表加载失败,导出可能不完整";
  });
});

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

async function subscribe(urls: string[]) {
  const clean = urls.map((u) => u.trim()).filter(Boolean);
  if (clean.length === 0) return;
  busy.value = true;
  message.value = "";
  failures.value = [];
  try {
    const r = await store.addFeeds(clean, categoryId.value);
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

async function importOpml(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const text = await file.text();
  busy.value = true;
  message.value = "";
  failures.value = [];
  try {
    const parsed = parseOpml(text);
    let created = 0;
    for (const cat of parsed.categories) {
      const c = await store.createCategory(cat.name);
      const r = await store.addFeeds(cat.feeds.map((f) => f.url), c.id);
      created += r.created;
      failures.value.push(...r.failed);
    }
    if (parsed.uncategorized.length > 0) {
      const r = await store.addFeeds(parsed.uncategorized.map((f) => f.url), null);
      created += r.created;
      failures.value.push(...r.failed);
    }
    message.value = `导入完成:成功 ${created} 个源`;
  } catch (err) {
    message.value = err instanceof Error ? err.message : "OPML 解析失败";
  } finally {
    busy.value = false;
  }
}

function doExport() {
  const categories = store.categories.map((c) => ({
    name: c.name,
    feeds: store.feeds
      .filter((f) => f.categoryId === c.id)
      .map((f): OpmlFeed => ({ url: f.url, title: f.title, siteUrl: f.siteUrl })),
  }));
  const uncategorized = store.feeds
    .filter((f) => f.categoryId === null)
    .map((f): OpmlFeed => ({ url: f.url, title: f.title, siteUrl: f.siteUrl }));
  if (uncategorized.length > 0) categories.push({ name: "未分类", feeds: uncategorized });
  const xml = exportOpml(categories);
  const blob = new Blob([xml], { type: "text/xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "readly-subscriptions.opml";
  a.click();
  URL.revokeObjectURL(a.href);
}

const tabCls = (active: boolean) =>
  `rounded-lg px-3 py-1.5 text-sm ${active ? "bg-[var(--accent)] text-white" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"}`;
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-8">
    <button class="mb-6 text-sm text-neutral-500 hover:underline" @click="router.push('/')">← 返回阅读器</button>
    <h1 class="text-xl font-semibold">添加订阅</h1>

    <div class="mt-4 flex gap-2">
      <button :class="tabCls(tab === 'single')" @click="tab = 'single'">单个添加</button>
      <button :class="tabCls(tab === 'batch')" @click="tab = 'batch'">批量添加</button>
      <button :class="tabCls(tab === 'opml')" @click="tab = 'opml'">OPML 导入/导出</button>
    </div>

    <div v-if="tab === 'single'" class="mt-6 space-y-3">
      <p class="text-sm text-neutral-500">输入网站地址自动发现订阅源,或直接填写 feed 地址</p>
      <div class="flex gap-2">
        <input v-model="singleUrl" placeholder="https://example.com 或 https://example.com/feed.xml" class="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" @keydown.enter="discover" />
        <button :disabled="busy" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50" @click="discover">发现</button>
      </div>
      <div v-if="candidates.length" class="space-y-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <label v-for="c in candidates" :key="c.url" class="flex items-center justify-between gap-3 text-sm">
          <span class="min-w-0 truncate">{{ c.title || c.url }}</span>
          <button class="shrink-0 rounded-lg border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700" @click="subscribe([c.url])">订阅</button>
        </label>
      </div>
      <button class="text-xs text-neutral-500 underline" @click="subscribe([singleUrl])">直接作为 feed 地址订阅</button>
    </div>

    <div v-else-if="tab === 'batch'" class="mt-6 space-y-3">
      <p class="text-sm text-neutral-500">每行一个 feed 地址,最多 100 个</p>
      <textarea v-model="batchText" rows="8" class="w-full rounded-lg border border-neutral-300 px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900" placeholder="https://a.com/feed&#10;https://b.com/rss" />
      <button :disabled="busy" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50" @click="subscribe(batchText.split('\n').map((s) => s.trim()).filter(Boolean))">
        批量订阅
      </button>
    </div>

    <div v-else class="mt-6 space-y-4">
      <label class="block rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        点击选择 OPML 文件导入
        <input type="file" accept=".opml,.xml" class="hidden" @change="importOpml" />
      </label>
      <button class="rounded-lg border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700" @click="doExport">导出全部订阅(OPML)</button>
    </div>

    <div v-if="message" class="mt-4 rounded-lg bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-900">{{ message }}</div>
    <ul v-if="failures.length" class="mt-2 space-y-1 text-xs text-red-600">
      <li v-for="f in failures" :key="f.url">{{ f.url }}:{{ f.error }}</li>
    </ul>
  </div>
</template>
