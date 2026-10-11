import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIClient } from '../src/shared/ai-client'
import type { AIConfig } from '../src/shared/types'
import { STORAGE_KEYS } from '../src/shared/constants'

describe('AIClient.generateWindowName', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('parses JSON response with name property', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ name: 'Frontend React Dev' }) } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const tabs = [
      { id: 1, title: 'React Documentation', url: 'https://react.dev' },
      { id: 2, title: 'Vite Guide', url: 'https://vitejs.dev' }
    ]

    const result = await client.generateWindowName(tabs)
    expect(result).toBe('Frontend React Dev')
  })

  it('unwraps markdown json blocks and handles alternate envelope keys', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    const markdownContent = '```json\n{\n  "windowName": "Machine Learning Research"\n}\n```'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: markdownContent } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const tabs = [
      { id: 10, title: 'arXiv paper on transformers', url: 'https://arxiv.org/abs/1706.03762' }
    ]

    const result = await client.generateWindowName(tabs)
    expect(result).toBe('Machine Learning Research')
  })

  it('falls back to raw text and removes surrounding quotes and newlines', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '"Travel & Vacation Booking"\n' } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const tabs = [
      { id: 20, title: 'Flights to Tokyo', url: 'https://google.com/flights' }
    ]

    const result = await client.generateWindowName(tabs)
    expect(result).toBe('Travel & Vacation Booking')
  })

  it('truncates window names exceeding 40 characters', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    const longName = 'This Is An Excessively Verbose And Extremely Long Window Name That Exceeds Forty Characters'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ name: longName }) } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const tabs = [{ id: 1, title: 'Long Window', url: 'https://example.com' }]
    const result = await client.generateWindowName(tabs)
    expect(result.length).toBeLessThanOrEqual(40)
    expect(result).toBe(longName.slice(0, 40).trim())
  })

  it('returns Window fallback when tabs list is empty', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    const result = await client.generateWindowName([])
    expect(result).toBe('Empty Window')
  })

  it('retries with stripped domains on sensitive content safety error', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    let callCount = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: 'Request blocked due to content safety policy violation' }
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ name: 'Internal Documentation' }) } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    }))

    const tabs = [
      { id: 1, title: 'Confidential Internal Financial Audit 2026', url: 'https://corp.internal/audit' }
    ]

    const result = await client.generateWindowName(tabs)
    expect(callCount).toBe(2)
    expect(result).toBe('Internal Documentation')
  })
})

describe('AIClient.generateAllWindowsNames', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty array when no windows provided', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    const result = await client.generateAllWindowsNames([])
    expect(result).toEqual([])
  })

  it('delegates to generateWindowName when single window is provided', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ name: 'Solo Project' }) } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const windows = [
      {
        windowId: 10,
        tabs: [{ id: 1, title: 'Project Home', url: 'https://project.local' }]
      }
    ]

    const result = await client.generateAllWindowsNames(windows)
    expect(result).toEqual([{ windowId: 10, name: 'Solo Project' }])
  })

  it('generates distinct names for multiple windows and unwraps envelopes', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    const mockResponse = JSON.stringify({
      windows: [
        { windowId: 1, name: 'Software Development' },
        { windowId: 2, name: 'Entertainment & Videos' }
      ]
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: mockResponse } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const windows = [
      {
        windowId: 1,
        tabs: [{ id: 1, title: 'GitHub PR', url: 'https://github.com/repo/pull/1' }]
      },
      {
        windowId: 2,
        tabs: [{ id: 2, title: 'YouTube Video', url: 'https://youtube.com/watch?v=123' }]
      }
    ]

    const result = await client.generateAllWindowsNames(windows)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ windowId: 1, name: 'Software Development' })
    expect(result[1]).toEqual({ windowId: 2, name: 'Entertainment & Videos' })
  })

  it('resolves duplicate window names across windows by appending numeric suffixes', async () => {
    const config: AIConfig = { enabled: true, provider: 'openai', apiKey: 'test-key' }
    const client = new AIClient(config)

    const mockResponse = JSON.stringify([
      { windowId: 1, name: 'Research' },
      { windowId: 2, name: 'Research' }
    ])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: mockResponse } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const windows = [
      {
        windowId: 1,
        tabs: [{ id: 1, title: 'Paper 1', url: 'https://arxiv.org/1' }]
      },
      {
        windowId: 2,
        tabs: [{ id: 2, title: 'Paper 2', url: 'https://nature.com/2' }]
      }
    ]

    const result = await client.generateAllWindowsNames(windows)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Research')
    expect(result[1].name).toBe('Research 2')
  })
})

