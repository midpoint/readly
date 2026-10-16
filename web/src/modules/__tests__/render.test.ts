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

  it("剥除 javascript:/data: 协议,data-src 提升不引入危险 src", () => {
    expect(sanitizeArticleHtml(`<a href="javascript:alert(1)">x</a>`)).not.toContain("javascript:");
    expect(sanitizeArticleHtml(`<img data-src="javascript:alert(1)">`)).not.toContain('src="javascript:');
    expect(sanitizeArticleHtml(`<img data-src="data:text/html;base64,PHNjcmlwdD4=">`)).not.toMatch(/src="data:/);
    expect(sanitizeArticleHtml(`<img data-src="https://ex.com/i.png">`)).toContain('src="https://ex.com/i.png"');
  });

  it("纯图片段打标:唯一元素子节点为 img 且无文本才标记 data-img-only", () => {
    expect(sanitizeArticleHtml('<p><img src="https://a.example.com/x.png"></p>')).toContain('data-img-only="1"');
    expect(sanitizeArticleHtml('<p>文字 <img src="https://a.example.com/x.png"></p>')).not.toContain("data-img-only");
    expect(sanitizeArticleHtml('<p><img src="https://a.example.com/x.png"> 文字</p>')).not.toContain("data-img-only");
    expect(sanitizeArticleHtml('<p><img src="https://a.example.com/x.png"><br></p>')).not.toContain("data-img-only");
  });
});
