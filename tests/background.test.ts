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
      action: {
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setPopup: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
        query: vi.fn(),
        remove: vi.fn(),
        ungroup: vi.fn()
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onRemoved: { addListener: vi.fn() },
        getLastFocused: vi.fn().mockResolvedValue({ id: 999 })
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

  it('extracts openrouter provider from payload', () => {
    const payload = { model: 'deepseek/deepseek-chat', provider: 'openrouter' }
    const result = getAIOverrides(payload)
    expect(result).toEqual({ model: 'deepseek/deepseek-chat', provider: 'openrouter' })
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
    const removeMock = vi.fn().mockResolvedValue(undefined)

    // Programming logic: Update stubbed global chrome methods
    const originalQuery = chrome.tabs.query
    const originalRemove = chrome.tabs.remove
    chrome.tabs.query = queryMock
    chrome.tabs.remove = removeMock
    chrome.tabGroups = {
      TAB_GROUP_ID_NONE: -1
    } as any

    try {
      // Logic: call cleanupTabGroups with minTabs = 3. Group 11 (2 tabs) should be dissolved.
      await cleanupTabGroups(1, 3)

      expect(queryMock).toHaveBeenCalledWith({ windowId: 1 })
      expect(removeMock).toHaveBeenCalledWith([1, 2])
      expect(removeMock).not.toHaveBeenCalledWith([3, 4, 5, 6])
    } finally {
      chrome.tabs.query = originalQuery
      chrome.tabs.remove = originalRemove
    }
  })
})

describe('sortGroupsByName', () => {
  let sortGroupsByName: any

  beforeAll(async () => {
    const managerModule = await import('../src/background/tab-manager')
    sortGroupsByName = managerModule.sortGroupsByName
  })

  it('sorts tab groups alphabetically by name and moves group tabs accordingly', async () => {
    const mockGroups = [
      { id: 101, title: 'Zebra', windowId: 1 },
      { id: 102, title: 'Alpha', windowId: 1 },
      { id: 103, title: 'Beta', windowId: 1 },
    ]

    const mockTabs = [
      { id: 0, pinned: true, groupId: -1, windowId: 1 },
      { id: 1, pinned: false, groupId: 101, windowId: 1 },
      { id: 2, pinned: false, groupId: 101, windowId: 1 },
      { id: 3, pinned: false, groupId: 102, windowId: 1 },
      { id: 4, pinned: false, groupId: 103, windowId: 1 },
    ]

    const tabGroupsQueryMock = vi.fn().mockResolvedValue(mockGroups)
    const tabsQueryMock = vi.fn().mockResolvedValue(mockTabs)
    const tabsMoveMock = vi.fn().mockResolvedValue(undefined)

    const originalTabGroups = chrome.tabGroups
    const originalTabsQuery = chrome.tabs.query
    const originalTabsMove = chrome.tabs.move

    chrome.tabGroups = {
      ...originalTabGroups,
      TAB_GROUP_ID_NONE: -1,
      query: tabGroupsQueryMock,
    } as any
    chrome.tabs.query = tabsQueryMock
    chrome.tabs.move = tabsMoveMock

    try {
      await sortGroupsByName(1)

      expect(tabGroupsQueryMock).toHaveBeenCalledWith({ windowId: 1 })
      expect(tabsQueryMock).toHaveBeenCalledWith({ windowId: 1 })
      
      // Alpha (102, tab [3]) moved first to index 1
      // Beta (103, tab [4]) moved second to index 2
      // Zebra (101, tabs [1, 2]) moved third to index 3
      expect(tabsMoveMock).toHaveBeenNthCalledWith(1, [3], { index: 1 })
      expect(tabsMoveMock).toHaveBeenNthCalledWith(2, [4], { index: 2 })
      expect(tabsMoveMock).toHaveBeenNthCalledWith(3, [1, 2], { index: 3 })
    } finally {
      chrome.tabGroups = originalTabGroups
      chrome.tabs.query = originalTabsQuery
      chrome.tabs.move = originalTabsMove
    }
  })
})

