import { describe, it, expect, afterEach, vi } from 'vitest'
import manifest from '../manifest.json'
import { buildExportableConfig, sanitizeImportedConfig } from '../src/shared/config-transfer'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import { assertSecureEndpoint, escapeAttribute, getOptimalFaviconUrl, isSafeLinkUrl } from '../src/shared/utils'
import type { ExtensionSettings } from '../src/shared/types'

function settingsWithKeys(): ExtensionSettings {
  const s: ExtensionSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  const providers = s.ai.providerSettings as Record<string, { apiKey: string }>
  s.ai.apiKey = 'sk-top-level'
  providers.openai.apiKey = 'sk-openai'
  providers.gemini.apiKey = 'AIza-gemini'
  return s
}

describe('config copy/paste', () => {
  it('copy strips every API key', () => {
    const exported = buildExportableConfig(settingsWithKeys())
    const json = JSON.stringify(exported)
    expect(json).not.toContain('sk-top-level')
    expect(json).not.toContain('sk-openai')
    expect(json).not.toContain('AIza-gemini')
    expect(exported.ai.providerSettings.openai.endpoint).toBe('https://api.openai.com/v1')
  })

  it('pasting a copied config keeps the existing keys', () => {
    const current = settingsWithKeys()
    const exported = buildExportableConfig(current)
    exported.theme = 'dark'
    const { settings, skipped } = sanitizeImportedConfig(exported, current)
    expect(settings.theme).toBe('dark')
    expect(settings.ai.apiKey).toBe('sk-top-level')
    expect((settings.ai.providerSettings as any).openai.apiKey).toBe('sk-openai')
    expect(skipped).toEqual([])
  })

  it('accepts real keys from an older export that still contains them', () => {
    const current = settingsWithKeys()
    const pasted = { ai: { providerSettings: { openai: { apiKey: 'sk-new' } } } }
    const { settings } = sanitizeImportedConfig(pasted, current)
    expect((settings.ai.providerSettings as any).openai.apiKey).toBe('sk-new')
  })

  it('drops wrong-typed fields and non-http endpoints', () => {
    const current = settingsWithKeys()
    const pasted = {
      mcpPort: '8585; rm -rf',
      windowWidth: 500,
      ai: {
        provider: 'evil',
        providerSettings: {
          openai: { endpoint: 'javascript:alert(1)', model: 42 },
          bogus: { endpoint: 'https://x' },
        },
      },
    }
    const { settings, skipped } = sanitizeImportedConfig(pasted, current)
    expect(settings.mcpPort).toBe(8585)
    expect(settings.windowWidth).toBe(500)
    expect(settings.ai.provider).toBe('openai')
    expect((settings.ai.providerSettings as any).openai.endpoint).toBe('https://api.openai.com/v1')
    expect((settings.ai.providerSettings as any).openai.model).toBe('gpt-4o-mini')
    expect(settings.ai.providerSettings).not.toHaveProperty('bogus')
    expect(skipped).toEqual(expect.arrayContaining([
      'mcpPort', 'ai.provider', 'ai.providerSettings.openai.endpoint', 'ai.providerSettings.openai.model', 'ai.providerSettings.bogus',
    ]))
  })

  it('never lets a paste enable MCP script execution', () => {
    const current = settingsWithKeys()
    const { settings, skipped } = sanitizeImportedConfig({ mcpAllowScriptExecution: true }, current)
    expect(settings.mcpAllowScriptExecution).toBe(false)
    expect(skipped).toContain('mcpAllowScriptExecution')
  })

  it('ignores prototype pollution keys', () => {
    const pasted = JSON.parse('{"__proto__": {"polluted": true}, "theme": "light"}')
    const { settings } = sanitizeImportedConfig(pasted, settingsWithKeys())
    expect(({} as any).polluted).toBeUndefined()
    expect(settings.theme).toBe('light')
  })

  it('rejects non-object JSON', () => {
    expect(() => sanitizeImportedConfig([1, 2], settingsWithKeys())).toThrow('Invalid configuration JSON')
    expect(() => sanitizeImportedConfig('x', settingsWithKeys())).toThrow('Invalid configuration JSON')
  })
})

describe('link sanitization helpers', () => {
  it('only allows http(s) links', () => {
    expect(isSafeLinkUrl('https://example.com')).toBe(true)
    expect(isSafeLinkUrl('http://example.com/a?b=1')).toBe(true)
    expect(isSafeLinkUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeLinkUrl('data:text/html,<script>')).toBe(false)
    expect(isSafeLinkUrl('chrome://settings')).toBe(false)
    expect(isSafeLinkUrl('not a url')).toBe(false)
  })

  it('escapes attribute breakouts', () => {
    expect(escapeAttribute('https://x.com/" onmouseover="alert(1)')).toBe('https://x.com/&quot; onmouseover=&quot;alert(1)')
    expect(escapeAttribute("a'b&c")).toBe('a&#39;b&amp;c')
  })
})

describe('AI endpoint transport', () => {
  it('allows https anywhere and http only on local hosts', () => {
    expect(assertSecureEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
    expect(assertSecureEndpoint('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(assertSecureEndpoint('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234')
    expect(assertSecureEndpoint('http://192.168.1.20:8080')).toBe('http://192.168.1.20:8080')
    expect(assertSecureEndpoint('http://[::1]:8080')).toBe('http://[::1]:8080')
  })

  it('blocks http to remote hosts and other protocols', () => {
    expect(() => assertSecureEndpoint('http://api.example.com/v1')).toThrow(/unencrypted/)
    expect(() => assertSecureEndpoint('http://172.32.0.1')).toThrow(/unencrypted/)
    expect(() => assertSecureEndpoint('ftp://example.com')).toThrow(/protocol/)
    expect(() => assertSecureEndpoint('nope')).toThrow(/Invalid/)
  })
})

describe('favicon web-accessible resource', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('manifest uses a dynamic URL for _favicon', () => {
    const entry: any = manifest.web_accessible_resources.find((r: any) => r.resources.includes('_favicon/*'))
    expect(entry.use_dynamic_url).toBe(true)
  })

  it('builds favicon URLs through runtime.getURL', () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'staticid', getURL: (p: string) => `chrome-extension://dynamic-uuid${p}` },
    })
    const url = getOptimalFaviconUrl('https://example.com/page')
    expect(url.startsWith('chrome-extension://dynamic-uuid/_favicon/?pageUrl=')).toBe(true)
    expect(url).not.toContain('staticid')
  })
})
