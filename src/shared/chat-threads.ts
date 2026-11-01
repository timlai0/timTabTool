/**
 * Persistence for Window Chat threads.
 *
 * Storage layout (chrome.storage.local):
 *   chatThreadIndex      ChatThreadMeta[]      lightweight list, newest activity first
 *   chatActiveThreadId   string
 *   chatThread:<id>      ChatThreadData        messages + memory for one thread
 * Keeping messages in per-thread keys means a save only rewrites the thread being edited.
 */

import type { ChatActionRecord } from './chat-tools'

export interface StoredChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  fullRequest?: string
  /** Tab actions the assistant proposed or ran for this reply. */
  actions?: ChatActionRecord[]
  timestamp: number
}

export interface ChatThreadData {
  messages: StoredChatMessage[]
  clickedUrls: string[]
  /** Rolling summary covering the first `summarizedCount` messages. */
  summary: string
  summarizedCount: number
}

export interface ChatThreadMeta {
  id: string
  title: string
  /** True once the user renamed the thread; auto-titling then stops. */
  customTitle?: boolean
  createdAt: number
  updatedAt: number
  messageCount: number
}

export const THREAD_INDEX_KEY = 'chatThreadIndex'
export const ACTIVE_THREAD_KEY = 'chatActiveThreadId'
export const THREAD_KEY_PREFIX = 'chatThread:'
export const DEFAULT_THREAD_TITLE = 'New chat'
export const MAX_THREADS = 30
export const MAX_MESSAGES_PER_THREAD = 200
const TITLE_MAX_CHARS = 40
/** Undo snapshots are kept for this many most recent actions per thread. */
export const MAX_UNDO_SNAPSHOTS = 10

const LEGACY_MESSAGES_KEY = 'chatSessionMessages'
const LEGACY_URLS_KEY = 'chatClickedUrls'

const threadKey = (id: string) => THREAD_KEY_PREFIX + id

export function emptyThreadData(): ChatThreadData {
  return { messages: [], clickedUrls: [], summary: '', summarizedCount: 0 }
}

function newThreadId(): string {
  return 'thread-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

/**
 * Title a thread from its first user message.
 * @param {StoredChatMessage[]} messages
 * @returns {string}
 */
export function deriveThreadTitle(messages: Pick<StoredChatMessage, 'role' | 'content'>[]): string {
  const first = messages.find(m => m.role === 'user')?.content.replace(/\s+/g, ' ').trim()
  if (!first) return DEFAULT_THREAD_TITLE
  return first.length > TITLE_MAX_CHARS ? first.slice(0, TITLE_MAX_CHARS - 1) + '…' : first
}

/**
 * Prepare thread data for storage: keep the full prompt only on the newest reply (it embeds the
 * whole tab list and would otherwise dominate the storage quota) and cap the message count.
 * @param {ChatThreadData} data
 * @returns {{ data: ChatThreadData; dropped: number }}
 */
export function normalizeThreadData(data: ChatThreadData): { data: ChatThreadData; dropped: number } {
  const dropped = Math.max(0, data.messages.length - MAX_MESSAGES_PER_THREAD)
  const kept = data.messages.slice(dropped)

  let lastAssistant = -1
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].role === 'assistant') { lastAssistant = i; break }
  }
  // Undo snapshots only matter for recent actions; older ones are dropped to protect the storage quota.
  let snapshotBudget = MAX_UNDO_SNAPSHOTS
  const keepSnapshots = new Set<string>()
  for (let i = kept.length - 1; i >= 0 && snapshotBudget > 0; i--) {
    for (const a of [...(kept[i].actions ?? [])].reverse()) {
      if (snapshotBudget > 0 && a.snapshots?.length) {
        keepSnapshots.add(a.id)
        snapshotBudget--
      }
    }
  }
  const messages = kept.map((m, i) => {
    const { fullRequest: _omit, ...rest } = m
    const withPrompt = i === lastAssistant && m.fullRequest ? { ...rest, fullRequest: m.fullRequest } : rest
    if (!withPrompt.actions) return withPrompt
    return {
      ...withPrompt,
      actions: withPrompt.actions.map(a => {
        if (!a.snapshots || keepSnapshots.has(a.id)) return a
        const { snapshots: _snap, ...noSnap } = a
        return noSnap
      }),
    }
  })

  const summarizedCount = Math.max(0, Math.min(data.summarizedCount - dropped, messages.length))
  return {
    data: {
      messages,
      clickedUrls: data.clickedUrls,
      summary: summarizedCount > 0 ? data.summary : '',
      summarizedCount,
    },
    dropped,
  }
}

