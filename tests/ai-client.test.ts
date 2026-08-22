import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIClient, fetchGoogleModels, fetchOpenRouterModels, getGoogleModelPricing, isFreeModel } from '../src/shared/ai-client'
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

  it('omits reasoning effort parameters when reasoningEffort is auto or unset', async () => {
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
})

