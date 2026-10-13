<script setup lang="ts">
import { computed } from "vue";
import { DEFAULT_READER_PREFS, type ReaderPrefs } from "@readly/shared";
import { ACCENT_PRESETS, FONT_STACKS, READING_THEMES } from "@/modules/theme";
import { useSettingsStore } from "@/stores/settings";

const emit = defineEmits<{ close: [] }>();

const settings = useSettingsStore();
const prefs = computed(() => settings.prefs);

// paper 主题的规格含衬线,主题卡=颜色+字体预设组合;字体族滑块仍可事后覆盖
const THEME_FONTS: Partial<Record<string, ReaderPrefs["fontFamily"]>> = { paper: "serif" };

function pickTheme(id: ReaderPrefs["readingTheme"]): void {
  // 仅带字体预设的主题卡改写字体族;其余主题卡只切配色,不覆盖用户已有的字体选择
  const font = THEME_FONTS[id];
  settings.updatePrefs(font ? { readingTheme: id, fontFamily: font } : { readingTheme: id });
}

function setMode(mode: ReaderPrefs["themeMode"]): void {
  settings.updatePrefs({ themeMode: mode });
}

function setAccent(value: string): void {
  settings.updatePrefs({ accent: value });
}

function setNumber(key: "fontSize" | "lineHeight" | "contentWidth", e: Event): void {
  const value = Number((e.target as HTMLInputElement).value);
  settings.updatePrefs({ [key]: value } as Partial<ReaderPrefs>);
}

function setFont(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  settings.updatePrefs({ fontFamily: v === "serif" ? "serif" : "system" });
}

function onCustomColor(e: Event): void {
  const value = (e.target as HTMLInputElement).value;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) settings.updatePrefs({ accent: value });
}

const section = "mt-4";
const label = "text-xs font-medium text-neutral-500";
const seg = (active: boolean) =>
  `flex-1 rounded-md px-2 py-1 text-xs ${active ? "bg-[var(--accent)] text-white" : "text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"}`;
</script>

<template>
  <aside class="flex h-full w-72 flex-col overflow-y-auto border-l border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
    <div class="flex items-center justify-between">
      <h3 class="font-semibold">阅读设置</h3>
      <button class="rounded-md px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800" @click="emit('close')">
        关闭
      </button>
    </div>

    <div :class="section">
      <p :class="label">外观</p>
      <div class="mt-1.5 flex rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
        <button :class="seg(prefs.themeMode === 'light')" data-mode="light" @click="setMode('light')">亮色</button>
        <button :class="seg(prefs.themeMode === 'dark')" data-mode="dark" @click="setMode('dark')">暗色</button>
        <button :class="seg(prefs.themeMode === 'system')" data-mode="system" @click="setMode('system')">跟随系统</button>
      </div>
    </div>

    <div :class="section">
      <p :class="label">强调色</p>
      <div class="mt-1.5 grid grid-cols-6 gap-1.5">
        <button
          v-for="p in ACCENT_PRESETS"
          :key="p.value"
          :title="p.name"
          :data-accent="p.value"
          class="h-6 w-6 rounded-full border border-black/10 transition-transform hover:scale-110"
          :style="{ background: p.value, boxShadow: prefs.accent === p.value ? '0 0 0 2px var(--accent)' : undefined }"
          @click="setAccent(p.value)"
        />
      </div>
      <label class="mt-2 flex items-center gap-2 text-xs text-neutral-500">
        自定义
        <input type="color" :value="prefs.accent" class="h-6 w-10 cursor-pointer rounded border-0 bg-transparent p-0" @input="onCustomColor" />
      </label>
    </div>

    <div :class="section">
      <p :class="label">阅读主题</p>
      <div class="mt-1.5 grid grid-cols-2 gap-1.5">
        <button
          v-for="t in READING_THEMES"
          :key="t.id"
          :data-theme-card="t.id"
          class="rounded-lg border px-2 py-1.5 text-left text-xs"
          :class="prefs.readingTheme === t.id ? 'border-[var(--accent)] text-neutral-900 dark:text-neutral-100' : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700'"
          @click="pickTheme(t.id)"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <div :class="section">
      <p :class="label">字号 {{ prefs.fontSize }}px</p>
      <input type="range" min="14" max="24" step="1" :value="prefs.fontSize" data-pref="fontSize" class="mt-1 w-full accent-[var(--accent)]" @input="setNumber('fontSize', $event)" />
    </div>

    <div :class="section">
      <p :class="label">行距 {{ prefs.lineHeight.toFixed(1) }}</p>
      <input type="range" min="1.4" max="2.2" step="0.1" :value="prefs.lineHeight" data-pref="lineHeight" class="mt-1 w-full accent-[var(--accent)]" @input="setNumber('lineHeight', $event)" />
    </div>

    <div :class="section">
      <p :class="label">正文宽度 {{ prefs.contentWidth }}px</p>
      <input type="range" min="560" max="900" step="20" :value="prefs.contentWidth" data-pref="contentWidth" class="mt-1 w-full accent-[var(--accent)]" @input="setNumber('contentWidth', $event)" />
    </div>

    <div :class="section">
      <p :class="label">字体</p>
      <select :value="prefs.fontFamily" class="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700" @change="setFont">
        <option value="system">系统无衬线</option>
        <option value="serif">中文衬线</option>
      </select>
      <p class="mt-1 truncate text-[10px] text-neutral-400" :style="{ fontFamily: FONT_STACKS[prefs.fontFamily] }">示例:阅读是随身携带的避难所</p>
    </div>

    <div :class="section">
      <p :class="label">已读策略</p>
      <label class="mt-1.5 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" :checked="prefs.autoMarkReadOnOpen" class="accent-[var(--accent)]" @change="settings.updatePrefs({ autoMarkReadOnOpen: ($event.target as HTMLInputElement).checked })" />
        打开文章即标已读
      </label>
      <label class="mt-1 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" :checked="prefs.autoMarkReadOnScroll" class="accent-[var(--accent)]" @change="settings.updatePrefs({ autoMarkReadOnScroll: ($event.target as HTMLInputElement).checked })" />
        滚动到底自动已读
      </label>
    </div>

    <button data-reset class="mt-5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800" @click="settings.resetPrefs()">
      恢复默认
    </button>
  </aside>
</template>
