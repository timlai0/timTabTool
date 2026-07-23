import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'path'
import { execSync } from 'child_process'
import manifest from './manifest.json'
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

export default defineConfig({
  plugins: [
    vue(),
    crx({ manifest }),
  ],
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
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        search: resolve(__dirname, 'src/popup/search.html'),
      },
    },
  },
})
