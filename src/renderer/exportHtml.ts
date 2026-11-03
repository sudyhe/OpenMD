/**
 * 导出 PDF 用的独立 HTML 组装。
 *
 * 思路参考 alanshaw/markdown-pdf:渲染好的正文 + 专用打印样式打包成一份
 * 自包含 HTML,交给无头 WebView2 的 PrintToPdf 排版输出(见
 * src-tauri/src/export_pdf.rs)。导出窗口是 file:// 页面,不加载应用的样式表,
 * 因此这里把 md.css / KaTeX / alerts 全部 `?inline` 内联进来。
 *
 * 注意:KaTeX 字体由 vite.config.ts 的 inlineKatexFonts 插件转成 data URI;
 * MiSans(20MB)不内联,导出环境没有该字体时回退到系统字体栈。
 */
import mdCss from "../theme/md.css?inline";
import katexCss from "katex/dist/katex.min.css?inline";
import alertsBaseCss from "markdown-it-github-alerts/styles/github-base.css?inline";
import alertsDarkCss from "markdown-it-github-alerts/styles/github-colors-dark-class.css?inline";
import type { ExportHeadingLevel } from "../stores/settings";

/**
 * 打印版式。A4 / 2cm 页边距与 Rust 侧 PrintToPdf 的纸张设置保持一致 ——
 * 两处都写死同一组值,避免 CSS 与打印设置互相覆盖导致版心漂移。
 *
 * 预览为屏幕阅读优化的横向滚动、裁切、栏宽限制,在纸上都会丢内容,
 * 这里逐条关闭。
 */
export const PRINT_CSS = `
@page {
  size: A4;
  margin: 2cm;
}
html,
body {
  margin: 0;
  padding: 0;
  background: #fff;
}
/* 预览靠左右内边距收窄阅读栏,纸上交给页边距:正文铺满版心。 */
article.md-body {
  max-width: none !important;
  margin: 0 !important;
  padding: 0 !important;
}
.md-frontmatter {
  max-width: none;
  margin: 0;
  padding: 0 0 10px;
}
/* 标题不落在页尾、块不跨页撕裂。 */
h1,
h2,
h3,
h4,
h5,
h6 {
  break-after: avoid;
  page-break-after: avoid;
  break-inside: avoid;
  page-break-inside: avoid;
}
pre,
blockquote,
table,
figure,
img,
svg,
.md-mermaid,
ul,
ol {
  break-inside: avoid;
  page-break-inside: avoid;
}
/* 预览为横向滚动开的 overflow / nowrap 在纸上会裁掉内容。 */
pre,
table {
  overflow: visible !important;
}
pre code {
  white-space: pre-wrap !important;
}
/* md.css 给 table 挂了 display:block + overflow-x:auto(屏幕横向滚动),
   打印时必须回到表格布局,否则整表被压成一行。 */
table {
  display: table !important;
}
img,
video {
  max-width: 100% !important;
  height: auto !important;
}
`;

/**
 * 每页右下角页码 x/y。Chromium 131+ 起打印引擎原生支持 @page 页边距盒与
 * page/pages 计数器(WebView2 = Chrome 156),页码由打印引擎直接绘制,
 * 不需要后期往 PDF 里盖章。padding-right 把文字从纸边推回正文右缘
 * (页边距盒的右缘就是纸边)。
 */
const PAGE_NUMBER_CSS = `
@page {
  @bottom-right {
    content: counter(page) "/" counter(pages);
    font-family: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
    font-size: 9pt;
    color: #666666;
    vertical-align: middle;
    padding-right: 2cm;
  }
}
`;

export interface ExportHtmlInput {
  /** renderFull 的产物(已 sanitize、本地图片已解析成 asset URL)。 */
  html: string;
  frontmatter: Record<string, unknown> | null;
  /** 文档名,用于 <title>。 */
  title: string;
  /**
   * 当前设置的正文字号(px,13–28),与预览的 `--md-font-size` 一致 ——
   * md.css 的 `.md-body { font-size: var(--md-font-size, 17px) }` 会吃这个值。
   * 缺省不注入,走 md.css 的 17px 兜底。
   */
  fontSize?: number;
  /** 每页右下角页码 x/y(打印引擎 @page 页边距盒),默认开。 */
  pageNumbers?: boolean;
  /** 标题输出范围;默认全部输出。 */
  headingLevel?: ExportHeadingLevel;
  /** 是否输出 frontmatter 元数据头;默认输出。 */
  includeFrontmatter?: boolean;
}

/** 转义 HTML 文本节点/属性值:frontmatter 来自任意 YAML,必须转义。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 复刻预览里的 frontmatter 头部(与 MarkdownView 一致:最多 8 个字段)。 */
function buildFrontmatterBlock(frontmatter: Record<string, unknown> | null): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return "";
  const fields = Object.entries(frontmatter)
    .slice(0, 8)
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      return (
        `<span class="md-frontmatter-field">` +
        `<span class="md-frontmatter-key">${escapeHtml(key)}</span>` +
        `<span class="md-frontmatter-value">${escapeHtml(text)}</span>` +
        `</span>`
      );
    })
    .join("");
  return `<div class="md-frontmatter">${fields}</div>`;
}

/**
 * 按层级剔除标题:在已 sanitize 的 HTML 上用 DOM 操作(不用正则,避免误伤)。
 * `no-h1` 去掉一级标题;`no-h1-h2` 连二级一起去掉。
 */
function stripHeadings(html: string, level: ExportHeadingLevel): string {
  if (level === "all") return html;
  const tags = level === "no-h1" ? ["h1"] : ["h1", "h2"];
  const host = document.createElement("div");
  host.innerHTML = html;
  for (const tag of tags) {
    for (const el of Array.from(host.querySelectorAll(tag))) el.remove();
  }
  return host.innerHTML;
}

/** 组装一份自包含的导出 HTML(无脚本,纯排版)。 */
export function buildExportHtml({
  html,
  frontmatter,
  title,
  fontSize,
  pageNumbers = true,
  headingLevel = "all",
  includeFrontmatter = true,
}: ExportHtmlInput): string {
  // 与预览一致:正文字号写成 CSS 变量注入,md.css 的 .md-body 会消费它。
  const sizeAttr = fontSize ? ` style="--md-font-size:${Math.round(fontSize)}px"` : "";
  const body = stripHeadings(html, headingLevel);
  const fmBlock = includeFrontmatter ? buildFrontmatterBlock(frontmatter) : "";
  const pageNumberCss = pageNumbers ? PAGE_NUMBER_CSS : "";
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}${pageNumberCss}</style>
<style>${mdCss}</style>
<style>${katexCss}</style>
<style>${alertsBaseCss}</style>
<style>${alertsDarkCss}</style>
</head>
<body>
${fmBlock}
<article class="md-body"${sizeAttr}>${body}</article>
</body>
</html>`;
}
