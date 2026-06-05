import type { ClassifyResult, GroupCategory, AIConfig, ChromeTabGroupColor } from '../shared/types'
import { DOMAIN_RULES, KEYWORD_RULES } from '../shared/rules'
import { extractDomain } from '../shared/utils'
import { AIClient } from '../shared/ai-client'


/**
 * Classify a tab into a category using the rule engine.
 * Priority: exact domain > parent domain > title keywords > default.
 */
export function classify(url: string | undefined, title: string | undefined): ClassifyResult {
  // 1. Exact domain match
  const domain = extractDomain(url)
  if (domain) {
    const exactMatch = DOMAIN_RULES[domain]
    if (exactMatch) {
      return { category: exactMatch, confidence: 0.95, method: 'domain' }
    }

    // 1.5 Parent domain match
    const parts = domain.split('.')
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
 */
export function classifyTabs(
  tabs: { url?: string; title?: string; id?: number }[],
): Map<GroupCategory, number[]> {
  const groups = new Map<GroupCategory, number[]>()

  for (const tab of tabs) {
    if (!tab.id) continue
    const result = classify(tab.url, tab.title)
    const existing = groups.get(result.category) || []
    existing.push(tab.id)
    groups.set(result.category, existing)
  }

  return groups
}


export interface FreeGroupResult {
  name: string
  color: ChromeTabGroupColor
  tabIds: number[]
}

/**
 * Send all tabs to AI for free-form grouping with custom group names and colors.
 * Throws on failure — caller should catch and fall back to rule engine.
 */
export async function groupTabsFreelyWithAI(
  tabs: { url?: string; title?: string; id?: number }[],
  aiConfig: AIConfig,
  signal?: AbortSignal,
): Promise<FreeGroupResult[]> {
  const validTabs = tabs.filter(
    (t): t is { url: string; title: string; id: number } => !!t.id && !!t.url,
  )

  if (validTabs.length === 0) return []

  const processedTabs = [...validTabs]
  if (aiConfig.sendRandomOrder) {
    for (let i = processedTabs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [processedTabs[i], processedTabs[j]] = [processedTabs[j], processedTabs[i]]
    }
  }

  const client = new AIClient(aiConfig, signal)
  const aiGroups = await client.groupTabsFreely(
    processedTabs.map((t) => ({ url: t.url, title: t.title || '' })),
  )

  return aiGroups.map((g) => ({
    name: g.name,
    color: g.color || 'grey',
    tabIds: g.tabIndices.map((i) => processedTabs[i - 1].id),
  }))
}
