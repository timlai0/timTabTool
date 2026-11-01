import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadThreads,
  loadThread,
  saveThread,
  createThread,
  renameThread,
  deleteThread,
  applyThreadSummary,
  deriveThreadTitle,
  normalizeThreadData,
  emptyThreadData,
  DEFAULT_THREAD_TITLE,
  MAX_THREADS,
  MAX_MESSAGES_PER_THREAD,
  MAX_UNDO_SNAPSHOTS,
  type StoredChatMessage,
} from '../src/shared/chat-threads'

let store: Record<string, any> = {}

function msg(i: number, role: 'user' | 'assistant', extra: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return { id: `m${i}`, role, content: `${role} ${i}`, timestamp: 1000 + i, ...extra }
}

beforeEach(() => {
  store = {}
  // Strictly increasing clock so ordering by updatedAt never depends on real timing
  let clock = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock)
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, any> = {}
          for (const k of list) if (k in store) out[k] = structuredClone(store[k])
          return out
        }),
        set: vi.fn(async (items: Record<string, any>) => {
          for (const [k, v] of Object.entries(items)) store[k] = structuredClone(v)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
        }),
      },
    },
  })
})

describe('thread helpers', () => {
  it('titles a thread from the first user message', () => {
    expect(deriveThreadTitle([])).toBe(DEFAULT_THREAD_TITLE)
    expect(deriveThreadTitle([msg(0, 'assistant'), msg(1, 'user', { content: '  hello\n  world ' })])).toBe('hello world')
    expect(deriveThreadTitle([msg(0, 'user', { content: 'x'.repeat(100) })]).length).toBe(40)
  })

  it('keeps fullRequest only on the newest assistant reply', () => {
    const { data } = normalizeThreadData({
      ...emptyThreadData(),
      messages: [
        msg(0, 'user'),
        msg(1, 'assistant', { fullRequest: 'big' }),
        msg(2, 'user'),
        msg(3, 'assistant', { fullRequest: 'big2' }),
      ],
    })
    expect(data.messages[1].fullRequest).toBeUndefined()
    expect(data.messages[3].fullRequest).toBe('big2')
  })

  it('keeps undo snapshots only for the most recent actions', () => {
    const snap = [{ id: 1, url: 'https://a.com', title: 'A', windowId: 1, index: 0, pinned: false, groupId: -1 }]
    const action = (id: string) => ({
      id, call: { tool: 'close_tabs' as const, tabIds: [1] }, destructive: true, status: 'done' as const, summary: id, snapshots: snap,
    })
    const messages = Array.from({ length: MAX_UNDO_SNAPSHOTS + 3 }, (_, i) => msg(i, 'assistant', { actions: [action(`act${i}`)] }))
    const { data } = normalizeThreadData({ ...emptyThreadData(), messages })
    const withSnap = data.messages.filter(m => m.actions![0].snapshots)
    expect(withSnap).toHaveLength(MAX_UNDO_SNAPSHOTS)
    expect(data.messages[0].actions![0].snapshots).toBeUndefined()
    expect(data.messages[0].actions![0].summary).toBe('act0')
    expect(data.messages[data.messages.length - 1].actions![0].snapshots).toEqual(snap)
  })

  it('caps messages and shifts the summarized count', () => {
    const messages = Array.from({ length: MAX_MESSAGES_PER_THREAD + 10 }, (_, i) => msg(i, i % 2 ? 'assistant' : 'user'))
    const { data, dropped } = normalizeThreadData({ messages, clickedUrls: [], summary: 's', summarizedCount: 15 })
    expect(dropped).toBe(10)
    expect(data.messages.length).toBe(MAX_MESSAGES_PER_THREAD)
    expect(data.summarizedCount).toBe(5)
    expect(data.summary).toBe('s')

    const gone = normalizeThreadData({ messages, clickedUrls: [], summary: 's', summarizedCount: 8 })
    expect(gone.data.summarizedCount).toBe(0)
    expect(gone.data.summary).toBe('')
  })
})

