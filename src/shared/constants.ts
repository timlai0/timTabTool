import type { GroupCategory, GroupDefinition, ExtensionSettings } from './types'

export const GROUP_DEFINITIONS: Record<GroupCategory, GroupDefinition> = {
  work: { color: 'blue', labelKey: 'groupWork' },
  dev: { color: 'green', labelKey: 'groupDev' },
  learn: { color: 'purple', labelKey: 'groupLearn' },
  social: { color: 'cyan', labelKey: 'groupSocial' },
  media: { color: 'red', labelKey: 'groupMedia' },
  shop: { color: 'yellow', labelKey: 'groupShop' },
  docs: { color: 'pink', labelKey: 'groupDocs' },
  other: { color: 'grey', labelKey: 'groupOther' },
}



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
    sendRandomOrder: false,
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
  mcpEnabled: true,
  mcpPort: 8585,
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
  'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'gemini-3-pro-preview': { input: 2.00, output: 12.00 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemma-4-31b-it': { input: 0, output: 0 },
  'gemma-4-26b-a4b-it': { input: 0, output: 0 },

  // OpenAI
  'gpt-4.5-preview': { input: 75.00, output: 150.00 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'o1': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 1.10, output: 4.40 },

  // Claude
  'claude-3-7-sonnet-20250219': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
}

export const PROVIDER_DEFAULTS: Record<string, { input: number; output: number }> = {
  openai: { input: 0.15, output: 0.60 },
  claude: { input: 3.00, output: 15.00 },
  gemini: { input: 0.30, output: 2.50 },
  custom: { input: 0.15, output: 0.60 },
}

export const PREDEFINED_MODELS: Record<string, { id: string, name: string, complexity: string, costFactor: string, maxTokens: string }[]> = {
  gemini: [
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', complexity: 'Medium', costFactor: '75%', maxTokens: '65K' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', complexity: 'High', costFactor: '100%', maxTokens: '65K' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', complexity: 'Low', costFactor: '12%', maxTokens: '65K' },
    { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite (Preview)', complexity: 'Low', costFactor: '12%', maxTokens: '65K' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)', complexity: 'Medium', costFactor: '25%', maxTokens: '65K' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)', complexity: 'High', costFactor: '100%', maxTokens: '65K' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', complexity: 'High', costFactor: '62%', maxTokens: '65K' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', complexity: 'Medium', costFactor: '15%', maxTokens: '65K' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', complexity: 'Low', costFactor: '5%', maxTokens: '65K' },
    { id: 'gemma-4-31b-it', name: 'Gemma 4 31B', complexity: 'Low', costFactor: 'Free', maxTokens: '8K' },
    { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B', complexity: 'Low', costFactor: 'Free', maxTokens: '8K' },
  ],
  openai: [
    { id: 'gpt-4.5-preview', name: 'GPT-4.5 (Preview)', complexity: 'High', costFactor: '100%', maxTokens: '65K' },
    { id: 'gpt-4o', name: 'GPT-4o', complexity: 'High', costFactor: '100%', maxTokens: '16K' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', complexity: 'Low', costFactor: '6%', maxTokens: '16K' },
    { id: 'o3-mini', name: 'o3 Mini', complexity: 'High', costFactor: '50%', maxTokens: '16K' },
    { id: 'o1', name: 'o1', complexity: 'High', costFactor: '200%', maxTokens: '16K' },
    { id: 'o1-mini', name: 'o1 Mini', complexity: 'High', costFactor: '50%', maxTokens: '16K' },
  ],
  claude: [
    { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', complexity: 'High', costFactor: '100%', maxTokens: '8K' },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', complexity: 'High', costFactor: '100%', maxTokens: '8K' },
    { id: 'claude-3-5-sonnet-20240620', name: 'Claude 3.5 Sonnet (Old)', complexity: 'Medium', costFactor: '20%', maxTokens: '8K' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', complexity: 'Low', costFactor: '10%', maxTokens: '8K' },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', complexity: 'High', costFactor: '100%', maxTokens: '4K' },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', complexity: 'Low', costFactor: '2%', maxTokens: '4K' },
  ]
}

export const MODEL_NAMES: Record<string, string> = Object.values(PREDEFINED_MODELS).flat().reduce((acc, curr) => ({ ...acc, [curr.id]: curr.name }), {} as Record<string, string>)

export const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  custom: '',
}

export const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  claude: 'claude-3-5-sonnet-20241022',
  gemini: 'gemini-2.5-flash',
  custom: 'gpt-4o-mini',
}
