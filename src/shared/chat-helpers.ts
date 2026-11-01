/**
 * Pure helpers for the Window Chat view: conversation memory, prompt assembly and Markdown export.
 *
 * Memory model (the model call is stateless, so every request re-sends what it needs):
 *   [rolling summary of old turns] + [older unsummarized turns, compressed] + [recent turns, verbatim]
 * Once more than SUMMARY_TRIGGER_TURNS turns are unsummarized, the oldest are folded into the summary.
 */

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp?: number
}

export interface ChatMemory {
  turns: ChatTurn[]
  /** Rolling summary covering the first `summarizedCount` turns. */
  summary?: string
  summarizedCount?: number
}

/** Newest turns always sent verbatim. */
export const RECENT_VERBATIM_TURNS = 6
/** Unsummarized turns allowed before the oldest are folded into the summary. */
export const SUMMARY_TRIGGER_TURNS = 12
export const VERBATIM_TURN_MAX_CHARS = 2000
export const COMPRESSED_USER_MAX_CHARS = 300
export const COMPRESSED_ASSISTANT_MAX_CHARS = 400
export const MEMORY_MAX_CHARS = 8000
export const SUMMARY_MAX_CHARS = 1500
const SUMMARY_INPUT_TURN_MAX_CHARS = 800

const STOPPED_MARKER = /\n*\*\(Generation stopped\)\*\s*$/
// Tab links are redundant in older turns: the tab list is re-sent with every request.
const MARKDOWN_LINK = /\[([^\]]+)\]\(https?:\/\/[^)]*\)/g

export const CHAT_SUGGESTIONS = [
  'Which tabs look the most urgent?',
  'Summarize what I am working on',
  'Find tabs I probably no longer need',
  'Group these tabs by topic',
]

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function clean(content: string): string {
  return content.replace(STOPPED_MARKER, '').trim()
}

/**
 * Shrink a turn that is no longer recent: drop link URLs, collapse blank lines, truncate.
 * @param {string} content
 * @param {number} max
 * @returns {string}
 */
export function compressTurnContent(content: string, max: number): string {
  const text = clean(content).replace(MARKDOWN_LINK, '$1').replace(/\n{3,}/g, '\n\n')
  return truncate(text, max)
}

/**
 * Decide which turns (and which summary) go into the next request, oldest first.
 * @param {ChatMemory} memory
 * @returns {{ summary: string; turns: ChatTurn[] }}
 */
export function planChatMemory(memory: ChatMemory): { summary: string; turns: ChatTurn[] } {
  const start = Math.min(Math.max(memory.summarizedCount ?? 0, 0), memory.turns.length)
  const summary = start > 0 ? (memory.summary ?? '').trim() : ''

  const live = memory.turns.slice(start).slice(-SUMMARY_TRIGGER_TURNS)
  const recentStart = Math.max(0, live.length - RECENT_VERBATIM_TURNS)

  let planned: ChatTurn[] = []
  live.forEach((turn, i) => {
    const content = i < recentStart
      ? compressTurnContent(turn.content, turn.role === 'user' ? COMPRESSED_USER_MAX_CHARS : COMPRESSED_ASSISTANT_MAX_CHARS)
      : truncate(clean(turn.content), VERBATIM_TURN_MAX_CHARS)
    if (content) planned.push({ role: turn.role, content })
  })

  // Enforce the character budget by dropping the oldest turns first (always keep the newest).
  let used = planned.reduce((acc, t) => acc + t.content.length, 0)
  while (planned.length > 1 && used > MEMORY_MAX_CHARS) {
    used -= planned[0].content.length
    planned = planned.slice(1)
  }
  // A transcript that opens with an assistant reply reads oddly; start on a user turn.
  while (planned.length > 0 && planned[0].role !== 'user') planned = planned.slice(1)

  return { summary, turns: planned }
}

/**
 * If enough unsummarized turns have piled up, return the ones to fold into the summary
 * and the new covered count. Splits on a user-turn boundary so a Q/A pair is never cut.
 * @param {ChatTurn[]} turns
 * @param {number} summarizedCount
 * @returns {{ toSummarize: ChatTurn[]; newCount: number } | null}
 */
