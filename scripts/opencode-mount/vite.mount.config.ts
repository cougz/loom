import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

// Library build config for the mountable OpenCode app bundle.
//
// Injected into the OpenCode clone alongside mount.tsx by
// scripts/build-opencode-ui. `base: "/opencode-ui/"` rewrites every
// asset URL the bundle references (chunks, fonts, CSS) so they resolve
// under the /opencode-ui/ prefix when served as static Worker assets —
// no HTML rewriting required.
//
// Build with: bunx vite build --config vite.mount.config.ts

export default defineConfig({
  base: "/opencode-ui/",
  plugins: [
    {
      name: "opencode-mount:config",
      config() {
        return {
          resolve: {
            alias: {
              "@": fileURLToPath(new URL("./src", import.meta.url)),
            },
          },
          worker: {
            format: "es",
          },
        };
      },
    },
    {
      // OpenCode ships .woff2 fonts imported from source. Emit them as
      // rollup file refs so Vite hashes them and rewrites import.meta URLs.
      name: "emit-font-assets",
      enforce: "pre",
      load(id) {
        if (!id.endsWith(".woff2")) return null;
        const ref = this.emitFile({
          type: "asset",
          name: basename(id),
          source: readFileSync(id),
        });
        return `export default import.meta.ROLLUP_FILE_URL_${ref}`;
      },
    },
    tailwindcss(),
    solidPlugin(),
  ],
  build: {
    target: "esnext",
    outDir: "dist-mount",
    lib: {
      entry: fileURLToPath(new URL("./src/mount.tsx", import.meta.url)),
      formats: ["es"],
      fileName: "opencode-mount",
    },
    // A single CSS file is simpler for the embed.html <link> to reference
    // than code-split style shards.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames(info) {
          if (info.names?.some((n) => n.endsWith(".css"))) return "[name][extname]";
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});
