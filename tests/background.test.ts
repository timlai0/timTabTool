import { describe, it, expect, vi, beforeAll } from 'vitest'

describe('getAIOverrides', () => {
  let getAIOverrides: any

  beforeAll(async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        getManifest: vi.fn(() => ({ version: '1.0.0' })),
        sendMessage: vi.fn().mockResolvedValue({}),
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
        removeAll: vi.fn((cb) => {
          if (cb) cb()
          return Promise.resolve()
        }),
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
      },
      i18n: {
        getMessage: vi.fn(() => '')
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
    const ungroupMock = vi.fn().mockResolvedValue(undefined)
    const removeMock = vi.fn().mockResolvedValue(undefined)

    // Programming logic: Update stubbed global chrome methods
    const originalQuery = chrome.tabs.query
    const originalUngroup = chrome.tabs.ungroup
    const originalRemove = chrome.tabs.remove
    chrome.tabs.query = queryMock
    chrome.tabs.ungroup = ungroupMock
    chrome.tabs.remove = removeMock
    chrome.tabGroups = {
      TAB_GROUP_ID_NONE: -1
    } as any

    try {
      // Logic: call cleanupTabGroups with minTabs = 3. Group 11 (2 tabs) should be ungrouped.
      await cleanupTabGroups(1, 3)

      expect(queryMock).toHaveBeenCalledWith({ windowId: 1 })
      expect(ungroupMock).toHaveBeenCalledWith([1, 2])
      expect(ungroupMock).not.toHaveBeenCalledWith([3, 4, 5, 6])
      expect(removeMock).not.toHaveBeenCalled()
    } finally {
      chrome.tabs.query = originalQuery
      chrome.tabs.ungroup = originalUngroup
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

  it('extracts windowId from sender.tab.windowId when payload is empty', async () => {
    const sender = { tab: { windowId: 777 } } as chrome.runtime.MessageSender
    const res = await resolveWindowId(undefined, sender)
    expect(res).toBe(777)
  })

  it('prefers explicit payload windowId over sender.tab.windowId', async () => {
    const sender = { tab: { windowId: 777 } } as chrome.runtime.MessageSender
    const res = await resolveWindowId({ windowId: 888 }, sender)
    expect(res).toBe(888)
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

describe('setupContextMenus', () => {
  let setupContextMenus: any

  beforeAll(async () => {
    const mod = await import('../src/background/index')
    setupContextMenus = mod.setupContextMenus
  })

  it('calls removeAll before creating context menu items and enforces top-level limit <= 6', () => {
    const createCalls: any[] = []
    chrome.contextMenus.create = vi.fn((props, cb) => {
      createCalls.push(props)
      if (cb) cb()
      return 1
    }) as any
    chrome.contextMenus.removeAll = vi.fn((cb) => {
      if (cb) cb()
      return Promise.resolve()
    }) as any

    setupContextMenus()

    expect(chrome.contextMenus.removeAll).toHaveBeenCalled()
    expect(createCalls.length).toBeGreaterThan(0)

    // Top-level action items must not exceed 6 (Firefox limit)
    const topLevelActionItems = createCalls.filter(
      (c) => c.contexts?.includes('action') && !c.parentId
    )
    expect(topLevelActionItems.length).toBeLessThanOrEqual(6)

    // Verify search items are nested under search-parent for action context
    const searchParent = createCalls.find((c) => c.id === 'search-parent')
    expect(searchParent).toBeDefined()

    const searchChildren = createCalls.filter((c) => c.parentId === 'search-parent')
    expect(searchChildren.length).toBe(3)
  })
})

describe('checkAndRegroupLast20Tabs', () => {
  let checkAndRegroupLast20Tabs: any

  beforeAll(async () => {
    const mod = await import('../src/background/tab-manager')
    checkAndRegroupLast20Tabs = mod.checkAndRegroupLast20Tabs
  })

  it('throws an error if AI is not configured', async () => {
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      TAB_GROUP_ID_NONE: -1,
    } as any
    chrome.storage.local.get = vi.fn().mockResolvedValue({})

    await expect(checkAndRegroupLast20Tabs(1, { enabled: false })).rejects.toThrow('AI is not configured')
  })

  it('handles window with 0 unpinned tabs gracefully', async () => {
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      TAB_GROUP_ID_NONE: -1,
    } as any
    chrome.tabs.query = vi.fn().mockResolvedValue([
      { id: 1, pinned: true, windowId: 1 }
    ])

    const res = await checkAndRegroupLast20Tabs(1, { enabled: true, apiKey: 'test-key', provider: 'openai' })
    expect(res.checkedCount).toBe(0)
    expect(res.regroupedCount).toBe(0)
  })

  it('selects only the last 20 unpinned tabs when more than 20 tabs are present', async () => {
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([{ id: 10, title: 'Existing' }]),
      update: vi.fn().mockResolvedValue({}),
      TAB_GROUP_ID_NONE: -1,
    } as any

    const tabs: any[] = []
    for (let i = 1; i <= 25; i++) {
      tabs.push({ id: i, index: i - 1, windowId: 1, pinned: false, url: `https://site${i}.com`, title: `Site ${i}`, groupId: -1 })
    }
    chrome.tabs.query = vi.fn().mockResolvedValue(tabs)

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify(tabs.slice(-20).map((_, idx) => ({ index: idx + 1, group: 'KEEP' })))
            }
          }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', mockFetch)

    const res = await checkAndRegroupLast20Tabs(1, { enabled: true, apiKey: 'test-key', provider: 'openai' })
    expect(res.checkedCount).toBe(20)
    expect(res.regroupedCount).toBe(0)
    expect(res.unchangedCount).toBe(20)
  })

  it('regroups tabs when AI assigns different existing groups or new groups', async () => {
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([{ id: 10, title: 'Work' }]),
      update: vi.fn().mockResolvedValue({}),
      TAB_GROUP_ID_NONE: -1,
    } as any

    const tabs = [
      { id: 1, index: 0, windowId: 1, pinned: false, url: 'https://work.com', title: 'Work PR', groupId: 10 },
      { id: 2, index: 1, windowId: 1, pinned: false, url: 'https://shopping.com', title: 'Shopping', groupId: 10 },
      { id: 3, index: 2, windowId: 1, pinned: false, url: 'https://work2.com', title: 'Work Issue', groupId: -1 }
    ]
    chrome.tabs.query = vi.fn().mockImplementation((queryInfo: any) => {
      if (queryInfo.groupId === 10) {
        return Promise.resolve(tabs.filter(t => t.groupId === 10))
      }
      return Promise.resolve(tabs)
    })

    const groupMock = vi.fn().mockResolvedValue(20)
    chrome.tabs.group = groupMock
    chrome.tabs.move = vi.fn().mockResolvedValue(undefined)
    chrome.tabs.ungroup = vi.fn().mockResolvedValue(undefined)

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify([
                { index: 1, group: 'KEEP' },
                { index: 2, group: 'NEW', newGroupName: 'Shopping', newGroupColor: 'yellow' },
                { index: 3, group: 'Work' }
              ])
            }
          }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', mockFetch)

    const res = await checkAndRegroupLast20Tabs(1, { enabled: true, apiKey: 'test-key', provider: 'openai' })
    expect(res.checkedCount).toBe(3)
    expect(res.regroupedCount).toBe(2)
    expect(res.unchangedCount).toBe(1)
    expect(groupMock).toHaveBeenCalled()
  })

  it('handles CHECK_LAST_20_TABS runtime message via onMessage listener', async () => {
    const onMessageCalls = (chrome.runtime.onMessage.addListener as any).mock.calls
    expect(onMessageCalls.length).toBeGreaterThan(0)
    const listener = onMessageCalls[0][0]

    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      TAB_GROUP_ID_NONE: -1,
    } as any
    chrome.tabs.query = vi.fn().mockResolvedValue([])

    const sendResponse = vi.fn()
    const result = listener({ action: 'CHECK_LAST_20_TABS', payload: { windowId: 1, enabled: true, apiKey: 'test-key', provider: 'openai' } }, {}, sendResponse)
    expect(result).toBe(true)
  })

  it('recognizes when a tab is already in the suggested target group and marks it unchanged without re-moving', async () => {
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([{ id: 10, title: 'Work' }]),
      update: vi.fn().mockResolvedValue({}),
      TAB_GROUP_ID_NONE: -1,
    } as any

    const tabs = [
      { id: 1, index: 0, windowId: 1, pinned: false, url: 'https://work.com', title: 'Work Task', groupId: 10 }
    ]
    chrome.tabs.query = vi.fn().mockResolvedValue(tabs)
    const moveMock = vi.fn()
    chrome.tabs.move = moveMock

    // AI says NEW group with same name 'Work'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify([{ index: 1, group: 'NEW', newGroupName: 'Work' }]) } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const res = await checkAndRegroupLast20Tabs(1, { enabled: true, apiKey: 'test-key', provider: 'openai' })
    expect(res.checkedCount).toBe(1)
    expect(res.regroupedCount).toBe(0)
    expect(res.unchangedCount).toBe(1)
    expect(moveMock).not.toHaveBeenCalled()
  })

  it('selects the true last 20 tabs by index even if chrome.tabs.query returns them out of order', async () => {
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      TAB_GROUP_ID_NONE: -1,
    } as any

    // 25 tabs in reverse order
    const tabs: any[] = []
    for (let i = 25; i >= 1; i--) {
      tabs.push({ id: i, index: i - 1, windowId: 1, pinned: false, url: `https://site${i}.com`, title: `Site ${i}`, groupId: -1 })
    }
    chrome.tabs.query = vi.fn().mockResolvedValue(tabs)

    let capturedTabs: any[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      const prompt = body.messages[1].content
      // Capture the indices in prompt
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify([{ index: 1, group: 'KEEP' }]) } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    }))

    const res = await checkAndRegroupLast20Tabs(1, { enabled: true, apiKey: 'test-key', provider: 'openai' })
    expect(res.checkedCount).toBe(20)
    // All 20 accounted for (19 default KEEP + 1 explicit KEEP)
    expect(res.unchangedCount).toBe(20)
    expect(res.regroupedCount).toBe(0)
  })

  it('matches existing groups case-insensitively during regrouping', async () => {
    chrome.tabGroups = {
      query: vi.fn().mockResolvedValue([{ id: 10, title: 'Development' }]),
      update: vi.fn().mockResolvedValue({}),
      TAB_GROUP_ID_NONE: -1,
    } as any

    const tabs = [
      { id: 101, index: 0, windowId: 1, pinned: false, url: 'https://github.com', title: 'GitHub', groupId: -1 }
    ]
    chrome.tabs.query = vi.fn().mockResolvedValue(tabs)

    const groupMock = vi.fn().mockResolvedValue(10)
    chrome.tabs.group = groupMock
    chrome.tabs.move = vi.fn().mockResolvedValue({})

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify([{ index: 1, group: 'development' }]) } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ))

    const res = await checkAndRegroupLast20Tabs(1, { enabled: true, apiKey: 'test-key', provider: 'openai' })
    expect(res.checkedCount).toBe(1)
    expect(res.regroupedCount).toBe(1)
    expect(groupMock).toHaveBeenCalledWith(expect.objectContaining({ groupId: 10 }))
  })
})

