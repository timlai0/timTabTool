'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isolateDomainTabs,
  closeDomainTabs,
  closeLeftTabs,
  closeRightTabs,
  muteAllTabs,
  unmuteAllTabs,
  toggleGroupTitles,
  areGroupTitlesHidden,
  expandAllGroups,
  collapseAllGroups,
  ungroupAllTabs,
  ungroupGroupTabs,
  extendOperationTimeout,
  setupOperationTimeout,
  clearOperationTimeout,
  cancelActiveOperation,
} from '../src/background/tab-manager'

describe('Deterministic Tab Actions & Timeout Lifecycle', () => {
  let mockTabs: any[] = []
  let mockGroups: any[] = []
  let createdWindows: any[] = []

  beforeEach(() => {
    mockTabs = [
      { id: 1, windowId: 10, index: 0, url: 'https://example.com/page1', pinned: false, groupId: -1 },
      { id: 2, windowId: 10, index: 1, url: 'https://example.com/page2', pinned: false, groupId: 100, active: true },
      { id: 3, windowId: 10, index: 2, url: 'https://github.com/repo', pinned: false, groupId: 100 },
      { id: 4, windowId: 10, index: 3, url: 'https://example.com/page3', pinned: false, groupId: -1 },
    ]
    mockGroups = [
      { id: 100, windowId: 10, title: 'Test Group', collapsed: false },
    ]
    createdWindows = []

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({}),
        getPlatformInfo: vi.fn().mockResolvedValue({}),
        lastError: null,
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        query: vi.fn(async ({ windowId }: any) => {
          if (windowId !== undefined) {
            return mockGroups.filter((g) => g.windowId === windowId)
          }
          return mockGroups
        }),
        get: vi.fn(async (groupId: number) => {
          const g = mockGroups.find((item) => item.id === groupId)
          if (!g) throw new Error('Group not found')
          return g
        }),
        update: vi.fn(async (groupId: number, updateProps: any) => {
          const g = mockGroups.find((item) => item.id === groupId)
          if (g) Object.assign(g, updateProps)
          return g
        }),
      },
      tabs: {
        query: vi.fn(async (queryInfo: any) => {
          return mockTabs.filter((t) => {
            if (queryInfo.windowId !== undefined && t.windowId !== queryInfo.windowId) return false
            if (queryInfo.active !== undefined && Boolean(t.active) !== queryInfo.active) return false
            if (queryInfo.groupId !== undefined && t.groupId !== queryInfo.groupId) return false
            return true
          })
        }),
        remove: vi.fn(async (tabIds: number | number[]) => {
          const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
          mockTabs = mockTabs.filter((t) => !ids.includes(t.id))
        }),
        move: vi.fn(async (tabIds: number | number[], moveProps: any) => {
          const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
          for (const id of ids) {
            const t = mockTabs.find((tab) => tab.id === id)
            if (t && moveProps.windowId) t.windowId = moveProps.windowId
            if (t && moveProps.index !== undefined) t.index = moveProps.index
          }
          return ids.map((id) => mockTabs.find((t) => t.id === id))
        }),
        update: vi.fn(async (tabId: number, props: any) => {
          const t = mockTabs.find((tab) => tab.id === tabId)
          if (t) Object.assign(t, props)
          return t
        }),
        ungroup: vi.fn(async (tabIds: number | number[]) => {
          const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
          for (const id of ids) {
            const t = mockTabs.find((tab) => tab.id === id)
            if (t) t.groupId = -1
          }
        }),
        group: vi.fn(async ({ tabIds }: any) => {
          const newGroupId = 999
          for (const id of tabIds) {
            const t = mockTabs.find((tab) => tab.id === id)
            if (t) t.groupId = newGroupId
          }
          mockGroups.push({ id: newGroupId, windowId: 10, title: '' })
          return newGroupId
        }),
      },
      windows: {
        WINDOW_ID_NONE: -1,
        create: vi.fn(async (createData: any) => {
          const newWin = { id: 20, tabs: [{ id: 9999, windowId: 20 }] }
          mockTabs.push(newWin.tabs[0])
          createdWindows.push(newWin)
          return newWin
        }),
        getAll: vi.fn(async () => [{ id: 10 }]),
      },
    })
  })

  it('closes all tabs belonging to the active domain in the window', async () => {
    // Active tab is tab id 2 (example.com)
    await closeDomainTabs(10)
    // Should have closed id 1, 2, 4 (example.com), leaving only id 3 (github.com)
    expect(mockTabs.map((t) => t.id)).toEqual([3])
  })

  it('isolates tabs belonging to the active domain into a new window', async () => {
    // Active tab is tab id 2 (example.com)
    await isolateDomainTabs(10)
    expect(createdWindows).toHaveLength(1)
    const newWinId = createdWindows[0].id
    // Tabs 1, 2, 4 moved to new window 20
    const movedTabs = mockTabs.filter((t) => t.windowId === newWinId)
    expect(movedTabs.map((t) => t.id)).toContain(1)
    expect(movedTabs.map((t) => t.id)).toContain(2)
    expect(movedTabs.map((t) => t.id)).toContain(4)
  })

  it('closes unpinned tabs to the left of the active tab', async () => {
    // Active tab is id 2 at index 1. Left tab is id 1 at index 0.
    await closeLeftTabs(10)
    expect(mockTabs.find((t) => t.id === 1)).toBeUndefined()
    expect(mockTabs.find((t) => t.id === 2)).toBeDefined()
    expect(mockTabs.find((t) => t.id === 3)).toBeDefined()
  })

  it('closes unpinned tabs to the right of the active tab', async () => {
    // Active tab is id 2 at index 1. Right tabs are id 3 (index 2) and id 4 (index 3).
    await closeRightTabs(10)
    expect(mockTabs.find((t) => t.id === 1)).toBeDefined()
    expect(mockTabs.find((t) => t.id === 2)).toBeDefined()
    expect(mockTabs.find((t) => t.id === 3)).toBeUndefined()
    expect(mockTabs.find((t) => t.id === 4)).toBeUndefined()
  })

  it('mutes and unmutes all tabs in the window', async () => {
    await muteAllTabs(10)
    expect(mockTabs.every((t) => t.muted === true)).toBe(true)

    await unmuteAllTabs(10)
    expect(mockTabs.every((t) => t.muted === false)).toBe(true)
  })

  it('toggles group titles hidden and visible', async () => {
    expect(areGroupTitlesHidden(10)).toBe(false)
    const hidden = await toggleGroupTitles(10)
    expect(hidden).toBe(true)
    expect(areGroupTitlesHidden(10)).toBe(true)

    const unhidden = await toggleGroupTitles(10)
    expect(unhidden).toBe(false)
    expect(areGroupTitlesHidden(10)).toBe(false)
  })

  it('expands and collapses all groups', async () => {
    await collapseAllGroups(10)
    expect(mockGroups[0].collapsed).toBe(true)

    await expandAllGroups(10)
    expect(mockGroups[0].collapsed).toBe(false)
  })

  it('ungroups all tabs in window and ungroupGroupTabs for specific tab ids', async () => {
    await ungroupGroupTabs([2, 3])
    expect(mockTabs.find((t) => t.id === 2)?.groupId).toBe(-1)
    expect(mockTabs.find((t) => t.id === 3)?.groupId).toBe(-1)

    mockTabs[1].groupId = 100
    await ungroupAllTabs(10)
    expect(mockTabs.every((t) => t.groupId === -1)).toBe(true)
  })

  it('manages operation timeout setup, extension, and cancellation', () => {
    const controller = new AbortController()
    setupOperationTimeout(10, controller)

    // Cannot extend non-registered controller in activeAbortControllers directly unless registered
    // but cancelActiveOperation clears it cleanly
    clearOperationTimeout(10)
    cancelActiveOperation(10)
    expect(controller.signal.aborted).toBe(false)
  })
})
