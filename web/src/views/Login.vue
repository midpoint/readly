<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const token = ref("");
const error = ref("");
const loading = ref(false);
const auth = useAuthStore();
const router = useRouter();

async function submit() {
  if (!token.value.trim()) return;
  loading.value = true;
  error.value = "";
  try {
    const okRes = await auth.login(token.value.trim());
    if (okRes) await router.push("/");
    else error.value = "令牌无效,请检查后重试";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-full items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
    <form class="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900" @submit.prevent="submit">
      <h1 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">Readly</h1>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">输入访问令牌以进入你的阅读器</p>
      <input
        v-model="token"
        type="password"
        placeholder="访问令牌"
        autocomplete="current-password"
        class="mt-6 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-[var(--accent)] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
      />
      <p v-if="error" class="mt-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      <button
        type="submit"
        :disabled="loading"
        class="mt-4 w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {{ loading ? "验证中…" : "进入" }}
      </button>
    </form>
  </div>
</template>
