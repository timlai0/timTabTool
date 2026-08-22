import type { AIConfig, AIGroupResult, ChromeTabGroupColor, GroupCategory, AIProgressCallback, AIProgressUpdate, OperationRetryInfo } from './types'
import type { AILogger } from './ai-logger'
import { DEFAULT_GROUPING_PROMPT, MODEL_PRICING, PROVIDER_DEFAULTS, DEFAULT_MODELS, DEFAULT_ENDPOINTS } from './constants'
import { getAutoBatchSize, formatTimeAgo, extractDomain, extractJsonSubstring } from './utils'

export const SYSTEM_PROMPT = 'You are an expert AI browser assistant specialized in tab organization, semantic topic clustering, and tab group naming. Always produce clean, structured output.'



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
  private logger?: AILogger

  // Safety safeguards to prevent runaway token billing and mass API loops
  private static globalRequestTimestamps: number[] = []
  private instanceRequestCount = 0

  static readonly MAX_REQUESTS_PER_RUN = 30
  static readonly MAX_REQUESTS_PER_MINUTE = 50

  constructor(config: AIConfig, signal?: AbortSignal, logger?: AILogger) {
    this.config = config
    this.signal = signal
    this.logger = logger
  }

  /**
   * Universal token and cost estimator for UI components.
   * Calculates lengths exactly based on the built prompt structure.
   */
  /**
   * Universal token and cost estimator for UI components.
   * Calculates lengths exactly based on the built prompt structure.
   * @param {AIConfig} config
   * @param {number} tabsCount
   * @param {'group' | 'split' | 'merge' | 'classify'} type
   * @param {string} [modelOverride]
   * @param {string} [providerOverride]
   * @param {string[]} [existingGroupNames]
   * @returns {{ tokens: number, costStr: string, tokensPerRequest: number, requests: number }}
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
  /**
   * Test the connection with a simple request.
   * @returns {Promise<{ ok: boolean; error?: string }>}
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    // Logic: Send a ping message to verify the API key and endpoint
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
  /**
   * Classify tabs that the rule engine couldn't confidently categorize.
   * @param {{ url: string; title: string; lastAccessed?: number; createdAt?: number }[]} tabs
   * @param {GroupCategory[]} categories
   * @param {boolean} [stripTitles=false]
   * @returns {Promise<Map<string, GroupCategory>>}
   */
  async classifyTabs(
    tabs: { url: string; title: string; lastAccessed?: number; createdAt?: number }[],
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
  /**
   * Let AI freely group tabs into dynamic groups with custom names and colors.
   * @param {{ url: string; title: string; lastAccessed?: number; createdAt?: number }[]} tabs
   * @param {string[]} [initialExistingGroupNames]
   * @returns {Promise<AIGroupResult[]>}
   */
  async groupTabsFreely(
    tabs: { url: string; title: string; lastAccessed?: number; createdAt?: number }[],
    initialExistingGroupNames: string[] = [],
    onProgress?: AIProgressCallback | ((current: number, total: number) => void)
  ): Promise<AIGroupResult[]> {
    if (tabs.length === 0) return []

    const batchSize = this.config.batchSize || getAutoBatchSize(this.config.maxTokens)
    const requiredBatches = Math.ceil(tabs.length / batchSize)

    // Fail early before initiating any network calls if total batches exceed safety limit
    if (!this.config.bypassSafeguards && this.instanceRequestCount + requiredBatches > AIClient.MAX_REQUESTS_PER_RUN) {
      throw new Error(`[timTabTool] AI safety safeguard: Single operation exceeded the safety limit of ${AIClient.MAX_REQUESTS_PER_RUN} requests to prevent run-away token billing. Please close some tabs or group in smaller batches.`)
    }

    const reportProgress = (update: AIProgressUpdate) => {
      if (!onProgress) return
      try {
        if (typeof onProgress === 'function') {
          (onProgress as any)(update)
          if (update.batchCurrent !== undefined && update.batchTotal !== undefined) {
            try {
              (onProgress as any)(update.batchCurrent, update.batchTotal)
            } catch {}
          }
        }
      } catch {}
    }

    const modelName = this.config.model || DEFAULT_MODELS[this.config.provider] || 'default'

    if (tabs.length <= batchSize) {
      reportProgress({
        stage: 'querying',
        statusText: `Querying ${modelName} (1 batch, ${tabs.length} tabs)...`,
        batchCurrent: 1,
        batchTotal: 1,
        tabStartIndex: 1,
        tabEndIndex: tabs.length,
        totalTabs: tabs.length,
        processedTabs: 0,
      })
      const results = await this.groupTabsBatch(tabs, 0, initialExistingGroupNames, false, 1, reportProgress)
      reportProgress({
        stage: 'parsing',
        statusText: `Parsed ${results.length} group${results.length === 1 ? '' : 's'} from response`,
        batchCurrent: 2,
        batchTotal: 1,
        tabStartIndex: 1,
        tabEndIndex: tabs.length,
        totalTabs: tabs.length,
        processedTabs: tabs.length,
        discoveredGroupNames: results.map(r => r.name),
      })
      return results
    }

    const allResults: AIGroupResult[] = []
    const combinedExistingNames = [...initialExistingGroupNames]
    for (let i = 0; i < tabs.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1
      const tabStart = i + 1
      const tabEnd = Math.min(i + batchSize, tabs.length)
      const currentBatchTabs = tabs.slice(i, i + batchSize)

      reportProgress({
        stage: 'querying',
        statusText: `Querying ${modelName} (Batch ${batchNum}/${requiredBatches}, tabs ${tabStart}–${tabEnd} of ${tabs.length})...`,
        batchCurrent: batchNum,
        batchTotal: requiredBatches,
        tabStartIndex: tabStart,
        tabEndIndex: tabEnd,
        totalTabs: tabs.length,
        processedTabs: i,
        discoveredGroupNames: allResults.map(r => r.name),
      })

      const batchResults = await this.groupTabsBatch(currentBatchTabs, i, combinedExistingNames, false, batchNum, reportProgress)
      
      // Merge batch results into allResults based on case-insensitive group name
      for (const group of batchResults) {
        const lowerName = group.name.trim().toLowerCase()
        const existing = allResults.find((r) => r.name.trim().toLowerCase() === lowerName)
        if (existing) {
          existing.tabIndices.push(...group.tabIndices)
        } else {
          allResults.push(group)
          combinedExistingNames.push(group.name)
        }
      }

      reportProgress({
        stage: 'parsing',
        statusText: `Discovered ${allResults.length} group${allResults.length === 1 ? '' : 's'} so far (Batch ${batchNum}/${requiredBatches})...`,
        batchCurrent: batchNum,
        batchTotal: requiredBatches,
        tabStartIndex: tabStart,
        tabEndIndex: tabEnd,
        totalTabs: tabs.length,
        processedTabs: tabEnd,
        discoveredGroupNames: allResults.map(r => r.name),
      })
    }

    reportProgress({
      stage: 'parsing',
      statusText: `AI clustering complete. ${allResults.length} groups generated.`,
      batchCurrent: requiredBatches + 1,
      batchTotal: requiredBatches,
      tabStartIndex: 1,
      tabEndIndex: tabs.length,
      totalTabs: tabs.length,
      processedTabs: tabs.length,
      discoveredGroupNames: allResults.map(r => r.name),
    })

    return allResults
  }

  /**
   * Formats a tab into a text string for the AI prompt.
   * @param {{ url: string; title: string; lastAccessed?: number; createdAt?: number }} tab
   * @param {number} index
   * @param {boolean} [stripTitles]
   * @returns {string}
   */
  private formatTabForPrompt(
    tab: { url: string; title: string; lastAccessed?: number; createdAt?: number },
    index: number,
    stripTitles = false,
  ): string {
    const urlString = tab.url || ''
    const domain = extractDomain(urlString) || urlString
    const openedTime = tab.createdAt ?? tab.lastAccessed
    const timeTag = openedTime ? ` (Opened: ${new Date(openedTime).toISOString()})` : ''

    if (stripTitles) {
      if (this.config.sendFullUrl) {
        return `${index}. (URL: ${urlString})${timeTag}`
      }
      return `${index}. (${domain})${timeTag}`
    }

    const shortTitle = tab.title.length > 40 ? tab.title.slice(0, 40) + '…' : tab.title
    const quotedTitle = `"${shortTitle}"`
    if (this.config.sendFullUrl) {
      return `${index}. ${quotedTitle} (URL: ${urlString})${timeTag}`
    }
    return `${index}. ${quotedTitle} (${domain})${timeTag}`
  }

  /**
   * Groups a batch of tabs.
   * @param {{ url: string; title: string; lastAccessed?: number; createdAt?: number }[]} tabs
   * @param {number} offset
   * @param {string[]} [existingGroupNames]
   * @param {boolean} [stripTitles]
   * @param {number} [batchIndex]
   * @returns {Promise<AIGroupResult[]>}
   */
  private async groupTabsBatch(
    tabs: { url: string; title: string; lastAccessed?: number; createdAt?: number }[],
    offset: number,
    existingGroupNames: string[] = [],
    stripTitles = false,
    batchIndex = 1,
    onProgress?: (update: AIProgressUpdate) => void
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

    const onRetry = (retry: OperationRetryInfo) => {
      if (onProgress) {
        onProgress({
          stage: 'retrying',
          statusText: `Rate limit / transient error. Retrying in ${(retry.delayMs / 1000).toFixed(0)}s (Attempt ${retry.attempt}/${retry.maxRetries})...`,
          retry,
        })
      }
    }

    try {
      const response = await this.chat(prompt, true, batchIndex, onRetry, onProgress)
      return this.parseFreeGroupResponse(response, offset + tabs.length, offset + 1)
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[timTabTool] Prompt blocked due to sensitive content, retrying with URLs only...')
        return this.groupTabsBatch(tabs, offset, existingGroupNames, true, batchIndex, onProgress)
      }
      throw err
    }
  }

  /**
   * Parses the JSON response from a free grouping request.
   * @param {string} response
   * @param {number} maxIndex
   * @param {number} [minIndex=1]
   * @returns {AIGroupResult[]}
   */
  private parseFreeGroupResponse(response: string, maxIndex: number, minIndex = 1): AIGroupResult[] {
    // Logic: Extract JSON, parse it, and construct group results
    const extracted = extractJsonSubstring(response, 'array')
    if (!extracted.startsWith('[')) {
      throw new Error(`No JSON array found in AI response: ${response.slice(0, 200)}`)
    }

    let jsonStr = extracted.replace(/,\s*([}\]])/g, '$1')

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

    // Collect unassigned tabs into an "_ungrouped_" group
    const unassigned: number[] = []
    for (let i = minIndex; i <= maxIndex; i++) {
      if (!assignedIndices.has(i)) unassigned.push(i)
    }
    if (unassigned.length > 0) {
      results.push({ name: '_ungrouped_', tabIndices: unassigned, color: 'grey' })
    }

    return results
  }

  /**
   * Classify new tabs into existing groups by name.
   * Returns a map of tab index (0-based) to target group name,
   * or a new group descriptor if no existing group fits.
   */
  /**
   * Classify new tabs into existing groups by name.
   * @param {{ url: string; title: string; lastAccessed?: number; createdAt?: number }[]} tabs
   * @param {string[]} existingGroupNames
   * @param {boolean} [stripTitles=false]
   * @returns {Promise<{ index: number; group: string; newGroupName?: string; newGroupColor?: string }[]>}
   */
  async classifyNewTabsIntoGroups(
    tabs: { url: string; title: string; lastAccessed?: number; createdAt?: number }[],
    existingGroupNames: string[],
    stripTitles = false,
    onProgress?: AIProgressCallback | ((current: number, total: number) => void)
  ): Promise<{ index: number; group: string; newGroupName?: string; newGroupColor?: string }[]> {
    if (tabs.length === 0) return []

    const batchSize = this.config.batchSize || getAutoBatchSize(this.config.maxTokens)
    const requiredBatches = Math.ceil(tabs.length / batchSize)

    if (!this.config.bypassSafeguards && this.instanceRequestCount + requiredBatches > AIClient.MAX_REQUESTS_PER_RUN) {
      throw new Error(`[timTabTool] AI safety safeguard: Single operation exceeded the safety limit of ${AIClient.MAX_REQUESTS_PER_RUN} requests to prevent run-away token billing. Please close some tabs or group in smaller batches.`)
    }

    const reportProgress = (update: AIProgressUpdate) => {
      if (!onProgress) return
      try {
        if (typeof onProgress === 'function') {
          (onProgress as any)(update)
          if (update.batchCurrent !== undefined && update.batchTotal !== undefined) {
            try {
              (onProgress as any)(update.batchCurrent, update.batchTotal)
            } catch {}
          }
        }
      } catch {}
    }

    const modelName = this.config.model || DEFAULT_MODELS[this.config.provider] || 'default'

    if (tabs.length <= batchSize) {
      reportProgress({
        stage: 'querying',
        statusText: `Classifying ${tabs.length} tab${tabs.length === 1 ? '' : 's'} with ${modelName}...`,
        batchCurrent: 1,
        batchTotal: 1,
        tabStartIndex: 1,
        tabEndIndex: tabs.length,
        totalTabs: tabs.length,
        processedTabs: 0,
      })
      const results = await this.classifyNewTabsBatch(tabs, 0, existingGroupNames, stripTitles, reportProgress)
      reportProgress({
        stage: 'parsing',
        statusText: `Classified ${tabs.length} tabs into existing and new groups`,
        batchCurrent: 2,
        batchTotal: 1,
        totalTabs: tabs.length,
        processedTabs: tabs.length,
      })
      return results
    }

    const allResults: { index: number; group: string; newGroupName?: string; newGroupColor?: string }[] = []
    const combinedExistingNames = [...existingGroupNames]

    for (let i = 0; i < tabs.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1
      const tabStart = i + 1
      const tabEnd = Math.min(i + batchSize, tabs.length)
      const currentBatch = tabs.slice(i, i + batchSize)

      reportProgress({
        stage: 'querying',
        statusText: `Classifying batch ${batchNum}/${requiredBatches} (tabs ${tabStart}–${tabEnd} of ${tabs.length}) with ${modelName}...`,
        batchCurrent: batchNum,
        batchTotal: requiredBatches,
        tabStartIndex: tabStart,
        tabEndIndex: tabEnd,
        totalTabs: tabs.length,
        processedTabs: i,
        discoveredGroupNames: combinedExistingNames,
      })

      const batchResults = await this.classifyNewTabsBatch(currentBatch, i, combinedExistingNames, stripTitles, reportProgress)
      
      for (const item of batchResults) {
        allResults.push(item)
        if (item.group === 'NEW' && item.newGroupName) {
          const newNameStr = item.newGroupName
          if (!combinedExistingNames.some(n => n.toLowerCase() === newNameStr.toLowerCase())) {
            combinedExistingNames.push(item.newGroupName)
          }
        }
      }

      reportProgress({
        stage: 'parsing',
        statusText: `Classified ${tabEnd}/${tabs.length} tabs so far...`,
        batchCurrent: batchNum,
        batchTotal: requiredBatches,
        tabStartIndex: tabStart,
        tabEndIndex: tabEnd,
        totalTabs: tabs.length,
        processedTabs: tabEnd,
        discoveredGroupNames: combinedExistingNames,
      })
    }

    reportProgress({
      stage: 'parsing',
      statusText: `Classification complete across ${tabs.length} tabs.`,
      batchCurrent: requiredBatches + 1,
      batchTotal: requiredBatches,
      totalTabs: tabs.length,
      processedTabs: tabs.length,
      discoveredGroupNames: combinedExistingNames,
    })

    return allResults
  }

  /**
   * Classify a batch of new tabs.
   * @param {{ url: string; title: string; lastAccessed?: number; createdAt?: number }[]} tabs
   * @param {number} offset
   * @param {string[]} existingGroupNames
   * @param {boolean} [stripTitles=false]
   * @returns {Promise<{ index: number; group: string; newGroupName?: string; newGroupColor?: string }[]>}
   */
  private async classifyNewTabsBatch(
    tabs: { url: string; title: string; lastAccessed?: number; createdAt?: number }[],
    offset: number,
    existingGroupNames: string[],
    stripTitles = false,
    onProgress?: (update: AIProgressUpdate) => void
  ): Promise<{ index: number; group: string; newGroupName?: string; newGroupColor?: string }[]> {
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

    const onRetry = (retry: OperationRetryInfo) => {
      if (onProgress) {
        onProgress({
          stage: 'retrying',
          statusText: `Rate limit / transient error. Retrying in ${(retry.delayMs / 1000).toFixed(0)}s (Attempt ${retry.attempt}/${retry.maxRetries})...`,
          retry,
        })
      }
    }

    try {
      const response = await this.chat(prompt, true, 1, onRetry, onProgress)

      const extracted = extractJsonSubstring(response, 'array')
      if (!extracted.startsWith('[')) return this.fallbackAllToNew(tabs, offset)

      let jsonStr = extracted.replace(/,\s*([}\]])/g, '$1')
      let parsed: {
        index: number
        group: string
        newGroupName?: string
        newGroupColor?: string
      }[]
      try {
        parsed = JSON.parse(jsonStr)
      } catch {
        try {
          parsed = JSON.parse(repairTruncatedJson(jsonStr))
        } catch {
          return this.fallbackAllToNew(tabs, offset)
        }
      }

      const validGroupNames = new Set(existingGroupNames.map(n => n.toLowerCase()))
      return parsed
        .filter((item) => item.index >= 1 && item.index <= tabs.length)
        .map((item) => {
          let finalGroup = 'NEW'
          if (item.group !== 'NEW' && validGroupNames.has(item.group.toLowerCase())) {
            finalGroup = existingGroupNames.find(n => n.toLowerCase() === item.group.toLowerCase()) || item.group
          }
          return {
            index: item.index - 1 + offset,
            group: finalGroup,
            newGroupName: item.newGroupName?.slice(0, MAX_GROUP_NAME_LENGTH),
            newGroupColor: VALID_COLORS.includes(item.newGroupColor as ChromeTabGroupColor)
              ? item.newGroupColor
              : undefined,
          }
        })
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[timTabTool] Prompt blocked due to sensitive content in classification, retrying with URLs only...')
        return this.classifyNewTabsBatch(tabs, offset, existingGroupNames, true)
      }
      console.error('[timTabTool] Classification failed:', err)
      throw err
    }
  }

  /**
   * Decide if the given group should be merged into one of the other existing groups.
   * Returns the name of the target group to merge into, or "KEEP" if it should remain separate.
   */
  /**
   * Decide if the given group should be merged into one of the other existing groups.
   * @param {{ url: string; title: string; lastAccessed?: number; createdAt?: number }[]} tabs
   * @param {string[]} existingGroupNames
   * @param {boolean} [stripTitles=false]
   * @returns {Promise<string>}
   */
  async decideMergeGroup(
    tabs: { url: string; title: string; lastAccessed?: number; createdAt?: number }[],
    existingGroupNames: string[],
    stripTitles = false,
  ): Promise<string> {
    if (tabs.length === 0 || existingGroupNames.length === 0) return 'KEEP'

    const batchSize = this.config.batchSize || getAutoBatchSize(this.config.maxTokens)
    const sampleTabs = tabs.slice(0, batchSize)

    const tabDescriptions = sampleTabs
      .map((t, i) => this.formatTabForPrompt(t, i + 1, stripTitles))
      .join('\n')

    const mergePrompt = this.config.mergePrompt?.trim() || 'Analyze the browser tabs of this group and decide if they should be merged into one of the other existing tab groups. Choose the best fitting existing group from the list. If none of the existing groups are a good fit and this group should remain separate, respond with "KEEP". Be conservative about merging; only merge if the topics are highly related.'

    const prompt = `${mergePrompt}

Existing tab groups in this window: ${existingGroupNames.map((n) => `"${n}"`).join(', ')}.

Tabs in the group to merge (showing ${sampleTabs.length} of ${tabs.length}):
${tabDescriptions}

JSON format: {"mergeTarget":"existing group name or KEEP"}
Only output the JSON object.`

    try {
      const response = await this.chat(prompt, true)
      const extracted = extractJsonSubstring(response, 'object')
      const jsonStr = extracted.replace(/,\s*([}\]])/g, '$1')

      const parsed = JSON.parse(jsonStr) as { mergeTarget?: string }
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
      console.warn('[timTabTool] Failed to decide merge group, keeping group untouched. Detail:', err)
      return 'KEEP'
    }
  }

  /**
   * @deprecated ABANDONED: Fallback method used when AI parsing completely fails.
   * @param {{ url: string; title: string; lastAccessed?: number; createdAt?: number }[]} tabs
   * @param {number} [offset=0]
   * @returns {{ index: number; group: string }[]}
   */
  private fallbackAllToNew(tabs: { url: string; title: string; lastAccessed?: number; createdAt?: number }[], offset = 0): { index: number; group: string }[] {
    return tabs.map((_, i) => ({ index: i + offset, group: 'NEW', newGroupName: 'Uncategorized', newGroupColor: 'grey' }))
  }

  /**
   * Execute an API call with exponential backoff and retry logic.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    onRetry?: (info: OperationRetryInfo) => void
  ): Promise<T> {
    // Logic: Retry failed requests unless aborted or permanently failed
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

        // Permanent API failures should not retry (e.g. prohibited content, token limit exceeded, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found)
        const isPermanent = 
          errorMsg.includes('PROHIBITED_CONTENT') || 
          errorMsg.includes('Prohibited Use policy') || 
          errorMsg.includes('promptFeedback') ||
          errorMsg.includes('MAX_TOKENS') ||
          errorMsg.includes('Exceeded output token limit') ||
          errorMsg.includes('API error 400') ||
          errorMsg.includes('API error 401') ||
          errorMsg.includes('API error 403') ||
          errorMsg.includes('API error 404')

        if (isPermanent || attempt === maxRetries) {
          throw err
        }

        const retryInfo: OperationRetryInfo = {
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          reason: errorMsg,
        }

        if (onRetry) {
          onRetry(retryInfo)
        }

        if (this.logger) {
          this.logger.logStep('API_RETRY', `Retrying API request in ${delay}ms (Attempt ${attempt + 1}/${maxRetries}): ${errorMsg}`, { attempt: attempt + 1, maxRetries, delayMs: delay })
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
    // Logic: Enforce max requests per run and rate limit per minute
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

  /**
   * Records a global request timestamp for rate limiting.
   */
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
   * Send a chat completion request to the configured provider.
   * @param {string} userMessage
   * @param {boolean} [jsonMode]
   * @param {number} [batchIndex]
   * @param {Function} [onRetry]
   * @returns {Promise<string>}
   */
  private async chat(
    userMessage: string,
    jsonMode?: boolean,
    batchIndex = 1,
    onRetry?: (info: OperationRetryInfo) => void,
    onProgress?: (update: AIProgressUpdate) => void
  ): Promise<string> {
    // Logic: Delegate request to OpenAI, Claude, or Gemini
    return this.executeWithRetry(async () => {
      const { provider } = this.config

      if (provider === 'claude') {
        return this.chatClaude(userMessage, jsonMode, batchIndex)
      }

      if (provider === 'gemini') {
        return this.chatGemini(userMessage, jsonMode, batchIndex)
      }

      // OpenAI / Custom (OpenAI-compatible)
      return this.chatOpenAI(userMessage, jsonMode, batchIndex, onProgress)
    }, onRetry)
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

  /**
   * Send chat request using OpenAI format.
   * @param {string} userMessage
   * @param {boolean} [jsonMode]
   * @param {number} [batchIndex]
   * @param {Function} [onProgress]
   * @returns {Promise<string>}
   */
  private async chatOpenAI(
    userMessage: string,
    jsonMode?: boolean,
    batchIndex = 1,
    onProgress?: (update: AIProgressUpdate) => void
  ): Promise<string> {
    // loop through items to handle max token continuations
    const maxContinuations = 3
    let continuations = 0
    let accumulatedContent = ''
    let accumulatedReasoning = ''
    
    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userMessage },
    ]

    const endpoint = `${this.getBaseUrl()}/chat/completions`
    const model = this.config.model || this.defaultModel

    if (this.config.provider === 'openrouter' && this.config.openRouterOnlyFree) {
      if (!isFreeModel(model)) {
        throw new Error(`Model "${model}" is not permitted when OpenRouter free models mode is enabled. Please select a free model (e.g. stealth/ox-alpha or a :free model).`)
      }
    }

    while (continuations <= maxContinuations) {
      const startTime = Date.now()
      if (this.logger) {
        this.logger.logRawRequest(batchIndex, endpoint, `Message len: ${userMessage.length}`, this.systemPrompt, userMessage)
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: this.config.maxTokens || 16384,
          ...(onProgress && { stream: true }),
          ...(jsonMode && { response_format: { type: 'json_object' } }),
          ...(this.config.provider === 'openrouter' && this.config.reasoningEffort && this.config.reasoningEffort !== 'auto' && {
            reasoning: {
              effort: this.config.reasoningEffort
            }
          }),
          ...(this.config.provider === 'openai' && this.config.reasoningEffort && this.config.reasoningEffort !== 'auto' && {
            reasoning_effort: this.config.reasoningEffort
          }),
        }),
        signal: this.signal,
      })

      const duration = Date.now() - startTime

      if (!response.ok) {
        let err = await response.text()
        if (!err.trim()) {
          err = response.statusText || 'Unknown Error'
        }
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, err, undefined, `API error ${response.status}: ${err}`)
        }
        throw new Error(`API error ${response.status}: ${err}`)
      }

      let text = ''
      let finishReason: string | undefined

      // Check if response is SSE stream
      const contentType = response.headers?.get?.('content-type') || ''
      const isSSE = contentType.includes('text/event-stream')
      const hasStreamReader = Boolean(response.body && typeof (response.body as any).getReader === 'function')

      if (isSSE && hasStreamReader) {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        let lastProgressEmit = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(':')) continue
            if (trimmed === 'data: [DONE]') continue
            if (trimmed.startsWith('data: ')) {
              try {
                const json = JSON.parse(trimmed.slice(6))
                const choice = json.choices?.[0]
                if (!choice) continue

                if (choice.finish_reason) {
                  finishReason = choice.finish_reason
                }

                const delta = choice.delta
                if (delta?.content) {
                  text += delta.content
                }

                const rDelta = delta?.reasoning || delta?.reasoning_content || delta?.thought || ''
                if (rDelta) {
                  accumulatedReasoning += rDelta
                  const now = Date.now()
                  if (onProgress && now - lastProgressEmit > 120) {
                    lastProgressEmit = now
                    onProgress({
                      stage: 'evaluating',
                      liveReasoning: accumulatedReasoning,
                      reasoningSnippet: rDelta.trim() ? rDelta.trim() : undefined,
                    })
                  }
                }
              } catch {
                // partial SSE payload, ignored
              }
            }
          }
        }
        // Final live reasoning flush
        if (onProgress && accumulatedReasoning) {
          onProgress({
            stage: 'evaluating',
            liveReasoning: accumulatedReasoning,
          })
        }
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, text, { accumulatedReasoning })
        }
      } else {
        // Fallback for non-streaming or test mocks
        const data = await response.json()
        const choice = data.choices?.[0]
        text = choice?.message?.content || ''
        finishReason = choice?.finish_reason
        const reasoning = choice?.message?.reasoning || choice?.message?.reasoning_content
        if (reasoning) {
          accumulatedReasoning = reasoning
          if (onProgress) {
            onProgress({
              stage: 'evaluating',
              liveReasoning: reasoning,
            })
          }
        }
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, text, data)
        }
      }

      accumulatedContent += text

      if (finishReason) {
        if (finishReason === 'length') {
          if (continuations >= maxContinuations) {
            break
          }
          continuations++
          messages.push({ role: 'assistant', content: text })
          messages.push({ role: 'user', content: 'Continue exactly from where you left off. Do not repeat previous text.' })
          continue
        } else if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
          throw new Error(`AI response failed: ${finishReason}`)
        }
      }
      break
    }
    
    return accumulatedContent
  }

  /**
   * Send chat request using Anthropic Claude format.
   * @param {string} userMessage
   * @param {boolean} [jsonMode]
   * @param {number} [batchIndex]
   * @returns {Promise<string>}
   */
  private async chatClaude(userMessage: string, jsonMode?: boolean, batchIndex = 1): Promise<string> {
    // loop through items to handle max token continuations
    const baseUrl = this.config.endpoint || DEFAULT_ENDPOINTS.claude
    const endpoint = `${baseUrl}/v1/messages`
    const maxContinuations = 3
    let continuations = 0
    let accumulatedContent = ''
    
    const messages: { role: string; content: string }[] = [
      { role: 'user', content: userMessage },
    ]
    if (jsonMode) {
      messages.push({ role: 'assistant', content: '[' })
    }

    while (continuations <= maxContinuations) {
      const startTime = Date.now()
      if (this.logger) {
        this.logger.logRawRequest(batchIndex, endpoint, `Message len: ${userMessage.length}`, this.systemPrompt, userMessage)
      }

      const response = await fetch(endpoint, {
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

      const duration = Date.now() - startTime

      if (!response.ok) {
        let err = await response.text()
        if (!err.trim()) {
          err = response.statusText || 'Unknown Error'
        }
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, err, undefined, `API error ${response.status}: ${err}`)
        }
        throw new Error(`API error ${response.status}: ${err}`)
      }

      const data = await response.json()
      const text = data.content?.[0]?.text || ''
      
      if (continuations === 0 && jsonMode) {
        accumulatedContent += '[' + text
      } else {
        accumulatedContent += text
      }

      if (this.logger) {
        this.logger.logRawResponse(batchIndex, response.status, duration, text, data)
      }

      const stopReason = data.stop_reason
      if (stopReason === 'max_tokens') {
        if (continuations >= maxContinuations) {
          break
        }
        continuations++
        
        const lastMsg = messages[messages.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.content += text
        } else {
          messages.push({ role: 'assistant', content: text })
        }
        messages.push({ role: 'user', content: 'Continue exactly from where you left off. Do not repeat previous text.' })
        continue
      } else if (stopReason && stopReason !== 'end_turn' && stopReason !== 'stop_sequence') {
        throw new Error(`AI response failed: ${stopReason}`)
      }
      break
    }
    
    return accumulatedContent
  }

  /**
   * Send chat request using Google Gemini format.
   * @param {string} userMessage
   * @param {boolean} [jsonMode]
   * @param {number} [batchIndex]
   * @returns {Promise<string>}
   */
  private async chatGemini(userMessage: string, jsonMode?: boolean, batchIndex = 1): Promise<string> {
    // loop through items to handle max token continuations
    const baseUrl = this.config.endpoint || DEFAULT_ENDPOINTS.gemini
    const model = this.config.model || this.defaultModel
    const endpoint = `${baseUrl}/v1beta/models/${model}:generateContent`
    const maxContinuations = 3
    let continuations = 0
    let accumulatedContent = ''
    
    const contents: any[] = [
      { role: 'user', parts: [{ text: userMessage }] },
    ]

    while (continuations <= maxContinuations) {
      const startTime = Date.now()
      if (this.logger) {
        this.logger.logRawRequest(batchIndex, endpoint, `Message len: ${userMessage.length}`, this.systemPrompt, userMessage)
      }

      const response = await fetch(
        `${endpoint}?key=${this.config.apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: this.systemPrompt }],
            },
            contents,
            generationConfig: {
              temperature: 0,
              maxOutputTokens: this.config.maxTokens || 16384,
              ...(jsonMode && { responseMimeType: 'application/json' }),
            },
          }),
          signal: this.signal,
        },
      )

      const duration = Date.now() - startTime

      if (!response.ok) {
        let errText = await response.text()
        try {
          const parsed = JSON.parse(errText)
          if (parsed.promptFeedback?.blockReason === 'PROHIBITED_CONTENT' || parsed.error?.message?.includes('PROHIBITED_CONTENT')) {
            const errMsg = `PROHIBITED_CONTENT: ${parsed.promptFeedback?.blockReasonMessage || parsed.error?.message || 'Prohibited content blocked.'}`
            if (this.logger) {
              this.logger.logRawResponse(batchIndex, response.status, duration, errText, parsed, errMsg)
            }
            throw new Error(errMsg)
          }
        } catch (e: any) {
          if (e.message?.startsWith('PROHIBITED_CONTENT')) throw e
        }
        if (!errText.trim()) {
          errText = response.statusText || 'Unknown Error'
        }
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, errText, undefined, `API error ${response.status}: ${errText}`)
        }
        throw new Error(`API error ${response.status}: ${errText}`)
      }

      const data = await response.json()
      
      if (data.promptFeedback?.blockReason === 'PROHIBITED_CONTENT') {
        const errMsg = `PROHIBITED_CONTENT: ${data.promptFeedback.blockReasonMessage || 'Prohibited content blocked.'}`
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, JSON.stringify(data), data, errMsg)
        }
        throw new Error(errMsg)
      }

      const candidate = data.candidates?.[0]
      const text = candidate?.content?.parts?.[0]?.text || ''
      accumulatedContent += text

      if (this.logger) {
        this.logger.logRawResponse(batchIndex, response.status, duration, text, data)
      }

      if (candidate) {
        const finishReason = candidate.finishReason
        if (finishReason === 'MAX_TOKENS') {
          if (continuations >= maxContinuations) {
            break
          }
          continuations++
          contents.push({ role: 'model', parts: [{ text }] })
          contents.push({ role: 'user', parts: [{ text: 'Continue exactly from where you left off. Do not repeat previous text.' }] })
          continue
        } else if (finishReason && finishReason !== 'STOP') {
          throw new Error(`AI response failed: ${finishReason}`)
        }
      }
      break
    }
    
    return accumulatedContent
  }

  private getBaseUrl(): string {
    return this.config.endpoint || DEFAULT_ENDPOINTS[this.config.provider] || DEFAULT_ENDPOINTS.openai
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    }
    if (this.config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://tabpilot.app'
      headers['X-Title'] = 'timTabTool'
    }
    return headers
  }
}

/**
 * Repairs a truncated JSON string by slicing up to the last known structural boundary
 * and closing all open strings, arrays, and objects.
 */
/**
 * Repairs a truncated JSON string by slicing up to the last known structural boundary
 * and closing all open strings, arrays, and objects.
 * @param {string} jsonStr
 * @returns {string}
 */
function repairTruncatedJson(jsonStr: string): string {
  // Logic: Use a stack to track bracket depth and append missing closures
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
  rawMaxOutputTokens?: number
}

export function getGoogleModelPricing(id: string): { input: number; output: number } {
  const lower = id.toLowerCase()

  // 1. Direct match in MODEL_PRICING
  if (MODEL_PRICING[id]) {
    return MODEL_PRICING[id]
  }

  for (const [key, rates] of Object.entries(MODEL_PRICING)) {
    if (key.toLowerCase() === lower) {
      return rates
    }
  }

  // 2. Open weights / free Gemma models
  if (lower.includes('gemma')) {
    return { input: 0, output: 0 }
  }

  // 3. Gemini 3.5+ / 3.6+ / 3.7+ / 4.x series
  if (lower.includes('gemini-3.5') || lower.includes('gemini-3.6') || lower.includes('gemini-3.7') || lower.includes('gemini-4')) {
    if (lower.includes('lite')) return { input: 0.25, output: 1.50 }
    if (lower.includes('pro')) return { input: 2.00, output: 12.00 }
    return { input: 1.50, output: 9.00 } // Flash 3.5/3.6 standard
  }

  // 4. Gemini 3.0 / 3.1 series
  if (lower.includes('gemini-3')) {
    if (lower.includes('lite')) return { input: 0.25, output: 1.50 }
    if (lower.includes('pro')) return { input: 2.00, output: 12.00 }
    return { input: 0.50, output: 3.00 } // Flash 3.0 standard
  }

  // 5. Gemini 2.5 series
  if (lower.includes('gemini-2.5')) {
    if (lower.includes('lite')) return { input: 0.10, output: 0.40 }
    if (lower.includes('pro')) return { input: 1.25, output: 10.00 }
    return { input: 0.30, output: 2.50 }
  }

  // 6. Gemini 2.0 series
  if (lower.includes('gemini-2')) {
    if (lower.includes('lite')) return { input: 0.075, output: 0.30 }
    if (lower.includes('pro')) return { input: 1.25, output: 5.00 }
    return { input: 0.10, output: 0.40 }
  }

  // Fallbacks
  if (lower.includes('pro')) return { input: 2.00, output: 12.00 }
  if (lower.includes('lite')) return { input: 0.25, output: 1.50 }
  if (lower.includes('flash')) return { input: 1.50, output: 9.00 }

  return PROVIDER_DEFAULTS.gemini
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
    const isLite = lowerId.includes('lite') || lowerId.includes('8b')

    let complexity = 'Medium'
    if (isPro) complexity = 'High'
    else if (isLite) complexity = 'Low'

    // Determine input and output costs per 1M tokens in USD
    const rates = getGoogleModelPricing(id)
    const inputCost = rates.input
    const outputCost = rates.output

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

    const outputLimitTokens = m.outputTokenLimit || 16384
    const outputLimit = Math.round(outputLimitTokens / 1024)
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
      rawMaxOutputTokens: outputLimitTokens,
    }
  })

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Checks if a model is free based on ID, pricing, and metadata.
 * @param {string} [modelId] - Model ID string.
 * @param {object} [modelObj] - Optional model metadata object.
 * @returns {boolean} True if the model is free.
 */
export function isFreeModel(modelId?: string, modelObj?: { costFactor?: string; costDetails?: string; inputCost?: number; outputCost?: number }): boolean {
  if (!modelId) return false
  if (modelId === 'stealth/ox-alpha' || modelId.endsWith(':free')) return true
  if (modelObj?.costFactor === 'Free' || modelObj?.costDetails === 'Free') return true
  if (modelObj?.inputCost === 0 && modelObj?.outputCost === 0) return true
  const pricing = MODEL_PRICING[modelId]
  if (pricing && pricing.input === 0 && pricing.output === 0) return true
  return false
}

/**
 * Fetches the available models from OpenRouter API.
 * @param {string} [apiKey] - Optional API key for OpenRouter.
 * @param {string} [endpoint] - Optional endpoint override.
 * @param {boolean} [onlyFree] - Whether to return only free models.
 * @returns {Promise<GoogleModelItem[]>} Array of models with token limits and pricing.
 */
export async function fetchOpenRouterModels(apiKey?: string, endpoint?: string, onlyFree = false): Promise<GoogleModelItem[]> {
  const baseUrl = endpoint?.trim() || DEFAULT_ENDPOINTS.openrouter
  const cleanBase = baseUrl.replace(/\/$/, '')
  const url = `${cleanBase}/models`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }

  const res = await fetch(url, { headers })
  if (!res.ok) {
    let errText = ''
    try {
      const errJson = await res.json()
      errText = errJson.error?.message || errJson.message || JSON.stringify(errJson)
    } catch {
      errText = await res.text().catch(() => res.statusText)
    }
    throw new Error(`OpenRouter API Error (${res.status}): ${errText || 'Failed to fetch models'}`)
  }

  const data = await res.json()
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Invalid response structure from OpenRouter API: missing "data" array.')
  }

  let results: GoogleModelItem[] = data.data.map((m: any) => {
    const id = m.id || ''
    const displayName = m.name || id
    const pricingPrompt = parseFloat(m.pricing?.prompt || '0')
    const pricingCompletion = parseFloat(m.pricing?.completion || '0')

    const inputCost = Math.round(pricingPrompt * 1000000 * 1000) / 1000
    const outputCost = Math.round(pricingCompletion * 1000000 * 1000) / 1000

    MODEL_PRICING[id] = { input: inputCost, output: outputCost }

    let complexity = 'Medium'
    if (inputCost >= 2.0 || id.includes('pro') || id.includes('r1') || id.includes('opus') || id.includes('sonnet')) {
      complexity = 'High'
    } else if (inputCost <= 0.25 || id.includes('mini') || id.includes('flash') || id.includes('haiku') || id.includes('small')) {
      complexity = 'Low'
    }

    let costFactor = '25%'
    let costDetails = ''
    if (inputCost === 0 && outputCost === 0) {
      costFactor = 'Free'
      costDetails = 'Free'
    } else {
      costFactor = `$${inputCost.toFixed(3)}/1M in`
      costDetails = `$${inputCost}/$${outputCost} per 1M`
    }

    const outputLimitTokens = m.top_provider?.max_completion_tokens || m.per_request_limits?.completion_tokens || (m.context_length && m.context_length <= 131072 ? m.context_length : 16384)
    const outputLimit = Math.round(outputLimitTokens / 1024)
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
      rawMaxOutputTokens: outputLimitTokens,
    }
  })

  if (onlyFree) {
    results = results.filter(m => isFreeModel(m.id, m))
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}
