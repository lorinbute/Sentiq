// Sentiq.iOS TD-V4-S2 §2: the iOS app's chart engine (src/ios-core), one classic script for JavaScriptCore (no page, no
// DOM, no modules). The app's script `scripts/build-core.sh` builds it into a temporary folder (never the repo's dist/)
// and copies it into the app's resources as ChartCore.js.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist/ios-core', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('./src/ios-core/core.ts', import.meta.url)),
      formats: ['iife'],
      name: 'SentiqCoreBundle',
      fileName: () => 'ChartCore.js',
    },
  },
});
