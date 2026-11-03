//! 导出 PDF:把前端组装好的自包含 HTML 交给 WebView2 的 PrintToPdf 静默排版。
//!
//! 流水线(参考 alanshaw/markdown-pdf 的「HTML → 无头渲染 → PDF」):
//! 1. 前端把文档渲染成独立 HTML(src/renderer/exportHtml.ts,含 @page 打印样式);
//! 2. 这里开一个隐藏窗口加载它,等页面加载完成;
//! 3. 在 UI 线程上调 WebView2 的 PrintToPdf(A4、2cm 页边距,与 HTML 的 @page 一致);
//! 4. 关窗、清理临时文件,前端在资源管理器里定位产物。
//!
//! 线程模型:命令本身是 async(跑在 Tauri 的异步运行时上),内部用
//! spawn_blocking 执行 —— `with_webview` 会把闭包派发到主事件循环并阻塞等待,
//! 若命令跑在主线程上会直接死锁。完成回调由 WebView2 在 UI 线程触发,经
//! mpsc channel 通知阻塞线程,主线程全程不被占用。
//!
//! Windows 专属:macOS 的 WKWebView(createPDF)与 Linux 的 WebKitGTK
//! (print_to_stream)各有一套 API,后续再补;非 Windows 直接返回错误。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// A4(210×297mm)与 2cm 页边距,单位英寸 —— WebView2 的打印设置用英寸,
/// 必须与导出 HTML 里 `@page { size: A4; margin: 2cm }` 保持一致。
const PAGE_WIDTH_IN: f64 = 8.2677; // 210mm
const PAGE_HEIGHT_IN: f64 = 11.6929; // 297mm
const MARGIN_IN: f64 = 0.7874; // 20mm

/// 导出窗口按 A4@96dpi(794×1123 CSS px)创建:WebView2 的打印布局会参考
/// 视口宽度,窗口尺寸贴近纸面可避免窄视口排版。
const EXPORT_WINDOW_WIDTH: f64 = 794.0;
const EXPORT_WINDOW_HEIGHT: f64 = 1123.0;

const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);
/// 页面 load 事件之后给内联字体/图片解码与布局留的时间。
const LAYOUT_SETTLE: Duration = Duration::from_millis(250);

/// 临时 HTML 文件名的序号(标签与文件名共用,保证并发导出互不干扰)。
static EXPORT_SEQ: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn export_pdf(app: tauri::AppHandle, html: String, out_path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || export_pdf_blocking(app, html, out_path))
            .await
            .map_err(|e| format!("导出任务执行失败: {e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, html, out_path);
        Err("PDF 导出目前仅支持 Windows".to_string())
    }
}

#[cfg(windows)]
fn export_pdf_blocking(app: tauri::AppHandle, html: String, out_path: String) -> Result<(), String> {
    // 1. 落临时 HTML(导出窗口以 file:// 加载)
    let html_path = temp_html_path();
    std::fs::write(&html_path, &html).map_err(|e| format!("写入临时文件失败: {e}"))?;

    let result = run_export(&app, &html_path, &out_path);

    // 2. 清理临时文件(尽力而为:WebView2 可能还握着句柄)
    let _ = std::fs::remove_file(&html_path);
    result
}

#[cfg(windows)]
fn temp_html_path() -> PathBuf {
    let seq = EXPORT_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("openmd-export-{}-{seq}.html", std::process::id()))
}

