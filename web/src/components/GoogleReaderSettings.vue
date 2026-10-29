<script setup lang="ts">
import { onMounted, ref } from "vue";
import { GREADER_USERNAME, SETTING_KEYS, type GReaderAuth } from "@readly/shared";
import { api } from "@/api/client";

const auth = ref<GReaderAuth | null>(null);
const busy = ref(false);
const message = ref("");
const server = location.origin;

function sanitize(raw: unknown): GReaderAuth | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { username?: unknown; password?: unknown };
  if (typeof value.username !== "string" || !value.username) return null;
  if (typeof value.password !== "string" || !value.password) return null;
  return { username: value.username, password: value.password };
}

async function load(): Promise<void> {
  try {
    const all = await api<Record<string, unknown>>("/api/settings");
    auth.value = sanitize(all[SETTING_KEYS.greaderAuth]);
  } catch {
    message.value = "Google Reader 设置加载失败";
  }
}

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function save(next: GReaderAuth | null): Promise<boolean> {
  busy.value = true;
  message.value = "";
  try {
    await api("/api/settings", { method: "PUT", body: { kv: { [SETTING_KEYS.greaderAuth]: next } } });
    auth.value = next;
    return true;
  } catch {
    message.value = "保存失败,请重试";
    return false;
  } finally {
    busy.value = false;
  }
}

async function enable(): Promise<void> {
  if (await save({ username: GREADER_USERNAME, password: generatePassword() })) {
    message.value = "已启用,请在客户端填入下方信息";
  }
}

async function reset(): Promise<void> {
  if (!window.confirm("重置后旧密码立即失效,需在客户端重新登录。继续?")) return;
  if (await save({ username: GREADER_USERNAME, password: generatePassword() })) {
    message.value = "已重置,请在客户端更新密码";
  }
}

async function disable(): Promise<void> {
  if (!window.confirm("停用后所有 Google Reader 客户端将无法同步。继续?")) return;
  if (await save(null)) message.value = "已停用";
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.value = "已复制";
  } catch {
    message.value = "复制失败,请手动选择文本";
  }
}

onMounted(load);
</script>

<template>
  <section class="mt-8">
    <h2 class="text-base font-semibold">第三方客户端(Google Reader API)</h2>
    <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
      兼容 Reeder、FeedMe、NewsFlash 等支持 Google Reader API 的客户端。启用后生成独立密码,可随时重置或停用;已读与收藏双向同步。
    </p>

    <div v-if="!auth" class="mt-4">
      <button
        data-greader-enable
        :disabled="busy"
        class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        @click="enable"
      >
        启用 Google Reader API
      </button>
    </div>

    <div v-else class="mt-4 space-y-3 rounded-xl border border-neutral-200 px-4 py-4 dark:border-neutral-800">
      <div class="flex items-center gap-2 text-sm">
        <span class="w-20 shrink-0 text-neutral-500 dark:text-neutral-400">服务器</span>
        <code data-greader-endpoint class="min-w-0 flex-1 truncate">{{ server }}</code>
        <button
          data-greader-copy-endpoint
          class="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="copy(server)"
        >
          复制
        </button>
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="w-20 shrink-0 text-neutral-500 dark:text-neutral-400">邮箱</span>
        <code data-greader-username class="min-w-0 flex-1 truncate">{{ auth.username }}</code>
        <button
          data-greader-copy-username
          class="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="copy(auth.username)"
        >
          复制
        </button>
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span class="w-20 shrink-0 text-neutral-500 dark:text-neutral-400">密码</span>
        <code data-greader-password class="min-w-0 flex-1 break-all">{{ auth.password }}</code>
        <button
          data-greader-copy-password
          class="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="copy(auth.password)"
        >
          复制
        </button>
      </div>
      <div class="flex flex-wrap gap-2 pt-1">
        <button
          data-greader-reset
          :disabled="busy"
          class="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          @click="reset"
        >
          重置密码
        </button>
        <button
          data-greader-disable
          :disabled="busy"
          class="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-red-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-neutral-800"
          @click="disable"
        >
          停用
        </button>
      </div>
      <p class="text-xs text-neutral-500 dark:text-neutral-400">
        客户端中选择「Google Reader」账户类型。分类会作为 label 显示;不支持在客户端内添加/删除订阅,仅 JSON;新文章由 Readly 后台定时刷新。
      </p>
    </div>

    <p v-if="message" data-greader-message class="mt-3 text-sm text-neutral-600 dark:text-neutral-300">{{ message }}</p>
  </section>
</template>
