 import { defineConfig, type Plugin } from "vite";
 import react from "@vitejs/plugin-react";
 import fs from "node:fs";
 import path from "node:path";
 // @ts-expect-error type error without @types/node package
 import process from "node:process";
 const host = process.env.TAURI_DEV_HOST;
 
 /**
  * katex.min.css 里的字体是相对路径(fonts/*.woff2),而导出 PDF 的独立 HTML
  * 是 file:// 页面、没有 node_modules 可解析 —— 这里把 woff2 直接内联成
  * data URI。只留 woff2(导出目标是 WebView2/Chromium,够用且省 2/3 体积),
  * woff/ttf 回退一并删掉,避免残留相对 URL 在导出窗口里 404。
  */
 function inlineKatexFonts(): Plugin {
   return {
     name: "openmd-inline-katex-fonts",
     enforce: "pre",
     transform(code, id) {
       const cleanId = id.replace(/\\/g, "/");
       if (!cleanId.includes("katex/dist/katex.min.css")) return null;
       const dir = path.dirname(cleanId.split("?")[0]);
       const inlined = code.replace(
         /url\(fonts\/([\w.-]+)\.woff2\)/g,
         (match, name: string) => {
           try {
             const buf = fs.readFileSync(path.join(dir, "fonts", `${name}.woff2`));
             return `url(data:font/woff2;base64,${buf.toString("base64")})`;
           } catch {
             return match;
           }
         },
       );
       const stripped = inlined
         .replace(/,\s*url\(fonts\/[\w.-]+\.woff\)\s*format\("woff"\)/g, "")
         .replace(/,\s*url\(fonts\/[\w.-]+\.ttf\)\s*format\("truetype"\)/g, "");
       return { code: stripped, map: null };
     },
   };
 }
 
 // https://vite.dev/config/
 export default defineConfig(() => ({
   plugins: [react(), inlineKatexFonts()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
