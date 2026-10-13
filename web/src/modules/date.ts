export function groupArticlesByDate<T extends { publishedAt: string }>(
  items: T[],
  now: Date = new Date()
): { label: string; items: T[] }[] {
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = dayStart(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekStart = new Date(today);
  const dow = (today.getDay() + 6) % 7; // 周一为一周起点
  weekStart.setDate(today.getDate() - dow);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const groups: { label: string; items: T[] }[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "本周", items: [] },
    { label: "本月", items: [] },
    { label: "更早", items: [] },
  ];

  for (const item of items) {
    const d = new Date(item.publishedAt);
    const day = dayStart(Number.isNaN(d.getTime()) ? now : d);
    if (day >= today) groups[0]!.items.push(item);
    else if (day >= yesterday) groups[1]!.items.push(item);
    else if (day >= weekStart) groups[2]!.items.push(item);
    else if (day >= monthStart) groups[3]!.items.push(item);
    else groups[4]!.items.push(item);
  }

  return groups.filter((g) => g.items.length > 0);
}
