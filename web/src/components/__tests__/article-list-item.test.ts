// @vitest-environment jsdom
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import type { ArticleListItem as ArticleItem } from "@readly/shared";
import ArticleListItem from "@/components/ArticleListItem.vue";
import { useAnalysisStore } from "@/stores/analysis";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: vi.fn() };
});

// 有图、有摘要,且未读 + 收藏 + 稍后 + 命中色点俱全:标记等价逐项可断言
const ITEM: ArticleItem = {
  id: 7,
  feedId: 3,
  feedTitle: "示例源",
  feedIconUrl: null,
  title: "待读文章",
  url: null,
  author: null,
  publishedAt: "2025-10-13T08:00:00.000Z",
  excerpt: "这是摘要内容",
  imageUrl: "https://img.example.com/cover.jpg",
  isRead: false,
  isStarred: true,
  isLater: true,
  hasFullText: false,
};

let app: App | null = null;
let host: HTMLElement | null = null;

function cleanup(): void {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
}

// 单一 pinia:测试侧取的 store 与组件侧同库(每用例独立)
function makePinia(): Pinia {
  const pinia = createPinia();
  setActivePinia(pinia);
  return pinia;
}

// 注入命中色点(r1,红):规则与命中直接落 store,hitsFor 即可读到
function seedAnalysis(): void {
  const analysis = useAnalysisStore();
  analysis.rules = [{ id: "r1", name: "规则一", keyword: "关键词", isRegex: false, caseSensitive: false, color: "#ef4444", enabled: true }];
  analysis.hits = { 7: [{ ruleId: "r1", count: 2 }] };
}

async function mountItem(pinia: Pinia): Promise<{ root: HTMLElement; selects: number[] }> {
  cleanup();
  const selects: number[] = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp({
    render: () => h(ArticleListItem, { item: ITEM, active: false, onSelect: (id: number) => selects.push(id) }),
  });
  app.use(pinia);
  app.mount(host);
  await nextTick();
  const root = host.querySelector<HTMLElement>("[data-article-row]");
  if (!root) throw new Error("缺少 [data-article-row] 根节点");
  return { root, selects };
}

function hasUnreadDot(root: HTMLElement): boolean {
  return [...root.querySelectorAll("span")].some(
    (s) => String(s.className).includes("bg-[var(--accent)]") && String(s.className).includes("rounded-full")
  );
}

function hitDots(root: HTMLElement): Element[] {
  return [...root.querySelectorAll("[data-hit-dot]")];
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe("ArticleListItem 双布局", () => {
  it("默认卡片布局:data-layout=card,含缩略图与摘要行,标记齐全", async () => {
    const pinia = makePinia();
    seedAnalysis();
    const { root } = await mountItem(pinia);

    expect(root.tagName).toBe("BUTTON");
    expect(root.getAttribute("data-layout")).toBe("card");
    // 卡片专属:缩略图 + 摘要行
    const img = root.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(ITEM.imageUrl);
    const excerpt = root.querySelector("p");
    expect(excerpt).not.toBeNull();
    expect(excerpt!.textContent).toContain("这是摘要内容");
    // 标题两行截断
    const title = root.querySelector("h3");
    expect(title!.classList.contains("line-clamp-2")).toBe(true);
    // 卡片间距
    expect(root.classList.contains("py-3")).toBe(true);
    // 标记等价:未读点 / ★ / 🕘 / 命中色点
    expect(hasUnreadDot(root)).toBe(true);
    expect(root.textContent).toContain("★");
    expect(root.textContent).toContain("🕘");
    expect(hitDots(root)).toHaveLength(1);
    expect(hitDots(root)[0]!.getAttribute("data-rule-id")).toBe("r1");
  });

  it("列表布局:data-layout=list,无缩略图无摘要,标题单行,标记仍齐全", async () => {
    const pinia = makePinia();
    seedAnalysis();
    const settings = useSettingsStore();
    settings.updatePrefs({ articleLayout: "list" });
    expect(settings.prefs.articleLayout).toBe("list");
    const { root } = await mountItem(pinia);

    expect(root.getAttribute("data-layout")).toBe("list");
    // 紧凑视图:无缩略图、无摘要行
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("p")).toBeNull();
    expect(root.textContent).not.toContain("这是摘要内容");
    // 标题单行截断
    const title = root.querySelector("h3");
    expect(title!.classList.contains("line-clamp-1")).toBe(true);
    expect(title!.classList.contains("line-clamp-2")).toBe(false);
    // 紧凑间距
    expect(root.classList.contains("py-1.5")).toBe(true);
    expect(root.classList.contains("py-3")).toBe(false);
    // 标记等价:未读点 / ★ / 🕘 / 命中色点仍存在
    expect(hasUnreadDot(root)).toBe(true);
    expect(root.textContent).toContain("★");
    expect(root.textContent).toContain("🕘");
    expect(hitDots(root)).toHaveLength(1);
    expect(hitDots(root)[0]!.getAttribute("data-rule-id")).toBe("r1");
    // 精简:不再渲染源名与时间(只显示标题+状态标记)
    expect(root.textContent).not.toContain("示例源");
    expect(root.textContent).not.toMatch(/刚刚|分钟前|小时前|天前|\d{4}\/\d{1,2}\/\d{1,2}/);
    expect(root.textContent).toContain("待读文章");
  });

  it("两种布局下点击均 emit select", async () => {
    const pinia = makePinia();
    seedAnalysis();
    const card = await mountItem(pinia);
    card.root.click();
    await nextTick();
    expect(card.selects).toEqual([7]);

    const settings = useSettingsStore();
    settings.updatePrefs({ articleLayout: "list" });
    const list = await mountItem(pinia);
    expect(list.root.getAttribute("data-layout")).toBe("list");
    list.root.click();
    await nextTick();
    expect(list.selects).toEqual([7]);
  });

  it("列表布局:命中超过 3 条时渲染 3 个色点 + 「+n」", async () => {
    const pinia = makePinia();
    const analysis = useAnalysisStore();
    const rule = (id: string, color: string) => ({ id, name: id, keyword: "k", isRegex: false, caseSensitive: false, color, enabled: true });
    analysis.rules = [rule("r1", "#ef4444"), rule("r2", "#22c55e"), rule("r3", "#f59e0b"), rule("r4", "#8b5cf6")];
    analysis.hits = { 7: [{ ruleId: "r1", count: 1 }, { ruleId: "r2", count: 1 }, { ruleId: "r3", count: 1 }, { ruleId: "r4", count: 1 }] };
    useSettingsStore().updatePrefs({ articleLayout: "list" });
    const { root } = await mountItem(pinia);

    expect(hitDots(root)).toHaveLength(3);
    expect(root.textContent).toContain("+1");
  });
});
