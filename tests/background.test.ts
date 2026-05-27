import { describe, it, expect, vi, beforeAll } from 'vitest'

describe('getAIOverrides', () => {
  let getAIOverrides: any

  beforeAll(async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        getManifest: vi.fn(() => ({ version: '1.0.0' }))
      },
      commands: {
        onCommand: { addListener: vi.fn() }
      },
      tabs: {
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
        query: vi.fn(),
        remove: vi.fn()
      },
      tabGroups: {
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() }
      },
      contextMenus: {
        create: vi.fn(),
        onClicked: { addListener: vi.fn() }
      },
      storage: {
        sync: {
          get: vi.fn(),
          set: vi.fn()
        },
        local: {
          get: vi.fn((key, cb) => {
            if (cb) cb({})
            return Promise.resolve({})
          }),
          set: vi.fn()
        },
        onChanged: {
          addListener: vi.fn()
        }
      }
    })

    const module = await import('../src/background/index')
    getAIOverrides = module.getAIOverrides
  })

  it('returns undefined if payload is missing or empty', () => {
    expect(getAIOverrides(null)).toBeUndefined()
    expect(getAIOverrides(undefined)).toBeUndefined()
    expect(getAIOverrides('string')).toBeUndefined()
    expect(getAIOverrides({})).toBeUndefined()
  })

  it('extracts model and provider from payload', () => {
    const payload = { model: 'gpt-4o', provider: 'openai' }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ model: 'gpt-4o', provider: 'openai' })
  })

  it('ignores invalid providers', () => {
    const payload = { model: 'some-model', provider: 'invalid-provider' }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ model: 'some-model' })
  })

  it('extracts sendFullUrl when present', () => {
    const payload = { sendFullUrl: true }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ sendFullUrl: true })
  })

  it('extracts sendFullUrl even when set to false', () => {
    const payload = { sendFullUrl: false }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ sendFullUrl: false })
  })

  it('extracts all overrides when present', () => {
    const payload = { model: 'gemini-3.5-flash', provider: 'gemini', sendFullUrl: true }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ model: 'gemini-3.5-flash', provider: 'gemini', sendFullUrl: true })
  })

  it('ignores literal "-full" as a model name (prevents search overlay bug)', () => {
    const payload = { model: '-full', provider: 'custom', sendFullUrl: true }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ provider: 'custom', sendFullUrl: true })
    expect(result?.model).toBeUndefined()
  })
})
