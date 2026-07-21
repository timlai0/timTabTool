import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIClient, fetchGoogleModels, getGoogleModelPricing } from '../src/shared/ai-client'
import type { AIConfig } from '../src/shared/types'

describe('getGoogleModelPricing', () => {
  it('correctly maps Gemini 3.6 Flash, Gemini 3.5 Flash Lite, and Gemini 3.5 Flash prices', () => {
    expect(getGoogleModelPricing('gemini-3.6-flash')).toEqual({ input: 1.5, output: 9.0 })
    expect(getGoogleModelPricing('gemini-3.5-flash')).toEqual({ input: 1.5, output: 9.0 })
    expect(getGoogleModelPricing('gemini-3.5-flash-lite')).toEqual({ input: 0.25, output: 1.5 })
  })
})

describe('AIClient Retry Logic', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('respects the maxRetries configuration on transient failures', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      maxRetries: 3,
    }
    const client = new AIClient(config)

    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount < 4) {
        // Return 500 Server Error for the first 3 calls
        return Promise.resolve(new Response('Server Error', { status: 500 }))
      }
      // Succeed on the 4th call
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'OK' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })

    vi.stubGlobal('fetch', mockFetch)

    const result = await client.testConnection()

    expect(result.ok).toBe(true)
    // 1 original attempt + 3 retries = 4 total calls
    expect(callCount).toBe(4)
  })

  it('stops retrying and fails when retry limit is exceeded', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      maxRetries: 2,
    }
    const client = new AIClient(config)

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('Rate Limit Exceeded', { status: 429 }))
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.testConnection()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('API error 429')
    // 1 original attempt + 2 retries = 3 total calls
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('does not retry permanent client errors (e.g. 400 Bad Request)', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      maxRetries: 3,
    }
    const client = new AIClient(config)

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('Bad Request', { status: 400 }))
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.testConnection()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('API error 400')
    // Should fail instantly on the 1st attempt, zero retries
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('stops immediately when aborted', async () => {
    const controller = new AbortController()
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      maxRetries: 3,
    }
    const client = new AIClient(config, controller.signal)

    const mockFetch = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.testConnection()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('aborted')
    // Should fail immediately and not retry at all
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('prevents mass API requests by throwing safeguard error when single operation request limit is exceeded', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      maxRetries: 0,
    }
    const client = new AIClient(config)

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'OK' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )
    vi.stubGlobal('fetch', mockFetch)

    let lastError = ''
    for (let i = 0; i < 20; i++) {
      const result = await client.testConnection()
      if (!result.ok && result.error) {
        lastError = result.error
        break
      }
    }

    expect(lastError).toContain('AI safety safeguard')
    expect(lastError).toContain('Single operation exceeded the safety limit')
    expect(mockFetch).toHaveBeenCalledTimes(15)
  })

  it('fails early before making any API calls if required operation batches exceed safety limit', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      batchSize: 20,
    }
    const client = new AIClient(config)
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    // Create 350 tabs (350 / 20 = 18 batches > 15 limit)
    const tabs = Array.from({ length: 350 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Tab ${i}` }))

    await expect(client.groupTabsFreely(tabs)).rejects.toThrow('Single operation exceeded the safety limit of 15 requests')
    expect(mockFetch).toHaveBeenCalledTimes(0)
  })

  it('bypasses safety limit when bypassSafeguards option is enabled', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      batchSize: 20,
      bypassSafeguards: true,
    }
    const client = new AIClient(config)
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '[{"name":"Dev","tabIndices":[1]}]' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )
    vi.stubGlobal('fetch', mockFetch)

    const tabs = Array.from({ length: 350 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Tab ${i}` }))
    const res = await client.groupTabsFreely(tabs)
    expect(res).toBeDefined()
    expect(mockFetch).toHaveBeenCalledTimes(18)
  })

  it('prevents global extension-wide rate abuse by throwing safeguard error when minute rate limit is exceeded', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      maxRetries: 0,
    }

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'OK' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )
    vi.stubGlobal('fetch', mockFetch)

    let lastError = ''
    let totalSuccessCount = 0

    // Reset static timestamps to guarantee test determinism
    ;(AIClient as any).globalRequestTimestamps = []

    for (let i = 0; i < 40; i++) {
      const freshClient = new AIClient(config)
      const result = await freshClient.testConnection()
      if (result.ok) {
        totalSuccessCount++
      } else if (result.error) {
        lastError = result.error
        break
      }
    }

    expect(lastError).toContain('AI safety safeguard')
    expect(lastError).toContain('Global rate limit exceeded')
    expect(totalSuccessCount).toBe(30)
  })
})

