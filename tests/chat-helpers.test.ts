import { describe, it, expect } from 'vitest'
import {
  buildChatPrompt,
  planChatMemory,
  splitForSummary,
  buildSummaryPrompt,
  cleanSummary,
  compressTurnContent,
  estimateChatTokens,
  exportChatMarkdown,
  RECENT_VERBATIM_TURNS,
  SUMMARY_TRIGGER_TURNS,
  VERBATIM_TURN_MAX_CHARS,
  COMPRESSED_ASSISTANT_MAX_CHARS,
  MEMORY_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  type ChatTurn,
} from '../src/shared/chat-helpers'

function conversation(pairs: number, size = 10): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (let i = 0; i < pairs; i++) {
    turns.push({ role: 'user', content: `q${i} ` + 'u'.repeat(size) })
    turns.push({ role: 'assistant', content: `a${i} ` + 'a'.repeat(size) })
  }
  return turns
}

describe('compressTurnContent', () => {
  it('drops link URLs, the stopped marker and extra blank lines', () => {
    const out = compressTurnContent('See [Docs](https://example.com/x?a=1) now\n\n\n\nok\n\n*(Generation stopped)*', 500)
    expect(out).toBe('See Docs now\n\nok')
  })

  it('truncates with an ellipsis', () => {
    expect(compressTurnContent('x'.repeat(50), 10)).toBe('x'.repeat(10) + '…')
  })
})

describe('planChatMemory', () => {
  it('returns nothing for an empty conversation', () => {
    expect(planChatMemory({ turns: [] })).toEqual({ summary: '', turns: [] })
  })

  it('keeps recent turns verbatim (links intact) and compresses older ones', () => {
    const turns = conversation(5) // 10 turns
    turns[1].content = 'Open [Docs](https://example.com) ' + 'z'.repeat(1000)
    turns[9].content = 'Open [Docs](https://example.com) fresh'
    const plan = planChatMemory({ turns })
    const old = plan.turns.find(t => t.content.startsWith('Open Docs'))!
    expect(old.content.length).toBeLessThanOrEqual(COMPRESSED_ASSISTANT_MAX_CHARS + 1)
    expect(plan.turns[plan.turns.length - 1].content).toContain('(https://example.com)')
    expect(plan.turns.length).toBe(10)
    expect(RECENT_VERBATIM_TURNS).toBe(6)
  })

  it('uses only turns after the summarized prefix, and includes the summary', () => {
    const turns = conversation(10)
    const plan = planChatMemory({ turns, summary: 'user likes rust', summarizedCount: 12 })
    expect(plan.summary).toBe('user likes rust')
    expect(plan.turns.length).toBe(8)
    expect(plan.turns[0].content.startsWith('q6')).toBe(true)
  })

  it('ignores a summary when nothing is marked as summarized', () => {
    expect(planChatMemory({ turns: conversation(1), summary: 'stale', summarizedCount: 0 }).summary).toBe('')
  })

  it('caps unsummarized turns when summarization has not happened', () => {
    const plan = planChatMemory({ turns: conversation(30) })
    expect(plan.turns.length).toBeLessThanOrEqual(SUMMARY_TRIGGER_TURNS)
    expect(plan.turns[plan.turns.length - 1].content.startsWith('a29')).toBe(true)
  })

  it('enforces the character budget by dropping the oldest turns, starting on a user turn', () => {
    const turns = conversation(6, VERBATIM_TURN_MAX_CHARS)
    const plan = planChatMemory({ turns })
    const total = plan.turns.reduce((a, t) => a + t.content.length, 0)
    expect(total).toBeLessThanOrEqual(MEMORY_MAX_CHARS)
    expect(plan.turns[0].role).toBe('user')
    expect(plan.turns[plan.turns.length - 1].content.startsWith('a5')).toBe(true)
  })

  it('skips empty turns', () => {
    const plan = planChatMemory({ turns: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '  ' }] })
    expect(plan.turns).toEqual([{ role: 'user', content: 'q' }])
  })
})

