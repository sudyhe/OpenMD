/**
 * 导出 PDF 的编排:取当前文档 → 渲染 → 预处理(mermaid/图片)→ 存盘对话框
 * → 后端 PrintToPdf → 在资源管理器里定位产物。
 *
 * 参考 alanshaw/markdown-pdf 的流水线,但渲染与排版都留在应用内:
 * markdown 管线见 renderer/pipeline.ts,HTML 组装见 renderer/exportHtml.ts,
 * 无头排版见 src-tauri/src/export_pdf.rs。
 */
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import i18n from "i18next";
import { dirnameOf, renderFull } from "../renderer/pipeline";
import { renderMermaidBlocks } from "../renderer/mermaid";
import { buildExportHtml } from "../renderer/exportHtml";
import { exportPdf as invokeExportPdf } from "../tauri/api";
import { useTabs } from "../stores/tabs";
import { useSettings } from "../stores/settings";
import { useExportFlow } from "../stores/exportFlow";

/** 防抖:导出链路(排版 → 存盘 → PrintToPdf)进行中时忽略重复触发。 */
let inFlight = false;

/**
 * mermaid 后处理要求容器挂在文档里(renderMermaidBlocks 会跳过已脱离文档的
 * 节点),用一个移出可视区的临时容器渲染,再取回 HTML。
 */
async function renderMermaidForExport(html: string): Promise<string> {
  if (!html.includes("language-mermaid")) return html;
  const host = document.createElement("div");
  // 固定宽度贴近纸面版心,让 mermaid 的换行/尺寸计算接近导出结果。
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:700px;visibility:hidden";
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    await renderMermaidBlocks(host, false); // 导出用亮色主题
    return host.innerHTML;
  } finally {
    host.remove();
  }
}

/** 把单个 URL 读成 data URI;失败返回 null(调用方保留原 URL)。 */
async function toDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * 本地图片已由渲染管线转成 asset 协议 URL,导出窗口(file://)未必还能取到,
 * 能取到的直接内联成 data URI —— PDF 因此自包含,离开本机也能看。
 * 取不到(网络图等)就保留原样,由导出窗口按普通图片加载。
 */
async function embedLocalImages(html: string): Promise<string> {
  const re = /\bsrc="(asset:[^"]+|https?:\/\/asset\.localhost[^"]+)"/g;
  const urls = new Set<string>();
  for (const m of html.matchAll(re)) urls.add(m[1]);
  if (urls.size === 0) return html;
  const entries = await Promise.all(
    [...urls].map(async (url) => [url, await toDataUri(url)] as const),
  );
  let out = html;
  for (const [url, dataUri] of entries) {
    if (dataUri) out = out.split(`src="${url}"`).join(`src="${dataUri}"`);
  }
  return out;
}

/** 去掉扩展名,作为 PDF 默认文件名。 */
function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/**
 * 导出当前标签页的文档为 PDF。
 *
 * - 无打开的文档 / 文档读取失败 → 抛错(调用方负责提示)
 * - 用户取消存盘对话框 → 静默返回
 * - 成功 → 在资源管理器中定位生成的 PDF
 */
export async function exportActiveTabToPdf(): Promise<void> {
  if (inFlight) return;
  // 先弹「导出选项」(页码/标题范围/frontmatter),确认后才走流水线。
  const proceed = await useExportFlow.getState().requestExport();
  if (!proceed) return;
  inFlight = true;
  try {
    await runExport();
  } finally {
    inFlight = false;
  }
}

async function runExport(): Promise<void> {
  const { tabs, activeId } = useTabs.getState();
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  if (!tab?.path) throw new Error(i18n.t("viewer.export.noDocument"));
  if (tab.error) throw new Error(tab.error);

  const source = tab.draft ?? tab.content;
  const { html, frontmatter } = renderFull(source, dirnameOf(tab.path));
  const body = await embedLocalImages(await renderMermaidForExport(html));
  // 字号跟随设置里的「正文字号」,与预览保持一致。
  const { fontSize, exportOptions } = useSettings.getState();
  const doc = buildExportHtml({ html: body, frontmatter, title: tab.name, fontSize, ...exportOptions });

  const outPath = await save({
    title: i18n.t("viewer.export.saveTitle"),
    defaultPath: `${stripExtension(tab.name)}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!outPath) return;

  await invokeExportPdf(doc, outPath);
  // 导出成功的反馈:直接在资源管理器里选中产物(失败不打扰)。
  void revealItemInDir(outPath).catch(() => {});
}