describe('AIClient Prompt Formatting', () => {
  it('formats tab with domain only when sendFullUrl is false', () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      sendFullUrl: false,
    }
    const client = new AIClient(config)
    const tab = { url: 'https://github.com/florianlanx/timTabTool/issues/1', title: 'Issue #1' }
    
    // Using cast to access private formatTabForPrompt method
    const formatted = (client as any).formatTabForPrompt(tab, 1, false)
    expect(formatted).toBe('1. Issue #1 (github.com)')
  })

  it('formats tab with full URL when sendFullUrl is true', () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      sendFullUrl: true,
    }
    const client = new AIClient(config)
    const tab = { url: 'https://github.com/florianlanx/timTabTool/issues/1', title: 'Issue #1' }
    
    const formatted = (client as any).formatTabForPrompt(tab, 1, false)
    expect(formatted).toBe('1. Issue #1 (URL: https://github.com/florianlanx/timTabTool/issues/1)')
  })

  it('formats tab with full URL when sendFullUrl is true even if stripTitles is true', () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      sendFullUrl: true,
    }
    const client = new AIClient(config)
    const tab = { url: 'https://github.com/florianlanx/timTabTool/issues/1', title: 'Issue #1' }
    
    const formatted = (client as any).formatTabForPrompt(tab, 1, true)
    expect(formatted).toBe('1. (URL: https://github.com/florianlanx/timTabTool/issues/1)')
  })
})

describe('fetchGoogleModels', () => {
  it('throws an error if apiKey is empty', async () => {
    await expect(fetchGoogleModels('')).rejects.toThrow('Google API Key is required')
  })

  it('fetches and filters generateContent models from Google API and attaches cost details', async () => {
    const mockResponse = {
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          outputTokenLimit: 16384,
        },
        {
          name: 'models/text-embedding-004',
          displayName: 'Text Embedding 004',
          supportedGenerationMethods: ['generateContent'], // has generateContent but is embedding model
        },
        {
          name: 'models/imagen-3.0-generate-002',
          displayName: 'Imagen 3',
          supportedGenerationMethods: ['generateContent'], // image gen model
        },
        {
          name: 'models/gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          supportedGenerationMethods: ['generateContent'],
          outputTokenLimit: 65536,
        },
        {
          name: 'models/gemma-2-9b-it',
          displayName: 'Gemma 2 9B',
          supportedGenerationMethods: ['generateContent'],
          outputTokenLimit: 8192,
        },
      ],
    }

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    vi.stubGlobal('fetch', mockFetch)

    const models = await fetchGoogleModels('test-google-key')
    expect(models.length).toBe(3)
    expect(models.map(m => m.id)).toContain('gemini-2.5-flash')
    expect(models.map(m => m.id)).toContain('gemini-2.5-pro')
    expect(models.map(m => m.id)).toContain('gemma-2-9b-it')
    expect(models.map(m => m.id)).not.toContain('text-embedding-004')
    expect(models.map(m => m.id)).not.toContain('imagen-3.0-generate-002')

    const flashModel = models.find(m => m.id === 'gemini-2.5-flash')
    expect(flashModel?.costDetails).toBeDefined()
    expect(flashModel?.inputCost).toBe(0.3)
    expect(flashModel?.outputCost).toBe(2.5)

    const gemmaModel = models.find(m => m.id === 'gemma-2-9b-it')
    expect(gemmaModel?.costDetails).toBe('Free')
  })
})
