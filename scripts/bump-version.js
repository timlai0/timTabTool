import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const packageJsonPath = path.join(rootDir, 'package.json')
const manifestJsonPath = path.join(rootDir, 'manifest.json')
const versionTsPath = path.join(rootDir, 'src', 'shared', 'version.ts')

// 1. Read package.json
const pkgRaw = fs.readFileSync(packageJsonPath, 'utf-8')
const pkg = JSON.parse(pkgRaw)

// Extract current base version and build number
let [major, minor, patch, buildStr] = pkg.version.split('.')
let build = buildStr ? parseInt(buildStr, 10) : 104
build++ // auto-increase

const newVersion = `${major}.${minor}.${patch}.${build}`

// Update package.json
pkg.version = newVersion
fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')

// 2. Read and update manifest.json
const manifestRaw = fs.readFileSync(manifestJsonPath, 'utf-8')
const manifest = JSON.parse(manifestRaw)
manifest.version = newVersion
fs.writeFileSync(manifestJsonPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')

// 3. Read and update version.ts
let versionTs = fs.readFileSync(versionTsPath, 'utf-8')
versionTs = versionTs.replace(/export const APP_VERSION = '.*'/, `export const APP_VERSION = '${major}.${minor}.${patch}'`)
versionTs = versionTs.replace(/export const BUILD_NUMBER = '.*'/, `export const BUILD_NUMBER = '${build}'`)
fs.writeFileSync(versionTsPath, versionTs, 'utf-8')

console.log(`\n[timTabTool] Bumped version to ${newVersion} (Build ${build})\n`)
