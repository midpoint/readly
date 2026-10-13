<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ComponentPublicInstance } from "vue";
import { useRouter } from "vue-router";
import type { Feed } from "@readly/shared";
import { useArticlesStore } from "@/stores/articles";
import { useFeedsStore } from "@/stores/feeds";

const feedsStore = useFeedsStore();
const articles = useArticlesStore();
const router = useRouter();

const stats = computed(() => feedsStore.stats);

function select(view: "all" | "unread" | "starred" | "later", feedId: number | null = null, categoryId: number | null = null) {
  const query: Record<string, string> = {};
  if (view !== "all") query.view = view;
  if (feedId !== null) query.feed = String(feedId);
  if (categoryId !== null) query.category = String(categoryId);
  void router.replace({ path: "/", query });
  void articles.setFilter(view, feedId, categoryId);
}

function feedsOf(categoryId: number | null) {
  return feedsStore.feeds.filter((f) => (categoryId === null ? f.categoryId === null : f.categoryId === categoryId));
}

const navItem = "flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-sm text-left hover:bg-neutral-200/60 dark:hover:bg-neutral-800";
const menuItem = "block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800";

// —— 刷新订阅 ——
type RefreshStatus = "idle" | "busy" | "done" | "error";
const refreshStatus = ref<RefreshStatus>("idle");
let refreshTimer: number | undefined;

const refreshLabel = computed(() => {
  switch (refreshStatus.value) {
    case "busy":
      return "刷新中…";
    case "done":
      return "已刷新";
    case "error":
      return "刷新失败";
    default:
      return "刷新订阅";
  }
});

async function refreshFeeds(): Promise<void> {
  if (refreshStatus.value === "busy") return;
  refreshStatus.value = "busy";
  try {
    await feedsStore.refreshAll();
    await feedsStore.load();
    await articles.load(true);
    refreshStatus.value = "done";
  } catch {
    refreshStatus.value = "error";
  }
  // 短暂展示结果后还原(重复触发时重置计时)
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshStatus.value = "idle";
    refreshTimer = undefined;
  }, 2000);
}

// —— 源项管理菜单 ——
const menuFeedId = ref<number | null>(null);
const menuMode = ref<"root" | "move">("root");
const renamingId = ref<number | null>(null);
const renameTitle = ref("");

function closeMenu(): void {
  menuFeedId.value = null;
  menuMode.value = "root";
  renamingId.value = null;
}

function toggleMenu(feedId: number): void {
  if (menuFeedId.value === feedId) {
    closeMenu();
    return;
  }
  menuFeedId.value = feedId;
  menuMode.value = "root";
  renamingId.value = null;
}

function onDocumentClick(): void {
  if (menuFeedId.value !== null) closeMenu();
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && menuFeedId.value !== null) closeMenu();
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
});

onUnmounted(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onDocumentKeydown);
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
});

function startRename(feed: Feed): void {
  menuMode.value = "root";
  renameTitle.value = feed.title;
  renamingId.value = feed.id;
}

function cancelRename(): void {
  renamingId.value = null;
}

// 稳定函数 ref:只在输入框挂载时聚焦,避免每次渲染重复 select
function focusRename(el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLInputElement) {
    el.focus();
    el.select();
  }
}

async function submitRename(feed: Feed): Promise<void> {
  if (renamingId.value !== feed.id) return; // Enter 后失焦会再次触发,去重
  const title = renameTitle.value.trim();
  closeMenu();
  if (!title || title === feed.title) return;
  try {
    await feedsStore.renameFeed(feed.id, title);
  } catch {
    // 失败静默:load() 回滚为服务端真实标题
  }
}

async function moveTo(feed: Feed, categoryId: number | null): Promise<void> {
  closeMenu();
  try {
    await feedsStore.moveFeed(feed.id, categoryId);
  } catch {
    // 失败静默,源保持原位
  }
}

async function confirmDelete(feed: Feed): Promise<void> {
  closeMenu();
  if (!window.confirm(`删除订阅「${feed.title}」及其全部文章?`)) return;
  try {
    await feedsStore.removeFeed(feed.id);
  } catch {
    // 失败静默
  }
}
</script>

