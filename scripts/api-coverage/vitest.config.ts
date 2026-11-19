import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The normal suite, plus the recorder.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    setupFiles: [fileURLToPath(new URL("./record.ts", import.meta.url))],
  },
});