describe('splitForSummary', () => {
  it('does nothing until enough turns pile up', () => {
    expect(splitForSummary(conversation(SUMMARY_TRIGGER_TURNS / 2), 0)).toBeNull()
  })

  it('folds all but the recent turns, splitting on a user boundary', () => {
    const turns = conversation(7) // 14 turns > 12
    const split = splitForSummary(turns, 0)!
    expect(split.newCount).toBe(turns.length - RECENT_VERBATIM_TURNS)
    expect(turns[split.newCount].role).toBe('user')
    expect(split.toSummarize.length).toBe(split.newCount)
  })

  it('only summarizes turns beyond the existing summary', () => {
    const turns = conversation(10) // 20 turns
    const split = splitForSummary(turns, 6)!
    expect(split.toSummarize[0]).toBe(turns[6])
    expect(split.toSummarize.length).toBe(split.newCount - 6)
  })

  it('moves the boundary forward when it would land on an assistant turn', () => {
    const turns = conversation(7)
    turns.pop() // 13 turns; length-6 = 7 is an assistant turn
    const split = splitForSummary(turns, 0)!
    expect(turns[split.newCount].role).toBe('user')
    expect(split.newCount).toBe(8)
  })
})

describe('summary prompt', () => {
  it('includes the previous summary and compressed new turns', () => {
    const p = buildSummaryPrompt('earlier stuff', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'see [A](https://a.com)' },
    ])
    expect(p).toContain('earlier stuff')
    expect(p).toContain('User: hi')
    expect(p).toContain('Assistant: see A')
    expect(p).not.toContain('https://a.com')
    expect(buildSummaryPrompt('', [])).toContain('(none)')
  })

  it('cleans a model-written summary', () => {
    expect(cleanSummary('Updated summary:  The user works on X. ')).toBe('The user works on X.')
    expect(cleanSummary('y'.repeat(SUMMARY_MAX_CHARS + 50)).length).toBe(SUMMARY_MAX_CHARS + 1)
  })
})

describe('buildChatPrompt', () => {
  it('has no memory sections for a fresh conversation', () => {
    const p = buildChatPrompt('- tab', { turns: [] }, 'hi?')
    expect(p).toContain('- tab')
    expect(p).not.toContain('Recent conversation')
    expect(p).not.toContain('Summary of the earlier conversation')
    expect(p.endsWith('User Question: hi?')).toBe(true)
  })

  it('orders summary, recent turns, then the question', () => {
    const p = buildChatPrompt('', {
      turns: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }],
      summary: 'long ago',
      summarizedCount: 0,
    }, 'second')
    // summarizedCount 0 means the summary is not applicable yet
    expect(p).not.toContain('long ago')

    const p2 = buildChatPrompt('', {
      turns: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'older' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }],
      summary: 'long ago',
      summarizedCount: 2,
    }, 'second')
    expect(p2.indexOf('long ago')).toBeLessThan(p2.indexOf('User: first'))
    expect(p2.indexOf('User: first')).toBeLessThan(p2.indexOf('User Question: second'))
    expect(p2).not.toContain('User: old')
  })
})

describe('estimateChatTokens', () => {
  it('combines tab count with planned memory size', () => {
    expect(estimateChatTokens(10, { turns: [] })).toBe(350)
    expect(estimateChatTokens(10, { turns: [{ role: 'user', content: 'a'.repeat(400) }] })).toBe(450)
  })
})

describe('exportChatMarkdown', () => {
  it('renders title, model and roles', () => {
    const md = exportChatMarkdown(
      [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
      { title: 'My chat', model: 'm1', exportedAt: new Date('2026-01-01T00:00:00Z') }
    )
    expect(md).toContain('# My chat')
    expect(md).toContain('Model: m1')
    expect(md).toContain('## You\n\nhello')
    expect(md).toContain('## Assistant\n\nworld')
  })
})
