import type { GroupCategory, GroupDefinition, ExtensionSettings } from './types'

export const GROUP_DEFINITIONS: Record<GroupCategory, GroupDefinition> = {
  work:   { color: 'blue',   labelKey: 'groupWork' },
  dev:    { color: 'green',  labelKey: 'groupDev' },
  learn:  { color: 'purple', labelKey: 'groupLearn' },
  social: { color: 'cyan',   labelKey: 'groupSocial' },
  media:  { color: 'red',    labelKey: 'groupMedia' },
  shop:   { color: 'yellow', labelKey: 'groupShop' },
  docs:   { color: 'pink',   labelKey: 'groupDocs' },
  other:  { color: 'grey',   labelKey: 'groupOther' },
}

export const ALL_CATEGORIES: GroupCategory[] = [
  'work', 'dev', 'learn', 'social', 'media', 'shop', 'docs', 'other',
]

export const DEFAULT_GROUPING_PROMPT = `Organize these browser tabs into logical, well-defined groups.
Guidelines:
1. Create 2-6 groups. Avoid creating too many single-tab groups.
2. Group names must be concise (1-3 words) and descriptive (e.g., "Web Development", "Shopping").
3. Use the same language as the tab titles.
4. Group related items aggressively rather than fragmenting them.`

export const DEFAULT_SPLIT_PROMPT = 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.'
export const DEFAULT_CLASSIFY_PROMPT = 'You are classifying new tabs. Decide if each new tab belongs to one of the existing groups or if a new group should be created. Be conservative about creating new groups.'

export const DEFAULT_SETTINGS: ExtensionSettings = {
  ai: {
    enabled: false,
    provider: 'openai',
    apiKey: '',
    batchSize: 20,
    customPrompt: '',
    groupingPrompt: DEFAULT_GROUPING_PROMPT,
    fallbackToSort: false,
    maxTokens: 16384,
    coherencePrompt: 'You should prioritize placing tabs into these existing groups if they fit, rather than creating new, redundant groups.',
    splitPrompt: DEFAULT_SPLIT_PROMPT,
    classifyPrompt: DEFAULT_CLASSIFY_PROMPT,
  },
  language: 'auto',
  groupOnStartup: false,
  searchShortcut: 'Ctrl+Shift+F',
  groupIndicatorStyle: 'header',
  smartGroupTitle: true,
  theme: 'system',
  windowWidth: 360,
  windowHeight: 600,
}

export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  TAB_HISTORY: 'tabHistory',
} as const
