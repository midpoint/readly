import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "..", "public");
const svg = await readFile(path.join(publicDir, "logo.svg"));

async function png(size, outfile, { maskable = false } = {}) {
  const inner = Math.round(size * (maskable ? 0.72 : 1));
  const logo = await sharp(svg).resize(inner, inner).png().toBuffer();
  const canvas = sharp({
    create: { width: size, height: size, channels: 4, background: maskable ? "#3b82f6" : "#00000000" },
  }).composite([{ input: logo, gravity: "center" }]);
  await canvas.png().toFile(path.join(publicDir, outfile));
  console.log(`wrote public/${outfile} (${size}px${maskable ? ", maskable" : ""})`);
}

await png(192, "pwa-192x192.png");
await png(512, "pwa-512x512.png");
await png(512, "maskable-512x512.png", { maskable: true });
await png(180, "apple-touch-icon-180x180.png");
