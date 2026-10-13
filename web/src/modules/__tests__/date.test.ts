import { describe, expect, it } from "vitest";
import { groupArticlesByDate } from "@/modules/date";

// 本地时间构造,断言在任意时区成立;2025-10-15 是周三,周一为一周起点 → 10-13 落在「本周」
const NOW = new Date(2025, 9, 15, 12, 0, 0);

function art(y: number, m: number, d: number, h = 1) {
  return { publishedAt: new Date(y, m, d, h).toISOString() };
}

describe("groupArticlesByDate", () => {
  it("按 今天/昨天/本周/本月/更早 分组且空组省略", () => {
    const out = groupArticlesByDate(
      [
        art(2025, 9, 15),
        art(2025, 9, 14),
        art(2025, 9, 13),
        art(2025, 9, 2),
        art(2025, 8, 20),
      ],
      NOW
    );
    expect(out.map((g) => g.label)).toEqual(["今天", "昨天", "本周", "本月", "更早"]);
    expect(out[0]!.items).toHaveLength(1);
  });

  it("组内保持传入顺序", () => {
    const a = art(2025, 9, 15, 9);
    const b = art(2025, 9, 15, 1);
    const out = groupArticlesByDate([a, b], NOW);
    expect(out[0]!.items[0]).toBe(a);
    expect(out[0]!.items[1]).toBe(b);
  });
});