describe('sortGroupsBySize', () => {
  let sortGroupsBySize: any

  beforeAll(async () => {
    const managerModule = await import('../src/background/tab-manager')
    sortGroupsBySize = managerModule.sortGroupsBySize
  })

  it('sorts tab groups by size descending and moves group tabs accordingly', async () => {
    const mockGroups = [
      { id: 101, title: 'Small Group', windowId: 1 },
      { id: 102, title: 'Big Group', windowId: 1 },
    ]

    const mockTabs = [
      { id: 0, pinned: true, groupId: -1, windowId: 1 },
      { id: 1, pinned: false, groupId: 101, windowId: 1 },
      { id: 2, pinned: false, groupId: 102, windowId: 1 },
      { id: 3, pinned: false, groupId: 102, windowId: 1 },
      { id: 4, pinned: false, groupId: 102, windowId: 1 },
    ]

    const tabGroupsQueryMock = vi.fn().mockResolvedValue(mockGroups)
    const tabsQueryMock = vi.fn().mockResolvedValue(mockTabs)
    const tabsMoveMock = vi.fn().mockResolvedValue(undefined)

    const originalTabGroups = chrome.tabGroups
    const originalTabsQuery = chrome.tabs.query
    const originalTabsMove = chrome.tabs.move

    chrome.tabGroups = {
      ...originalTabGroups,
      TAB_GROUP_ID_NONE: -1,
      query: tabGroupsQueryMock,
    } as any
    chrome.tabs.query = tabsQueryMock
    chrome.tabs.move = tabsMoveMock

    try {
      await sortGroupsBySize(1)

      expect(tabGroupsQueryMock).toHaveBeenCalledWith({ windowId: 1 })
      expect(tabsQueryMock).toHaveBeenCalledWith({ windowId: 1 })

      // Big Group (102, tabs [2, 3, 4]) has 3 tabs -> moved first to index 1
      // Small Group (101, tab [1]) has 1 tab -> moved second to index 4
      expect(tabsMoveMock).toHaveBeenNthCalledWith(1, [2, 3, 4], { index: 1 })
      expect(tabsMoveMock).toHaveBeenNthCalledWith(2, [1], { index: 4 })
    } finally {
      chrome.tabGroups = originalTabGroups
      chrome.tabs.query = originalTabsQuery
      chrome.tabs.move = originalTabsMove
    }
  })
})

describe('resolveWindowId', () => {
  let resolveWindowId: any

  beforeAll(async () => {
    const module = await import('../src/background/index')
    resolveWindowId = module.resolveWindowId
  })

  it('extracts number directly from numeric payload', async () => {
    const res = await resolveWindowId(42)
    expect(res).toBe(42)
  })

  it('extracts windowId property from object payload', async () => {
    const res = await resolveWindowId({ windowId: 105 })
    expect(res).toBe(105)
  })

  it('falls back to last focused normal window when payload is missing or invalid', async () => {
    const res = await resolveWindowId(undefined)
    expect(res).toBe(999)
  })
})

