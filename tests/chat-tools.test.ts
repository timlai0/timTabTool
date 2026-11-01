import { describe, it, expect } from 'vitest'
import {
  AUTO_DESTRUCTIVE_LIMIT,
  MAX_ACTIONS_PER_REPLY,
  MAX_TABS_PER_ACTION,
  actionMemoryNote,
  buildToolsPrompt,
  canUndo,
  needsConfirmation,
  parseActionBlocks,
  sanitizeToolCall,
  stripActionsBlock,
  validateToolCalls,
  type ChatActionRecord,
  type ChatToolMode,
  type ScopeTab,
} from '../src/shared/chat-tools'
import { buildChatPrompt } from '../src/shared/chat-helpers'
import { PRIVILEGED_ACTIONS } from '../src/background/sender-policy'

const scope = new Map<number, ScopeTab>([
  [1, { id: 1, title: 'Alpha', url: 'https://a.com', pinned: false }],
  [2, { id: 2, title: 'Beta', url: 'https://b.com', pinned: false }],
  [3, { id: 3, title: 'Gamma', url: 'https://c.com', pinned: true }],
  [4, { id: 4, title: 'Delta', url: 'https://d.com', pinned: false }],
])
let n = 0
const newId = () => `a${++n}`

function record(partial: Partial<ChatActionRecord> = {}): ChatActionRecord {
  return {
    id: 'x',
    call: { tool: 'close_tabs', tabIds: [1] },
    destructive: true,
    status: 'proposed',
    summary: 's',
    ...partial,
  }
}

describe('action block parsing', () => {
  const reply = 'Closing the duplicate.\n```actions\n[{"tool":"close_tabs","tab_ids":[1,2],"reason":"dupes"}]\n```'

  it('splits visible text from the proposed actions', () => {
    const parsed = parseActionBlocks(reply)
    expect(parsed.text).toBe('Closing the duplicate.')
    expect(parsed.raw).toHaveLength(1)
    expect(parsed.parseError).toBeUndefined()
  })

  it('accepts an object wrapper or a single object', () => {
    expect(parseActionBlocks('```actions\n{"actions":[{"tool":"pin_tabs","tab_ids":[1]}]}\n```').raw).toHaveLength(1)
    expect(parseActionBlocks('```actions\n{"tool":"pin_tabs","tab_ids":[1]}\n```').raw).toHaveLength(1)
  })

  it('reports unreadable blocks and still hides them', () => {
    const parsed = parseActionBlocks('Sure.\n```actions\n[{oops}\n```')
    expect(parsed.raw).toEqual([])
    expect(parsed.parseError).toBeTruthy()
    expect(parsed.text).toBe('Sure.')
  })

  it('ignores ordinary code fences', () => {
    const parsed = parseActionBlocks('```json\n[{"tool":"close_tabs","tab_ids":[1]}]\n```')
    expect(parsed.raw).toEqual([])
    expect(parsed.text).toContain('```json')
  })

  it('hides a half-streamed block', () => {
    expect(stripActionsBlock('Working on it.\n```actions\n[{"tool":"clo')).toBe('Working on it.')
    expect(stripActionsBlock('no block here')).toBe('no block here')
  })
})

describe('sanitizeToolCall', () => {
  it('rejects unknown tools and missing ids', () => {
    expect(sanitizeToolCall({ tool: 'rm_rf', tab_ids: [1] })).toBeNull()
    expect(sanitizeToolCall({ tool: 'close_tabs' })).toBeNull()
    expect(sanitizeToolCall({ tool: 'close_tabs', tab_ids: [] })).toBeNull()
    expect(sanitizeToolCall({ tool: 'close_tabs', tab_ids: ['1', -2, 1.5] })).toBeNull()
    expect(sanitizeToolCall(null)).toBeNull()
  })

  it('dedupes and caps ids, and accepts camelCase', () => {
    const many = Array.from({ length: 80 }, (_, i) => i + 1)
    expect(sanitizeToolCall({ tool: 'close_tabs', tab_ids: many })!.tabIds).toHaveLength(MAX_TABS_PER_ACTION)
    expect(sanitizeToolCall({ tool: 'close_tabs', tabIds: [2, 2, 3] })!.tabIds).toEqual([2, 3])
  })

  it('limits focus_tab to one tab and normalizes group fields', () => {
    expect(sanitizeToolCall({ tool: 'focus_tab', tab_ids: [4, 5] })!.tabIds).toEqual([4])
    const g = sanitizeToolCall({ tool: 'group_tabs', tab_ids: [1], title: '  My   group ', color: 'blue' })!
    expect(g.title).toBe('My group')
    expect(g.color).toBe('blue')
    expect(sanitizeToolCall({ tool: 'group_tabs', tab_ids: [1], color: 'chartreuse' })!.color).toBeUndefined()
    expect(sanitizeToolCall({ tool: 'group_tabs', tab_ids: [1] })!.title).toBe('Group')
  })
})

