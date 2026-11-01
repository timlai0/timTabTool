import { describe, it, expect } from 'vitest'
import manifest from '../manifest.json'
import pkg from '../package.json'
import enMessages from '../public/_locales/en/messages.json'
import zhMessages from '../public/_locales/zh_CN/messages.json'
import privacyPolicyRaw from '../docs/PRIVACY_POLICY.md?raw'
import storeListingRaw from '../docs/STORE_LISTING.md?raw'
import buildFirefoxRaw from '../scripts/build-firefox.js?raw'
import icon16 from '../public/icons/icon-16.png?inline'
import icon32 from '../public/icons/icon-32.png?inline'
import icon48 from '../public/icons/icon-48.png?inline'
import icon128 from '../public/icons/icon-128.png?inline'

const privacyPolicy = privacyPolicyRaw.replace(/\r\n/g, '\n')
const storeListing = storeListingRaw.replace(/\r\n/g, '\n')
const buildFirefoxScript = buildFirefoxRaw.replace(/\r\n/g, '\n')
const icons: Record<string, string> = {
  'icons/icon-16.png': icon16,
  'icons/icon-32.png': icon32,
  'icons/icon-48.png': icon48,
  'icons/icon-128.png': icon128,
}

function pngSize(dataUrl: string): { width: number; height: number } {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), c => c.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  // PNG signature, then the IHDR chunk holds width/height as big-endian uint32
  expect(String.fromCharCode(...bytes.subarray(1, 4))).toBe('PNG')
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

describe('Chrome Web Store readiness: manifest', () => {
  it('is Manifest V3 with a store-valid version that matches package.json', () => {
    expect(manifest.manifest_version).toBe(3)
    const parts = manifest.version.split('.')
    expect(parts.length).toBeLessThanOrEqual(4)
    for (const part of parts) {
      expect(part).toMatch(/^(0|[1-9]\d*)$/)
      expect(Number(part)).toBeLessThanOrEqual(65535)
    }
    expect(manifest.version).toBe(pkg.version)
  })

  it('has localized name and description within store limits', () => {
    const messages = [enMessages, zhMessages] as Record<string, { message: string }>[]
    expect(manifest.default_locale).toBe('en')

    // every locale defines the same keys
    expect(Object.keys(zhMessages).sort()).toEqual(Object.keys(enMessages).sort())

    // every __MSG_x__ reference in the manifest resolves
    const refs = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(m => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const m of messages) for (const ref of refs) expect(m[ref]?.message, ref).toBeTruthy()

    for (const m of messages) {
      expect(m.extName.message.length).toBeLessThanOrEqual(75)
      expect(m.extDescription.message.length).toBeLessThanOrEqual(132)
    }
  })

  it('ships icons at the declared sizes', () => {
    const declared = { ...manifest.icons, ...manifest.action.default_icon } as Record<string, string>
    expect(Object.keys(manifest.icons)).toContain('128')
    for (const [size, file] of Object.entries(declared)) {
      expect(icons[file], file).toBeTruthy()
      const { width, height } = pngSize(icons[file])
      expect({ file, width, height }).toEqual({ file, width: Number(size), height: Number(size) })
    }
  })

  it('does not weaken the extension-page CSP', () => {
    expect(JSON.stringify(manifest)).not.toMatch(/unsafe-eval|unsafe-inline/)
    expect(manifest).not.toHaveProperty('externally_connectable')
  })

  it('requests no unused or unexpected permissions', () => {
    // Anything added here must also get a privacy-policy row and a store justification (tests below).
    expect([...manifest.permissions].sort()).toEqual(
      ['clipboardRead', 'contextMenus', 'favicon', 'scripting', 'storage', 'tabGroups', 'tabs'],
    )
    expect(manifest.host_permissions).toEqual(['<all_urls>'])
  })
})

describe('Mozilla Add-ons (Firefox AMO) readiness: manifest transform', () => {
  it('configures Firefox MV3 manifest with Gecko ID, strict_min_version, and data_collection_permissions', () => {
    expect(buildFirefoxScript).toContain("id: 'timtabtool@timlai.de'")
    expect(buildFirefoxScript).toContain("strict_min_version: '142.0'")
    expect(buildFirefoxScript).toContain("required: ['none']")
    expect(buildFirefoxScript).toContain('delete manifest.minimum_chrome_version')
    expect(buildFirefoxScript).toContain("p !== 'favicon'")
    expect(buildFirefoxScript).toContain("manifest.permissions.push('menus')")
  })
})

describe('Store readiness: documentation', () => {
  it('documents every permission in the privacy policy and the store justifications', () => {
    for (const permission of manifest.permissions) {
      expect(privacyPolicy, `privacy policy: ${permission}`).toContain(`\`${permission}\``)
      expect(storeListing, `store listing: ${permission}`).toContain(`\`${permission}\``)
    }
    expect(privacyPolicy).toContain('<all_urls>')
    expect(storeListing).toContain('<all_urls>')
  })

  it('does not list permissions the extension no longer (or never) requests', () => {
    const table = privacyPolicy.slice(privacyPolicy.indexOf('## Permissions'), privacyPolicy.indexOf('## Third-party'))
    const listed = [...table.matchAll(/^\| `(\w+)`/gm)].map(m => m[1])
    expect(listed.length).toBeGreaterThan(0)
    for (const permission of listed) expect(manifest.permissions, permission).toContain(permission)
  })

  it('keeps the listing summary within the 132-character limit', () => {
    const summary = storeListing.match(/### Summary \(132 chars max\)\n(.+)\n/)?.[1]
    expect(summary).toBeTruthy()
    expect(summary!.length).toBeLessThanOrEqual(132)
  })

  it('states the AI data flow, local storage, and Firefox AMO reviewer build instructions', () => {
    expect(privacyPolicy).toMatch(/Last Updated:\*\* \d{4}-\d{2}-\d{2}/)
    expect(privacyPolicy).toContain('chrome.storage.local')
    expect(privacyPolicy).toMatch(/AI provider/i)
    expect(privacyPolicy).toMatch(/Window Chat/)
    expect(storeListing).toContain('Mozilla Add-ons (Firefox AMO) submission checklist')
    expect(storeListing).toContain('npm run build:firefox')
  })
})