describe('thread storage', () => {
  it('creates an empty first thread when nothing is stored', async () => {
    const { threads, activeId } = await loadThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe(activeId)
    expect(threads[0].title).toBe(DEFAULT_THREAD_TITLE)
    expect((await loadThread(activeId)).messages).toEqual([])
  })

  it('migrates the legacy single conversation', async () => {
    store.chatSessionMessages = [msg(0, 'user', { content: 'legacy question' }), msg(1, 'assistant')]
    store.chatClickedUrls = ['https://a.com']
    const { threads, activeId } = await loadThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].title).toBe('legacy question')
    expect(threads[0].messageCount).toBe(2)
    const data = await loadThread(activeId)
    expect(data.messages).toHaveLength(2)
    expect(data.clickedUrls).toEqual(['https://a.com'])
    expect(store.chatSessionMessages).toBeUndefined()
    expect(store.chatClickedUrls).toBeUndefined()

    // A second load must not migrate again or duplicate threads
    expect((await loadThreads()).threads).toHaveLength(1)
  })

  it('saves messages, auto-titles, and orders threads by recent activity', async () => {
    const first = (await loadThreads()).activeId
    const second = (await createThread()).id
    await saveThread(first, { ...emptyThreadData(), messages: [msg(0, 'user', { content: 'Tabs about cats' })] })
    const { threads } = await saveThread(first, { ...emptyThreadData(), messages: [msg(0, 'user', { content: 'Tabs about cats' }), msg(1, 'assistant')] })
    expect(threads[0].id).toBe(first)
    expect(threads[0].title).toBe('Tabs about cats')
    expect(threads[0].messageCount).toBe(2)
    expect(threads.find(t => t.id === second)!.title).toBe(DEFAULT_THREAD_TITLE)
  })

  it('renames a thread and restores auto-titling on an empty name', async () => {
    const id = (await loadThreads()).activeId
    await saveThread(id, { ...emptyThreadData(), messages: [msg(0, 'user', { content: 'auto title' })] })
    let threads = await renameThread(id, '  Project X ')
    expect(threads[0].title).toBe('Project X')
    ;({ threads } = await saveThread(id, { ...emptyThreadData(), messages: [msg(0, 'user', { content: 'something else' })] }))
    expect(threads[0].title).toBe('Project X')
    threads = await renameThread(id, '')
    expect(threads[0].title).toBe('something else')
  })

  it('deletes a thread and falls back to another, or a fresh one', async () => {
    const first = (await loadThreads()).activeId
    const second = (await createThread()).id
    const afterOne = await deleteThread(second)
    expect(afterOne.activeId).toBe(first)
    expect(store[`chatThread:${second}`]).toBeUndefined()

    const afterAll = await deleteThread(first)
    expect(afterAll.threads).toHaveLength(1)
    expect(afterAll.activeId).not.toBe(first)
  })

  it('does not resurrect a thread that was deleted during a save', async () => {
    const id = (await loadThreads()).activeId
    await createThread()
    await deleteThread(id)
    const { threads } = await saveThread(id, { ...emptyThreadData(), messages: [msg(0, 'user')] })
    expect(threads.some(t => t.id === id)).toBe(false)
    expect(store[`chatThread:${id}`]).toBeUndefined()
  })

  it('prunes the least recently used threads beyond the limit', async () => {
    const first = (await loadThreads()).activeId
    for (let i = 0; i < MAX_THREADS + 2; i++) await createThread()
    const { threads } = await loadThreads()
    expect(threads.length).toBe(MAX_THREADS)
    expect(threads.some(t => t.id === first)).toBe(false)
    expect(store[`chatThread:${first}`]).toBeUndefined()
  })

  it('applies a background summary only when it moves forward', async () => {
    const id = (await loadThreads()).activeId
    const messages = Array.from({ length: 10 }, (_, i) => msg(i, i % 2 ? 'assistant' : 'user'))
    await saveThread(id, { ...emptyThreadData(), messages })
    await applyThreadSummary(id, 'first', 4)
    expect((await loadThread(id)).summary).toBe('first')
    await applyThreadSummary(id, 'older', 2)
    expect((await loadThread(id)).summary).toBe('first')
    await applyThreadSummary(id, 'impossible', 99)
    expect((await loadThread(id)).summarizedCount).toBe(4)
  })
})
