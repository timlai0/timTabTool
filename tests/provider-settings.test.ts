import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_ENDPOINTS, DEFAULT_MODELS } from '../src/shared/constants'
import type { ExtensionSettings, AIProvider } from '../src/shared/types'

describe('Per-Provider Settings Memory & Synchronization', () => {
  function createTestSettings(): ExtensionSettings {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  }

  function syncActiveToProviderSettings(settings: ExtensionSettings, provider: AIProvider): void {
    if (!settings.ai.providerSettings) {
      settings.ai.providerSettings = {}
    }
    settings.ai.providerSettings[provider] = {
      apiKey: settings.ai.apiKey,
      endpoint: settings.ai.endpoint,
      model: settings.ai.model,
      batchSize: settings.ai.batchSize,
      maxTokens: settings.ai.maxTokens,
      onlyFreeModels: provider === 'openrouter' ? !!settings.ai.openRouterOnlyFree : undefined,
      reasoningEffort: settings.ai.reasoningEffort,
    }
  }

  function loadProviderSettings(settings: ExtensionSettings, newProvider: AIProvider, oldProvider?: AIProvider): void {
    if (!settings.ai.providerSettings) {
      settings.ai.providerSettings = {}
    }
    if (oldProvider) {
      syncActiveToProviderSettings(settings, oldProvider)
    }

    const saved = settings.ai.providerSettings[newProvider]
    if (saved) {
      settings.ai.apiKey = saved.apiKey ?? ''
      settings.ai.endpoint = saved.endpoint ?? (DEFAULT_ENDPOINTS[newProvider] || '')
      settings.ai.model = saved.model ?? (DEFAULT_MODELS[newProvider] || '')
      settings.ai.maxTokens = saved.maxTokens ?? (newProvider === 'gemini' ? 65536 : (newProvider === 'claude' ? 8192 : 16384))
      settings.ai.batchSize = saved.batchSize ?? 20
      settings.ai.reasoningEffort = saved.reasoningEffort ?? 'auto'
      if (newProvider === 'openrouter') {
        settings.ai.openRouterOnlyFree = !!saved.onlyFreeModels
      }
    } else {
      const defEndpoint = DEFAULT_ENDPOINTS[newProvider] || ''
      const defModel = DEFAULT_MODELS[newProvider] || ''
      const defTokens = newProvider === 'gemini' ? 65536 : (newProvider === 'claude' ? 8192 : 16384)
      settings.ai.apiKey = ''
      settings.ai.endpoint = defEndpoint
      settings.ai.model = defModel
      settings.ai.maxTokens = defTokens
      settings.ai.batchSize = 20
      settings.ai.reasoningEffort = 'auto'
      if (newProvider === 'openrouter') {
        settings.ai.openRouterOnlyFree = false
      }
      syncActiveToProviderSettings(settings, newProvider)
    }
    settings.ai.provider = newProvider
  }

  it('remembers settings of the previous provider when switching to another provider and back', () => {
    const settings = createTestSettings()

    // 1. Configure OpenAI
    settings.ai.provider = 'openai'
    settings.ai.apiKey = 'sk-openai-test-key'
    settings.ai.model = 'gpt-4o'
    settings.ai.endpoint = 'https://api.openai.com/v1'
    settings.ai.maxTokens = 16384
    settings.ai.batchSize = 25
    syncActiveToProviderSettings(settings, 'openai')

    // 2. Switch to OpenRouter
    loadProviderSettings(settings, 'openrouter', 'openai')
    expect(settings.ai.provider).toBe('openrouter')
    expect(settings.ai.apiKey).toBe('') // Unconfigured OpenRouter initially
    expect(settings.ai.endpoint).toBe('https://openrouter.ai/api/v1')
    expect(settings.ai.model).toBe('openai/gpt-4o-mini')
    expect(settings.ai.openRouterOnlyFree).toBe(false)

    // 3. Configure OpenRouter with free models only and low reasoning effort
    settings.ai.apiKey = 'sk-or-v1-test-key'
    settings.ai.model = 'stealth/ox-alpha'
    settings.ai.maxTokens = 32768
    settings.ai.batchSize = 15
    settings.ai.openRouterOnlyFree = true
    settings.ai.reasoningEffort = 'low'
    syncActiveToProviderSettings(settings, 'openrouter')

    // 4. Switch to Gemini
    loadProviderSettings(settings, 'gemini', 'openrouter')
    expect(settings.ai.provider).toBe('gemini')
    expect(settings.ai.endpoint).toBe('https://generativelanguage.googleapis.com')
    expect(settings.ai.model).toBe('gemini-2.5-flash')
    expect(settings.ai.maxTokens).toBe(65536)

    // 5. Configure Gemini
    settings.ai.apiKey = 'AIza-gemini-key'
    settings.ai.model = 'gemini-3.5-flash'
    syncActiveToProviderSettings(settings, 'gemini')

    // 6. Switch back to OpenAI and verify all OpenAI settings are intact
    loadProviderSettings(settings, 'openai', 'gemini')
    expect(settings.ai.provider).toBe('openai')
    expect(settings.ai.apiKey).toBe('sk-openai-test-key')
    expect(settings.ai.model).toBe('gpt-4o')
    expect(settings.ai.endpoint).toBe('https://api.openai.com/v1')
    expect(settings.ai.maxTokens).toBe(16384)
    expect(settings.ai.batchSize).toBe(25)

    // 7. Switch back to OpenRouter and verify OpenRouter settings including openRouterOnlyFree and reasoningEffort are intact
    loadProviderSettings(settings, 'openrouter', 'openai')
    expect(settings.ai.provider).toBe('openrouter')
    expect(settings.ai.apiKey).toBe('sk-or-v1-test-key')
    expect(settings.ai.model).toBe('stealth/ox-alpha')
    expect(settings.ai.endpoint).toBe('https://openrouter.ai/api/v1')
    expect(settings.ai.maxTokens).toBe(32768)
    expect(settings.ai.batchSize).toBe(15)
    expect(settings.ai.openRouterOnlyFree).toBe(true)
    expect(settings.ai.reasoningEffort).toBe('low')

    // 8. Switch back to Gemini and verify Gemini settings are intact
    loadProviderSettings(settings, 'gemini', 'openrouter')
    expect(settings.ai.provider).toBe('gemini')
    expect(settings.ai.apiKey).toBe('AIza-gemini-key')
    expect(settings.ai.model).toBe('gemini-3.5-flash')
  })

  it('cycles through all 5 providers preserving independent configurations', () => {
    const settings = createTestSettings()

    // 1. Custom provider
    loadProviderSettings(settings, 'custom')
    settings.ai.apiKey = 'custom-key'
    settings.ai.endpoint = 'http://localhost:11434/v1'
    settings.ai.model = 'llama3.2'
    settings.ai.maxTokens = 4096
    settings.ai.batchSize = 10
    syncActiveToProviderSettings(settings, 'custom')

    // 2. Claude provider
    loadProviderSettings(settings, 'claude', 'custom')
    settings.ai.apiKey = 'sk-ant-claude-key'
    settings.ai.model = 'claude-3-7-sonnet-20250219'
    settings.ai.maxTokens = 8192
    settings.ai.batchSize = 8
    syncActiveToProviderSettings(settings, 'claude')

    // 3. OpenAI provider
    loadProviderSettings(settings, 'openai', 'claude')
    settings.ai.apiKey = 'sk-openai-key'
    settings.ai.model = 'gpt-4o'
    syncActiveToProviderSettings(settings, 'openai')

    // 4. Gemini provider
    loadProviderSettings(settings, 'gemini', 'openai')
    settings.ai.apiKey = 'AIza-gemini-key'
    settings.ai.model = 'gemini-3.5-flash'
    syncActiveToProviderSettings(settings, 'gemini')

    // 5. OpenRouter provider
    loadProviderSettings(settings, 'openrouter', 'gemini')
    settings.ai.apiKey = 'sk-or-key'
    settings.ai.model = 'stealth/ox-alpha'
    settings.ai.openRouterOnlyFree = true
    syncActiveToProviderSettings(settings, 'openrouter')

    // Verify Custom
    loadProviderSettings(settings, 'custom', 'openrouter')
    expect(settings.ai.apiKey).toBe('custom-key')
    expect(settings.ai.endpoint).toBe('http://localhost:11434/v1')
    expect(settings.ai.model).toBe('llama3.2')
    expect(settings.ai.maxTokens).toBe(4096)
    expect(settings.ai.batchSize).toBe(10)

    // Verify Claude
    loadProviderSettings(settings, 'claude', 'custom')
    expect(settings.ai.apiKey).toBe('sk-ant-claude-key')
    expect(settings.ai.model).toBe('claude-3-7-sonnet-20250219')
    expect(settings.ai.maxTokens).toBe(8192)

    // Verify OpenRouter
    loadProviderSettings(settings, 'openrouter', 'claude')
    expect(settings.ai.apiKey).toBe('sk-or-key')
    expect(settings.ai.model).toBe('stealth/ox-alpha')
    expect(settings.ai.openRouterOnlyFree).toBe(true)
  })
})
