<script setup lang="ts">
import { computed, ref } from "vue";
import type { AiProvider } from "@readly/shared";
import { normalizeBaseUrl, PROVIDER_PRESETS } from "@/modules/ai";

const props = defineProps<{ initial?: AiProvider }>();
const emit = defineEmits<{ close: []; save: [provider: Omit<AiProvider, "id">] }>();

const name = ref(props.initial?.name ?? "");
const baseUrl = ref(props.initial?.baseUrl ?? "");
const model = ref(props.initial?.model ?? "");
const apiKey = ref(props.initial?.apiKey ?? "");
const useProxy = ref(props.initial?.useProxy ?? false);

const baseUrlOk = computed(() => /^https?:\/\//.test(baseUrl.value.trim()));
const modelOk = computed(() => model.value.trim().length > 0);
const canSave = computed(() => baseUrlOk.value && modelOk.value);
// 空 baseUrl 不报错(尚未填写);填了非法值才提示
const baseUrlError = computed(() => baseUrl.value.trim().length > 0 && !baseUrlOk.value);

function onPresetChange(e: Event): void {
  const preset = PROVIDER_PRESETS.find((p) => p.name === (e.target as HTMLSelectElement).value);
  if (!preset) return;
  name.value = preset.name;
  baseUrl.value = preset.baseUrl;
  model.value = preset.model;
}

function save(): void {
  if (!canSave.value) return;
  emit("save", {
    name: name.value.trim() || model.value.trim().slice(0, 60),
    baseUrl: normalizeBaseUrl(baseUrl.value),
    model: model.value.trim(),
    // 置空 apiKey 即清除密钥(sanitize 丢弃空串;新建时无密钥则不落字段)
    apiKey: apiKey.value.trim(),
    useProxy: useProxy.value,
  });
  emit("close");
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="emit('close')">
    <div class="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      <h3 class="text-base font-semibold">{{ initial ? "编辑服务商" : "新建服务商" }}</h3>
      <label class="mt-4 block text-xs text-neutral-500 dark:text-neutral-400">
        预设
        <select data-provider-preset class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100" @change="onPresetChange">
          <option value="">自定义 / 手动填写</option>
          <option v-for="p in PROVIDER_PRESETS" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
      </label>
      <label class="mt-3 block text-xs text-neutral-500 dark:text-neutral-400">
        名称(可选)
        <input v-model="name" data-provider-name class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100" placeholder="如:DeepSeek 备用" />
      </label>
      <label class="mt-3 block text-xs text-neutral-500 dark:text-neutral-400">
        baseUrl
        <input v-model="baseUrl" data-provider-baseurl class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100" placeholder="https://api.example.com/v1" />
      </label>
      <p v-if="baseUrlError" data-provider-error class="mt-1 text-xs text-red-600 dark:text-red-400">baseUrl 需为 http(s) 地址</p>
      <label class="mt-3 block text-xs text-neutral-500 dark:text-neutral-400">
        模型
        <input v-model="model" data-provider-model class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100" placeholder="如:deepseek-chat" />
      </label>
      <label class="mt-3 block text-xs text-neutral-500 dark:text-neutral-400">
        API 密钥(默认只存本机)
        <input
          v-model="apiKey"
          data-provider-key
          type="password"
          autocomplete="off"
          class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
          placeholder="sk-…"
        />
      </label>
      <label class="mt-3 flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
        <input v-model="useProxy" data-provider-proxy type="checkbox" class="accent-[var(--accent)]" />
        经 Worker 代理转发(供应商禁止浏览器直连时启用)
      </label>
      <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">代理模式不允许访问内网地址。</p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800" @click="emit('close')">取消</button>
        <button data-provider-save :disabled="!canSave" class="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm text-white disabled:opacity-50" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>
