import { describe, it, expect, beforeEach, vi } from 'vitest'
import { STORAGE_KEYS } from '../src/shared/constants'

interface FakeTab { id: number; windowId: number; index: number; url: string; title: string; pinned: boolean; groupId: number }
interface FakeGroup { id: number; windowId: number; title: string; color: string }

let tabs: FakeTab[]
let groups: FakeGroup[]
let store: Record<string, any>
let nextTabId: number
let nextGroupId: number

function pruneEmptyGroups() {
  groups = groups.filter(g => tabs.some(t => t.groupId === g.id))
}

function installChrome() {
  vi.stubGlobal('chrome', {
    runtime: { getURL: (p: string) => 'chrome-extension://abc/' + p, sendMessage: vi.fn().mockResolvedValue({}) },
    storage: {
      local: {
        get: vi.fn(async (keys: any) => {
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {})
          const out: Record<string, any> = {}
          for (const k of list) if (k in store) out[k] = structuredClone(store[k])
          return out
        }),
        set: vi.fn(async (items: Record<string, any>) => { for (const [k, v] of Object.entries(items)) store[k] = structuredClone(v) }),
        remove: vi.fn(async (keys: any) => { for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k] }),
      },
    },
    windows: {
      getAll: vi.fn(async () => [{ id: 10 }]),
      update: vi.fn(async () => ({})),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const t = tabs.find(x => x.id === id)
        if (!t) throw new Error(`No tab with id: ${id}`)
        return { ...t }
      }),
      create: vi.fn(async (props: any) => {
        const t: FakeTab = {
          id: nextTabId++, windowId: props.windowId ?? 10, index: props.index ?? tabs.length,
          url: props.url, title: props.url, pinned: Boolean(props.pinned), groupId: -1,
        }
        tabs.push(t)
        return { ...t }
      }),
      remove: vi.fn(async (ids: number | number[]) => {
        const list = Array.isArray(ids) ? ids : [ids]
        tabs = tabs.filter(t => !list.includes(t.id))
        pruneEmptyGroups()
      }),
      update: vi.fn(async (id: number, props: any) => {
        const t = tabs.find(x => x.id === id)
        if (!t) throw new Error(`No tab with id: ${id}`)
        Object.assign(t, props)
        return { ...t }
      }),
      group: vi.fn(async ({ tabIds, groupId, createProperties }: any) => {
        const gid = groupId ?? nextGroupId++
        if (groupId === undefined) {
          const first = tabs.find(t => t.id === tabIds[0])!
          groups.push({ id: gid, windowId: createProperties?.windowId ?? first.windowId, title: '', color: 'grey' })
        }
        for (const id of tabIds) tabs.find(t => t.id === id)!.groupId = gid
        pruneEmptyGroups()
        return gid
      }),
      ungroup: vi.fn(async (ids: number | number[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) tabs.find(t => t.id === id)!.groupId = -1
        pruneEmptyGroups()
      }),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: vi.fn(async (id: number) => {
        const g = groups.find(x => x.id === id)
        if (!g) throw new Error(`No group with id: ${id}`)
        return { ...g }
      }),
      update: vi.fn(async (id: number, props: any) => {
        const g = groups.find(x => x.id === id)
        if (g) Object.assign(g, props)
        return g
      }),
    },
  })
}

async function load() {
  vi.resetModules()
  return await import('../src/background/tabs/chat-tool-actions')
}

const tab = (id: number, over: Partial<FakeTab> = {}): FakeTab =>
  ({ id, windowId: 10, index: id - 1, url: `https://site${id}.com/`, title: `Site ${id}`, pinned: false, groupId: -1, ...over })

beforeEach(() => {
  tabs = [
    tab(1),
    tab(2, { groupId: 100 }),
    tab(3, { groupId: 100 }),
    tab(4, { pinned: true }),
    tab(5, { url: 'chrome-extension://abc/src/popup/index.html?view=chat' }),
  ]
  groups = [{ id: 100, windowId: 10, title: 'Research', color: 'blue' }]
  store = {}
  nextTabId = 50
  nextGroupId = 200
  installChrome()
})

