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

export const DEFAULT_SETTINGS: ExtensionSettings = {
  ai: {
    enabled: false,
    provider: 'openai',
    apiKey: '',
    batchSize: 20,
    customPrompt: '',
    groupingPrompt: DEFAULT_GROUPING_PROMPT,
  },
  language: 'auto',
  groupOnStartup: false,
  searchShortcut: 'Ctrl+Shift+F',
  groupIndicatorStyle: 'header',
  smartGroupTitle: true,
  theme: 'system',
  windowWidth: 360,
}

export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  TAB_HISTORY: 'tabHistory',
} as const
