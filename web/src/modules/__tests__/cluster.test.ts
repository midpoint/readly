import { describe, expect, it } from "vitest";
import { CLUSTER_THRESHOLDS } from "@readly/shared";
import { clusterByTfIdf, ClusterCancelledError, type ClusterInput } from "@/modules/cluster";

function item(id: number, title: string, publishedAt: string): ClusterInput {
  return { id, title, excerpt: null, content: null, publishedAt };
}

// 三组近义新闻 + 两条噪声
// fixture 调整(见 report):标题 2/3 与标题 1 各只差「宣布」/语序,标题 5 改为与标题 4 仅差「搭载/采用」,
// 使 normal(0.58) 档下三组近义标题分别成组、medoid 明确为 id=2
const ITEMS: ClusterInput[] = [
  item(1, "特斯拉上海工厂宣布扩产 产能提升一倍", "2026-01-01T08:00:00.000Z"),
  item(2, "特斯拉上海工厂扩产 产能提升一倍", "2026-01-01T09:00:00.000Z"),
  item(3, "上海特斯拉工厂扩产 产能提升一倍", "2026-01-01T10:00:00.000Z"),
  item(4, "苹果发布新款 MacBook Pro 搭载新芯片", "2026-01-01T08:30:00.000Z"),
  item(5, "苹果发布新款 MacBook Pro 采用新芯片", "2026-01-01T09:30:00.000Z"),
  item(6, "世界杯决赛今晚开战 两队首发公布", "2026-01-01T07:00:00.000Z"),
  item(7, "央行下调存款准备金率 释放流动性", "2026-01-01T06:00:00.000Z"),
  item(8, "某地暴雨导致多条道路积水", "2026-01-01T05:00:00.000Z"),
];

describe("clusterByTfIdf", () => {
  it("适中档把三组近义标题分别归组,噪声不成组", () => {
    const groups = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal);
    expect(groups).toHaveLength(2);
    const sets = groups.map((g) => g.members.map((i) => ITEMS[i]!.id).sort((a, b) => a - b));
    expect(sets).toContainEqual([1, 2, 3]);
    expect(sets).toContainEqual([4, 5]);
  });
  it("组代表是组内最居中的标题(medoid)", () => {
    const groups = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal);
    const g = groups.find((x) => x.members.length === 3)!;
    expect(ITEMS[g.representative]!.id).toBe(2); // 与另外两条重叠词最多
  });
  it("阈值单调:宽松组的数量 ≥ 适中的组数 ≥ 严格的组数", () => {
    const loose = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.loose).length;
    const normal = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal).length;
    const strict = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.strict).length;
    expect(loose).toBeGreaterThanOrEqual(normal);
    expect(normal).toBeGreaterThanOrEqual(strict);
  });
  it("组内按时间升序,组间按组内最新时间降序", () => {
    const groups = clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal);
    const g0 = groups[0]!;
    const times = g0.members.map((i) => ITEMS[i]!.publishedAt);
    expect([...times].sort()).toEqual(times);
    const lastOf = groups.map((g) => Math.max(...g.members.map((i) => Date.parse(ITEMS[i]!.publishedAt))));
    expect([...lastOf].sort((a, b) => b - a)).toEqual(lastOf);
  });
  it("onProgress 回报 0..1 且可取消", () => {
    const seen: number[] = [];
    clusterByTfIdf(ITEMS, CLUSTER_THRESHOLDS.normal, (r) => {
      seen.push(r);
      if (r > 0.5) throw new ClusterCancelledError();
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r >= 0 && r <= 1)).toBe(true);
  });
});
