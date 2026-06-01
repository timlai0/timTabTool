import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIClient } from '../src/shared/ai-client'
import type { AIConfig } from '../src/shared/types'

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
