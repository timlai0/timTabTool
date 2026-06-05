import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { execSync } from 'child_process'

// Programming logic: A simple plugin to run the Firefox manifest transform script after bundling
const firefoxManifestPlugin = () => ({
  name: 'firefox-manifest-plugin',
  closeBundle() {
    try {
      console.log('🤖 Running build-firefox.js script...')
      execSync('node scripts/build-firefox.js', { stdio: 'inherit' })
    } catch (err) {
      console.error('❌ Failed to run build-firefox.js:', err)
    }
  }
})

export default defineConfig({
  plugins: [vue(), firefoxManifestPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist-firefox',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/search-overlay.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background' || chunkInfo.name === 'content') {
            return '[name].js'
          }
          return 'assets/[name]-[hash].js'
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
})