describe('closeDuplicateTabs & closePossibleDuplicateTabs', () => {
  let closeDuplicateTabs: any
  let closePossibleDuplicateTabs: any

  beforeAll(async () => {
    const managerModule = await import('../src/background/tab-manager')
    closeDuplicateTabs = managerModule.closeDuplicateTabs
    closePossibleDuplicateTabs = managerModule.closePossibleDuplicateTabs
  })

  it('closes exact duplicates when given a specific windowId', async () => {
    const mockTabs = [
      { id: 1, url: 'https://example.com/page', windowId: 1 },
      { id: 2, url: 'https://example.com/page', windowId: 1 },
      { id: 3, url: 'https://example.com/other', windowId: 1 }
    ]

    const tabsQueryMock = vi.fn().mockResolvedValue(mockTabs)
    const tabsRemoveMock = vi.fn().mockResolvedValue(undefined)

    const originalQuery = chrome.tabs.query
    const originalRemove = chrome.tabs.remove
    chrome.tabs.query = tabsQueryMock
    chrome.tabs.remove = tabsRemoveMock

    try {
      await closeDuplicateTabs(1)
      expect(tabsQueryMock).toHaveBeenCalledWith({ windowId: 1 })
      expect(tabsRemoveMock).toHaveBeenCalledWith([2])
    } finally {
      chrome.tabs.query = originalQuery
      chrome.tabs.remove = originalRemove
    }
  })

  it('closes explicit tab IDs directly without querying', async () => {
    const tabsRemoveMock = vi.fn().mockResolvedValue(undefined)
    const originalRemove = chrome.tabs.remove
    chrome.tabs.remove = tabsRemoveMock

    try {
      await closeDuplicateTabs(undefined, [10, 20])
      expect(tabsRemoveMock).toHaveBeenCalledWith([10, 20])
    } finally {
      chrome.tabs.remove = originalRemove
    }
  })

  it('closes possible duplicates keeping only the first variant tab', async () => {
    const mockTabs = [
      { id: 10, url: 'https://example.com/doc?utm_source=a', windowId: 2 },
      { id: 11, url: 'https://example.com/doc?utm_source=b', windowId: 2 }
    ]

    const tabsQueryMock = vi.fn().mockResolvedValue(mockTabs)
    const tabsRemoveMock = vi.fn().mockResolvedValue(undefined)

    const originalQuery = chrome.tabs.query
    const originalRemove = chrome.tabs.remove
    chrome.tabs.query = tabsQueryMock
    chrome.tabs.remove = tabsRemoveMock

    try {
      await closePossibleDuplicateTabs(2)
      expect(tabsQueryMock).toHaveBeenCalledWith({ windowId: 2 })
      expect(tabsRemoveMock).toHaveBeenCalledWith([11])
    } finally {
      chrome.tabs.query = originalQuery
      chrome.tabs.remove = originalRemove
    }
  })
})

