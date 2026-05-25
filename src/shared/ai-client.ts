import type { AIConfig, AIGroupResult, ChromeTabGroupColor, GroupCategory } from './types'
import { DEFAULT_GROUPING_PROMPT } from './constants'
import { getAutoBatchSize } from './utils'

export const SYSTEM_PROMPT = 'You are a helpful assistant that classifies browser tabs into categories. Be concise.'

const DEFAULT_MODELS: Record<AIConfig['provider'], string> = {
  openai: 'gpt-4o-mini',
  claude: 'claude-sonnet-4-20250514',
  gemini: 'gemini-3.5-flash',
  custom: 'gpt-4o-mini',
}

const VALID_COLORS: ChromeTabGroupColor[] = [
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan',
]

const MAX_GROUP_NAME_LENGTH = 40


/**
 * Unified AI client that supports OpenAI, Claude, Gemini, and custom endpoints.
 */
export class AIClient {
  private config: AIConfig
  private signal?: AbortSignal

  constructor(config: AIConfig, signal?: AbortSignal) {
    this.config = config
    this.signal = signal
  }

  /**
   * Test the connection with a simple request.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.chat('Respond with exactly: OK')
      return { ok: response.includes('OK') }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Classify tabs that the rule engine couldn't confidently categorize.
   */
  async classifyTabs(
    tabs: { url: string; title: string }[],
    categories: GroupCategory[],
    stripTitles = false,
  ): Promise<Map<string, GroupCategory>> {
    if (tabs.length === 0) return new Map()

    const tabDescriptions = tabs
      .map((t, i) => this.formatTabForPrompt(t, i + 1, stripTitles))
      .join('\n')

    const prompt = `Classify each browser tab into one of these categories: ${categories.join(', ')}.

Tabs:
${tabDescriptions}

Respond with a JSON array where each element has "index" (1-based) and "category". Example:
[{"index": 1, "category": "dev"}, {"index": 2, "category": "media"}]

Only output the JSON array, no other text.`

    try {
      const response = await this.chat(prompt)

      // Parse response
      const result = new Map<string, GroupCategory>()
      try {
        const jsonMatch = response.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { index: number; category: string }[]
          for (const item of parsed) {
            const tab = tabs[item.index - 1]
            if (tab && categories.includes(item.category as GroupCategory)) {
              result.set(tab.url, item.category as GroupCategory)
            }
          }
        }
      } catch (err) {
        console.error('[TabPilot] Failed to parse AI response. Error:', err, 'Response:', response)
      }

      return result
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[TabPilot] Prompt blocked due to sensitive content in fallback, retrying with URLs only...')
        return this.classifyTabs(tabs, categories, true)
      }
      throw err
    }
  }

  /**
   * Let AI freely group tabs into dynamic groups with custom names and colors.
   * Splits into batches when tab count exceeds BATCH_SIZE.
   */
  async groupTabsFreely(
    tabs: { url: string; title: string }[],
  ): Promise<AIGroupResult[]> {
    if (tabs.length === 0) return []

    const batchSize = this.config.batchSize || getAutoBatchSize(this.config.maxTokens)

    if (tabs.length <= batchSize) {
      return this.groupTabsBatch(tabs, 0)
    }

    const allResults: AIGroupResult[] = []
    for (let i = 0; i < tabs.length; i += batchSize) {
      const batch = tabs.slice(i, i + batchSize)
      const existingGroupNames = allResults.map((r) => r.name)
      const batchResults = await this.groupTabsBatch(batch, i, existingGroupNames)
      
      // Merge batch results into allResults based on case-insensitive group name
      for (const group of batchResults) {
        const lowerName = group.name.trim().toLowerCase()
        const existing = allResults.find((r) => r.name.trim().toLowerCase() === lowerName)
        if (existing) {
          existing.tabIndices.push(...group.tabIndices)
        } else {
          allResults.push(group)
        }
      }
    }
    return allResults
  }

  private formatTabForPrompt(tab: { url: string; title: string }, index: number, stripTitles = false): string {
    const domain = new URL(tab.url).hostname.replace(/^www\./, '')
    if (stripTitles) {
      return `${index}. (${domain})`
    }
    const shortTitle = tab.title.length > 40 ? tab.title.slice(0, 40) + '…' : tab.title
    return `${index}. ${shortTitle} (${domain})`
  }

  private async groupTabsBatch(
    tabs: { url: string; title: string }[],
    offset: number,
    existingGroupNames: string[] = [],
    stripTitles = false,
  ): Promise<AIGroupResult[]> {
    const tabDescriptions = tabs
      .map((t, i) => this.formatTabForPrompt(t, offset + i + 1, stripTitles))
      .join('\n')

    const groupingPrompt = this.config.groupingPrompt?.trim() || DEFAULT_GROUPING_PROMPT
    
    let existingGroupsPrompt = ''
    if (existingGroupNames.length > 0) {
      const coherenceInstruction = this.config.coherencePrompt?.trim() || 'You should prioritize placing tabs into these existing groups if they fit, rather than creating new, redundant groups.'
      existingGroupsPrompt = `\n\nExisting groups created in previous batches: ${existingGroupNames.map(name => `"${name}"`).join(', ')}.\n${coherenceInstruction}`
    }

    const prompt = `${groupingPrompt}${existingGroupsPrompt}
Colors: grey,blue,red,yellow,green,pink,purple,cyan

Tabs:
${tabDescriptions}

JSON format: [{"name":"...","color":"...","tabIndices":[1,2]}]`

    try {
      const response = await this.chat(prompt, true)
      return this.parseFreeGroupResponse(response, offset + tabs.length, offset + 1)
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[TabPilot] Prompt blocked due to sensitive content, retrying with URLs only...')
        return this.groupTabsBatch(tabs, offset, existingGroupNames, true)
      }
      throw err
    }
  }

  private parseFreeGroupResponse(response: string, maxIndex: number, minIndex = 1): AIGroupResult[] {
    // Strip markdown code fences if present
    let cleaned = response.trim()
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim()
    }

    // Find the start of the JSON array
    const startIdx = cleaned.indexOf('[')
    if (startIdx === -1) {
      throw new Error(`No JSON array found in AI response: ${response.slice(0, 200)}`)
    }

    let jsonStr = cleaned.slice(startIdx)

    // Clean trailing commas before ] or } (common LLM mistake)
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1')

    // Try to parse directly first
    let parsed: { name: string; tabIndices: number[]; color?: string }[]
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      try {
        const repaired = repairTruncatedJson(jsonStr)
        parsed = JSON.parse(repaired)
      } catch (err) {
        throw new Error(`Failed to parse AI JSON after repair: ${(err as Error).message}. Original: ${jsonStr.slice(0, 200)}`)
      }
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('AI returned empty or invalid groups')
    }

    const assignedIndices = new Set<number>()
    const results: AIGroupResult[] = []

    for (let gi = 0; gi < parsed.length; gi++) {
      const group = parsed[gi]
      if (!group.name || !Array.isArray(group.tabIndices)) continue

      const validIndices: number[] = []
      for (const idx of group.tabIndices) {
        if (idx >= minIndex && idx <= maxIndex && !assignedIndices.has(idx)) {
          assignedIndices.add(idx)
          validIndices.push(idx)
        }
      }

      if (validIndices.length === 0) continue

      const color: ChromeTabGroupColor = VALID_COLORS.includes(group.color as ChromeTabGroupColor)
        ? (group.color as ChromeTabGroupColor)
        : VALID_COLORS[gi % VALID_COLORS.length]

      results.push({
        name: group.name.slice(0, MAX_GROUP_NAME_LENGTH),
        tabIndices: validIndices,
        color,
      })
    }

    // Collect unassigned tabs into an "Other" group
    const unassigned: number[] = []
    for (let i = minIndex; i <= maxIndex; i++) {
      if (!assignedIndices.has(i)) unassigned.push(i)
    }
    if (unassigned.length > 0) {
      results.push({ name: 'Other', tabIndices: unassigned, color: 'grey' })
    }

    return results
  }

  /**
   * Classify new tabs into existing groups by name.
   * Returns a map of tab index (0-based) to target group name,
   * or a new group descriptor if no existing group fits.
   */
  async classifyNewTabsIntoGroups(
    tabs: { url: string; title: string }[],
    existingGroupNames: string[],
    stripTitles = false,
  ): Promise<{ index: number; group: string; newGroupName?: string; newGroupColor?: string }[]> {
    if (tabs.length === 0) return []

    const tabDescriptions = tabs
      .map((t, i) => this.formatTabForPrompt(t, i + 1, stripTitles))
      .join('\n')

    const classifyPrompt = this.config.classifyPrompt?.trim() || 'You are classifying new tabs. Decide if each new tab belongs to one of the existing groups or if a new group should be created. Be conservative about creating new groups.'

    const prompt = `${classifyPrompt}

I have these existing tab groups: ${existingGroupNames.map((n) => `"${n}"`).join(', ')}.

New tabs to classify:
${tabDescriptions}

For each tab, decide which existing group it belongs to. If none fit, use "NEW" and suggest a name and color.
Colors: grey,blue,red,yellow,green,pink,purple,cyan

JSON format: [{"index":1,"group":"existing group name"}] or [{"index":2,"group":"NEW","newGroupName":"...","newGroupColor":"blue"}]
Only output the JSON array.`

    try {
      const response = await this.chat(prompt, true)

      const cleaned = response.trim()
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return this.fallbackAllToNew(tabs)

      let jsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, '$1')
      const parsed = JSON.parse(jsonStr) as {
        index: number
        group: string
        newGroupName?: string
        newGroupColor?: string
      }[]

      const validGroupNames = new Set(existingGroupNames)
      return parsed
        .filter((item) => item.index >= 1 && item.index <= tabs.length)
        .map((item) => ({
          index: item.index - 1,
          group: item.group === 'NEW' ? 'NEW' : (validGroupNames.has(item.group) ? item.group : 'NEW'),
          newGroupName: item.newGroupName?.slice(0, MAX_GROUP_NAME_LENGTH),
          newGroupColor: VALID_COLORS.includes(item.newGroupColor as ChromeTabGroupColor)
            ? item.newGroupColor
            : undefined,
        }))
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[TabPilot] Prompt blocked due to sensitive content in classification, retrying with URLs only...')
        return this.classifyNewTabsIntoGroups(tabs, existingGroupNames, true)
      }
      console.error('[TabPilot] Failed to parse classify-new-tabs response. Error:', err)
      return this.fallbackAllToNew(tabs)
    }
  }

  private fallbackAllToNew(tabs: { url: string; title: string }[]): { index: number; group: string }[] {
    return tabs.map((_, i) => ({ index: i, group: 'NEW', newGroupName: 'Uncategorized', newGroupColor: 'grey' }))
  }

  /**
   * Generate embeddings for semantic search (OpenAI only).
   */
  async getEmbeddings(texts: string[]): Promise<number[][] | null> {
    if (this.config.provider !== 'openai') return null

    try {
      const response = await fetch(`${this.getBaseUrl()}/embeddings`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: texts,
        }),
        signal: this.signal,
      })

      if (!response.ok) return null

      const data = await response.json()
      return data.data.map((d: { embedding: number[] }) => d.embedding)
    } catch (err) {
      console.error('[TabPilot] Failed to get embeddings:', err)
      return null
    }
  }

  /**
   * Send a chat completion request.
   */
  private async chat(userMessage: string, jsonMode?: boolean): Promise<string> {
    const { provider } = this.config

    if (provider === 'claude') {
      return this.chatClaude(userMessage, jsonMode)
    }

    if (provider === 'gemini') {
      return this.chatGemini(userMessage, jsonMode)
    }

    // OpenAI / Custom (OpenAI-compatible)
    return this.chatOpenAI(userMessage, jsonMode)
  }

  private get defaultModel(): string {
    return DEFAULT_MODELS[this.config.provider]
  }

  private get systemPrompt(): string {
    if (this.config.customPrompt?.trim()) {
      return `${SYSTEM_PROMPT}\n\nUser Instructions:\n${this.config.customPrompt.trim()}`
    }
    return SYSTEM_PROMPT
  }

  private async chatOpenAI(userMessage: string, jsonMode?: boolean): Promise<string> {
    const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.config.model || this.defaultModel,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0,
        max_tokens: this.config.maxTokens || 16384,
        ...(jsonMode && { response_format: { type: 'json_object' } }),
      }),
      signal: this.signal,
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`API error ${response.status}: ${err}`)
    }

    const data = await response.json()
    const choice = data.choices?.[0]
    if (choice) {
      const finishReason = choice.finish_reason
      if (finishReason === 'length') {
        throw new Error('AI response was cut off: Exceeded output token limit ("finish_reason": "length").')
      } else if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
        throw new Error(`AI response failed: ${finishReason}`)
      }
    }
    return choice?.message?.content || ''
  }

  private async chatClaude(userMessage: string, jsonMode?: boolean): Promise<string> {
    const baseUrl = this.config.endpoint || 'https://api.anthropic.com'
    const messages: { role: string; content: string }[] = [
      { role: 'user', content: userMessage },
      ...(jsonMode ? [{ role: 'assistant', content: '[' }] : []),
    ]
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.config.model || this.defaultModel,
        max_tokens: this.config.maxTokens || 16384,
        system: this.systemPrompt,
        messages,
      }),
      signal: this.signal,
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`API error ${response.status}: ${err}`)
    }

    const data = await response.json()
    const stopReason = data.stop_reason
    if (stopReason === 'max_tokens') {
      throw new Error('AI response was cut off: Exceeded output token limit ("stop_reason": "max_tokens").')
    } else if (stopReason && stopReason !== 'end_turn' && stopReason !== 'stop_sequence') {
      throw new Error(`AI response failed: ${stopReason}`)
    }
    const text = data.content?.[0]?.text || ''
    return jsonMode ? '[' + text : text
  }

  private async chatGemini(userMessage: string, jsonMode?: boolean): Promise<string> {
    const baseUrl = this.config.endpoint || 'https://generativelanguage.googleapis.com'
    const model = this.config.model || this.defaultModel
    const response = await fetch(
      `${baseUrl}/v1beta/models/${model}:generateContent?key=${this.config.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: this.systemPrompt }],
          },
          contents: [
            { role: 'user', parts: [{ text: userMessage }] },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: this.config.maxTokens || 16384,
            ...(jsonMode && { responseMimeType: 'application/json' }),
          },
        }),
        signal: this.signal,
      },
    )

    if (!response.ok) {
      const errText = await response.text()
      try {
        const parsed = JSON.parse(errText)
        if (parsed.promptFeedback?.blockReason === 'PROHIBITED_CONTENT' || parsed.error?.message?.includes('PROHIBITED_CONTENT')) {
          throw new Error(`PROHIBITED_CONTENT: ${parsed.promptFeedback?.blockReasonMessage || parsed.error?.message || 'Prohibited content blocked.'}`)
        }
      } catch {
        // Not JSON
      }
      throw new Error(`API error ${response.status}: ${errText}`)
    }

    const data = await response.json()
    
    // Check if the prompt itself was blocked by safety filters
    if (data.promptFeedback?.blockReason === 'PROHIBITED_CONTENT') {
      throw new Error(`PROHIBITED_CONTENT: ${data.promptFeedback.blockReasonMessage || 'Prohibited content blocked.'}`)
    }

    const candidate = data.candidates?.[0]
    if (candidate) {
      const finishReason = candidate.finishReason
      if (finishReason === 'MAX_TOKENS') {
        throw new Error('AI response was cut off: Exceeded output token limit ("finishReason": "MAX_TOKENS").')
      } else if (finishReason && finishReason !== 'STOP') {
        throw new Error(`AI response failed: ${finishReason}`)
      }
    }
    return candidate?.content?.parts?.[0]?.text || ''
  }

  private getBaseUrl(): string {
    return this.config.endpoint || 'https://api.openai.com/v1'
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    }
  }
}

/**
 * Repairs a truncated JSON string by slicing up to the last known structural boundary
 * and closing all open strings, arrays, and objects.
 */
export function repairTruncatedJson(jsonStr: string): string {
  let str = jsonStr.trim()
  if (!str.startsWith('[') && !str.startsWith('{')) {
    return str
  }

  let inString = false
  let escaped = false
  const stack: ('[' | '{')[] = []
  let cleanEndIndex = 0

  for (let i = 0; i < str.length; i++) {
    const char = str[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      if (!inString) {
        cleanEndIndex = i + 1
      }
      continue
    }

    if (inString) {
      continue
    }

    if (char === '[' || char === '{') {
      stack.push(char)
      cleanEndIndex = i + 1
      continue
    }

    if (char === ']' || char === '}') {
      const top = stack.pop()
      if ((char === ']' && top === '[') || (char === '}' && top === '{')) {
        cleanEndIndex = i + 1
      }
      continue
    }

    if (char === ',' || char === ':') {
      continue
    }

    if (/\d/.test(char) || char === '-' || char === '.' || char === 't' || char === 'f' || char === 'n') {
      cleanEndIndex = i + 1
    }
  }

  let repaired = str.slice(0, cleanEndIndex).trim()
  repaired = repaired.replace(/[:,]+$/, '').trim()

  const finalStack: ('[' | '{')[] = []
  let finalInString = false
  let finalEscaped = false

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i]
    if (finalEscaped) {
      finalEscaped = false
      continue
    }
    if (char === '\\') {
      finalEscaped = true
      continue
    }
    if (char === '"') {
      finalInString = !finalInString
      continue
    }
    if (finalInString) {
      continue
    }
    if (char === '[' || char === '{') {
      finalStack.push(char)
    }
    if (char === ']' || char === '}') {
      finalStack.pop()
    }
  }

  if (finalInString) {
    repaired += '"'
  }

  while (finalStack.length > 0) {
    const top = finalStack.pop()
    if (top === '[') repaired += ']'
    if (top === '{') repaired += '}'
  }

  return repaired
}
