import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const must = ["manifest.webmanifest", "sw.js", "pwa-192x192.png", "pwa-512x512.png", "maskable-512x512.png", "apple-touch-icon-180x180.png"];
for (const f of must) {
  await stat(path.join(dist, f)).catch(() => {
    console.error(`MISSING: dist/${f}`);
    process.exit(1);
  });
}
const manifest = JSON.parse(await readFile(path.join(dist, "manifest.webmanifest"), "utf8"));
const checks = [
  [manifest.name === "Readly", "manifest.name"],
  [manifest.lang === "zh-CN", "manifest.lang"],
  [manifest.display === "standalone", "manifest.display"],
  [Array.isArray(manifest.icons) && manifest.icons.length === 3, "manifest.icons 数量"],
  [manifest.icons.some((i) => i.purpose === "maskable"), "maskable 图标"],
];
const failed = checks.filter(([ok]) => !ok).map(([, name]) => name);
if (failed.length) {
  console.error("PWA 校验失败:", failed.join(", "));
  process.exit(1);
}
console.log("PWA 校验通过:manifest 字段与 4 个图标齐全,sw.js 已生成");
