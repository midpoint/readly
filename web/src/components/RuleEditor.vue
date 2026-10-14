<script setup lang="ts">
import { computed, ref } from "vue";
import type { KeywordRule } from "@readly/shared";
import { isRuleValid } from "@/modules/keywords";

const props = defineProps<{ initial?: KeywordRule }>();
const emit = defineEmits<{ close: []; save: [rule: Omit<KeywordRule, "id">] }>();

const RULE_COLORS = ["#3b82f6", "#ef4444", "#f59e0b", "#22c55e", "#14b8a6", "#8b5cf6", "#ec4899", "#64748b"];

const name = ref(props.initial?.name ?? "");
const keyword = ref(props.initial?.keyword ?? "");
const isRegex = ref(props.initial?.isRegex ?? false);
const caseSensitive = ref(props.initial?.caseSensitive ?? false);
const color = ref(props.initial?.color ?? RULE_COLORS[0]!);
const enabled = ref(props.initial?.enabled ?? true);

const draft = computed<KeywordRule>(() => ({
  id: props.initial?.id ?? "draft",
  name: name.value,
  keyword: keyword.value,
  isRegex: isRegex.value,
  caseSensitive: caseSensitive.value,
  color: color.value,
  enabled: enabled.value,
}));

// 空关键词必须挡住:store 的 updateRule(id, { keyword: "" }) 会 sanitize 掉该规则(静默删除)
const canSave = computed(() => keyword.value.trim().length > 0 && isRuleValid(draft.value));
const invalidRegex = computed(() => isRegex.value && keyword.value.trim().length > 0 && !isRuleValid(draft.value));

function save(): void {
  if (!canSave.value) return;
  emit("save", {
    name: name.value.trim() || keyword.value.trim().slice(0, 40),
    keyword: keyword.value.trim(),
    isRegex: isRegex.value,
    caseSensitive: caseSensitive.value,
    color: color.value,
    enabled: enabled.value,
  });
  emit("close");
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="emit('close')">
    <div class="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      <h3 class="text-base font-semibold">{{ initial ? "编辑规则" : "新建规则" }}</h3>
      <label class="mt-4 block text-xs text-neutral-500 dark:text-neutral-400">
        名称(可选)
        <input v-model="name" data-rule-name class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100" placeholder="如:OpenAI 动态" />
      </label>
      <label class="mt-3 block text-xs text-neutral-500 dark:text-neutral-400">
        关键词
        <input v-model="keyword" data-rule-keyword class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100" placeholder="要监控的词或正则表达式" />
      </label>
      <p v-if="invalidRegex" data-rule-error class="mt-1 text-xs text-red-600 dark:text-red-400">正则表达式无效</p>
      <div class="mt-3 flex flex-wrap items-center gap-4 text-xs text-neutral-600 dark:text-neutral-300">
        <label class="flex items-center gap-1.5"><input v-model="isRegex" data-rule-regex type="checkbox" class="accent-[var(--accent)]" />正则表达式</label>
        <label class="flex items-center gap-1.5"><input v-model="caseSensitive" type="checkbox" class="accent-[var(--accent)]" />区分大小写</label>
        <label class="flex items-center gap-1.5"><input v-model="enabled" type="checkbox" class="accent-[var(--accent)]" />启用</label>
      </div>
      <div class="mt-3">
        <p class="text-xs text-neutral-500 dark:text-neutral-400">标记颜色</p>
        <div class="mt-1.5 flex gap-1.5">
          <button
            v-for="c in RULE_COLORS"
            :key="c"
            aria-label="标记颜色"
            class="h-6 w-6 rounded-full border border-black/10"
            :style="{ background: c, boxShadow: color === c ? '0 0 0 2px var(--accent)' : undefined }"
            @click="color = c"
          />
        </div>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800" @click="emit('close')">取消</button>
        <button data-rule-save :disabled="!canSave" class="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm text-white disabled:opacity-50" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>
