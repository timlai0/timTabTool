import type { AIConfig, AIGroupResult, ChromeTabGroupColor, GroupCategory, AIProgressCallback, AIProgressUpdate, OperationRetryInfo, OpenRouterProviderItem, OpenRouterKeyInfo, ReviewAndRegroupTabInput, ReviewAndRegroupDecision, DuplicateGroupClusterItem, DistinctGroupRenameResult, WindowNameResult } from './types'
import type { AILogger } from './ai-logger'
import { DEFAULT_GROUPING_PROMPT, DEFAULT_WINDOW_NAMING_PROMPT, MODEL_PRICING, PROVIDER_DEFAULTS, DEFAULT_MODELS, DEFAULT_ENDPOINTS } from './constants'
import { getAutoBatchSize, formatTimeAgo, extractDomain, extractJsonSubstring, assertSecureEndpoint } from './utils'
import {
  getGoogleModelPricing,
  fetchGoogleModels,
  isChatCompatibleGeminiModel,
  isFreeModel,
  fetchOpenRouterModels,
  fetchOpenRouterProviders,
  fetchOpenRouterKeyInfo,
} from './ai-providers'
import type { GoogleModelItem } from './ai-providers'

export type { GoogleModelItem }
export {
  getGoogleModelPricing,
  fetchGoogleModels,
  isChatCompatibleGeminiModel,
  isFreeModel,
  fetchOpenRouterModels,
  fetchOpenRouterProviders,
  fetchOpenRouterKeyInfo,
}

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
    type: 'group' | 'split' | 'merge' | 'classify' | 'regroup' | 'name_window',
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
    } else if (type === 'regroup') {
      userPrompt = 'You are reviewing the last tabs to verify if each tab is currently in the correct group, and regroup it if needed.'
      if (existingGroupNames.length > 0) {
        baseUserPromptExtra = '\n\nExisting Groups: ' + existingGroupNames.join(', ')
      }
    } else if (type === 'name_window') {
      userPrompt = config.windowNamingPrompt?.trim() || DEFAULT_WINDOW_NAMING_PROMPT
      if (existingGroupNames.length > 0) {
        baseUserPromptExtra = '\n\nOther Window Names: ' + existingGroupNames.join(', ')
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
      if (this.signal?.aborted) {
        if (allResults.length > 0) {
          return allResults
        }
        throw new Error('Operation aborted by user')
      }

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

      try {
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
      } catch (err) {
        if (this.signal?.aborted && allResults.length > 0) {
          return allResults
        }
        throw err
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
      if (this.signal?.aborted) {
        if (allResults.length > 0) {
          return allResults
        }
        throw new Error('Operation aborted by user')
      }

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

      try {
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
      } catch (err) {
        if (this.signal?.aborted && allResults.length > 0) {
          return allResults
        }
        throw err
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
   * Format tab including current group for regrouping review prompt.
   */
  private formatTabWithGroupForPrompt(
    tab: ReviewAndRegroupTabInput,
    index: number,
    stripTitles = false,
  ): string {
    const base = this.formatTabForPrompt(tab, index, stripTitles)
    const groupLabel = tab.currentGroup
      ? ` [Current group: "${tab.currentGroup}"]`
      : ' [Current group: None (ungrouped)]'
    return `${base}${groupLabel}`
  }

  /**
   * Check if tabs (up to 20 tabs) are in correct groups, and regroup them if needed.
   * @param {ReviewAndRegroupTabInput[]} tabs - Tabs to review.
   * @param {string[]} existingGroupNames - Names of existing tab groups in the window.
   * @param {boolean} [stripTitles] - Whether to omit tab titles for privacy/moderation.
   * @param {AIProgressCallback} [onProgress] - Optional progress callback.
   * @returns {Promise<ReviewAndRegroupDecision[]>} Decisions for each tab.
   */
  async reviewAndRegroupTabs(
    tabs: ReviewAndRegroupTabInput[],
    existingGroupNames: string[],
    stripTitles = false,
    onProgress?: AIProgressCallback | ((current: number, total: number) => void)
  ): Promise<ReviewAndRegroupDecision[]> {
    if (tabs.length === 0) return []

    const reportProgress = (update: AIProgressUpdate) => {
      if (typeof onProgress === 'function') {
        (onProgress as any)(update)
      }
    }
    const modelName = this.config.model || DEFAULT_MODELS[this.config.provider] || 'default'

    reportProgress({
      stage: 'querying',
      statusText: `Reviewing ${tabs.length} tab${tabs.length === 1 ? '' : 's'} with ${modelName}...`,
      totalTabs: tabs.length,
      processedTabs: 0,
    })

    const results = await this.reviewAndRegroupBatch(tabs, 0, existingGroupNames, stripTitles, reportProgress)

    reportProgress({
      stage: 'parsing',
      statusText: `Finished reviewing ${tabs.length} tabs`,
      totalTabs: tabs.length,
      processedTabs: tabs.length,
    })

    return results
  }

  /**
   * Helper to build review & regroup prompt.
   */
  private buildReviewAndRegroupPrompt(
    tabs: ReviewAndRegroupTabInput[],
    existingGroupNames: string[],
    stripTitles = false
  ): string {
    const tabDescriptions = tabs
      .map((t, i) => this.formatTabWithGroupForPrompt(t, i + 1, stripTitles))
      .join('\n')
    const existingList = existingGroupNames.length > 0 ? existingGroupNames.map((n) => `"${n}"`).join(', ') : 'None'

    return `You are a browser tab organizer. Review the following tabs to verify if each tab is currently in the correct group, and regroup or categorize it if needed.

Existing tab groups: ${existingList}.

Tabs to check:
${tabDescriptions}

For each tab:
1. If its current group accurately matches its content/topic, KEEP it in that group: {"index": 1, "group": "KEEP"}.
   IMPORTANT: If the tab has "[Current group: None (ungrouped)]", do NOT return "KEEP" unless it should remain ungrouped. Assign it to an appropriate existing group or create a new group.
2. If it belongs in a different existing group from the list above, move it: {"index": 2, "group": "existing group name"}.
3. If it does not belong in any existing group and should be grouped, create a new group: {"index": 3, "group": "NEW", "newGroupName": "...", "newGroupColor": "blue"}.
4. If it should be ungrouped, set group to "_ungrouped_": {"index": 4, "group": "_ungrouped_"}.

Be conservative with already grouped tabs: if their current group is appropriate, keep them in that group. Regroup tabs that are misplaced or currently ungrouped.
Valid colors: grey, blue, red, yellow, green, pink, purple, cyan.

JSON format: [{"index":1,"group":"KEEP"}] or [{"index":2,"group":"existing group name"}] or [{"index":3,"group":"NEW","newGroupName":"...","newGroupColor":"blue"}]
Only output the JSON array.`
  }

  /**
   * Execute batch review and regroup call.
   */
  private async reviewAndRegroupBatch(
    tabs: ReviewAndRegroupTabInput[],
    offset: number,
    existingGroupNames: string[],
    stripTitles = false,
    onProgress?: (update: AIProgressUpdate) => void
  ): Promise<ReviewAndRegroupDecision[]> {
    const prompt = this.buildReviewAndRegroupPrompt(tabs, existingGroupNames, stripTitles)
    const onRetry = (retry: OperationRetryInfo) => {
      onProgress?.({
        stage: 'retrying',
        statusText: `Rate limit / transient error. Retrying in ${(retry.delayMs / 1000).toFixed(0)}s (Attempt ${retry.attempt}/${retry.maxRetries})...`,
        retry,
      })
    }

    try {
      const response = await this.chat(prompt, true, 1, onRetry, onProgress)
      return this.parseReviewAndRegroupResponse(response, tabs, offset, existingGroupNames)
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[timTabTool] Prompt blocked due to sensitive content in regroup review, retrying with URLs only...')
        return this.reviewAndRegroupBatch(tabs, offset, existingGroupNames, true, onProgress)
      }
      console.error('[timTabTool] Regroup review failed:', err)
      throw err
    }
  }

  /**
   * Parse the model JSON response for review and regroup decisions.
   */
  private parseReviewAndRegroupResponse(
    response: string,
    tabs: ReviewAndRegroupTabInput[],
    offset: number,
    existingGroupNames: string[]
  ): ReviewAndRegroupDecision[] {
    const extracted = extractJsonSubstring(response, 'auto')
    let parsedArray = this.tryParseRegroupJson(extracted)
    if (!parsedArray) {
      const arrayExtracted = extractJsonSubstring(response, 'array')
      parsedArray = this.tryParseRegroupJson(arrayExtracted)
    }

    if (!parsedArray || !Array.isArray(parsedArray)) {
      return this.fallbackAllToKeep(tabs, offset)
    }

    return this.mapParsedDecisions(parsedArray, tabs, offset, existingGroupNames)
  }

  /**
   * Attempt to parse regroup JSON and extract decision array from potential wrappers.
   */
  private tryParseRegroupJson(jsonStr: string): any[] | null {
    if (!jsonStr) return null
    let parsed: any = null
    try {
      parsed = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'))
    } catch {
      try {
        parsed = JSON.parse(repairTruncatedJson(jsonStr))
      } catch {
        return null
      }
    }

    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') {
      const possibleArrays = [
        parsed.decisions,
        parsed.tabs,
        parsed.results,
        parsed.items,
        parsed.groups,
        parsed.data,
      ]
      const found = possibleArrays.find((arr) => Array.isArray(arr))
      if (found) return found
    }
    return null
  }

  /**
   * Resolve group name and new group name from raw AI response fields.
   */
  private resolveTargetGroupName(
    rawGroup: string,
    rawNewName: string | undefined,
    existingGroupNames: string[]
  ): { group: string; newGroupName?: string } {
    if (rawGroup.toUpperCase() === 'KEEP') return { group: 'KEEP' }
    if (rawGroup.toLowerCase() === '_ungrouped_' || rawGroup.toUpperCase() === 'UNGROUPED') return { group: '_ungrouped_' }
    if (rawGroup.toUpperCase() === 'NEW') {
      const name = rawNewName || 'New Group'
      const match = existingGroupNames.find((n) => n.toLowerCase() === name.toLowerCase())
      return match ? { group: match } : { group: 'NEW', newGroupName: name }
    }
    if (rawGroup.length > 0) {
      const match = existingGroupNames.find((n) => n.toLowerCase() === rawGroup.toLowerCase())
      return match ? { group: match } : { group: 'NEW', newGroupName: rawNewName || rawGroup }
    }
    if (rawNewName && rawNewName.length > 0) {
      const match = existingGroupNames.find((n) => n.toLowerCase() === rawNewName.toLowerCase())
      return match ? { group: match } : { group: 'NEW', newGroupName: rawNewName }
    }
    return { group: 'KEEP' }
  }

  /**
   * Resolve a single parsed item into a structured decision.
   */
  private resolveParsedDecision(
    item: {
      index?: number
      group?: string
      targetGroup?: string
      category?: string
      name?: string
      newName?: string
      newGroupName?: string
      newGroupColor?: string
      color?: string
    },
    tabIdx: number,
    offset: number,
    existingGroupNames: string[]
  ): ReviewAndRegroupDecision {
    const rawGroup = typeof item.group === 'string'
      ? item.group.trim()
      : typeof item.targetGroup === 'string'
        ? item.targetGroup.trim()
        : typeof item.category === 'string'
          ? item.category.trim()
          : typeof item.name === 'string' && (item.newGroupName || item.color)
            ? item.name.trim()
            : ''

    const rawNewName = typeof item.newGroupName === 'string'
      ? item.newGroupName.trim()
      : typeof item.newName === 'string'
        ? item.newName.trim()
        : (typeof item.name === 'string' && (rawGroup.toUpperCase() === 'NEW' || !rawGroup))
          ? item.name.trim()
          : undefined

    const rawColor = typeof item.newGroupColor === 'string'
      ? item.newGroupColor.trim().toLowerCase()
      : typeof item.color === 'string'
        ? item.color.trim().toLowerCase()
        : undefined

    const validColor = VALID_COLORS.includes(rawColor as ChromeTabGroupColor) ? (rawColor as ChromeTabGroupColor) : undefined
    const { group, newGroupName } = this.resolveTargetGroupName(rawGroup, rawNewName, existingGroupNames)

    return {
      index: tabIdx + offset,
      group,
      newGroupName: newGroupName ? newGroupName.slice(0, MAX_GROUP_NAME_LENGTH) : undefined,
      newGroupColor: validColor,
    }
  }

  /**
   * Map parsed items into clean decisions, ensuring every tab has a valid decision.
   */
  private mapParsedDecisions(
    parsed: Array<{ index: number; group?: string; newGroupName?: string; newGroupColor?: string }>,
    tabs: ReviewAndRegroupTabInput[],
    offset: number,
    existingGroupNames: string[]
  ): ReviewAndRegroupDecision[] {
    const isZeroBased = parsed.some((item) => item?.index === 0) && !parsed.some((item) => item?.index === tabs.length)
    const decisionsByIndex = new Map<number, ReviewAndRegroupDecision>()

    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rawIdx = typeof item.index === 'number' ? item.index : parseInt(String(item.index), 10)
      if (isNaN(rawIdx)) continue
      const tabIdx = isZeroBased ? rawIdx : rawIdx - 1
      if (tabIdx < 0 || tabIdx >= tabs.length) continue

      const decision = this.resolveParsedDecision(item, tabIdx, offset, existingGroupNames)
      decisionsByIndex.set(tabIdx, decision)
    }

    return tabs.map((_, i) => decisionsByIndex.get(i) || { index: i + offset, group: 'KEEP' })
  }

  /**
   * Fallback returning KEEP for all tabs.
   */
  private fallbackAllToKeep(tabs: ReviewAndRegroupTabInput[], offset = 0): ReviewAndRegroupDecision[] {
    return tabs.map((_, i) => ({
      index: i + offset,
      group: 'KEEP',
    }))
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
   * Generates distinct, descriptive names for duplicate tab groups that currently share identical or ambiguous names.
   * @param {string} clusterName - Current common name or theme of the duplicate groups.
   * @param {DuplicateGroupClusterItem[]} groups - The groups to rename, each containing their current tabs.
   * @param {AIProgressCallback} [onProgress] - Optional progress callback for token/reasoning streaming.
   * @param {boolean} [stripTitles=false] - Whether to strip titles in case of prohibited content.
   * @returns {Promise<DistinctGroupRenameResult[]>}
   */
  async generateDistinctGroupNames(
    clusterName: string,
    groups: DuplicateGroupClusterItem[],
    onProgress?: AIProgressCallback,
    stripTitles = false,
  ): Promise<DistinctGroupRenameResult[]> {
    if (!groups || groups.length < 2) return []

    const formattedGroups = groups.map((g, idx) => {
      const tabLines = g.tabs
        .slice(0, 30)
        .map((t, tIdx) => this.formatTabForPrompt(t, tIdx + 1, stripTitles))
        .join('\n')
      return `Group #${idx + 1} (groupId: ${g.groupId}, current name: "${g.name}", total tabs: ${g.tabs.length}):\n${tabLines}`
    }).join('\n\n')

    const prompt = `You are an expert at organizing browser tabs into logical, distinctive groups.
I have ${groups.length} duplicate tab groups that currently share the same or similar name ("${clusterName}").
Your task is to analyze the tabs inside each group and generate a distinct, concise, and descriptive name (1-3 words) for each group based on its specific content and theme so the user can easily tell them apart.

Rules:
1. Every generated group name MUST be unique and distinct from the other groups.
2. Group names must be concise (1-3 words, capitalized, e.g. "React Components", "Marketing Research", "Travel Bookings").
3. Capture the specific differentiating topic or purpose of each group's tabs.
4. Output ONLY a valid JSON array of objects with the exact schema:
[
  {"groupId": ${groups[0].groupId}, "name": "Distinct Name 1"},
  ...
]

Groups to rename:
${formattedGroups}`

    try {
      const response = await this.chat(prompt, true, 1, undefined, onProgress)
      const extracted = extractJsonSubstring(response, 'auto')
      const jsonStr = extracted.replace(/,\s*([}\]])/g, '$1')

      let parsed: unknown = JSON.parse(jsonStr)
      if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
        const possibleKeys = ['groups', 'renames', 'results', 'decisions', 'items', 'data']
        for (const key of possibleKeys) {
          if (Array.isArray((parsed as Record<string, unknown>)[key])) {
            parsed = (parsed as Record<string, unknown>)[key]
            break
          }
        }
      }

      if (!Array.isArray(parsed)) {
        throw new Error('AI response did not return an array of renamed groups')
      }

      const results: DistinctGroupRenameResult[] = []
      const usedNames = new Set<string>()

      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const rawGid = (item as any).groupId ?? (item as any).id ?? (item as any).group_id
        const gid = Number(rawGid)
        if (isNaN(gid)) continue

        const originalGroup = groups.find((g) => g.groupId === gid)
        if (!originalGroup) continue

        let newName = String(
          (item as any).name ?? (item as any).newName ?? (item as any).new_name ?? (item as any).groupName ?? (item as any).title ?? ''
        ).trim()

        if (!newName) continue

        if (usedNames.has(newName.toLowerCase())) {
          let suffix = 2
          while (usedNames.has(`${newName} ${suffix}`.toLowerCase())) {
            suffix++
          }
          newName = `${newName} ${suffix}`
        }
        usedNames.add(newName.toLowerCase())

        results.push({
          groupId: gid,
          oldName: originalGroup.name,
          newName,
        })
      }

      return results
    } catch (err) {
      const msg = (err as Error).message
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback'))) {
        console.warn('[timTabTool] Prompt blocked in distinct group naming, retrying with URLs only...')
        return this.generateDistinctGroupNames(clusterName, groups, onProgress, true)
      }
      console.warn('[timTabTool] Failed to generate distinct group names. Error:', err)
      throw err
    }
  }

  /**
   * Generates a concise, descriptive name for a single browser window based on its tabs.
   * @param {Array<{ url: string; title: string; lastAccessed?: number; createdAt?: number }>} tabs
   * @param {{ existingNames?: string[]; windowId?: number; customPrompt?: string; onProgress?: AIProgressCallback; stripTitles?: boolean }} [options]
   * @returns {Promise<string>}
   */
  async generateWindowName(
    tabs: Array<{ url: string; title: string; lastAccessed?: number; createdAt?: number }>,
    options?: {
      existingNames?: string[]
      windowId?: number
      customPrompt?: string
      onProgress?: AIProgressCallback
      stripTitles?: boolean
    },
  ): Promise<string> {
    if (!tabs || tabs.length === 0) {
      return 'Empty Window'
    }

    const stripTitles = options?.stripTitles ?? false
    const tabLines = tabs
      .slice(0, 40)
      .map((t, idx) => this.formatTabForPrompt(t, idx + 1, stripTitles))
      .join('\n')

    const basePrompt = options?.customPrompt?.trim() || this.config.windowNamingPrompt?.trim() || DEFAULT_WINDOW_NAMING_PROMPT

    let contextSection = ''
    if (options?.existingNames && options.existingNames.length > 0) {
      contextSection = `\n\nOther open browser window names (your generated name must clearly differ and contrast with these): ${options.existingNames.map(n => `"${n}"`).join(', ')}.`
    }

    const prompt = `${basePrompt}${contextSection}

Tabs in this window (total ${tabs.length}):
${tabLines}

Output ONLY valid JSON matching this schema:
{"name": "Concise Descriptive Title"}`

    try {
      const response = await this.chat(prompt, true, 1, undefined, options?.onProgress)
      const extracted = extractJsonSubstring(response, 'auto')
      const jsonStr = extracted.replace(/,\s*([}\]])/g, '$1')

      let parsed: any = null
      try {
        parsed = JSON.parse(jsonStr)
      } catch {
        const match = response.match(/"(?:name|title|windowName)"\s*:\s*"([^"]+)"/i)
        if (match) {
          parsed = { name: match[1] }
        }
      }

      if (parsed && typeof parsed === 'object') {
        if (!parsed.name && !parsed.title && !parsed.windowName) {
          const keys = ['window', 'result', 'data', 'item', 'windows']
          for (const k of keys) {
            if (parsed[k] && typeof parsed[k] === 'object') {
              if (Array.isArray(parsed[k]) && parsed[k][0]) {
                parsed = parsed[k][0]
              } else {
                parsed = parsed[k]
              }
              break
            }
          }
        }
      }

      let generatedName = ''
      if (typeof parsed === 'string') {
        generatedName = parsed
      } else if (parsed && typeof parsed === 'object') {
        generatedName = String(parsed.name || parsed.title || parsed.windowName || parsed.newName || '').trim()
      }

      generatedName = generatedName.replace(/^["'`]+|["'`]+$/g, '').trim()

      if (!generatedName) {
        const cleanLine = response.replace(/```json|```|\{|\}|"name":/g, '').trim().split('\n')[0]?.trim()
        if (cleanLine && cleanLine.length <= 40) {
          generatedName = cleanLine.replace(/^["'`]+|["'`]+$/g, '').trim()
        }
      }

      if (!generatedName) {
        generatedName = 'Browser Window'
      }

      if (generatedName.length > 40) {
        generatedName = generatedName.slice(0, 40).trim()
      }

      return generatedName
    } catch (err) {
      const msg = (err as Error).message || ''
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback') || msg.includes('content safety') || msg.includes('safety policy'))) {
        console.warn('[timTabTool] Prompt blocked in window naming, retrying with URLs only...')
        return this.generateWindowName(tabs, { ...options, stripTitles: true })
      }
      console.warn('[timTabTool] Failed to generate window name. Error:', err)
      throw err
    }
  }

  /**
   * Generates distinct, descriptive names for multiple browser windows simultaneously.
   * @param {Array<{ windowId: number; tabs: Array<{ url: string; title: string; lastAccessed?: number; createdAt?: number }>; currentName?: string }>} windows
   * @param {{ customPrompt?: string; onProgress?: AIProgressCallback; stripTitles?: boolean }} [options]
   * @returns {Promise<WindowNameResult[]>}
   */
  async generateAllWindowsNames(
    windows: Array<{ windowId: number; tabs: Array<{ url: string; title: string; lastAccessed?: number; createdAt?: number }>; currentName?: string }>,
    options?: {
      customPrompt?: string
      onProgress?: AIProgressCallback
      stripTitles?: boolean
    },
  ): Promise<WindowNameResult[]> {
    if (!windows || windows.length === 0) return []

    const stripTitles = options?.stripTitles ?? false
    const formattedWindows = windows.map((w, idx) => {
      const tabLines = (w.tabs || [])
        .slice(0, 25)
        .map((t, tIdx) => this.formatTabForPrompt(t, tIdx + 1, stripTitles))
        .join('\n')
      const currentNameStr = w.currentName ? `, current name: "${w.currentName}"` : ''
      return `Window #${idx + 1} (windowId: ${w.windowId}, total tabs: ${w.tabs.length}${currentNameStr}):\n${tabLines || '(No tabs)'}`
    }).join('\n\n')

    const basePrompt = options?.customPrompt?.trim() || this.config.windowNamingPrompt?.trim() || DEFAULT_WINDOW_NAMING_PROMPT

    const prompt = `You are an expert at organizing browser workspaces.
${basePrompt}

Rules:
1. Every generated window name MUST be distinct and clearly contrast with other windows so the user can easily distinguish them.
2. Names must be concise (2-4 words, capitalized, e.g. "React Development", "Shopping & Reviews", "Finance & Invoices", "Travel Bookings").
3. Output ONLY a valid JSON array of objects with the exact schema:
[
  {"windowId": ${windows[0].windowId}, "name": "Distinct Window Name"},
  ...
]

Windows to name:
${formattedWindows}`

    try {
      const response = await this.chat(prompt, true, 1, undefined, options?.onProgress)
      const extracted = extractJsonSubstring(response, 'auto')
      const jsonStr = extracted.replace(/,\s*([}\]])/g, '$1')

      let parsed: unknown = JSON.parse(jsonStr)
      if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
        const possibleKeys = ['windows', 'results', 'names', 'items', 'data', 'decisions']
        for (const key of possibleKeys) {
          if (Array.isArray((parsed as Record<string, unknown>)[key])) {
            parsed = (parsed as Record<string, unknown>)[key]
            break
          }
        }
        if (!Array.isArray(parsed) && ((parsed as any).name || (parsed as any).title || (parsed as any).windowName)) {
          parsed = [parsed]
        }
      }

      if (!Array.isArray(parsed)) {
        throw new Error('AI response did not return an array of window names')
      }

      const results: WindowNameResult[] = []
      const usedNames = new Set<string>()

      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const rawWid = (item as any).windowId ?? (item as any).id ?? (item as any).window_id ?? (windows.length === 1 ? windows[0].windowId : undefined)
        const wid = Number(rawWid)
        if (isNaN(wid)) continue

        const targetWin = windows.find(w => w.windowId === wid)
        if (!targetWin) continue

        let name = String((item as any).name ?? (item as any).title ?? (item as any).windowName ?? '').trim()
        name = name.replace(/^["'`]+|["'`]+$/g, '').trim()
        if (!name) continue
        if (name.length > 40) name = name.slice(0, 40).trim()

        if (usedNames.has(name.toLowerCase())) {
          let suffix = 2
          while (usedNames.has(`${name} ${suffix}`.toLowerCase())) {
            suffix++
          }
          name = `${name} ${suffix}`
        }
        usedNames.add(name.toLowerCase())

        results.push({ windowId: wid, name })
      }

      // If any window was omitted by the model, provide a sensible fallback
      for (const w of windows) {
        if (!results.some(r => r.windowId === w.windowId)) {
          let fallbackName = 'Window'
          if (w.tabs.length > 0) {
            const firstDomain = extractDomain(w.tabs[0].url) || 'General'
            fallbackName = `${firstDomain} Tabs`
          }
          if (usedNames.has(fallbackName.toLowerCase())) {
            let suffix = 2
            while (usedNames.has(`${fallbackName} ${suffix}`.toLowerCase())) suffix++
            fallbackName = `${fallbackName} ${suffix}`
          }
          usedNames.add(fallbackName.toLowerCase())
          results.push({ windowId: w.windowId, name: fallbackName })
        }
      }

      return results
    } catch (err) {
      const msg = (err as Error).message || ''
      if (!stripTitles && (msg.includes('PROHIBITED_CONTENT') || msg.includes('Prohibited Use policy') || msg.includes('promptFeedback') || msg.includes('content safety') || msg.includes('safety policy'))) {
        console.warn('[timTabTool] Prompt blocked in multi-window naming, retrying with URLs only...')
        return this.generateAllWindowsNames(windows, { ...options, stripTitles: true })
      }
      console.warn('[timTabTool] Failed to generate all window names. Error:', err)
      throw err
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
   * @param {string} prompt
   * @param {boolean} [jsonMode]
   * @param {number} [batchIndex]
   * @param {Function} [onRetry]
   * @returns {Promise<string>}
   */
  public async chat(
    prompt: string,
    jsonMode = false,
    batchIndex = 1,
    onRetry?: (info: OperationRetryInfo) => void,
    onProgress?: (progress: AIProgressUpdate) => void
  ): Promise<string> {
    // Logic: Delegate request to OpenAI, Claude, or Gemini
    return this.executeWithRetry(async () => {
      const { provider } = this.config

      if (provider === 'claude') {
        return this.chatClaude(prompt, jsonMode, batchIndex)
      }

      if (provider === 'gemini') {
        return this.chatGemini(prompt, jsonMode, batchIndex, onProgress)
      }

      // OpenAI / Custom (OpenAI-compatible)
      return this.chatOpenAI(prompt, jsonMode, batchIndex, onProgress)
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

      const openrouterProviderObj: any = {}
      if (this.config.provider === 'openrouter') {
        if (this.config.openrouterProvider && this.config.openrouterProvider.trim() !== '' && this.config.openrouterProvider !== 'auto') {
          openrouterProviderObj.order = [this.config.openrouterProvider.trim()]
          if (this.config.openrouterAllowFallbacks !== undefined) {
            openrouterProviderObj.allow_fallbacks = this.config.openrouterAllowFallbacks
          }
        }
        if (this.config.openrouterRequireParams !== undefined) {
          openrouterProviderObj.require_parameters = this.config.openrouterRequireParams
        }
        if (this.config.openrouterDataCollection && this.config.openrouterDataCollection !== 'allow') {
          openrouterProviderObj.data_collection = this.config.openrouterDataCollection
        }
        if (this.config.openrouterSort && this.config.openrouterSort !== 'auto') {
          openrouterProviderObj.sort = this.config.openrouterSort
        }
        if (this.config.openrouterIgnoreProviders && this.config.openrouterIgnoreProviders.trim()) {
          const ignored = this.config.openrouterIgnoreProviders.split(',').map((s: string) => s.trim()).filter(Boolean)
          if (ignored.length > 0) {
            openrouterProviderObj.ignore = ignored
          }
        }
      }

      const openrouterFallbackList = this.config.provider === 'openrouter' && this.config.openrouterFallbackModels && this.config.openrouterFallbackModels.trim()
        ? [model, ...this.config.openrouterFallbackModels.split(',').map((s: string) => s.trim()).filter((s: string) => s && s !== model)]
        : undefined

      // Safe completion token ceiling to ensure prompt + max_tokens <= context_length
      let reqMaxTokens = this.config.maxTokens || 16384
      if (reqMaxTokens > 32768) {
        reqMaxTokens = 16384
      }

      const requestBody: any = {
        model,
        messages,
        temperature: 0,
        max_tokens: reqMaxTokens,
        ...(onProgress && { stream: true }),
        ...(jsonMode && { response_format: { type: 'json_object' } }),
        ...(this.config.provider === 'openrouter' && this.config.reasoningEffort && this.config.reasoningEffort !== 'auto' && {
          reasoning: {
            effort: this.config.reasoningEffort
          }
        }),
        ...(this.config.provider === 'openrouter' && Object.keys(openrouterProviderObj).length > 0 && {
          provider: openrouterProviderObj
        }),
        ...(this.config.provider === 'openrouter' && openrouterFallbackList && openrouterFallbackList.length > 1 && {
          models: openrouterFallbackList
        }),
        ...(this.config.provider === 'openai' && this.config.reasoningEffort && this.config.reasoningEffort !== 'auto' && {
          reasoning_effort: this.config.reasoningEffort
        }),
      }

      let response = await fetch(endpoint, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(requestBody),
        signal: this.signal,
      })

      // If 400 Bad Request due to unsupported response_format or parameter on OpenRouter/custom, retry without response_format
      if (!response.ok && response.status === 400 && requestBody.response_format) {
        const peekText = await response.clone().text().catch(() => '')
        const lowerPeek = peekText.toLowerCase()
        if (
          lowerPeek.includes('response_format') ||
          lowerPeek.includes('json_object') ||
          lowerPeek.includes('parameter') ||
          lowerPeek.includes('schema') ||
          lowerPeek.includes('not supported')
        ) {
          delete requestBody.response_format
          response = await fetch(endpoint, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(requestBody),
            signal: this.signal,
          })
        }
      }

      // If 400 Bad Request due to max_tokens exceeding provider output limits, retry with safe 4096 tokens
      if (!response.ok && response.status === 400 && requestBody.max_tokens > 4096) {
        const peekText = await response.clone().text().catch(() => '')
        const lowerPeek = peekText.toLowerCase()
        if (lowerPeek.includes('max_tokens') || lowerPeek.includes('maximum tokens') || lowerPeek.includes('context_length')) {
          requestBody.max_tokens = 4096
          response = await fetch(endpoint, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(requestBody),
            signal: this.signal,
          })
        }
      }

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
                }

                if ((delta?.content || rDelta) && onProgress) {
                  const now = Date.now()
                  if (now - lastProgressEmit > 40) {
                    lastProgressEmit = now
                    const cleanSnippet = accumulatedReasoning.trim()
                    onProgress({
                      stage: 'evaluating',
                      liveContent: text,
                      liveReasoning: accumulatedReasoning,
                      reasoningSnippet: cleanSnippet.length > 120 ? '...' + cleanSnippet.slice(-120) : cleanSnippet,
                    })
                  }
                }
              } catch {
                // partial SSE payload, ignored
              }
            }
          }
        }
        // Final live content and reasoning flush
        if (onProgress && (accumulatedReasoning || text)) {
          const cleanSnippet = accumulatedReasoning.trim()
          onProgress({
            stage: 'evaluating',
            liveContent: text,
            liveReasoning: accumulatedReasoning,
            reasoningSnippet: cleanSnippet.length > 120 ? '...' + cleanSnippet.slice(-120) : cleanSnippet,
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
        const reasoning = choice?.message?.reasoning || choice?.message?.reasoning_content || choice?.message?.thought
        if (reasoning) {
          accumulatedReasoning = reasoning
          if (onProgress) {
            const cleanSnippet = reasoning.trim()
            onProgress({
              stage: 'evaluating',
              liveReasoning: reasoning,
              reasoningSnippet: cleanSnippet.length > 120 ? '...' + cleanSnippet.slice(-120) : cleanSnippet,
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
    const baseUrl = assertSecureEndpoint(this.config.endpoint || DEFAULT_ENDPOINTS.claude)
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

      let reqMaxTokens = this.config.maxTokens || 8192
      const claudeModel = this.config.model || this.defaultModel
      if (claudeModel.includes('3-7') || claudeModel.includes('opus-4')) {
        reqMaxTokens = Math.min(reqMaxTokens, 64000)
      } else {
        reqMaxTokens = Math.min(reqMaxTokens, 8192)
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
          model: claudeModel,
          max_tokens: reqMaxTokens,
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
  /**
   * Consumes a Gemini Server-Sent Events (SSE) stream and extracts thought / reasoning deltas.
   * @param {Response} response
   * @param {Function} [onProgress]
   * @returns {Promise<{ text: string; accumulatedReasoning: string; finishReason?: string }>}
   */
  private async readGeminiSseStream(
    response: Response,
    onProgress?: (update: AIProgressUpdate) => void
  ): Promise<{ text: string; accumulatedReasoning: string; finishReason?: string }> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let text = ''
    let accumulatedReasoning = ''
    let finishReason: string | undefined
    let lastProgressEmit = 0

    const processLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]') return
      if (!trimmed.startsWith('data: ')) return

      try {
        const json = JSON.parse(trimmed.slice(6))
        if (json.promptFeedback?.blockReason === 'PROHIBITED_CONTENT') {
          throw new Error(`PROHIBITED_CONTENT: ${json.promptFeedback.blockReasonMessage || 'Prohibited content blocked.'}`)
        }
        if (json.error) {
          throw new Error(`Gemini stream error: ${json.error.message || JSON.stringify(json.error)}`)
        }

        const candidate = json.candidates?.[0]
        if (!candidate) return

        if (candidate.finishReason) {
          finishReason = candidate.finishReason
        }

        const parts: any[] = candidate.content?.parts || []
        let chunkHasDelta = false

        // Extract reasoning from candidate level if available
        if (candidate.reasoning_content || candidate.reasoning) {
          const candidateThought = candidate.reasoning_content || candidate.reasoning
          if (typeof candidateThought === 'string' && candidateThought) {
            accumulatedReasoning += candidateThought
            chunkHasDelta = true
          }
        }

        for (const part of parts) {
          const isThoughtPart = Boolean(part.thought) || Boolean(part.thoughtSignature && !part.text)
          if (isThoughtPart) {
            const rDelta = typeof part.thought === 'string' 
              ? part.thought 
              : (typeof part.text === 'string' ? part.text : '')
            if (rDelta) {
              accumulatedReasoning += rDelta
              chunkHasDelta = true
            }
          } else if (part.text) {
            text += part.text
            chunkHasDelta = true
          }
        }

        if (chunkHasDelta && onProgress) {
          const now = Date.now()
          if (now - lastProgressEmit > 40) {
            lastProgressEmit = now
            const cleanSnippet = accumulatedReasoning.trim()
            onProgress({
              stage: 'evaluating',
              liveContent: text,
              liveReasoning: accumulatedReasoning,
              reasoningSnippet: cleanSnippet.length > 120 ? '...' + cleanSnippet.slice(-120) : cleanSnippet,
            })
          }
        }
      } catch (e: any) {
        if (e.message?.startsWith('PROHIBITED_CONTENT') || e.message?.startsWith('Gemini stream error')) throw e
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        processLine(line)
      }
    }
    if (buffer.trim()) {
      processLine(buffer)
    }

    if (onProgress && (accumulatedReasoning || text)) {
      const cleanSnippet = accumulatedReasoning.trim()
      onProgress({
        stage: 'evaluating',
        liveContent: text,
        liveReasoning: accumulatedReasoning,
        reasoningSnippet: cleanSnippet.length > 120 ? '...' + cleanSnippet.slice(-120) : cleanSnippet,
      })
    }

    return { text, accumulatedReasoning, finishReason }
  }

  /**
   * Parses non-streaming JSON response from Gemini API.
   * @param {any} data
   * @param {Function} [onProgress]
   * @returns {{ text: string; accumulatedReasoning: string; finishReason?: string }}
   */
  private parseGeminiJsonResponse(
    data: any,
    onProgress?: (update: AIProgressUpdate) => void
  ): { text: string; accumulatedReasoning: string; finishReason?: string } {
    if (data.promptFeedback?.blockReason === 'PROHIBITED_CONTENT') {
      throw new Error(`PROHIBITED_CONTENT: ${data.promptFeedback.blockReasonMessage || 'Prohibited content blocked.'}`)
    }

    const candidate = data.candidates?.[0]
    const finishReason = candidate?.finishReason
    const parts: any[] = candidate?.content?.parts || []
    const thoughtParts = parts.filter((p: any) => Boolean(p.thought) || Boolean(p.thoughtSignature && !p.text))
    const textParts = parts.filter((p: any) => !p.thought && !(p.thoughtSignature && !p.text))
    const text = textParts.map((p: any) => p.text || '').join('')
    let accumulatedReasoning = ''

    if (candidate?.reasoning_content && typeof candidate.reasoning_content === 'string') {
      accumulatedReasoning += candidate.reasoning_content
    } else if (candidate?.reasoning && typeof candidate.reasoning === 'string') {
      accumulatedReasoning += candidate.reasoning
    }

    if (thoughtParts.length > 0) {
      const reasoningText = thoughtParts.map((p: any) => (typeof p.thought === 'string' ? p.thought : p.text) || '').join('')
      accumulatedReasoning += reasoningText
    }

    if (accumulatedReasoning && onProgress) {
      const cleanSnippet = accumulatedReasoning.trim()
      onProgress({
        stage: 'evaluating',
        liveContent: text,
        liveReasoning: accumulatedReasoning,
        reasoningSnippet: cleanSnippet.length > 120 ? '...' + cleanSnippet.slice(-120) : cleanSnippet,
      })
    }

    return { text, accumulatedReasoning, finishReason }
  }

  private async chatGemini(
    userMessage: string, 
    jsonMode?: boolean, 
    batchIndex = 1,
    onProgress?: (update: AIProgressUpdate) => void
  ): Promise<string> {
    const baseUrl = assertSecureEndpoint(this.config.endpoint || DEFAULT_ENDPOINTS.gemini)
    const model = this.config.model || this.defaultModel
    const maxContinuations = 3
    let continuations = 0
    let accumulatedContent = ''
    let accumulatedReasoning = ''

    const effort = this.config.reasoningEffort

    let thinkingConfig: Record<string, any> | undefined
    if (effort && effort !== 'auto') {
      const thinkingLevel = effort === 'max' ? 'high' : effort
      thinkingConfig = {
        thinkingLevel,
        includeThoughts: true,
      }
    } else {
      thinkingConfig = {
        includeThoughts: true,
      }
    }
    
    const contents: any[] = [
      { role: 'user', parts: [{ text: userMessage }] },
    ]

    while (continuations <= maxContinuations) {
      const startTime = Date.now()
      const action = onProgress ? 'streamGenerateContent' : 'generateContent'
      const sseQuery = onProgress ? '?alt=sse' : ''
      const apiKey = (this.config.apiKey || '').trim()
      // Send the key as a header so it never ends up in URLs, logs or log exports
      const endpoint = `${baseUrl}/v1beta/models/${model}:${action}${sseQuery}`
      const geminiHeaders = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }

      if (this.logger) {
        this.logger.logRawRequest(batchIndex, endpoint, `Message len: ${userMessage.length}`, this.systemPrompt, userMessage)
      }

      const generationConfig: any = {
        maxOutputTokens: Math.min(this.config.maxTokens || 16384, 65536),
        ...(jsonMode && { responseMimeType: 'application/json' }),
        ...(thinkingConfig !== undefined && {
          thinkingConfig: { ...thinkingConfig },
        }),
      }

      let response = await fetch(endpoint, {
        method: 'POST',
        headers: geminiHeaders,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: this.systemPrompt }] },
          contents,
          generationConfig,
        }),
        signal: this.signal,
      })

      if (!response.ok && response.status === 400 && generationConfig.thinkingConfig) {
        const peekText = await response.clone().text().catch(() => '')
        const lowerPeek = peekText.toLowerCase()
        if (
          lowerPeek.includes('thinking') ||
          lowerPeek.includes('thinkingbudget') ||
          lowerPeek.includes('thinkinglevel') ||
          lowerPeek.includes('thinkingconfig') ||
          lowerPeek.includes('not supported')
        ) {
          delete generationConfig.thinkingConfig
          response = await fetch(endpoint, {
            method: 'POST',
            headers: geminiHeaders,
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: this.systemPrompt }] },
              contents,
              generationConfig,
            }),
            signal: this.signal,
          })
        }
      }

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
        if (!errText.trim()) errText = response.statusText || 'Unknown Error'
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, errText, undefined, `API error ${response.status}: ${errText}`)
        }
        throw new Error(`API error ${response.status}: ${errText}`)
      }

      const contentType = response.headers?.get?.('content-type') || ''
      const isSSE = contentType.includes('text/event-stream')
      const hasStreamReader = Boolean(response.body && typeof (response.body as any).getReader === 'function')

      let text = ''
      let finishReason: string | undefined

      if (isSSE && hasStreamReader) {
        const streamResult = await this.readGeminiSseStream(response, onProgress)
        text = streamResult.text
        accumulatedReasoning = streamResult.accumulatedReasoning
        finishReason = streamResult.finishReason
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, text, { accumulatedReasoning })
        }
      } else {
        const data = await response.json()
        const nonStreamResult = this.parseGeminiJsonResponse(data, onProgress)
        text = nonStreamResult.text
        accumulatedReasoning = nonStreamResult.accumulatedReasoning
        finishReason = nonStreamResult.finishReason
        if (this.logger) {
          this.logger.logRawResponse(batchIndex, response.status, duration, text, { ...data, accumulatedReasoning })
        }
      }

      accumulatedContent += text

      if (finishReason) {
        if (finishReason === 'MAX_TOKENS') {
          if (continuations >= maxContinuations) break
          continuations++
          contents.push({ role: 'model', parts: [{ text }] })
          contents.push({ role: 'user', parts: [{ text: 'Continue exactly from where you left off. Do not repeat previous text.' }] })
          continue
        } else if (finishReason !== 'STOP') {
          throw new Error(`AI response failed: ${finishReason}`)
        }
      }
      break
    }
    
    return accumulatedContent
  }

  private getBaseUrl(): string {
    return assertSecureEndpoint(this.config.endpoint || DEFAULT_ENDPOINTS[this.config.provider] || DEFAULT_ENDPOINTS.openai)
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey && this.config.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${this.config.apiKey.trim()}`
    }
    if (this.config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://timayaya.de'
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


