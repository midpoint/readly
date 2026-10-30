<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { AiProvider } from "@readly/shared";
import FeverSettings from "@/components/FeverSettings.vue";
import GoogleReaderSettings from "@/components/GoogleReaderSettings.vue";
import ProviderEditor from "@/components/ProviderEditor.vue";
import ShortcutHelp from "@/components/ShortcutHelp.vue";
import { useShortcutHelp } from "@/composables/useShortcutHelp";
import { exportOpml, parseOpml, type OpmlFeed } from "@/modules/opml";
import { useAiStore } from "@/stores/ai";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";

const router = useRouter();
const ai = useAiStore();
const store = useFeedsStore();
const { openShortcutHelp } = useShortcutHelp();
const busy = ref(false);
const message = ref("");
const failures = ref<{ url: string; error: string }[]>([]);

const creating = ref(false);
const editing = ref<AiProvider | null>(null);

onMounted(() => {
  // 后台接线:本地切片就绪 + 首次无本地副本时采用服务端(失败静默,不阻塞首屏);订阅列表预载失败给出提示
  ai.init();
  void store.load().catch(() => {
    message.value = "订阅列表加载失败,导出可能不完整";
  });
});

function onSave(patch: Omit<AiProvider, "id">): void {
  if (editing.value) ai.updateProvider(editing.value.id, patch);
  else ai.addProvider(patch);
}

function onDelete(p: AiProvider): void {
  if (!window.confirm(`删除服务商「${p.name}」?(未开启云同步时其密钥将永久丢失)`)) return;
  ai.removeProvider(p.id);
}

// 订阅集合已变(OPML 导入):标记文章列表失效,返回阅读器时由 Inbox 自动重拉
function markListStale(): void {
  useArticlesStore().markStale();
}

async function importOpml(e: Event): Promise<void> {
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
    markListStale();
    message.value = `导入完成:成功 ${created} 个源`;
  } catch (err) {
    message.value = err instanceof Error ? err.message : "OPML 解析失败";
  } finally {
    busy.value = false;
  }
}

function doExport(): void {
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
</script>

<template>
  <div class="mx-auto min-h-full max-w-3xl bg-white px-6 py-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <button class="text-sm text-neutral-500 hover:underline dark:text-neutral-400" @click="router.push('/')">← 返回阅读器</button>
    <h1 class="mt-4 text-xl font-semibold">设置</h1>

    <section class="mt-8">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-semibold">AI 服务商</h2>
        <span v-if="ai.providers.length >= 20" data-provider-limit class="text-xs text-neutral-500 dark:text-neutral-400">最多 20 个服务商</span>
      </div>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        用于 AI 摘要。填写任意 OpenAI 兼容接口(预设可改);密钥默认只存本机浏览器,不随订阅数据上云。
      </p>

      <div class="mt-4 space-y-2">
        <div
          v-for="p in ai.providers"
          :key="p.id"
          data-provider-row
          class="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800"
        >
          <input
            data-provider-active
            type="radio"
            name="ai-active"
            class="shrink-0 accent-[var(--accent)]"
            :checked="ai.activeId === p.id"
            aria-label="设为默认服务商"
            @change="ai.setActive(p.id)"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ p.name }}</p>
            <p class="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">{{ p.baseUrl }} · {{ p.model }}</p>
          </div>
          <span v-if="p.useProxy" class="shrink-0 rounded-md bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">代理</span>
          <span v-if="p.apiKey" class="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">已存密钥</span>
          <button data-provider-edit class="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800" @click="editing = p">编辑</button>
          <button data-provider-delete class="shrink-0 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800" @click="onDelete(p)">删除</button>
        </div>
      </div>

      <p
        v-if="ai.providers.length === 0"
        class="mt-4 rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
      >
        还没有配置 AI 服务商,点下方「新增服务商」开始
      </p>
      <p v-else-if="!ai.configured" class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        请选择一个默认服务商(行首单选),AI 摘要才会启用。
      </p>

      <button
        data-new-provider
        class="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="ai.providers.length >= 20"
        @click="creating = true"
      >
        新增服务商
      </button>

      <div class="mt-6 rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <label class="flex items-center gap-2 text-sm">
          <input
            data-sync-keys
            type="checkbox"
            class="accent-[var(--accent)]"
            :checked="ai.syncKeys"
            @change="ai.updateSyncKeys(($event.target as HTMLInputElement).checked)"
          />
          <span>将密钥随设置同步到云端(D1)</span>
        </label>
        <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          关闭时(默认)D1 中的服务商配置会剥离密钥,密钥只留在这台设备。
        </p>
        <p v-if="ai.syncKeys" data-sync-warning class="mt-1 text-xs text-red-600 dark:text-red-400">
          密钥将写入你的 D1 数据库,请确认部署环境可信
        </p>
      </div>
    </section>

    <section class="mt-8">
      <h2 class="text-base font-semibold">订阅数据</h2>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">OPML 是通用的订阅列表格式,可在其它阅读器间迁移。</p>
      <div class="mt-4 flex flex-wrap gap-2">
        <label class="cursor-pointer rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
          导入 OPML
          <input type="file" accept=".opml,.xml" class="hidden" data-opml-import @change="importOpml" />
        </label>
        <button
          data-opml-export
          :disabled="busy"
          class="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="doExport"
        >
          导出全部订阅(OPML)
        </button>
      </div>
      <div v-if="message" class="mt-4 rounded-lg bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-900">{{ message }}</div>
      <ul v-if="failures.length" class="mt-2 space-y-1 text-xs text-red-600 dark:text-red-400">
        <li v-for="f in failures" :key="f.url">{{ f.url }}:{{ f.error }}</li>
      </ul>
    </section>

    <GoogleReaderSettings />

    <FeverSettings />

    <section class="mt-8">
      <h2 class="text-base font-semibold">帮助</h2>
      <button
        data-shortcut-help-open
        class="mt-4 rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        @click="openShortcutHelp"
      >
        查看快捷键
      </button>
    </section>

    <ShortcutHelp />

    <ProviderEditor v-if="creating" @close="creating = false" @save="onSave" />
    <ProviderEditor v-else-if="editing" :initial="editing" @close="editing = null" @save="onSave" />
  </div>
</template>