describe('validateToolCalls', () => {
  it('drops unknown ids and never closes, groups or pins pinned tabs', () => {
    const records = validateToolCalls([
      { tool: 'close_tabs', tab_ids: [1, 3, 99] },
      { tool: 'group_tabs', tab_ids: [3], title: 'x' },
      { tool: 'unpin_tabs', tab_ids: [3] },
    ], scope, newId)
    expect(records).toHaveLength(2)
    expect(records[0].call.tabIds).toEqual([1])
    expect(records[0].skipped).toBe(2)
    expect(records[0].destructive).toBe(true)
    expect(records[0].status).toBe('proposed')
    expect(records[1].call.tool).toBe('unpin_tabs')
    expect(records[1].destructive).toBe(false)
  })

  it('describes actions with tab titles', () => {
    const [r] = validateToolCalls([{ tool: 'close_tabs', tab_ids: [1, 2, 4] }], scope, newId)
    expect(r.summary).toBe('Close 3 tabs: Alpha, Beta, Delta')
    const [g] = validateToolCalls([{ tool: 'group_tabs', tab_ids: [1], title: 'Docs' }], scope, newId)
    expect(g.summary).toBe('Group 1 tab as "Docs": Alpha')
  })

  it('caps the number of actions per reply', () => {
    const raw = Array.from({ length: MAX_ACTIONS_PER_REPLY + 5 }, () => ({ tool: 'pin_tabs', tab_ids: [1] }))
    expect(validateToolCalls(raw, scope, newId)).toHaveLength(MAX_ACTIONS_PER_REPLY)
  })
})

describe('permission modes', () => {
  const closeFew = record()
  const closeMany = record({ call: { tool: 'close_tabs', tabIds: Array.from({ length: AUTO_DESTRUCTIVE_LIMIT + 1 }, (_, i) => i + 1) } })
  const group = record({ destructive: false, call: { tool: 'group_tabs', tabIds: [1], title: 't' } })

  const table: [ChatToolMode, ChatActionRecord, boolean][] = [
    ['off', group, true],
    ['confirm-all', group, true],
    ['confirm-all', closeFew, true],
    ['confirm-destructive', group, false],
    ['confirm-destructive', closeFew, true],
    ['auto', group, false],
    ['auto', closeFew, false],
    ['auto', closeMany, true],
  ]
  it.each(table)('%s: needs confirmation = %s', (mode, action, expected) => {
    expect(needsConfirmation(mode, action)).toBe(expected)
  })
})

describe('prompt, memory and undo helpers', () => {
  it('adds the protocol only when actions are enabled', () => {
    expect(buildToolsPrompt('off')).toBe('')
    const on = buildToolsPrompt('confirm-destructive')
    expect(on).toContain('close_tabs')
    expect(on).toContain('```actions')
    expect(on).toContain('untrusted')
    const prompt = buildChatPrompt('- tab', { turns: [] }, 'q', on)
    expect(prompt.indexOf('close_tabs')).toBeLessThan(prompt.indexOf('User Question: q'))
  })

  it('notes outcomes for the model', () => {
    expect(actionMemoryNote(undefined)).toBe('')
    const note = actionMemoryNote([record({ status: 'done', summary: 'Close 1 tab' }), record({ status: 'declined', summary: 'Pin 2 tabs' })])
    expect(note).toContain('[Action: Close 1 tab — done]')
    expect(note).toContain('[Action: Pin 2 tabs — declined by the user]')
  })

  it('only offers undo for finished, undoable actions that kept their snapshots', () => {
    const snap = [{ id: 1, url: 'https://a.com', title: 'A', windowId: 1, index: 0, pinned: false, groupId: -1 }]
    expect(canUndo(record({ status: 'done', snapshots: snap }))).toBe(true)
    expect(canUndo(record({ status: 'done' }))).toBe(false)
    expect(canUndo(record({ status: 'undone', snapshots: snap }))).toBe(false)
    expect(canUndo(record({ status: 'done', snapshots: snap, call: { tool: 'focus_tab', tabIds: [1] } }))).toBe(false)
  })

  it('treats the tool messages as privileged', () => {
    expect(PRIVILEGED_ACTIONS.has('CHAT_TOOL_EXEC')).toBe(true)
    expect(PRIVILEGED_ACTIONS.has('CHAT_TOOL_UNDO')).toBe(true)
  })
})
