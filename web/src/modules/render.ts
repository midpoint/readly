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
    const dataSrc = img.getAttribute("data-src");
    if (dataSrc === null) continue;
    // data-src 绕过 DOMPurify 的 URI 校验(ALLOW_DATA_ATTR 在 URI 正则前短路),
    // 因此必须按 src 的同一套策略复验后才可提升;data: 在 img 上被 DOMPurify 放行
    // (ADD_DATA_URI_TAGS),此处按需求额外排除。
    const promotable =
      DOMPurify.isValidAttribute("img", "src", dataSrc) &&
      !/^\s*data:/i.test(dataSrc.replace(/[\t\n\r]/g, ""));
    if (!promotable) {
      img.removeAttribute("data-src");
    } else if (!img.getAttribute("src")) {
      img.setAttribute("src", dataSrc);
    }
  }
  // 「纯图片段」精确打标:唯一元素子节点为 img 且无文本。CSS :only-child 不数文本节点,
  // 会把「文字+单图」误判为纯图片段;此处按 textContent 精确判定。
  for (const p of Array.from(root.querySelectorAll("p"))) {
    if (p.children.length === 1 && p.children[0]!.tagName === "IMG" && p.textContent?.trim() === "") {
      p.setAttribute("data-img-only", "1");
    }
  }
  return root.innerHTML;
}
