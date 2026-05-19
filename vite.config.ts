import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@design": path.resolve(__dirname, "./src/design"),
    },
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // Split the biggest sub-systems into their own chunks so the
    // initial paint doesn't drag every editor / animation framework
    // into the parser. Each `manualChunks` group becomes its own
    // file the webview can fetch in parallel.
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/commands",
            "@codemirror/language",
            "@codemirror/search",
            "@codemirror/lang-javascript",
            "@codemirror/lang-rust",
            "@codemirror/lang-json",
            "@codemirror/lang-markdown",
            "@codemirror/lang-html",
            "@codemirror/lang-css",
            "@codemirror/lang-python",
            "@codemirror/lang-yaml",
            "@lezer/highlight",
          ],
          // `@tiptap/pm` is a meta-package without a root entry — it
          // only ships sub-paths like `@tiptap/pm/state`. Listing it
          // here would break the build, so we let Vite group those
          // sub-paths automatically into the same chunk.
          tiptap: [
            "@tiptap/react",
            "@tiptap/starter-kit",
            "tiptap-markdown",
          ],
          motion: ["motion"],
          tauri: [
            "@tauri-apps/api",
            "@tauri-apps/plugin-dialog",
            "@tauri-apps/plugin-fs",
            "@tauri-apps/plugin-process",
            "@tauri-apps/plugin-shell",
          ],
        },
      },
    },
    // Bumped from Vite's 500 KiB default — CodeMirror + TipTap make
    // legitimately large chunks that we don't want screaming in CI.
    chunkSizeWarningLimit: 1500,
  },

  envPrefix: ["VITE_", "TAURI_"],
});