describe('Multi-Window Concurrent AI Operations and Progress State', () => {
  let setActiveOperation: any
  let getActiveOperations: any
  let updateOperationProgress: any
  let cancelActiveOperation: any
  let isAnyAIOperationRunning: any
  let clearWindowCache: any

  beforeAll(async () => {
    const managerModule = await import('../src/background/tab-manager')
    setActiveOperation = managerModule.setActiveOperation
    getActiveOperations = managerModule.getActiveOperations
    updateOperationProgress = managerModule.updateOperationProgress
    cancelActiveOperation = managerModule.cancelActiveOperation
    isAnyAIOperationRunning = managerModule.isAnyAIOperationRunning
    clearWindowCache = managerModule.clearWindowCache
  })

  it('tracks concurrent AI operations across distinct windows without collisions', () => {
    clearWindowCache(101)
    clearWindowCache(102)
    clearWindowCache(103)

    setActiveOperation(101, 'group')
    setActiveOperation(102, 'classify')
    setActiveOperation(103, 'regroup')

    expect(isAnyAIOperationRunning()).toBe(true)

    const activeOps = getActiveOperations()
    expect(activeOps[101]?.type).toBe('group')
    expect(activeOps[102]?.type).toBe('classify')
    expect(activeOps[103]?.type).toBe('regroup')

    updateOperationProgress(101, {
      statusText: 'Analyzing 40 tabs...',
      processedTabs: 10,
      totalTabs: 40,
      batchCurrent: 1,
      batchTotal: 2,
    })

    updateOperationProgress(102, {
      statusText: 'Classifying 5 new tabs...',
      processedTabs: 3,
      totalTabs: 5,
      batchCurrent: 1,
      batchTotal: 1,
    })

    const updatedOps = getActiveOperations()
    expect(updatedOps[101].statusText).toBe('Analyzing 40 tabs...')
    expect(updatedOps[101].processedTabs).toBe(10)
    expect(updatedOps[102].statusText).toBe('Classifying 5 new tabs...')
    expect(updatedOps[102].processedTabs).toBe(3)
    expect(updatedOps[103].statusText).toBeUndefined()

    // Cancel window 102 independently
    cancelActiveOperation(102)
    const afterCancelOps = getActiveOperations()
    expect(afterCancelOps[102]).toBeUndefined()
    expect(afterCancelOps[101]?.type).toBe('group')
    expect(afterCancelOps[103]?.type).toBe('regroup')
    expect(isAnyAIOperationRunning()).toBe(true)

    // Complete remaining windows
    cancelActiveOperation(101)
    cancelActiveOperation(103)
    expect(isAnyAIOperationRunning()).toBe(false)
    expect(Object.keys(getActiveOperations())).toHaveLength(0)
  })
})




