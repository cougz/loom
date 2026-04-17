import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  plugins:
    mode === "test"
      ? []
      : [
          tsconfigPaths(),
          cloudflare({
            configPath: "./wrangler.jsonc",
          }),
        ],
  build: {
    // Output to dist/client for TanStack Start
    outDir: "dist/client",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "node",
  },
}));