#[cfg(windows)]
fn run_export(app: &tauri::AppHandle, html_path: &Path, out_path: &str) -> Result<(), String> {
    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let label = format!("pdf-export-{}", EXPORT_SEQ.fetch_add(1, Ordering::Relaxed));
    let url = tauri::Url::from_file_path(html_path)
        .map_err(|_| "临时 HTML 转 URL 失败".to_string())?;

    // 页面加载完成信号必须在 builder 上注册(on_page_load 是 builder 方法)。
    let (load_tx, load_rx) = mpsc::sync_channel::<()>(1);
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .visible(false)
        .focused(false)
        .inner_size(EXPORT_WINDOW_WIDTH, EXPORT_WINDOW_HEIGHT)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = load_tx.try_send(());
            }
        })
        .build()
        .map_err(|e| format!("创建导出窗口失败: {e}"))?;

    // 3. 等页面加载;超时也要把窗口收掉
    if load_rx.recv_timeout(LOAD_TIMEOUT).is_err() {
        let _ = window.destroy();
        return Err("导出页面加载超时".to_string());
    }
    std::thread::sleep(LAYOUT_SETTLE);

    // 4. 发起 PrintToPdf:闭包在 UI 线程执行,同步失败经 channel 报回,
    //    异步完成由 WebView2 回调同一 channel。
    let (done_tx, done_rx) = mpsc::channel::<Result<(), String>>();
    let out_path_owned = out_path.to_string();
    let dispatched = window.with_webview(move |webview| {
        if let Err(msg) = start_print_to_pdf(&webview, &out_path_owned, &done_tx) {
            let _ = done_tx.send(Err(msg));
        }
    });
    if let Err(e) = dispatched {
        let _ = window.destroy();
        return Err(format!("访问导出窗口失败: {e}"));
    }

    let printed = match done_rx.recv_timeout(PRINT_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = window.destroy();
            return Err("生成 PDF 超时".to_string());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = window.destroy();
            return Err("生成 PDF 失败(回调丢失)".to_string());
        }
    };

    // 5. 产物已落盘,收掉隐藏窗口
    let _ = window.destroy();
    printed
}

/// 在 UI 线程上取 WebView2 接口并发起异步 PrintToPdf。
///
/// 成功发起后由 `tx`(clone)在完成回调里报告结果;失败时 `tx` 未被消费,
/// 由调用方发送错误。
#[cfg(windows)]
fn start_print_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    out_path: &str,
    tx: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, ICoreWebView2_7, ICoreWebView2Environment6,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, PCWSTR};

    unsafe {
        let controller = webview.controller();
        let core = controller
            .CoreWebView2()
            .map_err(|e| format!("获取 CoreWebView2 失败: {e}"))?;

        // 打印设置挂在 Environment6 上;纸张/页边距与导出 HTML 的 @page 对齐。
        let core2: ICoreWebView2_2 = core
            .cast()
            .map_err(|e| format!("查询 ICoreWebView2_2 失败: {e}"))?;
        let environment = core2
            .Environment()
            .map_err(|e| format!("获取 WebView2 Environment 失败: {e}"))?;
        let environment6: ICoreWebView2Environment6 = environment
            .cast()
            .map_err(|e| format!("查询 ICoreWebView2Environment6 失败: {e}"))?;
        let settings = environment6
            .CreatePrintSettings()
            .map_err(|e| format!("创建打印设置失败: {e}"))?;
        settings
            .SetPageWidth(PAGE_WIDTH_IN)
            .map_err(|e| format!("设置纸张宽度失败: {e}"))?;
        settings
            .SetPageHeight(PAGE_HEIGHT_IN)
            .map_err(|e| format!("设置纸张高度失败: {e}"))?;
        settings
            .SetMarginTop(MARGIN_IN)
            .map_err(|e| format!("设置上边距失败: {e}"))?;
        settings
            .SetMarginBottom(MARGIN_IN)
            .map_err(|e| format!("设置下边距失败: {e}"))?;
        settings
            .SetMarginLeft(MARGIN_IN)
            .map_err(|e| format!("设置左边距失败: {e}"))?;
        settings
            .SetMarginRight(MARGIN_IN)
            .map_err(|e| format!("设置右边距失败: {e}"))?;

        // PrintToPdf 定义在 ICoreWebView2_7 上。
        let core7: ICoreWebView2_7 = core
            .cast()
            .map_err(|e| format!("查询 ICoreWebView2_7 失败: {e}"))?;

        // 完成回调:WebView2 在 UI 线程上调用,把结果转给阻塞中的命令线程。
        let done_tx = tx.clone();
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |error, success| {
            let outcome = if success {
                Ok(())
            } else {
                Err(match error {
                    Ok(()) => "PrintToPdf 未成功".to_string(),
                    Err(e) => format!("PrintToPdf 失败: {e}"),
                })
            };
            let _ = done_tx.send(outcome);
            Ok(())
        }));

        let wide: Vec<u16> = out_path.encode_utf16().chain(std::iter::once(0)).collect();
        core7
            .PrintToPdf(PCWSTR(wide.as_ptr()), &settings, &handler)
            .map_err(|e| format!("调用 PrintToPdf 失败: {e}"))?;
        Ok(())
    }
}
