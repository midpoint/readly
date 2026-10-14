// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMirror, MemoryMirror, MIRROR_LIMIT, syncMirror, type MirrorRow } from "@/modules/idb";

function row(id: number, publishedAt: string): MirrorRow {
  return { id, feedId: 1, feedTitle: "F", title: `t${id}`, url: null, publishedAt, excerpt: null, content: `<p>${id}</p>` };
}

// 每一篇一个不同的时间戳:分钟随 id 递增
function timedRow(id: number, baseUtcMs: number): MirrorRow {
  return row(id, new Date(baseUtcMs + id * 60_000).toISOString());
}

const BASE_2026 = Date.UTC(2026, 0, 1);

beforeEach(async () => {
  // 等 deleteDatabase 完成(旧连接由 onversionchange 自动关闭),保证用例之间数据隔离
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("readly");
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
});

describe("Mirror(idb)", () => {
  it("putMany 计数新增,getAllNewest 按时间倒序", async () => {
    const m = await createMirror();
    const r1 = await m.putMany([row(1, "2026-01-01T00:00:00.000Z"), row(2, "2026-01-02T00:00:00.000Z")]);
    expect(r1).toEqual({ added: 2, total: 2 });
    const r2 = await m.putMany([row(2, "2026-01-02T00:00:00.000Z"), row(3, "2026-01-03T00:00:00.000Z")]);
    expect(r2).toEqual({ added: 1, total: 3 });
    const newest = await m.getAllNewest(2);
    expect(newest.map((x) => x.id)).toEqual([3, 2]);
  });
});

describe("syncMirror", () => {
  it("翻页至到底(0 或 null 均停),两页合计恰好 1000 篇", async () => {
    const m = await createMirror();
    const pages: Record<number, { items: MirrorRow[]; nextCursorId: number | null }> = {
      0: { items: Array.from({ length: 600 }, (_, i) => row(1000 - i, `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`)), nextCursorId: 400 },
      400: { items: Array.from({ length: 400 }, (_, i) => row(400 - i, `2025-12-31T00:00:00.000Z`)), nextCursorId: 0 },
    };
    const fetchPage = vi.fn(async (cursorId: number | null) => pages[cursorId ?? 0]!);
    const r = await syncMirror(m, fetchPage);
    expect(r.exhausted).toBe(true);
    expect(r.synced).toBe(1000);
    expect(r.total).toBe(MIRROR_LIMIT);
    expect(await m.count()).toBe(MIRROR_LIMIT);
    // 两页合计恰好 1000 篇,未触发淘汰;最旧一篇是第二页里 id 最小者(时间全同 → 主键最小)
    const oldest = await m.getAllNewest(MIRROR_LIMIT);
    expect(oldest[0]!.id).toBeGreaterThan(400);
    expect(oldest[oldest.length - 1]!.id).toBe(1);
  });

  it("超过窗口时淘汰 publishedAt 最旧的,保留恰好 1000 篇", async () => {
    const m = await createMirror();
    const items = Array.from({ length: 1200 }, (_, i) => timedRow(1200 - i, BASE_2026));
    const fetchPage = vi.fn(async (_cursorId: number | null) => ({ items, nextCursorId: 0 }));
    const r = await syncMirror(m, fetchPage);
    expect(r.exhausted).toBe(true);
    expect(r.synced).toBe(1200);
    expect(r.total).toBe(MIRROR_LIMIT);
    expect(await m.count()).toBe(MIRROR_LIMIT);
    const all = await m.getAllNewest(MIRROR_LIMIT);
    expect(all[0]!.id).toBe(1200);
    // 淘汰最旧 200 篇(id 1..200),边界为 201
    expect(all[all.length - 1]!.id).toBe(201);
  });

  it("累计达到窗口上限即停止翻页(不再取下一页)", async () => {
    const m = await createMirror();
    const p1 = Array.from({ length: 1000 }, (_, i) => timedRow(2000 - i, Date.UTC(2026, 5, 1)));
    const p2 = Array.from({ length: 300 }, (_, i) => timedRow(500 - i, Date.UTC(2025, 0, 1)));
    const fetchPage = vi.fn(async (cursorId: number | null) =>
      cursorId === null ? { items: p1, nextCursorId: 500 } : { items: p2, nextCursorId: 100 }
    );
    const r = await syncMirror(m, fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(r.exhausted).toBe(false);
    expect(r.total).toBe(MIRROR_LIMIT);
    expect(await m.count()).toBe(MIRROR_LIMIT);
  });

  it("整页重复(added===0)时停止,避免死循环", async () => {
    const m = await createMirror();
    const items = Array.from({ length: 500 }, (_, i) => timedRow(500 - i, Date.UTC(2026, 2, 1)));
    const fetchPage = vi.fn(async () => ({ items, nextCursorId: 400 }));
    const r = await syncMirror(m, fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(r.exhausted).toBe(true);
    expect(r.synced).toBe(500);
    expect(r.total).toBe(500);
  });
});

describe("MemoryMirror 兜底", () => {
  it("indexedDB 不可用时 createMirror 回退内存镜像", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      const m = await createMirror();
      expect(m.kind).toBe("memory");
      const r = await m.putMany([row(1, "2026-01-01T00:00:00.000Z"), row(2, "2026-01-02T00:00:00.000Z")]);
      expect(r).toEqual({ added: 2, total: 2 });
      expect((await m.getAllNewest(1)).map((x) => x.id)).toEqual([2]);
      await m.deleteMany([2]);
      expect(await m.count()).toBe(1);
      await m.clear();
      expect(await m.count()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("内存镜像同样执行滚动窗口淘汰", async () => {
    const m = new MemoryMirror();
    expect(m.kind).toBe("memory");
    const items = Array.from({ length: 1100 }, (_, i) => timedRow(1100 - i, BASE_2026));
    const fetchPage = vi.fn(async (_cursorId: number | null) => ({ items, nextCursorId: 0 }));
    const r = await syncMirror(m, fetchPage);
    expect(r.exhausted).toBe(true);
    expect(r.total).toBe(MIRROR_LIMIT);
    const all = await m.getAllNewest(MIRROR_LIMIT);
    expect(all[0]!.id).toBe(1100);
    expect(all[all.length - 1]!.id).toBe(101);
  });
});
