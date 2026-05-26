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
export const DEFAULT_MERGE_PROMPT = 'Analyze the browser tabs of this group and decide if they should be merged into one of the other existing tab groups. Choose the best fitting existing group from the list. If none of the existing groups are a good fit and this group should remain separate, respond with "KEEP". Be conservative about merging; only merge if the topics are highly related.'

export const DEFAULT_SETTINGS: ExtensionSettings = {
  ai: {
    enabled: false,
    provider: 'openai',
    apiKey: '',
    batchSize: 20,
    customPrompt: '',
    groupingPrompt: DEFAULT_GROUPING_PROMPT,
    sendFullUrl: false,
    fallbackToSort: false,
    maxTokens: 16384,
    coherencePrompt: 'You should try to place tabs into these existing groups if they are a strong semantic fit. However, if the existing groups are a poor fit or if the previous grouping structure seems bad, feel free to create a new group. Do not force tabs into mismatched groups.',
    splitPrompt: DEFAULT_SPLIT_PROMPT,
    classifyPrompt: DEFAULT_CLASSIFY_PROMPT,
    mergePrompt: DEFAULT_MERGE_PROMPT,
    maxRetries: 2,
  },
  language: 'auto',
  groupOnStartup: false,
  searchShortcut: 'Ctrl+Shift+F',
  groupIndicatorStyle: 'header',
  smartGroupTitle: true,
  theme: 'system',
  windowWidth: 360,
  windowHeight: 600,
  showRuleGroupsWhenUngrouped: true,
}

export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  TAB_HISTORY: 'tabHistory',
} as const

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Gemini
  'gemini-3.5-flash': { input: 1.50, output: 9.00 },
  'gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
  'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
  'gemini-3.1-flash-live-preview': { input: 0.75, output: 4.50 },
  'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'gemini-3-pro-preview': { input: 2.00, output: 12.00 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash-lite-preview-09-2025': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
  'gemma-4-31b-it': { input: 0, output: 0 },
  'gemma-4-26b-a4b-it': { input: 0, output: 0 },

  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },

  // Claude
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
}

export const PROVIDER_DEFAULTS: Record<string, { input: number; output: number }> = {
  openai: { input: 0.15, output: 0.60 },
  claude: { input: 3.00, output: 15.00 },
  gemini: { input: 1.50, output: 9.00 },
  custom: { input: 0.15, output: 0.60 },
}