describe('Action Badge Lifecycle and AI Operation Status', () => {
  let updateNewTabsBadge: any
  let setAIBadge: any
  let isAnyAIOperationRunning: any
  let clearWindowCache: any
  let cancelActiveOperation: any

  beforeAll(async () => {
    const managerModule = await import('../src/background/tab-manager')
    updateNewTabsBadge = managerModule.updateNewTabsBadge
    setAIBadge = managerModule.setAIBadge
    isAnyAIOperationRunning = managerModule.isAnyAIOperationRunning
    clearWindowCache = managerModule.clearWindowCache
    cancelActiveOperation = managerModule.cancelActiveOperation
  })

  it('sets badge to "AI" with purple background when setAIBadge is called', async () => {
    const setBadgeTextMock = vi.fn().mockResolvedValue(undefined)
    const setBadgeBackgroundColorMock = vi.fn().mockResolvedValue(undefined)
    chrome.action = {
      setBadgeText: setBadgeTextMock,
      setBadgeBackgroundColor: setBadgeBackgroundColorMock,
      setPopup: vi.fn(),
    } as any

    await setAIBadge(1)
    expect(isAnyAIOperationRunning()).toBe(true)
    expect(setBadgeTextMock).toHaveBeenCalledWith({ text: 'AI' })
    expect(setBadgeBackgroundColorMock).toHaveBeenCalledWith({ color: '#8B5CF6' })
  })

  it('reconciles and clears AI badge when no operations are running and no duplicates exist', async () => {
    clearWindowCache(1)
    expect(isAnyAIOperationRunning()).toBe(false)

    const setBadgeTextMock = vi.fn().mockResolvedValue(undefined)
    const setBadgeBackgroundColorMock = vi.fn().mockResolvedValue(undefined)
    const tabsQueryMock = vi.fn().mockResolvedValue([
      { id: 1, url: 'https://example.com/1', windowId: 1 },
      { id: 2, url: 'https://example.com/2', windowId: 1 },
    ])

    chrome.action = {
      setBadgeText: setBadgeTextMock,
      setBadgeBackgroundColor: setBadgeBackgroundColorMock,
      setPopup: vi.fn(),
    } as any
    chrome.tabs.query = tabsQueryMock

    await updateNewTabsBadge(1)
    expect(setBadgeTextMock).toHaveBeenCalledWith({ text: '' })
  })

  it('shows duplicate count in badge when duplicates exist and no AI operations are running', async () => {
    clearWindowCache(1)
    const setBadgeTextMock = vi.fn().mockResolvedValue(undefined)
    const setBadgeBackgroundColorMock = vi.fn().mockResolvedValue(undefined)
    const tabsQueryMock = vi.fn().mockResolvedValue([
      { id: 1, url: 'https://example.com/dup', windowId: 1 },
      { id: 2, url: 'https://example.com/dup', windowId: 1 },
      { id: 3, url: 'https://example.com/dup', windowId: 1 },
      { id: 4, url: 'https://example.com/unique', windowId: 1 },
    ])

    chrome.action = {
      setBadgeText: setBadgeTextMock,
      setBadgeBackgroundColor: setBadgeBackgroundColorMock,
      setPopup: vi.fn(),
    } as any
    chrome.tabs.query = tabsQueryMock

    await updateNewTabsBadge(1)
    expect(setBadgeTextMock).toHaveBeenCalledWith({ text: '2' })
    expect(setBadgeBackgroundColorMock).toHaveBeenCalledWith({ color: 'red' })
  })

  it('immediately cleans up active AI operation on cancelActiveOperation', async () => {
    await setAIBadge(2)
    expect(isAnyAIOperationRunning()).toBe(true)

    const setBadgeTextMock = vi.fn().mockResolvedValue(undefined)
    chrome.action = {
      setBadgeText: setBadgeTextMock,
      setBadgeBackgroundColor: vi.fn(),
      setPopup: vi.fn(),
    } as any
    chrome.tabs.query = vi.fn().mockResolvedValue([])

    cancelActiveOperation(2)
    expect(isAnyAIOperationRunning()).toBe(false)
  })

  it('immediately cleans up active AI operation on clearWindowCache', async () => {
    await setAIBadge(3)
    expect(isAnyAIOperationRunning()).toBe(true)

    const setBadgeTextMock = vi.fn().mockResolvedValue(undefined)
    chrome.action = {
      setBadgeText: setBadgeTextMock,
      setBadgeBackgroundColor: vi.fn(),
      setPopup: vi.fn(),
    } as any
    chrome.tabs.query = vi.fn().mockResolvedValue([])

    clearWindowCache(3)
    expect(isAnyAIOperationRunning()).toBe(false)
  })
})

describe('mergeAllWindows', () => {
  let mergeAllWindows: any

  beforeAll(async () => {
    const mod = await import('../src/background/tab-manager')
    mergeAllWindows = mod.mergeAllWindows
  })

  it('moves all tabs from other windows into the target window', async () => {
    chrome.windows = {
      getAll: vi.fn().mockResolvedValue([
        { id: 1, type: 'normal' },
        { id: 2, type: 'normal' },
        { id: 3, type: 'normal' },
      ]),
    } as any

    const tabsMoveMock = vi.fn().mockResolvedValue(undefined)
    chrome.tabs.move = tabsMoveMock
    chrome.tabs.query = vi.fn().mockImplementation(async (queryInfo: { windowId: number }) => {
      if (queryInfo.windowId === 2) {
        return [{ id: 201 }, { id: 202 }]
      }
      if (queryInfo.windowId === 3) {
        return [{ id: 301 }]
      }
      return []
    })

    await mergeAllWindows(1)

    expect(tabsMoveMock).toHaveBeenCalledWith([201, 202], { windowId: 1, index: -1 })
    expect(tabsMoveMock).toHaveBeenCalledWith([301], { windowId: 1, index: -1 })
  })
})