describe('executeChatToolCall', () => {
  it('rejects malformed calls', async () => {
    const { executeChatToolCall } = await load()
    expect((await executeChatToolCall({ tool: 'nope', tab_ids: [1] })).ok).toBe(false)
    expect((await executeChatToolCall(undefined)).ok).toBe(false)
  })

  it('closes tabs, skipping pinned and extension pages, and records them as closed by chat', async () => {
    const { executeChatToolCall } = await load()
    const res = await executeChatToolCall({ tool: 'close_tabs', tab_ids: [1, 3, 4, 5, 99] })
    expect(res.ok).toBe(true)
    expect(res.affected).toBe(2)
    expect(res.skipped).toBe(3)
    expect(res.snapshots.map(s => s.id).sort()).toEqual([1, 3])
    expect(tabs.map(t => t.id).sort()).toEqual([2, 4, 5])
    const closed = store[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]
    expect(closed.map((e: any) => e.source)).toEqual(['Chat', 'Chat'])
  })

  it('fails cleanly when none of the tabs exist', async () => {
    const { executeChatToolCall } = await load()
    const res = await executeChatToolCall({ tool: 'close_tabs', tab_ids: [98, 99] })
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('groups tabs with a title and color', async () => {
    const { executeChatToolCall } = await load()
    const res = await executeChatToolCall({ tool: 'group_tabs', tab_ids: [1, 3], title: 'Mix', color: 'red' })
    expect(res.ok).toBe(true)
    const t1 = tabs.find(t => t.id === 1)!
    const g = groups.find(x => x.id === t1.groupId)!
    expect(g.title).toBe('Mix')
    expect(g.color).toBe('red')
    expect(tabs.find(t => t.id === 3)!.groupId).toBe(t1.groupId)
  })

  it('ungroups and pins/unpins', async () => {
    const { executeChatToolCall } = await load()
    expect((await executeChatToolCall({ tool: 'ungroup_tabs', tab_ids: [2, 3] })).affected).toBe(2)
    expect(tabs.find(t => t.id === 2)!.groupId).toBe(-1)
    expect((await executeChatToolCall({ tool: 'pin_tabs', tab_ids: [1] })).affected).toBe(1)
    expect(tabs.find(t => t.id === 1)!.pinned).toBe(true)
    expect((await executeChatToolCall({ tool: 'unpin_tabs', tab_ids: [4] })).affected).toBe(1)
    expect(tabs.find(t => t.id === 4)!.pinned).toBe(false)
  })

  it('focuses a tab', async () => {
    const { executeChatToolCall } = await load()
    const res = await executeChatToolCall({ tool: 'focus_tab', tab_ids: [2] })
    expect(res.ok).toBe(true)
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true })
  })
})

describe('undoChatToolCall', () => {
  it('reopens closed tabs in their old group and clears them from recently-closed', async () => {
    const { executeChatToolCall, undoChatToolCall } = await load()
    const closed = await executeChatToolCall({ tool: 'close_tabs', tab_ids: [1, 3] })
    expect(store[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]).toHaveLength(2)

    const res = await undoChatToolCall('close_tabs', closed.snapshots)
    expect(res.ok).toBe(true)
    expect(res.restored).toBe(2)
    expect(res.failed).toBe(0)

    const reopened = tabs.filter(t => t.id >= 50)
    expect(reopened.map(t => t.url).sort()).toEqual(['https://site1.com/', 'https://site3.com/'])
    // Tab 3 came from group 100, which still exists thanks to tab 2
    expect(reopened.find(t => t.url === 'https://site3.com/')!.groupId).toBe(100)
    expect(reopened.find(t => t.url === 'https://site1.com/')!.groupId).toBe(-1)
    expect(store[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]).toHaveLength(0)
  })

  it('recreates a group that disappeared when its last tab closed', async () => {
    const { executeChatToolCall, undoChatToolCall } = await load()
    const closed = await executeChatToolCall({ tool: 'close_tabs', tab_ids: [2, 3] })
    expect(groups).toHaveLength(0)
    await undoChatToolCall('close_tabs', closed.snapshots)
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe('Research')
    expect(groups[0].color).toBe('blue')
    expect(tabs.filter(t => t.id >= 50).every(t => t.groupId === groups[0].id)).toBe(true)
  })

  it('puts tabs back after group_tabs and ungroup_tabs', async () => {
    const { executeChatToolCall, undoChatToolCall } = await load()
    const grouped = await executeChatToolCall({ tool: 'group_tabs', tab_ids: [1, 3], title: 'Mix' })
    await undoChatToolCall('group_tabs', grouped.snapshots)
    expect(tabs.find(t => t.id === 1)!.groupId).toBe(-1)
    expect(tabs.find(t => t.id === 3)!.groupId).toBe(100)

    const ungrouped = await executeChatToolCall({ tool: 'ungroup_tabs', tab_ids: [2, 3] })
    await undoChatToolCall('ungroup_tabs', ungrouped.snapshots)
    expect(tabs.find(t => t.id === 2)!.groupId).not.toBe(-1)
    expect(tabs.find(t => t.id === 2)!.groupId).toBe(tabs.find(t => t.id === 3)!.groupId)
  })

  it('restores pin state', async () => {
    const { executeChatToolCall, undoChatToolCall } = await load()
    const pinned = await executeChatToolCall({ tool: 'pin_tabs', tab_ids: [1] })
    await undoChatToolCall('pin_tabs', pinned.snapshots)
    expect(tabs.find(t => t.id === 1)!.pinned).toBe(false)
    const unpinned = await executeChatToolCall({ tool: 'unpin_tabs', tab_ids: [4] })
    await undoChatToolCall('unpin_tabs', unpinned.snapshots)
    expect(tabs.find(t => t.id === 4)!.pinned).toBe(true)
  })

  it('refuses bad input and non-undoable tools', async () => {
    const { undoChatToolCall } = await load()
    expect((await undoChatToolCall('close_tabs', 'nope')).ok).toBe(false)
    expect((await undoChatToolCall('close_tabs', [])).ok).toBe(false)
    expect((await undoChatToolCall('focus_tab', [{ id: 1, url: 'https://a.com', windowId: 10 }])).ok).toBe(false)
  })
})
