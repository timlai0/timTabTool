import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIClient, fetchGoogleModels, fetchOpenRouterModels, fetchOpenRouterProviders, fetchOpenRouterKeyInfo, getGoogleModelPricing, isFreeModel } from '../src/shared/ai-client'
import type { AIConfig, AIProgressUpdate } from '../src/shared/types'

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

  it('attempts to continue up to maxContinuations times when output token limit (MAX_TOKENS) is exceeded', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'gemini',
      apiKey: 'test-key',
      maxRetries: 3,
    }
    const client = new AIClient(config)

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{ finishReason: 'MAX_TOKENS' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.classifyNewTabsIntoGroups([{ url: 'https://example.com', title: 'Example' }], [])

    // 1 initial request + 3 continuations = 4 attempts
    expect(mockFetch).toHaveBeenCalledTimes(4)
    expect(result[0].group).toBe('NEW')
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
    for (let i = 0; i < 35; i++) {
      const result = await client.testConnection()
      if (!result.ok && result.error) {
        lastError = result.error
        break
      }
    }

    expect(lastError).toContain('AI safety safeguard')
    expect(lastError).toContain('Single operation exceeded the safety limit')
    expect(mockFetch).toHaveBeenCalledTimes(30)
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

    // Create 650 tabs (650 / 20 = 33 batches > 30 limit)
    const tabs = Array.from({ length: 650 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Tab ${i}` }))

    await expect(client.groupTabsFreely(tabs)).rejects.toThrow('Single operation exceeded the safety limit of 30 requests')
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

    for (let i = 0; i < 60; i++) {
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
    expect(totalSuccessCount).toBe(50)
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
    expect(formatted).toBe('1. "Issue #1" (github.com)')
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
    expect(formatted).toBe('1. "Issue #1" (URL: https://github.com/florianlanx/timTabTool/issues/1)')
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

  it('includes tab opened time tag when createdAt or lastAccessed is present', () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      sendFullUrl: false,
    }
    const client = new AIClient(config)
    const tenMinsAgo = Date.now() - 10 * 60 * 1000
    const tab = { url: 'https://github.com/florianlanx/timTabTool/issues/1', title: 'Issue #1', createdAt: tenMinsAgo }

    const formatted = (client as any).formatTabForPrompt(tab, 1, false)
    expect(formatted).toBe(`1. "Issue #1" (github.com) (Opened: ${new Date(tenMinsAgo).toISOString()})`)
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
          name: 'models/gemini-3.1-flash-preview-0925',
          displayName: 'Nano Banana 2.1', // image model whose id carries no marker
          supportedGenerationMethods: ['generateContent'],
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
    expect(models.map(m => m.id)).not.toContain('gemini-3.1-flash-preview-0925')

    const flashModel = models.find(m => m.id === 'gemini-2.5-flash')
    expect(flashModel?.costDetails).toBeDefined()
    expect(flashModel?.inputCost).toBe(0.3)
    expect(flashModel?.outputCost).toBe(2.5)

    const gemmaModel = models.find(m => m.id === 'gemma-2-9b-it')
    expect(gemmaModel?.costDetails).toBe('Free')
  })
})

describe('AIClient Progress Tracking & Streaming', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    ;(AIClient as any).globalRequestTimestamps = []
  })

  it('emits progress updates during groupTabsFreely execution', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
    }
    const client = new AIClient(config)

    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify([
              { name: 'Dev Tools', color: 'blue', tabIndices: [1, 2] }
            ])
          }
        }
      ]
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))

    const progressUpdates: any[] = []
    const tabs = [
      { url: 'https://github.com', title: 'GitHub' },
      { url: 'https://stackoverflow.com', title: 'Stack Overflow' },
    ]

    const result = await client.groupTabsFreely(tabs, undefined, (update: AIProgressUpdate) => {
      progressUpdates.push(update)
    })

    expect(result.length).toBe(1)
    expect(result[0].name).toBe('Dev Tools')
    expect(progressUpdates.length).toBeGreaterThanOrEqual(2)
    
    // Check stages
    const queryingUpdate = progressUpdates.find(u => u.stage === 'querying')
    expect(queryingUpdate).toBeDefined()
    expect(queryingUpdate.batchCurrent).toBe(1)
    expect(queryingUpdate.batchTotal).toBe(1)
    expect(queryingUpdate.totalTabs).toBe(2)
    expect(queryingUpdate.tabStartIndex).toBe(1)
    expect(queryingUpdate.tabEndIndex).toBe(2)

    const parsingUpdate = progressUpdates.find(u => u.stage === 'parsing')
    expect(parsingUpdate).toBeDefined()
    expect(parsingUpdate.discoveredGroupNames).toContain('Dev Tools')
  })

  it('emits retry progress updates during transient errors', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      maxRetries: 2,
    }
    const client = new AIClient(config)

    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(new Response('Rate limited', { status: 429 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify([{ name: 'Test', color: 'blue', tabIndices: [1] }]) } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const progressUpdates: any[] = []
    const tabs = [{ url: 'https://example.com', title: 'Example' }]

    await client.groupTabsFreely(tabs, undefined, (update: AIProgressUpdate) => {
      progressUpdates.push(update)
    })

    const retryUpdate = progressUpdates.find(u => u.stage === 'retrying')
    expect(retryUpdate).toBeDefined()
    expect(retryUpdate.retry).toBeDefined()
    expect(retryUpdate.retry.attempt).toBe(1)
    expect(retryUpdate.retry.maxRetries).toBe(2)
  })
})

describe('OpenRouter Provider & Model Fetching', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends requests to OpenRouter with proper headers and endpoint', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'openai/gpt-4o-mini',
    }
    const client = new AIClient(config)

    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}

    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url
      capturedHeaders = (init.headers as Record<string, string>) || {}
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
    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(capturedHeaders['Authorization']).toBe('Bearer sk-or-v1-test')
    expect(capturedHeaders['HTTP-Referer']).toBe('https://tabpilot.app')
    expect(capturedHeaders['X-Title']).toBe('timTabTool')
  })

  it('fetches live models from OpenRouter API and parses pricing', async () => {
    const mockApiResponse = {
      data: [
        {
          id: 'deepseek/deepseek-chat',
          name: 'DeepSeek: DeepSeek V3',
          pricing: {
            prompt: '0.00000014',
            completion: '0.00000028',
          },
          top_provider: {
            max_completion_tokens: 8192,
          }
        },
        {
          id: 'anthropic/claude-3.7-sonnet',
          name: 'Anthropic: Claude 3.7 Sonnet',
          pricing: {
            prompt: '0.000003',
            completion: '0.000015',
          },
          top_provider: {
            max_completion_tokens: 16384,
          }
        }
      ]
    }

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockApiResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    vi.stubGlobal('fetch', mockFetch)

    const models = await fetchOpenRouterModels('sk-or-v1-test')
    expect(models.length).toBe(2)
    const deepseek = models.find(m => m.id === 'deepseek/deepseek-chat')
    expect(deepseek).toBeDefined()
    expect(deepseek?.name).toBe('DeepSeek: DeepSeek V3')
    expect(deepseek?.inputCost).toBeCloseTo(0.14)
    expect(deepseek?.outputCost).toBeCloseTo(0.28)
    expect(deepseek?.maxTokens).toBe('8K')

    const claude = models.find(m => m.id === 'anthropic/claude-3.7-sonnet')
    expect(claude).toBeDefined()
    expect(claude?.inputCost).toBeCloseTo(3.0)
    expect(claude?.outputCost).toBeCloseTo(15.0)
    expect(claude?.maxTokens).toBe('16K')
  })

  it('safely bounds maxTokens for models reporting context window as max_completion_tokens in OpenRouter', async () => {
    const mockApiResponse = {
      data: [
        {
          id: 'google/gemini-2.0-flash-001',
          name: 'Google: Gemini 2.0 Flash',
          context_length: 256000,
          top_provider: {
            max_completion_tokens: 256000,
          }
        },
        {
          id: 'qwen/qwen-2.5-72b-instruct',
          name: 'Qwen: Qwen 2.5 72B',
          context_length: 131072,
          top_provider: {}
        }
      ]
    }

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockApiResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    vi.stubGlobal('fetch', mockFetch)

    const models = await fetchOpenRouterModels('sk-or-v1-test')
    const gemini = models.find(m => m.id === 'google/gemini-2.0-flash-001')
    expect(gemini).toBeDefined()
    expect(gemini?.rawMaxOutputTokens).toBe(32768)
    expect(gemini?.maxTokens).toBe('32K')

    const qwen = models.find(m => m.id === 'qwen/qwen-2.5-72b-instruct')
    expect(qwen).toBeDefined()
    expect(qwen?.rawMaxOutputTokens).toBe(16384)
    expect(qwen?.maxTokens).toBe('16K')
  })

  it('bounds max_tokens in chatOpenAI request payload when configured with huge token limits', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'google/gemini-2.0-flash-001',
      maxTokens: 256000,
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody).toBeDefined()
    expect(capturedBody.max_tokens).toBe(16384)
  })

  it('estimates costs correctly for OpenRouter models', () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'openai/gpt-4o-mini',
      batchSize: 20,
    }

    const estimate = AIClient.estimateCostAndTokens(config, 20, 'group')
    expect(estimate.requests).toBe(1)
    expect(estimate.tokens).toBeGreaterThan(0)
    expect(estimate.costStr).not.toBe('')
  })

  it('correctly identifies free models with isFreeModel', () => {
    expect(isFreeModel('stealth/ox-alpha')).toBe(true)
    expect(isFreeModel('meta-llama/llama-3.3-70b-instruct:free')).toBe(true)
    expect(isFreeModel('deepseek/deepseek-r1:free')).toBe(true)
    expect(isFreeModel('google/gemini-2.0-flash-exp:free')).toBe(true)
    expect(isFreeModel('custom-model', { costFactor: 'Free' })).toBe(true)
    expect(isFreeModel('custom-model-2', { inputCost: 0, outputCost: 0 })).toBe(true)

    expect(isFreeModel('openai/gpt-4o')).toBe(false)
    expect(isFreeModel('anthropic/claude-3.7-sonnet')).toBe(false)
  })

  it('filters to only free models when onlyFree is enabled in fetchOpenRouterModels', async () => {
    const mockApiResponse = {
      data: [
        {
          id: 'stealth/ox-alpha',
          name: 'Stealth: OX Alpha',
          pricing: { prompt: '0', completion: '0' },
          top_provider: { max_completion_tokens: 32768 }
        },
        {
          id: 'meta-llama/llama-3.3-70b-instruct:free',
          name: 'Meta: Llama 3.3 70B (Free)',
          pricing: { prompt: '0', completion: '0' },
          top_provider: { max_completion_tokens: 8192 }
        },
        {
          id: 'openai/gpt-4o',
          name: 'OpenAI: GPT-4o',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
          top_provider: { max_completion_tokens: 16384 }
        }
      ]
    }

    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(mockApiResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    ))

    const allModels = await fetchOpenRouterModels('test-key', undefined, false)
    expect(allModels.length).toBe(3)

    const freeModels = await fetchOpenRouterModels('test-key', undefined, true)
    expect(freeModels.length).toBe(2)
    expect(freeModels.some(m => m.id === 'stealth/ox-alpha')).toBe(true)
    expect(freeModels.some(m => m.id === 'meta-llama/llama-3.3-70b-instruct:free')).toBe(true)
    expect(freeModels.some(m => m.id === 'openai/gpt-4o')).toBe(false)
  })

  it('rejects paid models when openRouterOnlyFree is enabled in AIClient', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'openai/gpt-4o',
      openRouterOnlyFree: true,
    }
    const client = new AIClient(config)

    const result = await client.testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not permitted when OpenRouter free models mode is enabled')
  })

  it('permits free models when openRouterOnlyFree is enabled in AIClient', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'stealth/ox-alpha',
      openRouterOnlyFree: true,
    }
    const client = new AIClient(config)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const result = await client.testConnection()
    expect(result.ok).toBe(true)
  })

  it('performs tab grouping successfully with OpenRouter', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'stealth/ox-alpha',
      openRouterOnlyFree: true,
    }
    const client = new AIClient(config)

    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify([
              { name: 'Research', color: 'blue', tabIndices: [1, 2] }
            ])
          }
        }
      ]
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))

    const tabs = [
      { url: 'https://arxiv.org/abs/1234', title: 'Paper 1' },
      { url: 'https://arxiv.org/abs/5678', title: 'Paper 2' },
    ]

    const groups = await client.groupTabsFreely(tabs)
    expect(groups.length).toBe(1)
    expect(groups[0].name).toBe('Research')
    expect(groups[0].tabIndices).toEqual([1, 2])
  })

  it('injects reasoning effort into OpenRouter request body when configured', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'stealth/ox-alpha',
      reasoningEffort: 'low',
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody).toBeDefined()
    expect(capturedBody.reasoning).toEqual({ effort: 'low' })
    expect(capturedBody.reasoning_effort).toBeUndefined()
  })

  it('injects reasoning_effort into OpenAI request body when configured', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o3-mini',
      reasoningEffort: 'high',
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody).toBeDefined()
    expect(capturedBody.reasoning_effort).toBe('high')
    expect(capturedBody.reasoning).toBeUndefined()
  })

  it('injects thinkingConfig.thinkingLevel and includeThoughts into Gemini request body and omits sampling parameters when reasoningEffort is configured', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'gemini',
      apiKey: 'AIza-test-key',
      model: 'gemini-2.5-flash',
      reasoningEffort: 'medium',
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'Thinking about the request...', thought: true },
                    { text: 'OK' },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.testConnection()
    expect(result.ok).toBe(true)
    expect(capturedBody).toBeDefined()
    expect(capturedBody.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'medium', includeThoughts: true })
    expect(capturedBody.generationConfig?.thinkingBudget).toBeUndefined()
    expect(capturedBody.generationConfig?.temperature).toBeUndefined()
    expect(capturedBody.generationConfig?.topP).toBeUndefined()
    expect(capturedBody.generationConfig?.topK).toBeUndefined()
  })

  it('injects thinkingLevel and includeThoughts for Gemini 3 models', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'gemini',
      apiKey: 'AIza-test-key',
      model: 'gemini-3.5-flash',
      reasoningEffort: 'high',
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'Deep reasoning trace...', thought: true },
                    { text: 'OK' },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.testConnection()
    expect(result.ok).toBe(true)
    expect(capturedBody).toBeDefined()
    expect(capturedBody.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true })
    expect(capturedBody.generationConfig?.thinkingBudget).toBeUndefined()
    expect(capturedBody.generationConfig?.temperature).toBeUndefined()
    expect(capturedBody.generationConfig?.topP).toBeUndefined()
    expect(capturedBody.generationConfig?.topK).toBeUndefined()
  })

  it.each([
    ['minimal', 'minimal'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'high'],
  ])('maps Gemini reasoningEffort %s to thinkingLevel %s without sampling parameters', async (effort, expectedLevel) => {
    const config: AIConfig = {
      enabled: true,
      provider: 'gemini',
      apiKey: 'AIza-test-key',
      model: 'gemini-2.5-flash',
      reasoningEffort: effort as any,
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'OK' }] },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: expectedLevel, includeThoughts: true })
    expect(capturedBody.generationConfig?.thinkingBudget).toBeUndefined()
    expect(capturedBody.generationConfig?.temperature).toBeUndefined()
    expect(capturedBody.generationConfig?.topP).toBeUndefined()
    expect(capturedBody.generationConfig?.topK).toBeUndefined()
  })

  it('omits reasoning effort parameters when reasoningEffort is auto or unset for OpenRouter', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'stealth/ox-alpha',
      reasoningEffort: 'auto',
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody).toBeDefined()
    expect(capturedBody.reasoning).toBeUndefined()
    expect(capturedBody.reasoning_effort).toBeUndefined()
  })

  it('injects includeThoughts: true for Gemini when reasoningEffort is auto or unset', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'gemini',
      apiKey: 'AIza-test-key',
      model: 'gemini-2.5-flash',
      reasoningEffort: 'auto',
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'OK' }],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody).toBeDefined()
    expect(capturedBody.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
    expect(capturedBody.generationConfig?.temperature).toBeUndefined()
    expect(capturedBody.generationConfig?.topP).toBeUndefined()
    expect(capturedBody.generationConfig?.topK).toBeUndefined()
    expect(capturedBody.generationConfig?.thinkingBudget).toBeUndefined()
  })

  it('injects provider routing order and allow_fallbacks into OpenRouter request body when openrouterProvider is configured', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'google/gemini-2.5-flash',
      openrouterProvider: 'google',
      openrouterAllowFallbacks: true,
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody).toBeDefined()
    expect(capturedBody.provider).toEqual({
      order: ['google'],
      allow_fallbacks: true,
    })
  })

  it('injects provider routing with allow_fallbacks=false when fallbacks are disabled', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'nvidia/llama-3.1-nemotron-70b-instruct',
      openrouterProvider: 'nvidia',
      openrouterAllowFallbacks: false,
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody).toBeDefined()
    expect(capturedBody.provider).toEqual({
      order: ['nvidia'],
      allow_fallbacks: false,
    })
  })

  it('omits provider routing when openrouterProvider is auto or unset', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'openai/gpt-4o-mini',
      openrouterProvider: '',
    }
    const client = new AIClient(config)

    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await client.testConnection()
    expect(capturedBody).toBeDefined()
    expect(capturedBody.provider).toBeUndefined()
  })

  it('fetches and parses live OpenRouter providers using fetchOpenRouterProviders', async () => {
    const mockProvidersResponse = {
      data: [
        { slug: 'together', name: 'Together AI' },
        { slug: 'google', name: 'Google' },
        { slug: 'nvidia', name: 'NVIDIA' },
      ]
    }

    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      expect(url).toContain('/providers')
      expect((init.headers as any)['Authorization']).toBe('Bearer test-key')
      return Promise.resolve(
        new Response(JSON.stringify(mockProvidersResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const providers = await fetchOpenRouterProviders('test-key')
    expect(providers.length).toBe(3)
    expect(providers[0].name).toBe('Google')
    expect(providers[0].slug).toBe('google')
    expect(providers[1].name).toBe('NVIDIA')
    expect(providers[1].slug).toBe('nvidia')
    expect(providers[2].name).toBe('Together AI')
    expect(providers[2].slug).toBe('together')
  })

  it('fetches OpenRouter key info and detects active BYOK when byok_usage > 0', async () => {
    const mockKeyResponse = {
      data: {
        label: 'Production Key',
        usage: 12.5,
        limit: 100,
        is_free_tier: false,
        byok_usage: 4.82,
        byok_usage_daily: 0.15,
        byok_usage_weekly: 1.25,
        byok_usage_monthly: 4.82,
      }
    }

    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith('/key')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockKeyResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      }
      if (url.endsWith('/byok')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ provider: 'google', disabled: false }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      }
      return Promise.reject(new Error('Unknown URL'))
    })
    vi.stubGlobal('fetch', mockFetch)

    const info = await fetchOpenRouterKeyInfo('sk-or-v1-test')
    expect(info.label).toBe('Production Key')
    expect(info.isByokActive).toBe(true)
    expect(info.byokUsage).toBe(4.82)
    expect(info.byokProviders).toEqual(['google'])
  })

  it('detects inactive BYOK when byok_usage is 0 and no upstream providers returned', async () => {
    const mockKeyResponse = {
      data: {
        label: 'Standard Key',
        usage: 5.0,
        limit: 50,
        is_free_tier: false,
        byok_usage: 0,
      }
    }

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/key')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockKeyResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      }
      if (url.endsWith('/byok')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      }
      return Promise.reject(new Error('Unknown URL'))
    })
    vi.stubGlobal('fetch', mockFetch)

    const info = await fetchOpenRouterKeyInfo('sk-or-v1-standard')
    expect(info.label).toBe('Standard Key')
    expect(info.isByokActive).toBe(false)
    expect(info.byokUsage).toBe(0)
    expect(info.byokProviders).toBeUndefined()
  })

  it('falls back to /auth/key when /key returns 404', async () => {
    const mockAuthKeyResponse = {
      data: {
        label: 'Legacy Key',
        usage: 1.0,
        is_free_tier: true,
        byok_usage: 0.5,
      }
    }

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/auth/key')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockAuthKeyResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      }
      if (url.endsWith('/key')) {
        return Promise.resolve(new Response('Not Found', { status: 404 }))
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }))
    })
    vi.stubGlobal('fetch', mockFetch)

    const info = await fetchOpenRouterKeyInfo('sk-or-v1-legacy')
    expect(info.label).toBe('Legacy Key')
    expect(info.isByokActive).toBe(true)
    expect(info.byokUsage).toBe(0.5)
  })

  it('throws descriptive error on invalid API key for fetchOpenRouterKeyInfo', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchOpenRouterKeyInfo('invalid-key')).rejects.toThrow('Invalid API key')
  })

  it('streams live reasoning and emits progress updates via SSE', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-v1-test',
      model: 'stealth/ox-alpha',
    }
    const client = new AIClient(config)

    const encoder = new TextEncoder()
    const sseChunks = [
      'data: {"choices":[{"delta":{"reasoning":"Thinking about quantum tabs..."},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning":" grouping by topic."},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"[{\\"name\\":\\"Quantum\\",\\"color\\":\\"blue\\",\\"tabIndices\\":[1]}]"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      }
    })

    const mockResponse = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse))

    const progressUpdates: any[] = []
    const tabs = [{ url: 'https://quantum.org', title: 'Quantum Computing' }]

    const groups = await client.groupTabsFreely(tabs, undefined, (update: AIProgressUpdate) => {
      progressUpdates.push(update)
    })

    expect(groups.length).toBe(1)
    expect(groups[0].name).toBe('Quantum')
    const reasoningUpdates = progressUpdates.filter(u => u.liveReasoning)
    expect(reasoningUpdates.length).toBeGreaterThan(0)
    const finalReasoning = reasoningUpdates[reasoningUpdates.length - 1].liveReasoning
    expect(finalReasoning).toContain('Thinking about quantum tabs')
    expect(finalReasoning).toContain('grouping by topic.')
  })

  it('streams live reasoning and emits progress updates via SSE for Gemini', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'gemini',
      apiKey: 'AIza-gemini-test-key',
      model: 'gemini-2.5-flash',
      reasoningEffort: 'medium',
    }
    const client = new AIClient(config)

    const encoder = new TextEncoder()
    const sseChunks = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Evaluating quantum physics tabs...","thought":true}]},"finishReason":null}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" Creating dedicated research cluster.","thought":true}]},"finishReason":null}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"[{\\"name\\":\\"Quantum Physics\\",\\"color\\":\\"cyan\\",\\"tabIndices\\":[1]}]"}]},"finishReason":"STOP"}]}\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      }
    })

    const mockResponse = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })

    let capturedUrl = ''
    let capturedBody: any = null
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(mockResponse)
    })
    vi.stubGlobal('fetch', mockFetch)

    const progressUpdates: any[] = []
    const tabs = [{ url: 'https://quantum-physics.org', title: 'Quantum Physics' }]

    const groups = await client.groupTabsFreely(tabs, undefined, (update: AIProgressUpdate) => {
      progressUpdates.push(update)
    })

    expect(groups.length).toBe(1)
    expect(groups[0].name).toBe('Quantum Physics')
    expect(capturedUrl).toContain('streamGenerateContent')
    expect(capturedUrl).toContain('alt=sse')
    expect(capturedBody.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'medium', includeThoughts: true })
    expect(capturedBody.generationConfig?.thinkingBudget).toBeUndefined()
    expect(capturedBody.generationConfig?.temperature).toBeUndefined()

    const reasoningUpdates = progressUpdates.filter(u => u.liveReasoning)
    expect(reasoningUpdates.length).toBeGreaterThan(0)
    const finalReasoning = reasoningUpdates[reasoningUpdates.length - 1].liveReasoning
    expect(finalReasoning).toContain('Evaluating quantum physics tabs')
    expect(finalReasoning).toContain('Creating dedicated research cluster.')
    expect(reasoningUpdates[reasoningUpdates.length - 1].reasoningSnippet).toBeDefined()
  })

  it('extracts thought parts in Gemini non-streaming fallback and emits progress updates', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'gemini',
      apiKey: 'AIza-gemini-test-key',
      model: 'gemini-2.5-flash',
    }
    const client = new AIClient(config)

    const mockResponseData = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Analyzing tabs for optimal grouping...', thought: true },
              { text: '[{"name":"Dev Docs","color":"green","tabIndices":[1]}]' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    }

    const mockResponse = new Response(JSON.stringify(mockResponseData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse))

    const progressUpdates: any[] = []
    const tabs = [{ url: 'https://dev.example.com', title: 'Dev Docs' }]

    const groups = await client.groupTabsFreely(tabs, undefined, (update: AIProgressUpdate) => {
      progressUpdates.push(update)
    })

    expect(groups.length).toBe(1)
    expect(groups[0].name).toBe('Dev Docs')

    const reasoningUpdates = progressUpdates.filter(u => u.liveReasoning)
    expect(reasoningUpdates.length).toBeGreaterThan(0)
    expect(reasoningUpdates[0].liveReasoning).toBe('Analyzing tabs for optimal grouping...')
    expect(reasoningUpdates[0].reasoningSnippet).toBe('Analyzing tabs for optimal grouping...')
  })

  it('automatically recovers and retries without thinkingConfig when Gemini returns 400 Bad Request on unsupported model', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'gemini',
      apiKey: 'AIza-gemini-test-key',
      model: 'gemini-1.5-flash',
      reasoningEffort: 'medium',
    }
    const client = new AIClient(config)

    let callCount = 0
    let secondRequestBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'thinkingConfig is not supported for gemini-1.5-flash' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }
      secondRequestBody = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: '[{"name":"Docs","color":"blue","tabIndices":[1]}]' }],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const tabs = [{ url: 'https://docs.example.com', title: 'Docs' }]
    const groups = await client.groupTabsFreely(tabs)
    expect(groups.length).toBe(1)
    expect(groups[0].name).toBe('Docs')
    expect(callCount).toBe(2)
    expect(secondRequestBody.generationConfig?.thinkingConfig).toBeUndefined()
  })

  it('returns partial aggregated results if aborted during later batches in groupTabsFreely', async () => {
    const abortController = new AbortController()
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      batchSize: 100,
    }
    const client = new AIClient(config, abortController.signal)

    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // Batch 1 succeeds with all 100 tabs assigned to Dev
        const allBatch1Indices = Array.from({ length: 100 }, (_, i) => i + 1)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify([{ name: 'Dev', color: 'blue', tabIndices: allBatch1Indices }]) } }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      } else {
        // Batch 2 triggers abort
        abortController.abort()
        const abortError = new Error('The operation was aborted.')
        abortError.name = 'AbortError'
        return Promise.reject(abortError)
      }
    })

    vi.stubGlobal('fetch', mockFetch)

    // Pass 150 tabs with batchSize = 100 to force 2 batches
    const tabs = Array.from({ length: 150 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `Tab ${i}`,
    }))

    const groups = await client.groupTabsFreely(tabs)

    expect(groups.length).toBe(1)
    expect(groups[0].name).toBe('Dev')
    expect(callCount).toBe(2)
  })

  it('returns partial aggregated results if aborted during later batches in classifyNewTabsIntoGroups', async () => {
    const abortController = new AbortController()
    const config: AIConfig = {
      enabled: true,
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      batchSize: 100,
    }
    const client = new AIClient(config, abortController.signal)

    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // Batch 1 succeeds
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify([{ index: 1, group: 'Work' }]) } }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      } else {
        // Batch 2 triggers abort
        abortController.abort()
        const abortError = new Error('The operation was aborted.')
        abortError.name = 'AbortError'
        return Promise.reject(abortError)
      }
    })

    vi.stubGlobal('fetch', mockFetch)

    const unassignedTabs = Array.from({ length: 150 }, (_, i) => ({
      url: `https://work.com/${i}`,
      title: `Work Tab ${i}`,
    }))
    const existingGroupNames = ['Work']

    const assignments = await client.classifyNewTabsIntoGroups(
      unassignedTabs,
      existingGroupNames
    )

    expect(assignments.length).toBe(1)
    expect(assignments[0].group).toBe('Work')
    expect(callCount).toBe(2)
  })

  it('injects provider routing strategy, data_collection, require_parameters, and ignore list for OpenRouter', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-test-key',
      model: 'anthropic/claude-3.5-sonnet',
      openrouterProvider: 'google',
      openrouterAllowFallbacks: false,
      openrouterSort: 'throughput',
      openrouterDataCollection: 'deny',
      openrouterRequireParams: true,
      openrouterIgnoreProviders: 'cloudflare, novita',
    }
    const client = new AIClient(config)

    let capturedBody: any
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
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
    expect(capturedBody.provider).toEqual({
      order: ['google'],
      allow_fallbacks: false,
      sort: 'throughput',
      data_collection: 'deny',
      require_parameters: true,
      ignore: ['cloudflare', 'novita'],
    })
  })

  it('injects fallback models array when openrouterFallbackModels is configured', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-test-key',
      model: 'anthropic/claude-3.5-sonnet',
      openrouterFallbackModels: 'openai/gpt-4o-mini, google/gemini-2.5-flash',
    }
    const client = new AIClient(config)

    let capturedBody: any
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
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
    expect(capturedBody.models).toEqual([
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-flash',
    ])
  })

  it('omits Authorization header when apiKey is empty or whitespace', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: '   ',
      model: 'stealth/ox-alpha',
    }
    const client = new AIClient(config)

    let capturedHeaders: any
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.testConnection()
    expect(result.ok).toBe(true)
    expect(capturedHeaders['Authorization']).toBeUndefined()
    expect(capturedHeaders['HTTP-Referer']).toBe('https://tabpilot.app')
  })

  it('automatically retries without response_format when provider returns 400 parameter error', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-test-key',
      model: 'z-ai/glm-5.2:free',
    }
    const client = new AIClient(config)

    let callCount = 0
    let lastRequestBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++
      lastRequestBody = JSON.parse(init.body as string)
      if (callCount === 1) {
        // Return 400 saying response_format not supported
        return Promise.resolve(
          new Response('Provider does not support response_format: json_object', { status: 400 })
        )
      }
      // Second call succeeds
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify([{ name: 'Dev', color: 'green', tabIndices: [1] }]) } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.groupTabsFreely([{ url: 'https://github.com', title: 'GitHub' }])
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('Dev')
    expect(callCount).toBe(2)
    expect(lastRequestBody.response_format).toBeUndefined()
  })

  it('automatically retries with reduced max_tokens when provider returns 400 token limit error', async () => {
    const config: AIConfig = {
      enabled: true,
      provider: 'openrouter',
      apiKey: 'sk-or-test-key',
      model: 'liquid/lfm-2.5-2.6b:free',
      maxTokens: 16384,
    }
    const client = new AIClient(config)

    let callCount = 0
    let lastRequestBody: any = null
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++
      lastRequestBody = JSON.parse(init.body as string)
      if (callCount === 1) {
        return Promise.resolve(
          new Response('max_tokens is too large for model context_length limit', { status: 400 })
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify([{ name: 'Docs', color: 'pink', tabIndices: [1] }]) } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await client.groupTabsFreely([{ url: 'https://docs.com', title: 'Docs' }])
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('Docs')
    expect(callCount).toBe(2)
    expect(lastRequestBody.max_tokens).toBe(4096)
  })

  describe('reviewAndRegroupTabs', () => {
    it('returns empty array when tabs array is empty', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)
      const res = await client.reviewAndRegroupTabs([], ['Work'])
      expect(res).toEqual([])
    })

    it('parses review decisions correctly with KEEP, existing group, new group, and ungroup', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      const mockResponse = JSON.stringify([
        { index: 1, group: 'KEEP' },
        { index: 2, group: 'Shopping' },
        { index: 3, group: 'NEW', newGroupName: 'Travel', newGroupColor: 'blue' },
        { index: 4, group: '_ungrouped_' }
      ])

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: mockResponse } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      vi.stubGlobal('fetch', mockFetch)

      const tabs = [
        { url: 'https://work.com', title: 'Work PR', currentGroup: 'Work' },
        { url: 'https://amazon.com', title: 'Store', currentGroup: 'Work' },
        { url: 'https://hotel.com', title: 'Hotel booking' },
        { url: 'https://random.com', title: 'Misc', currentGroup: 'Work' }
      ]

      const decisions = await client.reviewAndRegroupTabs(tabs, ['Work', 'Shopping'])
      expect(decisions).toHaveLength(4)
      expect(decisions[0]).toEqual({ index: 0, group: 'KEEP', newGroupName: undefined, newGroupColor: undefined })
      expect(decisions[1]).toEqual({ index: 1, group: 'Shopping', newGroupName: undefined, newGroupColor: undefined })
      expect(decisions[2]).toEqual({ index: 2, group: 'NEW', newGroupName: 'Travel', newGroupColor: 'blue' })
      expect(decisions[3]).toEqual({ index: 3, group: '_ungrouped_', newGroupName: undefined, newGroupColor: undefined })
    })

    it('falls back to KEEP when JSON parsing completely fails', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'This is not json at all' } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      vi.stubGlobal('fetch', mockFetch)

      const tabs = [
        { url: 'https://site1.com', title: 'Site 1', currentGroup: 'Work' },
        { url: 'https://site2.com', title: 'Site 2', currentGroup: 'Research' }
      ]

      const decisions = await client.reviewAndRegroupTabs(tabs, ['Work', 'Research'])
      expect(decisions).toEqual([
        { index: 0, group: 'KEEP' },
        { index: 1, group: 'KEEP' }
      ])
    })

    it('retries with stripped titles when PROHIBITED_CONTENT error occurs', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key', maxRetries: 1 }
      const client = new AIClient(config)

      let callCount = 0
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: { message: 'PROHIBITED_CONTENT: blocked by policy' } }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify([{ index: 1, group: 'KEEP' }]) } }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      })
      vi.stubGlobal('fetch', mockFetch)

      const tabs = [{ url: 'https://sensitive.com', title: 'Secret Doc', currentGroup: 'Confidential' }]
      const decisions = await client.reviewAndRegroupTabs(tabs, ['Confidential'])
      expect(decisions).toHaveLength(1)
      expect(decisions[0].group).toBe('KEEP')
      expect(callCount).toBe(2)
    })

    it('estimates tokens and cost accurately for regroup type', () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const est = AIClient.estimateCostAndTokens(config, 20, 'regroup', undefined, undefined, ['Work', 'Dev'])
      expect(est.tokens).toBeGreaterThan(0)
      expect(typeof est.costStr).toBe('string')
    })

    it('treats unknown group name as NEW group instead of forcing KEEP when tab is already grouped', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      const mockResponse = JSON.stringify([
        { index: 1, group: 'Cooking' }
      ])
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: mockResponse } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ))

      const tabs = [{ url: 'https://recipes.com', title: 'Pasta Recipe', currentGroup: 'Work' }]
      const decisions = await client.reviewAndRegroupTabs(tabs, ['Work', 'Dev'])
      expect(decisions).toHaveLength(1)
      expect(decisions[0].group).toBe('NEW')
      expect(decisions[0].newGroupName).toBe('Cooking')
    })

    it('defaults omitted tabs in partial AI response to KEEP', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      // AI only returned decision for tab 2
      const mockResponse = JSON.stringify([
        { index: 2, group: 'NEW', newGroupName: 'Travel' }
      ])
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: mockResponse } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ))

      const tabs = [
        { url: 'https://site1.com', title: 'Site 1', currentGroup: 'Work' },
        { url: 'https://site2.com', title: 'Site 2', currentGroup: 'Work' },
        { url: 'https://site3.com', title: 'Site 3', currentGroup: 'Work' }
      ]
      const decisions = await client.reviewAndRegroupTabs(tabs, ['Work'])
      expect(decisions).toHaveLength(3)
      expect(decisions[0]).toEqual({ index: 0, group: 'KEEP' })
      expect(decisions[1]).toEqual({ index: 1, group: 'NEW', newGroupName: 'Travel', newGroupColor: undefined })
      expect(decisions[2]).toEqual({ index: 2, group: 'KEEP' })
    })

    it('handles 0-based indices returned by LLM seamlessly', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      const mockResponse = JSON.stringify([
        { index: 0, group: 'KEEP' },
        { index: 1, group: 'Work' }
      ])
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: mockResponse } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ))

      const tabs = [
        { url: 'https://site1.com', title: 'Site 1', currentGroup: 'Dev' },
        { url: 'https://site2.com', title: 'Site 2', currentGroup: 'Dev' }
      ]
      const decisions = await client.reviewAndRegroupTabs(tabs, ['Dev', 'Work'])
      expect(decisions).toHaveLength(2)
      expect(decisions[0]).toEqual({ index: 0, group: 'KEEP', newGroupName: undefined, newGroupColor: undefined })
      expect(decisions[1]).toEqual({ index: 1, group: 'Work', newGroupName: undefined, newGroupColor: undefined })
    })

    it('unwraps object responses containing decisions or tabs arrays and handles aliases', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      const mockResponse = JSON.stringify({
        decisions: [
          { index: 1, targetGroup: 'Work' },
          { index: 2, category: 'NEW', newName: 'Finance', color: 'blue' }
        ]
      })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: mockResponse } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ))

      const tabs = [
        { url: 'https://site1.com', title: 'Site 1' },
        { url: 'https://site2.com', title: 'Site 2' }
      ]
      const decisions = await client.reviewAndRegroupTabs(tabs, ['Work'])
      expect(decisions).toHaveLength(2)
      expect(decisions[0]).toEqual({ index: 0, group: 'Work', newGroupName: undefined, newGroupColor: undefined })
      expect(decisions[1]).toEqual({ index: 1, group: 'NEW', newGroupName: 'Finance', newGroupColor: 'blue' })
    })
  })

  describe('generateDistinctGroupNames', () => {
    it('returns empty array if fewer than 2 groups are passed', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      const result = await client.generateDistinctGroupNames('Work', [
        { groupId: 1, name: 'Work', tabs: [{ url: 'https://site1.com', title: 'Site 1' }] }
      ])
      expect(result).toEqual([])
    })

    it('successfully parses direct array of renamed groups', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      const mockResponse = JSON.stringify([
        { groupId: 101, name: 'Frontend Dev' },
        { groupId: 102, name: 'Backend API' }
      ])
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: mockResponse } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ))

      const groups = [
        { groupId: 101, name: 'Dev', tabs: [{ url: 'https://react.dev', title: 'React' }] },
        { groupId: 102, name: 'Dev', tabs: [{ url: 'https://nodejs.org', title: 'Node' }] }
      ]

      const results = await client.generateDistinctGroupNames('Dev', groups)
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({ groupId: 101, oldName: 'Dev', newName: 'Frontend Dev' })
      expect(results[1]).toEqual({ groupId: 102, oldName: 'Dev', newName: 'Backend API' })
    })

    it('unwraps envelope objects and handles property aliases', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      const mockResponse = JSON.stringify({
        groups: [
          { id: 201, title: 'Travel Booking' },
          { group_id: 202, newName: 'Hotel Search' }
        ]
      })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: mockResponse } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ))

      const groups = [
        { groupId: 201, name: 'Travel', tabs: [{ url: 'https://flights.com', title: 'Flights' }] },
        { groupId: 202, name: 'Travel', tabs: [{ url: 'https://hotels.com', title: 'Hotels' }] }
      ]

      const results = await client.generateDistinctGroupNames('Travel', groups)
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({ groupId: 201, oldName: 'Travel', newName: 'Travel Booking' })
      expect(results[1]).toEqual({ groupId: 202, oldName: 'Travel', newName: 'Hotel Search' })
    })

    it('resolves name collisions by appending numeric suffixes', async () => {
      const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
      const client = new AIClient(config)

      // AI returned duplicate names for both groups
      const mockResponse = JSON.stringify([
        { groupId: 301, name: 'Research' },
        { groupId: 302, name: 'Research' }
      ])
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: mockResponse } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ))

      const groups = [
        { groupId: 301, name: 'Docs', tabs: [{ url: 'https://site1.com', title: 'Paper 1' }] },
        { groupId: 302, name: 'Docs', tabs: [{ url: 'https://site2.com', title: 'Paper 2' }] }
      ]

      const results = await client.generateDistinctGroupNames('Docs', groups)
      expect(results).toHaveLength(2)
      expect(results[0].newName).toBe('Research')
      expect(results[1].newName).toBe('Research 2')
    })
  })
})



