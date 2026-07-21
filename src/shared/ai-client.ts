import type { AIConfig, AIGroupResult, ChromeTabGroupColor, GroupCategory } from './types'
import { DEFAULT_GROUPING_PROMPT, MODEL_PRICING, PROVIDER_DEFAULTS, DEFAULT_MODELS, DEFAULT_ENDPOINTS } from './constants'
import { getAutoBatchSize } from './utils'

export const SYSTEM_PROMPT = 'You are a helpful assistant that classifies browser tabs into categories. Be concise.'



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

  // Safety safeguards to prevent runaway token billing and mass API loops
  private static globalRequestTimestamps: number[] = []
  private instanceRequestCount = 0

  static readonly MAX_REQUESTS_PER_RUN = 15
  static readonly MAX_REQUESTS_PER_MINUTE = 30

  constructor(config: AIConfig, signal?: AbortSignal) {
    this.config = config
    this.signal = signal
  }

  /**
   * Universal token and cost estimator for UI components.
   * Calculates lengths exactly based on the built prompt structure.
   */
  static estimateCostAndTokens(
    config: AIConfig,
    tabsCount: number,
    type: 'group' | 'split' | 'merge' | 'classify',
    modelOverride?: string,
    providerOverride?: string,
    existingGroupNames: string[] = []
  ) {
    if (tabsCount === 0) {
      return { tokens: 0, costStr: 'Free', tokensPerRequest: 0, requests: 0 }
    }

    const batchSize = config.batchSize || getAutoBatchSize(config.maxTokens)
    const batches = Math.ceil(tabsCount / batchSize)

    let systemPrompt = 'You are a helpful assistant that classifies browser tabs into categories. Be concise.'
    if (config.customPrompt?.trim()) {
      systemPrompt += `\n\nUser Instructions:\n${config.customPrompt.trim()}`
    }

    let userPrompt = ''
    let baseUserPromptExtra = ''

    if (type === 'group') {
      userPrompt = config.groupingPrompt?.trim() || DEFAULT_GROUPING_PROMPT
      if (existingGroupNames.length > 0) {
        const coherenceInstruction = config.coherencePrompt?.trim() || 'You should try to place tabs into these existing groups if they are a strong semantic fit. However, if the existing groups are a poor fit or if the previous grouping structure seems bad, feel free to create a new group. Do not force tabs into mismatched groups.'
        baseUserPromptExtra = `\n\nExisting groups created in previous batches: ${existingGroupNames.map(name => `"${name}"`).join(', ')}.\n${coherenceInstruction}`
      }
    } else if (type === 'split') {
      userPrompt = config.splitPrompt?.trim() || 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.'
    } else if (type === 'merge') {
      userPrompt = config.mergePrompt?.trim() || 'Analyze the browser tabs of this group and decide if they should be merged into one of the other existing tab groups. Choose the best fitting existing group from the list. If none of the existing groups are a good fit and this group should remain separate, respond with "KEEP". Be conservative about merging; only merge if the topics are highly related.'
    } else if (type === 'classify') {
      userPrompt = config.classifyPrompt?.trim() || 'You are classifying new tabs. Decide if each new tab belongs to one of the existing groups or if a new group should be created. Be conservative about creating new groups.'
      if (existingGroupNames.length > 0) {
        baseUserPromptExtra = '\n\nExisting Groups: ' + existingGroupNames.join(', ')
      }
    }

    // Include the boilerplate formatting length
    const formatInstructionLen = '\nColors: grey,blue,red,yellow,green,pink,purple,cyan\n\nTabs:\n\n\nJSON format: [{"name":"...","color":"...","tabIndices":[1,2]}]'.length

    let model = modelOverride
    if (!model) {
      model = config.model || DEFAULT_MODELS[providerOverride || config.provider] || 'gpt-4o-mini'
    }

    const promptLen = systemPrompt.length + userPrompt.length + baseUserPromptExtra.length + formatInstructionLen
    const promptTokens = Math.ceil(promptLen / 4)
    
    // Increase baseline token multiplier since URLs and Titles tend to consume more tokens than expected
    const tokenMultiplier = config.sendFullUrl ? 110 : 35
    
    const inputTokens = batches * promptTokens + tabsCount * tokenMultiplier
    
    // Estimate output tokens - JSON formatting takes space, plus thought tokens for reasoning models
    let outputTokens = batches * 150 + tabsCount * 10
    if (model.includes('pro') || model.includes('preview') || model.includes('thinking') || model.includes('opus')) {
      // Reasoning/Pro models often use thought traces or elaborate reasoning which are billed as output tokens
      outputTokens += batches * 4500
    } else if (model.includes('gemini-3') || model.includes('gemini-2')) {
      // Newer Gemini Flash models also use thought tokens, but generally fewer than Pro models
      outputTokens += batches * 2000
    }
    
    const totalTokens = inputTokens + outputTokens
    
    // Import MODEL_PRICING and PROVIDER_DEFAULTS dynamically to avoid circular dependencies if any
    const provider = providerOverride || config.provider
    
    let rates = MODEL_PRICING[model]
    if (!rates) {
      rates = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai
    }
    
    const cost = (inputTokens * rates.input + outputTokens * rates.output) / 1000000
    
    let costStr = ''
    if (cost === 0) costStr = 'Free'
    else if (cost < 0.0001) costStr = '< $0.0001'
    else costStr = `~$${cost.toFixed(4)}`
    
    return { 
      tokens: totalTokens, 
      costStr, 
      tokensPerRequest: Math.round(totalTokens / batches),
      requests: batches 
    }
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
        console.error('[timTabTool] Failed to parse AI response. Error:', err, 'Response:', response)
      }

      return result
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[timTabTool] Prompt blocked due to sensitive content in fallback, retrying with URLs only...')
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
    const requiredBatches = Math.ceil(tabs.length / batchSize)

    // Fail early before initiating any network calls if total batches exceed safety limit
    if (!this.config.bypassSafeguards && this.instanceRequestCount + requiredBatches > AIClient.MAX_REQUESTS_PER_RUN) {
      throw new Error(`[timTabTool] AI safety safeguard: Single operation exceeded the safety limit of ${AIClient.MAX_REQUESTS_PER_RUN} requests to prevent run-away token billing. Please close some tabs or group in smaller batches.`)
    }

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
    let urlString = tab.url || ''
    let domain = ''
    try {
      domain = new URL(urlString).hostname.replace(/^www\./, '')
    } catch {
      domain = urlString
    }

    if (stripTitles) {
      if (this.config.sendFullUrl) {
        return `${index}. (URL: ${urlString})`
      }
      return `${index}. (${domain})`
    }

    const shortTitle = tab.title.length > 40 ? tab.title.slice(0, 40) + '…' : tab.title
    if (this.config.sendFullUrl) {
      return `${index}. ${shortTitle} (URL: ${urlString})`
    }
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

    const userPrompt = this.config.groupingPrompt?.trim() || DEFAULT_GROUPING_PROMPT
    const groupingPrompt = (userPrompt !== DEFAULT_GROUPING_PROMPT)
      ? `CRITICAL USER INSTRUCTION FOR TAB GROUPING:\n"${userPrompt}"\nOrganize the tabs into groups strictly adhering to this instruction. Every tab must belong to a group that follows this directive.`
      : userPrompt
    
    let existingGroupsPrompt = ''
    if (existingGroupNames.length > 0) {
      const coherenceInstruction = this.config.coherencePrompt?.trim() || 'You should try to place tabs into these existing groups if they are a strong semantic fit. However, if the existing groups are a poor fit or if the previous grouping structure seems bad, feel free to create a new group. Do not force tabs into mismatched groups.'
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
        console.warn('[timTabTool] Prompt blocked due to sensitive content, retrying with URLs only...')
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
        console.warn('[timTabTool] Prompt blocked due to sensitive content in classification, retrying with URLs only...')
        return this.classifyNewTabsIntoGroups(tabs, existingGroupNames, true)
      }
      console.error('[timTabTool] Failed to parse classify-new-tabs response. Error:', err)
      return this.fallbackAllToNew(tabs)
    }
  }

  /**
   * Decide if the given group should be merged into one of the other existing groups.
   * Returns the name of the target group to merge into, or "KEEP" if it should remain separate.
   */
  async decideMergeGroup(
    tabs: { url: string; title: string }[],
    existingGroupNames: string[],
    stripTitles = false,
  ): Promise<string> {
    if (tabs.length === 0 || existingGroupNames.length === 0) return 'KEEP'

    const tabDescriptions = tabs
      .map((t, i) => this.formatTabForPrompt(t, i + 1, stripTitles))
      .join('\n')

    const mergePrompt = this.config.mergePrompt?.trim() || 'Analyze the browser tabs of this group and decide if they should be merged into one of the other existing tab groups. Choose the best fitting existing group from the list. If none of the existing groups are a good fit and this group should remain separate, respond with "KEEP". Be conservative about merging; only merge if the topics are highly related.'

    const prompt = `${mergePrompt}

Existing tab groups in this window: ${existingGroupNames.map((n) => `"${n}"`).join(', ')}.

Tabs in the group to merge:
${tabDescriptions}

JSON format: {"mergeTarget":"existing group name or KEEP"}
Only output the JSON object.`

    try {
      const response = await this.chat(prompt, true)
      const cleaned = response.trim()
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return 'KEEP'

      const parsed = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, '$1')) as { mergeTarget: string }
      const target = parsed.mergeTarget || 'KEEP'
      const validNames = new Set(existingGroupNames.map(n => n.toLowerCase()))
      if (target !== 'KEEP' && validNames.has(target.toLowerCase())) {
        // Find matching target with original casing
        return existingGroupNames.find(n => n.toLowerCase() === target.toLowerCase()) || 'KEEP'
      }
      return 'KEEP'
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[timTabTool] Prompt blocked in merge analysis, retrying with URLs only...')
        return this.decideMergeGroup(tabs, existingGroupNames, true)
      }
      console.error('[timTabTool] Failed to decide merge group. Error:', err)
      return 'KEEP'
    }
  }

  private fallbackAllToNew(tabs: { url: string; title: string }[]): { index: number; group: string }[] {
    return tabs.map((_, i) => ({ index: i, group: 'NEW', newGroupName: 'Uncategorized', newGroupColor: 'grey' }))
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = this.config.maxRetries !== undefined ? this.config.maxRetries : 2
    const isTest = typeof (globalThis as any).process !== 'undefined' && (globalThis as any).process?.env?.NODE_ENV === 'test'
    let delay = isTest ? 1 : 1000

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Enforce rate limiting and operation safeguards before calling the API
        this.checkRequestSafeguards()
        AIClient.recordGlobalRequest()
        this.instanceRequestCount++

        return await fn()
      } catch (err) {
        const errorMsg = (err as Error).message || String(err)

        // Don't retry if aborted by user or blocked by safety safeguards
        if (errorMsg.includes('AI safety safeguard')) {
          throw err
        }

        if (this.signal?.aborted || errorMsg.includes('aborted') || errorMsg.includes('AbortError')) {
          throw err
        }

        // Permanent API failures should not retry (e.g. prohibited content, 400 Bad Request, 401 Unauthorized, 403 Forbidden)
        const isPermanent = 
          errorMsg.includes('PROHIBITED_CONTENT') || 
          errorMsg.includes('Prohibited Use policy') || 
          errorMsg.includes('promptFeedback') ||
          errorMsg.includes('API error 400') ||
          errorMsg.includes('API error 401') ||
          errorMsg.includes('API error 403')

        if (isPermanent || attempt === maxRetries) {
          throw err
        }

        console.warn(`[timTabTool] AI API call failed: ${errorMsg}. Retrying in ${delay}ms... (Attempt ${attempt + 1}/${maxRetries})`)

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (this.signal?.aborted) {
              reject(new Error('aborted'))
            } else {
              resolve()
            }
          }, delay)

          if (this.signal) {
            this.signal.addEventListener('abort', () => {
              clearTimeout(timeout)
              reject(new Error('aborted'))
            })
          }
        })

        delay *= 2
      }
    }
    throw new Error('executeWithRetry: unreachable')
  }

  /**
   * Enforces safety budget limitations on AI API requests to prevent run-away billing.
   */
  private checkRequestSafeguards(): void {
    if (this.config.bypassSafeguards) return

    // 1. Instance limit check (per operation run)
    if (this.instanceRequestCount >= AIClient.MAX_REQUESTS_PER_RUN) {
      throw new Error(`[timTabTool] AI safety safeguard: Single operation exceeded the safety limit of ${AIClient.MAX_REQUESTS_PER_RUN} requests to prevent run-away token billing. Please close some tabs or group in smaller batches.`)
    }

    // 2. Rolling window minute limit check (global extension throttle)
    const now = Date.now()
    AIClient.globalRequestTimestamps = AIClient.globalRequestTimestamps.filter(
      (t) => now - t < 60000
    )

    if (AIClient.globalRequestTimestamps.length >= AIClient.MAX_REQUESTS_PER_MINUTE) {
      throw new Error(`[timTabTool] AI safety safeguard: Global rate limit exceeded (${AIClient.MAX_REQUESTS_PER_MINUTE} requests/min) to prevent run-away mass token consumption. Please wait a moment before trying again.`)
    }
  }

  private static recordGlobalRequest(): void {
    AIClient.globalRequestTimestamps.push(Date.now())
  }

  /**
   * Generate embeddings for semantic search (OpenAI only).
   */
  async getEmbeddings(texts: string[]): Promise<number[][] | null> {
    if (this.config.provider !== 'openai') return null

    try {
      return await this.executeWithRetry(async () => {
        const response = await fetch(`${this.getBaseUrl()}/embeddings`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: texts,
          }),
          signal: this.signal,
        })

        if (!response.ok) {
          let err = await response.text()
          if (!err.trim()) {
            err = response.statusText || 'Unknown Error'
          }
          throw new Error(`API error ${response.status}: ${err}`)
        }

        const data = await response.json()
        return data.data.map((d: { embedding: number[] }) => d.embedding)
      })
    } catch (err) {
      console.error('[timTabTool] Failed to get embeddings:', err)
      return null
    }
  }

  /**
   * Send a chat completion request.
   */
  private async chat(userMessage: string, jsonMode?: boolean): Promise<string> {
    return this.executeWithRetry(async () => {
      const { provider } = this.config

      if (provider === 'claude') {
        return this.chatClaude(userMessage, jsonMode)
      }

      if (provider === 'gemini') {
        return this.chatGemini(userMessage, jsonMode)
      }

      // OpenAI / Custom (OpenAI-compatible)
      return this.chatOpenAI(userMessage, jsonMode)
    })
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
      let err = await response.text()
      if (!err.trim()) {
        err = response.statusText || 'Unknown Error'
      }
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
    const baseUrl = this.config.endpoint || DEFAULT_ENDPOINTS.claude
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
      let err = await response.text()
      if (!err.trim()) {
        err = response.statusText || 'Unknown Error'
      }
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
    const baseUrl = this.config.endpoint || DEFAULT_ENDPOINTS.gemini
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
      let errText = await response.text()
      try {
        const parsed = JSON.parse(errText)
        if (parsed.promptFeedback?.blockReason === 'PROHIBITED_CONTENT' || parsed.error?.message?.includes('PROHIBITED_CONTENT')) {
          throw new Error(`PROHIBITED_CONTENT: ${parsed.promptFeedback?.blockReasonMessage || parsed.error?.message || 'Prohibited content blocked.'}`)
        }
      } catch {
        // Not JSON
      }
      if (!errText.trim()) {
        errText = response.statusText || 'Unknown Error'
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
    return this.config.endpoint || DEFAULT_ENDPOINTS.openai
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
function repairTruncatedJson(jsonStr: string): string {
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

export interface GoogleModelItem {
  id: string
  name: string
  complexity: string
  costFactor: string
  maxTokens: string
  inputCost?: number
  outputCost?: number
  costDetails?: string
}

export async function fetchGoogleModels(apiKey: string, endpoint?: string): Promise<GoogleModelItem[]> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Google API Key is required to fetch models.')
  }
  const baseUrl = endpoint?.trim() || DEFAULT_ENDPOINTS.gemini
  const cleanBase = baseUrl.replace(/\/$/, '')
  const url = `${cleanBase}/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`

  const res = await fetch(url)
  if (!res.ok) {
    let errText = ''
    try {
      const errJson = await res.json()
      errText = errJson.error?.message || errJson.message || JSON.stringify(errJson)
    } catch {
      errText = await res.text().catch(() => res.statusText)
    }
    throw new Error(`Google API Error (${res.status}): ${errText || 'Failed to fetch models'}`)
  }

  const data = await res.json()
  if (!data.models || !Array.isArray(data.models)) {
    throw new Error('Invalid response structure from Google API: missing "models" array.')
  }

  // Strictly filter for compatible chat / text-generation models
  const compatibleModels = data.models.filter((m: any) => {
    const rawName: string = (m.name || '').toLowerCase()
    const methods: string[] = m.supportedGenerationMethods || []

    // 1. Must support text generation
    if (!methods.includes('generateContent')) return false

    // 2. Must be a Gemini or Gemma model
    if (!rawName.includes('gemini') && !rawName.includes('gemma')) return false

    // 3. Exclude non-chat / specialized incompatible models (embeddings, imagen, veo, aqa, bison, robotics)
    const incompatibleKeywords = ['embedding', 'imagen', 'veo', 'aqa', 'bison', 'robotics']
    if (incompatibleKeywords.some(keyword => rawName.includes(keyword))) return false

    return true
  })

  const results: GoogleModelItem[] = compatibleModels.map((m: any) => {
    const rawName: string = m.name || ''
    const id = rawName.replace(/^models\//, '')
    const displayName = m.displayName || id
    const lowerId = id.toLowerCase()

    const isGemma = lowerId.includes('gemma')
    const isPro = lowerId.includes('pro')
    const isFlash = lowerId.includes('flash')
    const isLite = lowerId.includes('lite') || lowerId.includes('8b')

    let complexity = 'Medium'
    if (isPro) complexity = 'High'
    else if (isLite) complexity = 'Low'

    // Determine input and output costs per 1M tokens in USD
    let inputCost = 0.15
    let outputCost = 0.60

    if (MODEL_PRICING[id]) {
      inputCost = MODEL_PRICING[id].input
      outputCost = MODEL_PRICING[id].output
    } else if (isGemma) {
      inputCost = 0
      outputCost = 0
    } else if (isPro) {
      inputCost = 1.25
      outputCost = 5.00
    } else if (isLite) {
      inputCost = 0.075
      outputCost = 0.30
    } else if (isFlash) {
      inputCost = 0.15
      outputCost = 0.60
    }

    // Register into global MODEL_PRICING dynamically for cost calculations
    MODEL_PRICING[id] = { input: inputCost, output: outputCost }

    let costFactor = '25%'
    let costDetails = ''

    if (inputCost === 0 && outputCost === 0) {
      costFactor = 'Free'
      costDetails = 'Free'
    } else {
      costFactor = `$${inputCost.toFixed(3)}/1M in`
      costDetails = `$${inputCost}/$${outputCost} per 1M`
    }

    const outputLimit = m.outputTokenLimit ? Math.round(m.outputTokenLimit / 1024) : 16
    const maxTokens = `${outputLimit > 0 ? outputLimit : 16}K`

    return {
      id,
      name: displayName,
      complexity,
      costFactor,
      costDetails,
      inputCost,
      outputCost,
      maxTokens,
    }
  })

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}
