import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { apiFetch } from "./helpers";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
});

describe("categories API", () => {
  it("创建/列出/改名/删除,删除后源回落未分类", async () => {
    const created = await apiFetch("/api/categories", { method: "POST", body: { name: "科技" } });
    expect(created.status).toBe(201);
    const cat = (await created.json()) as { id: number; name: string };
    expect(cat.name).toBe("科技");

    const list = await apiFetch("/api/categories");
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const patched = await apiFetch(`/api/categories/${cat.id}`, { method: "PATCH", body: { name: "科技资讯" } });
    expect(((await patched.json()) as { name: string }).name).toBe("科技资讯");

    await env.DB.prepare("INSERT INTO feeds (url, title, category_id) VALUES (?, ?, ?)").bind("https://feed.example.com/rss", "测试", cat.id).run();
    const del = await apiFetch(`/api/categories/${cat.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const feed = await env.DB.prepare("SELECT category_id FROM feeds LIMIT 1").first<{ category_id: number | null }>();
    expect(feed!.category_id).toBeNull();
  });

  it("名称为空 400", async () => {
    const res = await apiFetch("/api/categories", { method: "POST", body: { name: "  " } });
    expect(res.status).toBe(400);
  });

  it("重排序", async () => {
    const a = (await (await apiFetch("/api/categories", { method: "POST", body: { name: "A" } })).json()) as { id: number };
    const b = (await (await apiFetch("/api/categories", { method: "POST", body: { name: "B" } })).json()) as { id: number };
    await apiFetch("/api/categories/reorder", { method: "POST", body: { ids: [b.id, a.id] } });
    const list = (await (await apiFetch("/api/categories")).json()) as { id: number }[];
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });
});
