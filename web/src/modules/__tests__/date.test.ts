import { describe, expect, it } from "vitest";
import { groupArticlesByDate } from "@/modules/date";

const NOW = new Date("2025-10-13T12:00:00.000Z"); // 周一

function art(iso: string) {
  return { publishedAt: iso };
}

describe("groupArticlesByDate", () => {
  it("按 今天/昨天/本周/本月/更早 分组且空组省略", () => {
    const out = groupArticlesByDate(
      [
        art("2025-10-13T01:00:00.000Z"),
        art("2025-10-12T01:00:00.000Z"),
        art("2025-10-09T01:00:00.000Z"), // 本周(周一为一周起点:10-13 所在周的周一)
        art("2025-10-02T01:00:00.000Z"),
        art("2025-09-20T01:00:00.000Z"),
      ],
      NOW
    );
    expect(out.map((g) => g.label)).toEqual(["今天", "昨天", "本月", "更早"]);
    expect(out[0]!.items).toHaveLength(1);
  });

  it("组内保持传入顺序", () => {
    const a = art("2025-10-13T09:00:00.000Z");
    const b = art("2025-10-13T01:00:00.000Z");
    const out = groupArticlesByDate([a, b], NOW);
    expect(out[0]!.items[0]).toBe(a);
    expect(out[0]!.items[1]).toBe(b);
  });
});
