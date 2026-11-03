import { create } from "zustand";

interface ExportFlowState {
  open: boolean;
  /** 当前挂起的 Promise 回调;由 <ExportOptionsDialog/> 回填。 */
  resolve: ((proceed: boolean) => void) | null;
  /** 弹出「导出选项」对话框;返回是否继续导出(取消/Esc = false)。 */
  requestExport: () => Promise<boolean>;
  /** 由对话框调用:回填结果并关闭。 */
  settleExport: (proceed: boolean) => void;
}

/**
 * 导出 PDF 的选项确认桥接层(与 stores/confirm.ts 同一模式):
 * 入口(按钮 / Ctrl+P)只负责发起,选项 UI 由 <ExportOptionsDialog/> 渲染,
 * 用户点「导出…」后才继续走 存盘对话框 → PrintToPdf 的流水线。
 */
export const useExportFlow = create<ExportFlowState>((set, get) => ({
  open: false,
  resolve: null,
  requestExport: () =>
    new Promise<boolean>((resolve) => {
      // 上一个请求若还挂着,先按「取消」收尾,避免 Promise 永久悬空。
      get().resolve?.(false);
      set({ open: true, resolve });
    }),
  settleExport: (proceed) => {
    const { resolve } = get();
    set({ open: false, resolve: null });
    resolve?.(proceed);
  },
}));