describe('Background window naming operations and message routing', () => {
  let generateWindowName: any
  let generateAllWindowsNames: any
  let handleExtensionMessage: any

  beforeEach(async () => {
    vi.restoreAllMocks()

    // Setup chrome mock
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({}),
        onMessage: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        getManifest: vi.fn(() => ({ version: '1.0.0' })),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      },
      commands: {
        onCommand: { addListener: vi.fn() }
      },
      action: {
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setPopup: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue({}),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        ungroup: vi.fn(),
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
      },
      tabGroups: {
        query: vi.fn().mockResolvedValue([]),
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        getLastFocused: vi.fn().mockResolvedValue({ id: 1 }),
        getAll: vi.fn().mockResolvedValue([{ id: 10 }, { id: 20 }]),
        onRemoved: { addListener: vi.fn() },
      },
      contextMenus: {
        create: vi.fn(),
        removeAll: vi.fn((cb) => { if (cb) cb(); return Promise.resolve() }),
        onClicked: { addListener: vi.fn() }
      },
      storage: {
        sync: {
          get: vi.fn().mockImplementation((keys, cb) => {
            const data = {
              ai: {
                enabled: true,
                provider: 'openai',
                apiKey: 'test-key',
                windowNamingPrompt: 'Name this window based on its tabs'
              }
            }
            if (cb) cb(data)
            return Promise.resolve(data)
          }),
          set: vi.fn().mockResolvedValue(undefined)
        },
        local: {
          get: vi.fn().mockImplementation((keys, cb) => {
            const data: Record<string, any> = {
              [STORAGE_KEYS.SETTINGS]: {
                ai: {
                  enabled: true,
                  provider: 'openai',
                  apiKey: 'test-key',
                  windowNamingPrompt: 'Name this window based on its tabs'
                }
              },
              [STORAGE_KEYS.CUSTOM_WINDOW_NAMES]: {}
            }
            if (cb) cb(data)
            return Promise.resolve(data)
          }),
          set: vi.fn().mockResolvedValue(undefined)
        },
        onChanged: { addListener: vi.fn() }
      },
      i18n: {
        getMessage: vi.fn((key: string) => key)
      }
    })

    const opsMod = await import('../src/background/tabs/ai-tab-operations')
    generateWindowName = opsMod.generateWindowName
    generateAllWindowsNames = opsMod.generateAllWindowsNames

    const routerMod = await import('../src/background/message-router')
    handleExtensionMessage = routerMod.handleExtensionMessage
  })

  it('generateWindowName persists custom name to local storage and broadcasts updates', async () => {
    chrome.tabs.query = vi.fn().mockResolvedValue([
      { id: 1, windowId: 5, title: 'Vue.js Guide', url: 'https://vuejs.org' },
      { id: 2, windowId: 5, title: 'Pinia Docs', url: 'https://pinia.vuejs.org' }
    ])

    // Mock fetch for AI client call
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ name: 'Vue Development' }) } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const result = await generateWindowName(5)
    expect(result).toEqual({ windowId: 5, name: 'Vue Development' })

    // Verify storage update
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [STORAGE_KEYS.CUSTOM_WINDOW_NAMES]: expect.objectContaining({ 5: 'Vue Development' })
      })
    )

    // Verify broadcast messages
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WINDOW_NAMES_UPDATED',
        payload: expect.objectContaining({ 5: 'Vue Development' })
      })
    )
  })

  it('generateAllWindowsNames generates names for all windows and updates storage', async () => {
    chrome.tabs.query = vi.fn().mockResolvedValue([
      { id: 1, windowId: 10, title: 'TypeScript Handbook', url: 'https://typescriptlang.org' },
      { id: 2, windowId: 20, title: 'Spotify Web Player', url: 'https://open.spotify.com' }
    ])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { windowId: 10, name: 'TypeScript Documentation' },
                  { windowId: 20, name: 'Music & Audio' }
                ])
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const { results } = await generateAllWindowsNames()
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ windowId: 10, name: 'TypeScript Documentation' })
    expect(results[1]).toEqual({ windowId: 20, name: 'Music & Audio' })

    // Verify storage update
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [STORAGE_KEYS.CUSTOM_WINDOW_NAMES]: expect.objectContaining({
          10: 'TypeScript Documentation',
          20: 'Music & Audio'
        })
      })
    )
  })

  it('handleExtensionMessage routes GENERATE_WINDOW_NAME and GENERATE_ALL_WINDOW_NAMES', async () => {
    chrome.windows.getAll = vi.fn().mockResolvedValue([{ id: 1, focused: true }])
    chrome.tabs.query = vi.fn().mockResolvedValue([
      { id: 1, windowId: 1, title: 'GitHub', url: 'https://github.com' }
    ])

    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ name: 'Dev Window' }) } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    ))

    const singleResponse = await handleExtensionMessage({
      action: 'GENERATE_WINDOW_NAME',
      payload: { windowId: 1 }
    }) as any
    expect(singleResponse.ok).toBe(true)
    expect(singleResponse.result).toEqual({ windowId: 1, name: 'Dev Window' })

    const allResponse = await handleExtensionMessage({
      action: 'GENERATE_ALL_WINDOW_NAMES',
      payload: {}
    }) as any
    expect(allResponse.ok).toBe(true)
    expect(allResponse.result.results).toEqual([{ windowId: 1, name: 'Dev Window' }])
  })
})
