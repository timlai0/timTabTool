'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isRestorableUrl,
  recordClosedTabs,
  recordTabIdsBeforeClose,
  getClosedTabs,
  restoreClosedTab,
  restoreAllClosedTabs,
  removeClosedTab,
  clearClosedTabs,
  restoreClosedBatch,
  removeClosedBatch,
  MAX_CLOSED_TABS,
} from '../src/shared/closed-tabs-manager'
import {
  initLiveTabTracker,
  trackLiveTab,
  untrackLiveTab,
  markTabIdsClosedByExtension,
  isTabClosedByExtension,
  handleTabRemovalForMassClose,
  flushPendingClosedTabs,
  clearLiveTabs,
  getLiveTabCount,
} from '../src/background/tab-manager'
import { STORAGE_KEYS } from '../src/shared/constants'

describe('ClosedTabsManager', () => {
  let storageStore: Record<string, any> = {}

  beforeEach(() => {
    storageStore = {}
    clearLiveTabs()

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({}),
        lastError: null,
      },
      storage: {
        local: {
          get: vi.fn((key: string) => {
            return Promise.resolve({ [key]: storageStore[key] })
          }),
          set: vi.fn((items: Record<string, any>) => {
            Object.assign(storageStore, items)
            return Promise.resolve()
          }),
          remove: vi.fn((key: string) => {
            delete storageStore[key]
            return Promise.resolve()
          }),
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        getAll: vi.fn().mockResolvedValue([]),
        getLastFocused: vi.fn().mockResolvedValue({ id: 1 }),
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
      },
      tabs: {
        query: vi.fn<(queryInfo?: any) => Promise<any>>().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
        get: vi.fn((tabId: number) => {
          if (tabId === 101) {
            return Promise.resolve({
              id: 101,
              url: 'https://github.com',
              title: 'GitHub',
              favIconUrl: 'https://github.com/favicon.ico',
              windowId: 1,
            })
          }
          if (tabId === 102) {
            return Promise.resolve({
              id: 102,
              url: 'chrome://settings',
              title: 'Settings',
              windowId: 1,
            })
          }
          return Promise.reject(new Error('Tab not found'))
        }),
        create: vi.fn((props: { url: string; windowId?: number }) => {
          return Promise.resolve({ id: 999, ...props })
        }),
      },
    })
  })

  describe('isRestorableUrl', () => {
    it('returns true for standard web URLs', () => {
      expect(isRestorableUrl('https://example.com')).toBe(true)
      expect(isRestorableUrl('http://localhost:3000')).toBe(true)
    })

    it('returns false for internal or blank URLs', () => {
      expect(isRestorableUrl('chrome://extensions')).toBe(false)
      expect(isRestorableUrl('chrome-extension://xyz/popup.html')).toBe(false)
      expect(isRestorableUrl('moz-extension://xyz/popup.html')).toBe(false)
      expect(isRestorableUrl('edge://settings')).toBe(false)
      expect(isRestorableUrl('about:blank')).toBe(false)
      expect(isRestorableUrl('')).toBe(false)
      expect(isRestorableUrl(undefined)).toBe(false)
    })
  })

  describe('recordClosedTabs', () => {
    it('records valid tabs and ignores internal tabs', async () => {
      await recordClosedTabs(
        [
          { url: 'https://example.com/1', title: 'Example 1' },
          { url: 'chrome://bookmarks', title: 'Bookmarks' },
          { url: 'https://example.com/2', title: 'Example 2' },
        ],
        'Duplicates'
      )

      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toHaveLength(2)
      expect(stored[0].url).toBe('https://example.com/1')
      expect(stored[0].source).toBe('Duplicates')
      expect(stored[1].url).toBe('https://example.com/2')
      expect(stored[0].id).toBeDefined()
      expect(stored[0].closedAt).toBeTypeOf('number')
    })

    it('caps stored entries at MAX_CLOSED_TABS', async () => {
      const initial = Array.from({ length: 195 }, (_, i) => ({
        id: `ct_old_${i}`,
        url: `https://example.com/old-${i}`,
        title: `Old ${i}`,
        closedAt: 1000 + i,
        source: 'Old',
      }))
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = initial

      const newTabs = Array.from({ length: 15 }, (_, i) => ({
        url: `https://example.com/new-${i}`,
        title: `New ${i}`,
      }))

      await recordClosedTabs(newTabs, 'New')
      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toHaveLength(MAX_CLOSED_TABS)
      expect(stored[0].url).toBe('https://example.com/new-0')
    })

    it('deduplicates tabs with identical URLs in the same batch', async () => {
      await recordClosedTabs(
        [
          { url: 'https://example.com/dupe', title: 'Dupe 1' },
          { url: 'https://example.com/dupe', title: 'Dupe 2' },
          { url: 'https://example.com/unique', title: 'Unique' },
        ],
        'Duplicates'
      )

      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toHaveLength(2)
      expect(stored.map((e: any) => e.url)).toEqual(['https://example.com/dupe', 'https://example.com/unique'])
    })

    it('replaces older duplicate URLs and preserves newer metadata', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: 'old-1', url: 'https://example.com/page', title: 'Old Page', closedAt: 100, source: 'Old' },
        { id: 'old-2', url: 'https://example.com/other', title: 'Other', closedAt: 100, source: 'Old' },
      ]

      await recordClosedTabs(
        [{ url: 'https://example.com/page', title: 'New Page' }],
        'New Source'
      )

      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toHaveLength(2)
      expect(stored[0].url).toBe('https://example.com/page')
      expect(stored[0].source).toBe('New Source')
      expect(stored[1].url).toBe('https://example.com/other')
    })
  })

  describe('getClosedTabs', () => {
    it('returns unique tabs even if raw storage contains duplicate URLs', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: '1', url: 'https://example.com/dup', title: 'Dup First', closedAt: 200, source: 'Mass Close' },
        { id: '2', url: 'https://example.com/other', title: 'Other', closedAt: 150, source: 'Single' },
        { id: '3', url: 'https://example.com/dup', title: 'Dup Second', closedAt: 100, source: 'Duplicates' },
      ]

      const tabs = await getClosedTabs()
      expect(tabs).toHaveLength(2)
      expect(tabs[0].id).toBe('1')
      expect(tabs[1].id).toBe('2')
    })
  })

  describe('recordTabIdsBeforeClose', () => {
    it('queries tabs by ID and records valid ones', async () => {
      await recordTabIdsBeforeClose([101, 102, 999], 'Test Close')

      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toHaveLength(1)
      expect(stored[0].url).toBe('https://github.com')
      expect(stored[0].title).toBe('GitHub')
      expect(stored[0].source).toBe('Test Close')
    })
  })

  describe('restoreClosedTab', () => {
    it('reopens tab and removes it from storage', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: 'tab-1', url: 'https://vuejs.org', title: 'Vue.js', closedAt: 1000, source: 'Test' },
        { id: 'tab-2', url: 'https://vitejs.dev', title: 'Vite', closedAt: 2000, source: 'Test' },
      ]

      const restored = await restoreClosedTab('tab-1', 5)
      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://vuejs.org', windowId: 5 })
      expect(restored).toBeDefined()

      const remaining = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('tab-2')
    })

    it('returns null if entry is not found', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = []
      const res = await restoreClosedTab('non-existent')
      expect(res).toBeNull()
      expect(chrome.tabs.create).not.toHaveBeenCalled()
    })
  })

  describe('restoreAllClosedTabs', () => {
    it('restores all tabs and empties storage', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: 'tab-1', url: 'https://vuejs.org', title: 'Vue.js', closedAt: 1000, source: 'Test' },
        { id: 'tab-2', url: 'https://vitejs.dev', title: 'Vite', closedAt: 2000, source: 'Test' },
      ]

      const count = await restoreAllClosedTabs()
      expect(count).toBe(2)
      expect(chrome.tabs.create).toHaveBeenCalledTimes(2)
      expect(storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]).toBeUndefined()
    })
  })

  describe('removeClosedTab and clearClosedTabs', () => {
    it('removes a specific entry without restoring', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: 'tab-1', url: 'https://vuejs.org', title: 'Vue.js', closedAt: 1000, source: 'Test' },
        { id: 'tab-2', url: 'https://vitejs.dev', title: 'Vite', closedAt: 2000, source: 'Test' },
      ]

      await removeClosedTab('tab-1')
      const remaining = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('tab-2')
      expect(chrome.tabs.create).not.toHaveBeenCalled()
    })

    it('clears all closed tabs', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: 'tab-1', url: 'https://vuejs.org', title: 'Vue.js', closedAt: 1000, source: 'Test' },
      ]

      await clearClosedTabs()
      expect(storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]).toBeUndefined()
    })
  })

  describe('restoreClosedBatch and removeClosedBatch', () => {
    it('restores only tabs belonging to the specified batch in chronological order', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: 'tab-1', batchId: 'batch-A', url: 'https://vuejs.org', title: 'Vue.js', closedAt: 1000, source: 'Mass Close' },
        { id: 'tab-2', batchId: 'batch-B', url: 'https://other.org', title: 'Other', closedAt: 1500, source: 'Duplicates' },
        { id: 'tab-3', batchId: 'batch-A', url: 'https://vitejs.dev', title: 'Vite', closedAt: 1100, source: 'Mass Close' },
      ]

      const count = await restoreClosedBatch('batch-A', 2)
      expect(count).toBe(2)
      expect(chrome.tabs.create).toHaveBeenCalledTimes(2)
      expect(chrome.tabs.create).toHaveBeenNthCalledWith(1, { url: 'https://vitejs.dev', windowId: 2 })
      expect(chrome.tabs.create).toHaveBeenNthCalledWith(2, { url: 'https://vuejs.org', windowId: 2 })

      const remaining = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('tab-2')
    })

    it('returns 0 if batchId is missing or matches no entries', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: 'tab-1', batchId: 'batch-A', url: 'https://vuejs.org', title: 'Vue.js', closedAt: 1000, source: 'Test' },
      ]

      const countEmpty = await restoreClosedBatch('')
      const countNonExistent = await restoreClosedBatch('batch-Z')
      expect(countEmpty).toBe(0)
      expect(countNonExistent).toBe(0)
      expect(chrome.tabs.create).not.toHaveBeenCalled()
    })

    it('removes only tabs matching batchId without reopening', async () => {
      storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] = [
        { id: 'tab-1', batchId: 'batch-A', url: 'https://vuejs.org', title: 'Vue.js', closedAt: 1000, source: 'Test' },
        { id: 'tab-2', batchId: 'batch-B', url: 'https://vitejs.dev', title: 'Vite', closedAt: 2000, source: 'Test' },
      ]

      await removeClosedBatch('batch-A')
      const remaining = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('tab-2')
      expect(chrome.tabs.create).not.toHaveBeenCalled()
    })
  })

  describe('LiveTabTracker and Mass Close Detection', () => {
    it('initializes live tab tracker from chrome.tabs.query', async () => {
      ;(chrome.tabs.query as any).mockResolvedValueOnce([
        { id: 1, url: 'https://site1.com', title: 'Site 1', windowId: 10 } as chrome.tabs.Tab,
        { id: 2, url: 'https://site2.com', title: 'Site 2', windowId: 10 } as chrome.tabs.Tab,
      ])

      await initLiveTabTracker()
      expect(getLiveTabCount()).toBe(2)
    })

    it('marks and consumes extension closed tabs to bypass mass close recording', () => {
      markTabIdsClosedByExtension([10, 20])
      expect(isTabClosedByExtension(10)).toBe(true)
      expect(isTabClosedByExtension(10)).toBe(false)
      expect(isTabClosedByExtension(20)).toBe(true)
      expect(isTabClosedByExtension(30)).toBe(false)
    })

    it('records a mass close batch when 2 or more tabs are closed in a burst', async () => {
      trackLiveTab({ id: 1, url: 'https://tab1.com', title: 'Tab 1', windowId: 5 } as chrome.tabs.Tab)
      trackLiveTab({ id: 2, url: 'https://tab2.com', title: 'Tab 2', windowId: 5 } as chrome.tabs.Tab)

      handleTabRemovalForMassClose(1, { windowId: 5, isWindowClosing: false })
      handleTabRemovalForMassClose(2, { windowId: 5, isWindowClosing: false })

      await flushPendingClosedTabs()

      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toBeDefined()
      expect(stored).toHaveLength(2)
      expect(stored[0].source).toBe('Mass Close (2 tabs)')
      expect(stored[0].batchId).toBeDefined()
      expect(stored[1].batchId).toBe(stored[0].batchId)
    })

    it('records closed window batch when isWindowClosing is true', async () => {
      trackLiveTab({ id: 3, url: 'https://tab3.com', title: 'Tab 3', windowId: 8 } as chrome.tabs.Tab)
      trackLiveTab({ id: 4, url: 'https://tab4.com', title: 'Tab 4', windowId: 8 } as chrome.tabs.Tab)

      handleTabRemovalForMassClose(3, { windowId: 8, isWindowClosing: true })
      handleTabRemovalForMassClose(4, { windowId: 8, isWindowClosing: true })

      await flushPendingClosedTabs()

      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toBeDefined()
      expect(stored).toHaveLength(2)
      expect(stored[0].source).toBe('Closed Window (2 tabs)')
      expect(stored[0].batchId).toBeDefined()
    })

    it('ignores single tab closures when window is not closing', async () => {
      trackLiveTab({ id: 5, url: 'https://tab5.com', title: 'Tab 5', windowId: 9 } as chrome.tabs.Tab)

      handleTabRemovalForMassClose(5, { windowId: 9, isWindowClosing: false })

      await flushPendingClosedTabs()

      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toBeUndefined()
    })

    it('ignores closures initiated by extension actions', async () => {
      trackLiveTab({ id: 6, url: 'https://tab6.com', title: 'Tab 6', windowId: 9 } as chrome.tabs.Tab)
      trackLiveTab({ id: 7, url: 'https://tab7.com', title: 'Tab 7', windowId: 9 } as chrome.tabs.Tab)

      markTabIdsClosedByExtension([6, 7])

      handleTabRemovalForMassClose(6, { windowId: 9, isWindowClosing: false })
      handleTabRemovalForMassClose(7, { windowId: 9, isWindowClosing: false })

      await flushPendingClosedTabs()

      const stored = storageStore[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
      expect(stored).toBeUndefined()
    })
  })
})
