// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeArticleHtml } from "@/modules/render";

describe("sanitizeArticleHtml", () => {
  it("移除危险标签与属性", () => {
    const out = sanitizeArticleHtml(`<p onclick="x()">hi</p><script>bad()</script><iframe src="x"></iframe>`);
    expect(out).toContain("<p>hi</p>");
    expect(out).not.toContain("script");
    expect(out).not.toContain("iframe");
    expect(out).not.toContain("onclick");
  });

  it("外链加 rel 与 target,图片加 lazy", () => {
    const out = sanitizeArticleHtml(`<a href="https://ex.com">x</a><img src="https://ex.com/i.png">`);
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('loading="lazy"');
  });
});
