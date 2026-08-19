import type { ClassifyResult, GroupCategory, AIConfig, ChromeTabGroupColor, AIProgressCallback } from '../shared/types'
import type { AILogger } from '../shared/ai-logger'
import { DOMAIN_RULES, KEYWORD_RULES } from '../shared/rules'
import { extractDomain } from '../shared/utils'
import { AIClient } from '../shared/ai-client'

/**
 * Classify a tab into a category using the rule engine.
 * Priority: exact domain > parent domain > title keywords > default.
 * @param {string | undefined} url - The URL of the tab to classify.
 * @param {string | undefined} title - The title of the tab to classify.
 * @returns {ClassifyResult} The classification result including category and confidence.
 */
export function classify(url: string | undefined, title: string | undefined): ClassifyResult {
  // 1. Exact domain match
  const domain = extractDomain(url)
  if (domain) {
    // Logic: check for exact domain match first
    const exactMatch = DOMAIN_RULES[domain]
    if (exactMatch) {
      return { category: exactMatch, confidence: 0.95, method: 'domain' }
    }

    // 1.5 Parent domain match
    const parts = domain.split('.')
    // Logic: loop through domain parts to find a parent domain match
    for (let i = 1; i < parts.length - 1; i++) {
      const parentDomain = parts.slice(i).join('.')
      const parentMatch = DOMAIN_RULES[parentDomain]
      if (parentMatch) {
        return { category: parentMatch, confidence: 0.85, method: 'domain' }
      }
    }
  }

  // 2. Title keyword match
  if (title) {
    // Logic: loop through keywords rules to find regex match in title
    for (const rule of KEYWORD_RULES) {
      if (rule.pattern.test(title)) {
        return { category: rule.category, confidence: 0.7, method: 'keyword' }
      }
    }
  }

  // 3. Default
  return { category: 'other', confidence: 0.3, method: 'default' }
}

/**
 * Classify multiple tabs and group them by category (rule engine only).
 * @param {Array<{ url?: string; title?: string; id?: number }>} tabs - The tabs to classify.
 * @returns {Map<GroupCategory, number[]>} A map of category to array of tab IDs.
 */
export function classifyTabs(
  tabs: { url?: string; title?: string; id?: number }[],
): Map<GroupCategory, number[]> {
  const groups = new Map<GroupCategory, number[]>()

  // Logic: loop through tabs and group by classification result
  for (const tab of tabs) {
    if (!tab.id) continue
    const result = classify(tab.url, tab.title)
    const existing = groups.get(result.category) || []
    existing.push(tab.id)
    groups.set(result.category, existing)
  }

  return groups
}


/**
 * Interface for free-form grouping result from AI.
 */
export interface FreeGroupResult {
  /** The name of the group */
  name: string
  /** The assigned color for the group */
  color: ChromeTabGroupColor
  /** Array of tab IDs belonging to this group */
  tabIds: number[]
}

/**
 * Send all tabs to AI for free-form grouping with custom group names and colors.
 * Throws on failure — caller should catch and fall back to rule engine.
 * @param {Array<{ url?: string; title?: string; id?: number; lastAccessed?: number; createdAt?: number }>} tabs - The tabs to group.
 * @param {AIConfig} aiConfig - AI configuration settings.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @param {AILogger} [logger] - Optional logger instance.
 * @param {AIProgressCallback | Function} [onProgress] - Optional progress callback.
 * @returns {Promise<FreeGroupResult[]>} The AI generated grouping result.
 */
export async function groupTabsFreelyWithAI(
  tabs: { url?: string; title?: string; id?: number; lastAccessed?: number; createdAt?: number }[],
  aiConfig: AIConfig,
  signal?: AbortSignal,
  logger?: AILogger,
  onProgress?: AIProgressCallback | ((current: number, total: number) => void)
): Promise<FreeGroupResult[]> {
  const validTabs = tabs.filter(
    (t): t is { url: string; title: string; id: number; lastAccessed?: number; createdAt?: number } => !!t.id && !!t.url,
  )

  if (validTabs.length === 0) return []

  const processedTabs = [...validTabs]
  // Logic: optionally randomize tab order before sending to AI
  if (aiConfig.sendRandomOrder) {
    for (let i = processedTabs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [processedTabs[i], processedTabs[j]] = [processedTabs[j], processedTabs[i]]
    }
  }

  const client = new AIClient(aiConfig, signal, logger)
  const aiGroups = await client.groupTabsFreely(
    processedTabs.map((t) => ({
      url: t.url,
      title: t.title || '',
      lastAccessed: t.lastAccessed,
      createdAt: t.createdAt,
    })),
    [],
    onProgress
  )

  return aiGroups.map((g) => ({
    name: g.name,
    color: g.color || 'grey',
    tabIds: g.tabIndices.map((i) => processedTabs[i - 1].id),
  }))
}
