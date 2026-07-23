import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { execSync } from 'child_process'
import pkg from './package.json'

import { readFileSync } from 'fs'

let buildNumber = '85'
let commitHash = 'dev'
try {
  const versionFile = readFileSync(resolve(__dirname, 'src/shared/version.ts'), 'utf8')
  const match = versionFile.match(/BUILD_NUMBER\s*=\s*'(\d+)'/)
  if (match && match[1]) {
    buildNumber = match[1]
  }
  const gitCount = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim()
  if (Number(gitCount) > Number(buildNumber)) {
    buildNumber = gitCount
  }
  commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {
  // Fallback if git is unavailable
}
const buildTime = new Date().toISOString()

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
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_NUMBER__: JSON.stringify(buildNumber),
    __BUILD_HASH__: JSON.stringify(commitHash),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    modulePreload: false,
    outDir: 'dist-firefox',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        search: resolve(__dirname, 'src/popup/search.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
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
