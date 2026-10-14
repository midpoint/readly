// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractFromHtml, plainTextLength } from "@/modules/extract";

const PAGE = `<!doctype html><html><head><title>页面标题</title></head><body>
<nav>导航导航导航</nav>
<article>
  <h1>真正的文章标题</h1>
  <p>第一段内容,这里是一段足够长的正文文本,用于通过 Readability 的阈值判断。需要重复足够多的字符才能稳定提取,所以这句话再写一遍。</p>
  <p>第二段内容,继续提供足量的正文文本以保证提取器认为这是文章主体而不是导航或页脚。再多写一些字凑长度,凑到几百个字符以上。</p>
  <p>第三段内容,同样需要足够的文本量,继续补充文字以达到阈值要求,让提取结果稳定可靠不随字数波动。</p>
  <p>第四段内容,收尾段落,依旧保持一定的文本长度,确保整体正文字数远超最小阈值,使测试不受实现细节影响。</p>
  <img src="/img/photo.png" alt="图">
  <a href="/relative/link">站内链接</a>
</article>
<footer>页脚页脚</footer>
</body></html>`;

describe("extractFromHtml", () => {
  it("提取正文并绝对化相对 URL,经 sanitizeArticleHtml 清洗", () => {
    const r = extractFromHtml(PAGE, "https://news.example.com/post/1");
    expect(r.html).toContain("第一段内容");
    expect(r.html).not.toContain("<nav>");
    expect(r.textLength).toBeGreaterThan(150);
    expect(r.title).toContain("标题");
    expect(r.html).toContain('src="https://news.example.com/img/photo.png"');
    expect(r.html).toContain('href="https://news.example.com/relative/link"');
  });

  it("无正文时抛「无法提取正文」", () => {
    // Readability 0.6 在「最佳尝试正文长度为 0」时才返回 null(有任意文本都会回落到 body),
    // 故无正文 fixture 取真实的无文本页面:JS 渲染壳(空容器 + 脚本)。
    const NO_CONTENT = `<!doctype html><html><head><title>App</title></head><body><div id="app"></div><script>window.__DATA__=1;</script></body></html>`;
    expect(() => extractFromHtml(NO_CONTENT, "https://x.example.com/")).toThrow(/无法提取正文/);
  });

  it("恶意载荷被清洗:输出不含 onerror / javascript:", () => {
    const EVIL = `<!doctype html><html><head><title>恶意页</title></head><body><article>
      <h1>恶意载荷</h1>
      <p>正文段落,提供足量文本让提取器认定这段是文章主体而不是导航或边栏,继续补充文字凑长度以保证提取稳定。</p>
      <img src="/img/a.png" onerror="alert(1)" alt="坏图">
      <a href="javascript:alert(document.cookie)">点我</a>
    </article></body></html>`;
    const r = extractFromHtml(EVIL, "https://news.example.com/post/3");
    expect(r.html).not.toContain("onerror");
    expect(r.html.toLowerCase()).not.toContain("javascript:");
    // 正常内容仍保留(清洗不是「清空」)
    expect(r.html).toContain("恶意载荷");
  });

  it("顺序不可反:清洗提升 data-src→src 之后再绝对化", () => {
    const LAZY = `<!doctype html><html><body><article>
      <h1>惰性加载图</h1>
      <p>正文段落,提供足量文本让提取器认定这段是文章主体而不是其它边栏内容,继续补充文字以凑够长度。</p>
      <img data-src="/img/photo?id=1" alt="查询串">
      <img data-src="/img/lazy.png" alt="扩展名">
    </article></body></html>`;
    const r = extractFromHtml(LAZY, "https://news.example.com/post/2");
    // Readability 的 _fixLazyImages 只对「像图片扩展名」的 data-src 复制 src,且复制的是原样相对值
    // (它在 _fixRelativeUris 之后运行),所以 /img/photo?id=1 这条只能由 sanitizeArticleHtml 提升,
    // 若把绝对化提到清洗之前,该 img 就只剩相对路径 —— 顺序被本断言钉死。
    expect(r.html).toContain('src="https://news.example.com/img/photo?id=1"');
    expect(r.html).toContain('src="https://news.example.com/img/lazy.png"');
  });
});

describe("plainTextLength", () => {
  it("去标签与空白后计长;空值 0", () => {
    expect(plainTextLength("<p>你好 世界</p>")).toBe(4);
    expect(plainTextLength(null)).toBe(0);
    expect(plainTextLength("  ")).toBe(0);
  });
});
