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
    const payload = { model: 'gemini-3.5-flash', provider: 'gemini', sendFullUrl: true, sendRandomOrder: true }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ model: 'gemini-3.5-flash', provider: 'gemini', sendFullUrl: true, sendRandomOrder: true })
  })

  it('extracts sendRandomOrder even when set to false', () => {
    const payload = { sendRandomOrder: false }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ sendRandomOrder: false })
  })

  it('ignores literal "-full" as a model name (prevents search overlay bug)', () => {
    const payload = { model: '-full', provider: 'custom', sendFullUrl: true }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ provider: 'custom', sendFullUrl: true })
    expect(result?.model).toBeUndefined()
  })
})

describe('cleanupTabGroups', () => {
  let cleanupTabGroups: any

  beforeAll(async () => {
    const managerModule = await import('../src/background/tab-manager')
    cleanupTabGroups = managerModule.cleanupTabGroups
  })

  it('ungroups tab groups with fewer than minTabs tabs', async () => {
    // Programming logic: Setup mock tabs in different groups
    // Group 11 has 2 tabs, Group 12 has 4 tabs, group -1 is ungrouped
    const mockTabs = [
      { id: 1, groupId: 11, windowId: 1 },
      { id: 2, groupId: 11, windowId: 1 },
      { id: 3, groupId: 12, windowId: 1 },
      { id: 4, groupId: 12, windowId: 1 },
      { id: 5, groupId: 12, windowId: 1 },
      { id: 6, groupId: 12, windowId: 1 },
      { id: 7, groupId: -1, windowId: 1 },
    ]

    const queryMock = vi.fn().mockResolvedValue(mockTabs)
    const ungroupMock = vi.fn().mockResolvedValue(undefined)

    // Programming logic: Update stubbed global chrome methods
    const originalQuery = chrome.tabs.query
    const originalUngroup = (chrome.tabs as any).ungroup
    chrome.tabs.query = queryMock
    ;(chrome.tabs as any).ungroup = ungroupMock
    chrome.tabGroups = {
      TAB_GROUP_ID_NONE: -1
    } as any

    try {
      // Logik: cleanupTabGroups mit minTabs = 3 aufrufen. Gruppe 11 (2 Tabs) sollte aufgelöst werden.
      await cleanupTabGroups(1, 3)

      expect(queryMock).toHaveBeenCalledWith({ windowId: 1 })
      expect(ungroupMock).toHaveBeenCalledWith([1, 2])
      expect(ungroupMock).not.toHaveBeenCalledWith([3, 4, 5, 6])
    } finally {
      chrome.tabs.query = originalQuery
      ;(chrome.tabs as any).ungroup = originalUngroup
    }
  })
})