<template>
  <aside class="flex h-full w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
    <div class="flex items-center justify-between px-4 py-3">
      <h1 class="text-base font-semibold">Readly</h1>
      <button class="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white" @click="router.push('/add')">
        添加订阅
      </button>
    </div>
    <nav class="space-y-0.5 px-2">
      <button :class="navItem" @click="select('all')">
        <span>全部文章</span>
      </button>
      <button :class="navItem" @click="select('unread')">
        <span>未读</span>
        <span v-if="stats?.unreadTotal" class="text-xs text-neutral-500">{{ stats.unreadTotal }}</span>
      </button>
      <button :class="navItem" @click="select('starred')">
        <span>收藏</span>
        <span v-if="stats?.starredTotal" class="text-xs text-neutral-500">{{ stats.starredTotal }}</span>
      </button>
      <button :class="navItem" @click="select('later')">
        <span>稍后读</span>
        <span v-if="stats?.laterTotal" class="text-xs text-neutral-500">{{ stats.laterTotal }}</span>
      </button>
    </nav>
    <div class="mt-4 flex-1 overflow-y-auto px-2 pb-4">
      <template v-for="cat in feedsStore.categories" :key="cat.id">
        <button :class="[navItem, 'mt-2 font-medium text-neutral-500']" @click="select('all', null, cat.id)">
          <span class="truncate">{{ cat.name }}</span>
          <span v-if="stats?.perCategory[cat.id]" class="text-xs">{{ stats.perCategory[cat.id] }}</span>
        </button>
        <div v-for="feed in feedsOf(cat.id)" :key="feed.id" class="group relative flex items-center">
          <input
            v-if="renamingId === feed.id"
            :ref="focusRename"
            v-model="renameTitle"
            class="mx-1 w-full min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-[var(--accent)] dark:border-neutral-700 dark:bg-neutral-900"
            @click.stop
            @keydown.enter.prevent="submitRename(feed)"
            @keydown.esc.stop="cancelRename"
            @blur="submitRename(feed)"
          />
          <template v-else>
            <button :class="[navItem, 'min-w-0 flex-1 pl-6']" @click="select('all', feed.id, null)">
              <span class="truncate">{{ feed.title }}</span>
              <span v-if="feed.unreadCount" class="text-xs text-neutral-500">{{ feed.unreadCount }}</span>
            </button>
            <button
              class="mr-1 shrink-0 rounded-md px-1.5 py-1 text-xs text-neutral-400 opacity-100 hover:bg-neutral-200/60 hover:text-neutral-600 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 dark:hover:bg-neutral-800"
              aria-label="源管理菜单"
              @click.stop="toggleMenu(feed.id)"
            >
              ⋯
            </button>
          </template>
          <div
            v-if="menuFeedId === feed.id && renamingId !== feed.id"
            class="absolute right-1 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            @click.stop
          >
            <template v-if="menuMode === 'root'">
              <button :class="menuItem" @click="startRename(feed)">重命名</button>
              <button :class="menuItem" @click="menuMode = 'move'">移动到</button>
              <button :class="[menuItem, 'text-red-600 dark:text-red-400']" @click="confirmDelete(feed)">删除</button>
            </template>
            <template v-else>
              <button :class="menuItem" @click="moveTo(feed, null)">未分类</button>
              <button v-for="c in feedsStore.categories" :key="c.id" :class="menuItem" @click="moveTo(feed, c.id)">
                {{ c.name }}
              </button>
            </template>
          </div>
        </div>
      </template>
      <button :class="[navItem, 'mt-2 font-medium text-neutral-500']" @click="select('all')">
        <span>未分类</span>
      </button>
      <div v-for="feed in feedsOf(null)" :key="feed.id" class="group relative flex items-center">
        <input
          v-if="renamingId === feed.id"
          :ref="focusRename"
          v-model="renameTitle"
          class="mx-1 w-full min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-[var(--accent)] dark:border-neutral-700 dark:bg-neutral-900"
          @click.stop
          @keydown.enter.prevent="submitRename(feed)"
          @keydown.esc.stop="cancelRename"
          @blur="submitRename(feed)"
        />
        <template v-else>
          <button :class="[navItem, 'min-w-0 flex-1 pl-6']" @click="select('all', feed.id, null)">
            <span class="truncate">{{ feed.title }}</span>
            <span v-if="feed.unreadCount" class="text-xs text-neutral-500">{{ feed.unreadCount }}</span>
          </button>
          <button
            class="mr-1 shrink-0 rounded-md px-1.5 py-1 text-xs text-neutral-400 opacity-100 hover:bg-neutral-200/60 hover:text-neutral-600 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 dark:hover:bg-neutral-800"
            aria-label="源管理菜单"
            @click.stop="toggleMenu(feed.id)"
          >
            ⋯
          </button>
        </template>
        <div
          v-if="menuFeedId === feed.id && renamingId !== feed.id"
          class="absolute right-1 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          @click.stop
        >
          <template v-if="menuMode === 'root'">
            <button :class="menuItem" @click="startRename(feed)">重命名</button>
            <button :class="menuItem" @click="menuMode = 'move'">移动到</button>
            <button :class="[menuItem, 'text-red-600 dark:text-red-400']" @click="confirmDelete(feed)">删除</button>
          </template>
          <template v-else>
            <button :class="menuItem" @click="moveTo(feed, null)">未分类</button>
            <button v-for="c in feedsStore.categories" :key="c.id" :class="menuItem" @click="moveTo(feed, c.id)">
              {{ c.name }}
            </button>
          </template>
        </div>
      </div>
    </div>
    <div class="border-t border-neutral-200 p-3 dark:border-neutral-800">
      <button class="w-full rounded-lg px-3 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800" @click="router.push('/add')">
        导入 / 导出 OPML
      </button>
      <button
        class="w-full rounded-lg px-3 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-200/60 disabled:opacity-60 dark:hover:bg-neutral-800"
        :disabled="refreshStatus === 'busy'"
        @click="refreshFeeds"
      >
        {{ refreshLabel }}
      </button>
    </div>
  </aside>
</template>
