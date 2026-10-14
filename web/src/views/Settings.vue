<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { AiProvider } from "@readly/shared";
import ProviderEditor from "@/components/ProviderEditor.vue";
import { useAiStore } from "@/stores/ai";

const router = useRouter();
const ai = useAiStore();

const creating = ref(false);
const editing = ref<AiProvider | null>(null);

onMounted(() => {
  // 后台接线:本地切片就绪 + 首次无本地副本时采用服务端(失败静默,不阻塞首屏)
  ai.init();
});

function onSave(patch: Omit<AiProvider, "id">): void {
  if (editing.value) ai.updateProvider(editing.value.id, patch);
  else ai.addProvider(patch);
}
</script>

<template>
  <div class="mx-auto min-h-full max-w-3xl bg-white px-6 py-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <button class="text-sm text-neutral-500 hover:underline dark:text-neutral-400" @click="router.push('/')">← 返回阅读器</button>
    <h1 class="mt-4 text-xl font-semibold">设置</h1>

    <section class="mt-8">
      <h2 class="text-base font-semibold">AI 服务商</h2>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        用于 AI 摘要 / 翻译。填写任意 OpenAI 兼容接口(预设可改);密钥默认只存本机浏览器,不随订阅数据上云。
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
          <span v-if="p.apiKey" class="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">已存密钥</span>
          <button data-provider-edit class="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800" @click="editing = p">编辑</button>
          <button data-provider-delete class="shrink-0 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800" @click="ai.removeProvider(p.id)">删除</button>
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

      <button data-new-provider class="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white" @click="creating = true">新增服务商</button>

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

    <ProviderEditor v-if="creating" @close="creating = false" @save="onSave" />
    <ProviderEditor v-else-if="editing" :initial="editing" @close="editing = null" @save="onSave" />
  </div>
</template>
