'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildKnownUnclosedTabs,
  formatExportAsMarkdown,
  formatExportAsJson,
  formatExportAsPlainText,
  formatExportAsHtmlBookmarks,
  formatKnownUnclosedTabs,
} from '../src/shared/tab-exporter'
import { handleExtensionMessage } from '../src/background/message-router'
import { STORAGE_KEYS } from '../src/shared/constants'
import { recordTabVisit, markTabClosedInHistory, flushTabHistory, clearHistoryCache } from '../src/background/storage'
import {
  trackLiveTab,
  handleTabRemovalForMassClose,
  markTabIdsClosedByExtension,
  clearLiveTabs,
} from '../src/background/tabs/live-tab-tracker'

describe('TabExporter', () => {
  const sampleOpenTabs = [
    {
      id: 1,
      url: 'https://github.com/org/repo',
      title: 'GitHub Repo',
      windowId: 10,
      windowName: 'Work Window',
      groupId: 100,
      groupTitle: 'Dev',
      pinned: false,
      lastAccessed: 2000,
    },
    {
      id: 2,
      url: 'https://mail.google.com',
      title: 'Gmail',
      windowId: 10,
      windowName: 'Work Window',
      pinned: true,
      lastAccessed: 1900,
    },
    {
      id: 3,
      url: 'chrome://extensions',
      title: 'Extensions',
      windowId: 10,
    },
  ]

  const sampleHistoryEntries = [
    {
      url: 'https://github.com/org/repo',
      title: 'GitHub Repo',
      lastAccessed: 2000,
      visitCount: 5,
      closed: false,
    },
    {
      url: 'https://docs.rs/tokio',
      title: 'Tokio Docs',
      lastAccessed: 1800,
      visitCount: 2,
      closed: false,
    },
    {
      url: 'https://news.ycombinator.com',
      title: 'Hacker News',
      lastAccessed: 1700,
      visitCount: 3,
      closed: true,
    },
    {
      url: 'https://reddit.com/r/rust',
      title: 'Rust Subreddit',
      lastAccessed: 1600,
      visitCount: 1,
      closed: false,
    },
  ]

  describe('buildKnownUnclosedTabs', () => {
    it('returns both open tabs and non-closed history tabs for all_unclosed scope', () => {
      const items = buildKnownUnclosedTabs({
        openTabs: sampleOpenTabs,
        historyEntries: sampleHistoryEntries,
        explicitlyClosedUrls: ['https://reddit.com/r/rust'],
        scope: 'all_unclosed',
      })

      expect(items).toHaveLength(3)
      expect(items.filter((i) => i.status === 'open')).toHaveLength(2)
      expect(items.filter((i) => i.status === 'unrestored')).toHaveLength(1)
      expect(items[2].url).toBe('https://docs.rs/tokio')
    })

    it('returns only open restorable tabs for open_only scope', () => {
      const items = buildKnownUnclosedTabs({
        openTabs: sampleOpenTabs,
        historyEntries: sampleHistoryEntries,
        explicitlyClosedUrls: [],
        scope: 'open_only',
      })

      expect(items).toHaveLength(2)
      expect(items.every((i) => i.status === 'open')).toBe(true)
      expect(items.map((i) => i.url)).toEqual([
        'https://github.com/org/repo',
        'https://mail.google.com',
      ])
    })

    it('returns only unrestored non-closed tabs for missing_only scope', () => {
      const items = buildKnownUnclosedTabs({
        openTabs: sampleOpenTabs,
        historyEntries: sampleHistoryEntries,
        explicitlyClosedUrls: ['https://reddit.com/r/rust'],
        scope: 'missing_only',
      })

      expect(items).toHaveLength(1)
      expect(items[0].status).toBe('unrestored')
      expect(items[0].url).toBe('https://docs.rs/tokio')
    })

    it('deduplicates normalized URLs between open tabs and history', () => {
      const items = buildKnownUnclosedTabs({
        openTabs: [
          {
            id: 1,
            url: 'https://example.com/page?utm_source=newsletter',
            title: 'Example Page',
          },
        ],
        historyEntries: [
          {
            url: 'https://example.com/page',
            title: 'Example Page Old',
            lastAccessed: 1000,
            closed: false,
          },
        ],
        explicitlyClosedUrls: [],
        scope: 'all_unclosed',
      })

      expect(items).toHaveLength(1)
      expect(items[0].status).toBe('open')
    })
  })

  describe('Export Formatters', () => {
    const items = buildKnownUnclosedTabs({
      openTabs: sampleOpenTabs,
      historyEntries: sampleHistoryEntries,
      explicitlyClosedUrls: ['https://reddit.com/r/rust'],
      scope: 'all_unclosed',
    })
    const fixedTime = 1760000000000

    it('formats as Markdown grouped by window, group, and unrestored section', () => {
      const md = formatExportAsMarkdown(items, 'all_unclosed', fixedTime)
      expect(md).toContain('# Known Unclosed Tabs Export')
      expect(md).toContain('## Currently Open Tabs (2)')
      expect(md).toContain('### Work Window')
      expect(md).toContain('#### Dev (1)')
      expect(md).toContain('- [GitHub Repo](https://github.com/org/repo)')
      expect(md).toContain('#### Pinned (1)')
      expect(md).toContain('- [Gmail](https://mail.google.com)')
      expect(md).toContain('## Unrestored / Known Unclosed History Tabs (1)')
      expect(md).toContain('- [Tokio Docs](https://docs.rs/tokio)')
    })

    it('formats as JSON with counts and metadata', () => {
      const jsonStr = formatExportAsJson(items, 'all_unclosed', fixedTime)
      const parsed = JSON.parse(jsonStr)
      expect(parsed.scope).toBe('all_unclosed')
      expect(parsed.counts).toEqual({ total: 3, open: 2, unrestored: 1 })
      expect(parsed.tabs).toHaveLength(3)
    })

    it('formats as Plain Text URL list', () => {
      const txt = formatExportAsPlainText(items)
      expect(txt.trim().split('\n')).toEqual([
        'https://github.com/org/repo',
        'https://mail.google.com',
        'https://docs.rs/tokio',
      ])
    })

    it('formats as Netscape HTML bookmarks', () => {
      const html = formatExportAsHtmlBookmarks(items, 'all_unclosed', fixedTime)
      expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
      expect(html).toContain('<H3 ADD_DATE="1760000000">Work Window</H3>')
      expect(html).toContain('HREF="https://github.com/org/repo"')
      expect(html).toContain('HREF="https://docs.rs/tokio"')
    })

    it('dispatches via formatKnownUnclosedTabs', () => {
      expect(formatKnownUnclosedTabs(items, 'txt', 'all_unclosed', fixedTime)).toContain('https://docs.rs/tokio')
      expect(formatKnownUnclosedTabs(items, 'json', 'all_unclosed', fixedTime)).toContain('"unrestored": 1')
    })
  })

  describe('History Closure Tracking & EXPORT_KNOWN_TABS Message', () => {
    let storageStore: Record<string, any> = {}

    beforeEach(() => {
      storageStore = {}
      clearLiveTabs()
      clearHistoryCache()

      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn().mockResolvedValue({}),
          lastError: null,
        },
        storage: {
          local: {
            get: vi.fn((key: string) => Promise.resolve({ [key]: storageStore[key] })),
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
          query: vi.fn().mockResolvedValue([{ id: 50, title: 'Research', color: 'blue', windowId: 1 }]),
        },
        tabs: {
          query: vi.fn().mockResolvedValue([
            {
              id: 11,
              url: 'https://open-tab.org',
              title: 'Open Tab',
              windowId: 1,
              groupId: 50,
              pinned: false,
            },
          ]),
        },
      })
    })

    it('marks closed=true in tabHistory when a tab is closed normally, but keeps closed=false when window closes', async () => {
      await recordTabVisit('https://explicit-close.com', 'Explicit Close', undefined, true)
      await recordTabVisit('https://window-crash.com', 'Window Crash', undefined, true)

      trackLiveTab({ id: 21, url: 'https://explicit-close.com', title: 'Explicit Close', windowId: 1 } as chrome.tabs.Tab)
      trackLiveTab({ id: 22, url: 'https://window-crash.com', title: 'Window Crash', windowId: 1 } as chrome.tabs.Tab)

      handleTabRemovalForMassClose(21, { windowId: 1, isWindowClosing: false })
      handleTabRemovalForMassClose(22, { windowId: 1, isWindowClosing: true })

      await flushTabHistory()

      const res = (await handleExtensionMessage({
        action: 'EXPORT_KNOWN_TABS',
        payload: { scope: 'missing_only', format: 'json' },
      })) as any

      expect(res.ok).toBe(true)
      expect(res.counts.unrestored).toBe(1)
      expect(res.items[0].url).toBe('https://window-crash.com')
    })

    it('marks closed=true when closed by extension action', async () => {
      await recordTabVisit('https://ext-closed.com', 'Ext Closed', undefined, true)
      trackLiveTab({ id: 31, url: 'https://ext-closed.com', title: 'Ext Closed', windowId: 1 } as chrome.tabs.Tab)
      markTabIdsClosedByExtension([31])
      handleTabRemovalForMassClose(31, { windowId: 1, isWindowClosing: false })
      await markTabClosedInHistory(['https://ext-closed.com'], true)

      const res = (await handleExtensionMessage({
        action: 'EXPORT_KNOWN_TABS',
        payload: { scope: 'all_unclosed', format: 'markdown' },
      })) as any

      expect(res.ok).toBe(true)
      expect(res.counts.open).toBe(1)
      expect(res.counts.unrestored).toBe(0)
      expect(res.content).toContain('https://open-tab.org')
      expect(res.content).not.toContain('https://ext-closed.com')
    })
  })
})
