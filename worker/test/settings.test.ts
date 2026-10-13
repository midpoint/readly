import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSetting, putSetting } from "../src/lib/settings";

describe("settings lib", () => {
  it("缺省返回 fallback", async () => {
    expect(await getSetting(env.DB, "nope", { a: 1 })).toEqual({ a: 1 });
  });
  it("写入后可读回,且可覆盖", async () => {
    await putSetting(env.DB, "k1", [1, 2, 3]);
    expect(await getSetting(env.DB, "k1", [])).toEqual([1, 2, 3]);
    await putSetting(env.DB, "k1", { x: "y" });
    expect(await getSetting(env.DB, "k1", null)).toEqual({ x: "y" });
  });
  it("坏 JSON 返回 fallback", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("bad", "{oops").run();
    expect(await getSetting(env.DB, "bad", "fb")).toBe("fb");
  });
});
