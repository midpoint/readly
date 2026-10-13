import DOMPurify from "dompurify";

export function sanitizeArticleHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "form", "input", "button", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });
  const doc = new DOMParser().parseFromString(`<div id="root">${clean}</div>`, "text/html");
  const root = doc.getElementById("root");
  if (!root) return clean;
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("target", "_blank");
  }
  for (const img of Array.from(root.querySelectorAll("img"))) {
    img.setAttribute("loading", "lazy");
    if (!img.getAttribute("src") && img.getAttribute("data-src")) {
      img.setAttribute("src", img.getAttribute("data-src")!);
    }
  }
  return root.innerHTML;
}
