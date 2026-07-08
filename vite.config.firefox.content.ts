import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    modulePreload: false,
    outDir: 'dist-firefox',
    emptyOutDir: false, // Logik: Nicht leeren, da der Hintergrund-Build das Verzeichnis erstellt hat / Programming logic: Do not empty since the background build created it
    rollupOptions: {
      input: resolve(__dirname, 'src/content/search-overlay.ts'),
      output: {
        entryFileNames: 'content.js',
        format: 'iife',
      },
    },
  },
})