// Index read-modify-write cycles are serialized so concurrent saves cannot clobber each other.
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

async function readIndex(): Promise<ChatThreadMeta[]> {
  const data = await chrome.storage.local.get(THREAD_INDEX_KEY)
  const index = data[THREAD_INDEX_KEY]
  return Array.isArray(index) ? (index as ChatThreadMeta[]) : []
}

/**
 * Drop the least recently used threads beyond MAX_THREADS (never the active one).
 */
async function prune(index: ChatThreadMeta[], activeId: string): Promise<ChatThreadMeta[]> {
  if (index.length <= MAX_THREADS) return index
  const removable = index
    .filter(t => t.id !== activeId)
    // Ties fall back to index position: new threads are prepended, so later entries are older.
    .sort((a, b) => a.updatedAt - b.updatedAt || index.indexOf(b) - index.indexOf(a))
    .slice(0, index.length - MAX_THREADS)
  const removeIds = new Set(removable.map(t => t.id))
  await chrome.storage.local.remove(removable.map(t => threadKey(t.id)))
  return index.filter(t => !removeIds.has(t.id))
}

function sortIndex(index: ChatThreadMeta[]): ChatThreadMeta[] {
  return [...index].sort((a, b) => b.updatedAt - a.updatedAt)
}

async function createInternal(index: ChatThreadMeta[]): Promise<{ meta: ChatThreadMeta; index: ChatThreadMeta[] }> {
  const now = Date.now()
  const meta: ChatThreadMeta = { id: newThreadId(), title: DEFAULT_THREAD_TITLE, createdAt: now, updatedAt: now, messageCount: 0 }
  await chrome.storage.local.set({ [threadKey(meta.id)]: emptyThreadData() })
  return { meta, index: [meta, ...index] }
}

/**
 * Load the thread list and active thread id, migrating the single-conversation storage on first run.
 * @returns {Promise<{ threads: ChatThreadMeta[]; activeId: string }>}
 */
export function loadThreads(): Promise<{ threads: ChatThreadMeta[]; activeId: string }> {
  return serialized(async () => {
    const stored = await chrome.storage.local.get([THREAD_INDEX_KEY, ACTIVE_THREAD_KEY, LEGACY_MESSAGES_KEY, LEGACY_URLS_KEY])
    let index = Array.isArray(stored[THREAD_INDEX_KEY]) ? (stored[THREAD_INDEX_KEY] as ChatThreadMeta[]) : []

    if (index.length === 0) {
      const legacy = Array.isArray(stored[LEGACY_MESSAGES_KEY]) ? (stored[LEGACY_MESSAGES_KEY] as StoredChatMessage[]) : []
      const created = await createInternal([])
      index = created.index
      if (legacy.length > 0) {
        const urls = Array.isArray(stored[LEGACY_URLS_KEY]) ? (stored[LEGACY_URLS_KEY] as string[]) : []
        const { data } = normalizeThreadData({ ...emptyThreadData(), messages: legacy, clickedUrls: urls })
        const last = legacy[legacy.length - 1]
        index = [{ ...created.meta, title: deriveThreadTitle(legacy), updatedAt: last?.timestamp ?? created.meta.updatedAt, messageCount: legacy.length }]
        await chrome.storage.local.set({ [threadKey(created.meta.id)]: data })
      }
      await chrome.storage.local.set({ [THREAD_INDEX_KEY]: index, [ACTIVE_THREAD_KEY]: created.meta.id })
      await chrome.storage.local.remove([LEGACY_MESSAGES_KEY, LEGACY_URLS_KEY])
      return { threads: sortIndex(index), activeId: created.meta.id }
    }

    const savedActive = stored[ACTIVE_THREAD_KEY]
    const activeId = typeof savedActive === 'string' && index.some(t => t.id === savedActive) ? savedActive : sortIndex(index)[0].id
    return { threads: sortIndex(index), activeId }
  })
}

/**
 * Read one thread's messages and memory.
 * @param {string} id
 * @returns {Promise<ChatThreadData>}
 */
