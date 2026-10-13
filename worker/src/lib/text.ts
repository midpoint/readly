export { fnv1a } from "./hash";

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeFeedHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<iframe[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#$2")
    .replace(/(href|src)\s*=\s*javascript:[^\s>]+/gi, "$1=\"#\"");
}

export function detectLang(text: string): "zh" | "en" | null {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return null;
  return cjk >= latin / 2 && cjk > 0 ? "zh" : "en";
}

export function excerptOf(html: string, max = 400): string {
  const text = stripHtml(html);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
