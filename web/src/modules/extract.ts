import { Readability } from "@mozilla/readability";
import { sanitizeArticleHtml } from "./render";

export interface ExtractResult {
  title: string | null;
  html: string;
  textLength: number;
}

function absoluteize(html: string, base: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root");
  if (!root) return html;
  const fix = (el: Element, attr: string): void => {
    const v = el.getAttribute(attr);
    if (!v) return;
    try {
      el.setAttribute(attr, new URL(v, base).toString());
    } catch {
      // 保留原值
    }
  };
  for (const a of Array.from(root.querySelectorAll("a[href]"))) fix(a, "href");
  for (const img of Array.from(root.querySelectorAll("img[src]"))) fix(img, "src");
  return root.innerHTML;
}

export function extractFromHtml(pageHtml: string, pageUrl: string): ExtractResult {
  const doc = new DOMParser().parseFromString(pageHtml, "text/html");
  if (!doc.querySelector("base")) {
    const base = doc.createElement("base");
    base.setAttribute("href", pageUrl);
    doc.head.prepend(base);
  }
  const parsed = new Readability(doc).parse();
  if (!parsed || !parsed.content) throw new Error("无法提取正文");
  // 先过唯一渲染清洗点,再做 URL 绝对化(清洗含 data-src→src 提升,顺序不可反)
  const clean = absoluteize(sanitizeArticleHtml(parsed.content), pageUrl);
  // 清洗后为空(内容全为被禁标签等):与解析失败同一条错误文案,不渲染空正文
  if (!clean.trim()) throw new Error("无法提取正文");
  const text = (parsed.textContent ?? "").replace(/\s+/g, " ").trim();
  return { title: parsed.title ?? null, html: clean, textLength: text.length };
}

export function plainTextLength(html: string | null | undefined): number {
  if (!html) return 0;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, "").length;
}