export function splitForSummary(turns: ChatTurn[], summarizedCount: number): { toSummarize: ChatTurn[]; newCount: number } | null {
  const start = Math.min(Math.max(summarizedCount, 0), turns.length)
  if (turns.length - start <= SUMMARY_TRIGGER_TURNS) return null

  let end = turns.length - RECENT_VERBATIM_TURNS
  while (end < turns.length && turns[end].role !== 'user') end++
  if (end >= turns.length || end <= start) return null

  return { toSummarize: turns.slice(start, end), newCount: end }
}

/**
 * Prompt asking the model to fold new turns into the running summary.
 * @param {string} previousSummary
 * @param {ChatTurn[]} turns
 * @returns {string}
 */
export function buildSummaryPrompt(previousSummary: string, turns: ChatTurn[]): string {
  const transcript = turns
    .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${compressTurnContent(t.content, SUMMARY_INPUT_TURN_MAX_CHARS)}`)
    .join('\n\n')
  return `You maintain a running summary of a conversation between a user and a browser tab assistant.
Merge the new messages into the existing summary. Keep what matters for future questions: the user's goals, preferences, decisions, and which tabs (by title) were discussed and what was concluded. Drop pleasantries and anything that is just a restatement of the tab list. Write plain text, at most 150 words, no preamble.

Existing summary:
${previousSummary.trim() || '(none)'}

New messages:
${transcript}

Updated summary:`
}

/**
 * Normalize a model-written summary.
 * @param {string} raw
 * @returns {string}
 */
export function cleanSummary(raw: string): string {
  return truncate(raw.replace(/^\s*(updated )?summary:\s*/i, '').trim(), SUMMARY_MAX_CHARS)
}

/**
 * Build the single-string prompt sent to the model: tab context, memory, then the new question.
 * @param {string} tabsContext
 * @param {ChatMemory} memory
 * @param {string} question
 * @param {string} [extraInstructions] Appended to the system part (e.g. the tool protocol).
 * @returns {string}
 */
export function buildChatPrompt(tabsContext: string, memory: ChatMemory, question: string, extraInstructions = ''): string {
  const systemPrompt = `You are a browser tab assistant. The user will ask questions about their current browser tabs.
Here is the list of tabs in scope:

${tabsContext}

Answer the user's question concisely based on the provided list of tabs. You MUST format any mentioned tabs as markdown links using their exact URL, e.g., [Tab Title](https://example.com). You can use basic markdown like **bold** and *italic*.${extraInstructions}`

  const plan = planChatMemory(memory)
  let memoryText = ''
  if (plan.summary) memoryText += `\n\nSummary of the earlier conversation:\n${plan.summary}`
  if (plan.turns.length > 0) {
    memoryText += `\n\nRecent conversation:\n${plan.turns.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n')}`
  }

  return `${systemPrompt}${memoryText}\n\nUser Question: ${question}`
}

/**
 * Rough input-token estimate for the tab list plus the memory that would be sent.
 * @param {number} tabCount
 * @param {ChatMemory} memory
 * @returns {number}
 */
export function estimateChatTokens(tabCount: number, memory: ChatMemory): number {
  const plan = planChatMemory(memory)
  const chars = plan.summary.length + plan.turns.reduce((acc, t) => acc + t.content.length, 0)
  return Math.round(tabCount * 35 + chars / 4)
}

/**
 * Render a conversation as Markdown for export.
 * @param {ChatTurn[]} turns
 * @param {{ title?: string; model?: string; exportedAt?: Date }} [meta]
 * @returns {string}
 */
export function exportChatMarkdown(turns: ChatTurn[], meta: { title?: string; model?: string; exportedAt?: Date } = {}): string {
  const when = (meta.exportedAt ?? new Date()).toISOString()
  const lines = [`# ${meta.title || 'Window Chat'}`, '', `Exported: ${when}`]
  if (meta.model) lines.push(`Model: ${meta.model}`)
  for (const t of turns) {
    lines.push('', `## ${t.role === 'user' ? 'You' : 'Assistant'}`)
    if (t.timestamp) lines.push(`*${new Date(t.timestamp).toISOString()}*`)
    lines.push('', t.content)
  }
  return lines.join('\n') + '\n'
}