export async function loadThread(id: string): Promise<ChatThreadData> {
  const data = await chrome.storage.local.get(threadKey(id))
  const raw = data[threadKey(id)] as Partial<ChatThreadData> | undefined
  return {
    messages: Array.isArray(raw?.messages) ? raw!.messages : [],
    clickedUrls: Array.isArray(raw?.clickedUrls) ? raw!.clickedUrls : [],
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    summarizedCount: typeof raw?.summarizedCount === 'number' ? raw.summarizedCount : 0,
  }
}

/**
 * Persist a thread and refresh its index entry.
 * @param {string} id
 * @param {ChatThreadData} data
 * @returns {Promise<{ threads: ChatThreadMeta[]; dropped: number }>}
 */
export function saveThread(id: string, data: ChatThreadData): Promise<{ threads: ChatThreadMeta[]; dropped: number }> {
  return serialized(async () => {
    const index = await readIndex()
    const existing = index.find(t => t.id === id)
    if (!existing) return { threads: sortIndex(index), dropped: 0 } // deleted while a save was in flight

    const normalized = normalizeThreadData(data)
    await chrome.storage.local.set({ [threadKey(id)]: normalized.data })

    const next = index.map(t => t.id === id
      ? {
          ...t,
          title: t.customTitle ? t.title : deriveThreadTitle(normalized.data.messages),
          updatedAt: Date.now(),
          messageCount: normalized.data.messages.length,
        }
      : t)
    await chrome.storage.local.set({ [THREAD_INDEX_KEY]: next })
    return { threads: sortIndex(next), dropped: normalized.dropped }
  })
}

/**
 * Create a fresh thread and make it active.
 * @returns {Promise<{ threads: ChatThreadMeta[]; id: string }>}
 */
export function createThread(): Promise<{ threads: ChatThreadMeta[]; id: string }> {
  return serialized(async () => {
    const { meta, index } = await createInternal(await readIndex())
    const pruned = await prune(index, meta.id)
    await chrome.storage.local.set({ [THREAD_INDEX_KEY]: pruned, [ACTIVE_THREAD_KEY]: meta.id })
    return { threads: sortIndex(pruned), id: meta.id }
  })
}

export async function setActiveThread(id: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_THREAD_KEY]: id })
}

/**
 * Rename a thread; an empty name restores automatic titling.
 * @param {string} id
 * @param {string} title
 * @returns {Promise<ChatThreadMeta[]>}
 */
export function renameThread(id: string, title: string): Promise<ChatThreadMeta[]> {
  return serialized(async () => {
    const trimmed = title.trim().slice(0, 80)
    const index = await readIndex()
    const next = await Promise.all(index.map(async t => {
      if (t.id !== id) return t
      if (trimmed) return { ...t, title: trimmed, customTitle: true }
      const { messages } = await loadThread(id)
      const { customTitle: _omit, ...rest } = t
      return { ...rest, title: deriveThreadTitle(messages) }
    }))
    await chrome.storage.local.set({ [THREAD_INDEX_KEY]: next })
    return sortIndex(next)
  })
}

/**
 * Delete a thread. Returns the thread to show next (creating one if none are left).
 * @param {string} id
 * @returns {Promise<{ threads: ChatThreadMeta[]; activeId: string }>}
 */
export function deleteThread(id: string): Promise<{ threads: ChatThreadMeta[]; activeId: string }> {
  return serialized(async () => {
    await chrome.storage.local.remove(threadKey(id))
    let index = (await readIndex()).filter(t => t.id !== id)
    if (index.length === 0) index = (await createInternal([])).index
    const activeId = sortIndex(index)[0].id
    await chrome.storage.local.set({ [THREAD_INDEX_KEY]: index, [ACTIVE_THREAD_KEY]: activeId })
    return { threads: sortIndex(index), activeId }
  })
}

/**
 * Store a freshly computed summary on a thread that is not currently open in the view.
 * Only moves the summary forward.
 * @param {string} id
 * @param {string} summary
 * @param {number} summarizedCount
 */
export function applyThreadSummary(id: string, summary: string, summarizedCount: number): Promise<void> {
  return serialized(async () => {
    if (!(await readIndex()).some(t => t.id === id)) return
    const data = await loadThread(id)
    if (summarizedCount <= data.summarizedCount || summarizedCount > data.messages.length) return
    await chrome.storage.local.set({ [threadKey(id)]: { ...data, summary, summarizedCount } })
  })
}
