import { describe, expect, it } from "vitest";
import { PRINT_CSS, buildExportHtml } from "./exportHtml";

describe("buildExportHtml", () => {
  it("包成自包含文档并内嵌打印样式", () => {
    const out = buildExportHtml({ html: "<p>hi</p>", frontmatter: null, title: "a.md" });
    expect(out).toContain("<!doctype html>");
    expect(out).toContain("<title>a.md</title>");
    expect(out).toContain('<article class="md-body"><p>hi</p></article>');
    expect(out).toContain("size: A4");
    expect(out).toContain("margin: 2cm");
    // 导出窗口只排版不执行脚本
    expect(out).not.toContain("<script");
  });

  it("转义标题与 frontmatter 值,防 YAML 注入 HTML", () => {
    const out = buildExportHtml({
      html: "<p>x</p>",
      frontmatter: { title: "<img src=x onerror=1>", tags: ["a", "<b>"] },
      title: "a</title><script>alert(1)</script>",
    });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;img src=x onerror=1&gt;");
    expect(out).toContain("a, &lt;b&gt;");
    expect(out).toContain('class="md-frontmatter"');
  });

  it("frontmatter 最多展示 8 个字段(与预览一致)", () => {
    const fm: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) fm[`k${i}`] = `v${i}`;
    const out = buildExportHtml({ html: "", frontmatter: fm, title: "t" });
    expect(out).toContain("k7");
    expect(out).not.toContain("k8");
  });

  it("空 frontmatter 不输出头部", () => {
    const out = buildExportHtml({ html: "<p>x</p>", frontmatter: {}, title: "t" });
    expect(out).not.toContain('<div class="md-frontmatter">');
  });
  it("带上设置里的正文字号", () => {
    const out = buildExportHtml({ html: "<p>x</p>", frontmatter: null, title: "t", fontSize: 22 });
    expect(out).toContain('style="--md-font-size:22px"');
    // 未指定时走 md.css 的 17px 兜底,不注入变量
    const fallback = buildExportHtml({ html: "<p>x</p>", frontmatter: null, title: "t" });
    expect(fallback).not.toContain("--md-font-size");
  });

});

describe("PRINT_CSS", () => {
  it("覆盖预览里会裁内容的滚动与块级表格", () => {
    expect(PRINT_CSS).toContain("display: table !important");
    expect(PRINT_CSS).toContain("overflow: visible !important;");
    expect(PRINT_CSS).toContain("white-space: pre-wrap !important;");
  });

  it("声明分页规则", () => {
    expect(PRINT_CSS).toContain("break-inside: avoid");
    expect(PRINT_CSS).toContain("page-break-after: avoid");
    // 正文铺满版心,由页边距控制栏宽
    expect(PRINT_CSS).toContain("padding: 0 !important");
  });
});

describe("导出选项", () => {
  const html = "<h1>T1</h1><h2>T2</h2><h3>T3</h3><p>body</p>";

  it("按层级剔除标题", () => {
    const noH1 = buildExportHtml({ html, frontmatter: null, title: "t", headingLevel: "no-h1" });
    expect(noH1).not.toContain("<h1>");
    expect(noH1).toContain("<h2>T2</h2>");
    expect(noH1).toContain("<h3>T3</h3>");

    const noH12 = buildExportHtml({ html, frontmatter: null, title: "t", headingLevel: "no-h1-h2" });
    expect(noH12).not.toContain("<h1>");
    expect(noH12).not.toContain("<h2>");
    expect(noH12).toContain("<h3>T3</h3>");
    expect(noH12).toContain("<p>body</p>");

    const all = buildExportHtml({ html, frontmatter: null, title: "t", headingLevel: "all" });
    expect(all).toContain("<h1>T1</h1>");
  });

  it("可不输出 frontmatter 元数据头", () => {
    const on = buildExportHtml({ html: "<p>x</p>", frontmatter: { a: "1" }, title: "t" });
    expect(on).toContain('<div class="md-frontmatter">');
    const off = buildExportHtml({
      html: "<p>x</p>",
      frontmatter: { a: "1" },
      title: "t",
      includeFrontmatter: false,
    });
    expect(off).not.toContain('<div class="md-frontmatter">');
  });

  it("页码开关控制 @page 页边距盒(x/y)", () => {
    const on = buildExportHtml({ html: "<p>x</p>", frontmatter: null, title: "t" });
    expect(on).toContain('content: counter(page) "/" counter(pages)');
    const off = buildExportHtml({ html: "<p>x</p>", frontmatter: null, title: "t", pageNumbers: false });
    expect(off).not.toContain("counter(pages)");
  });
});
