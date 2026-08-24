import type { GroupCategory, GroupDefinition, ExtensionSettings, OpenRouterProviderItem } from './types'

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



/**
 * @constant DEFAULT_GROUPING_PROMPT
 */
export const DEFAULT_GROUPING_PROMPT = `Organize these browser tabs into logical, well-defined groups.
Guidelines:
1. Create 2-6 groups based on clear semantic topics. Avoid creating unnecessary single-tab groups.
2. Group names must be concise (1-3 words) and descriptive (e.g., "Web Dev", "Shopping", "Research").
3. Preserve the primary language of the tab titles.
4. Group related items logically rather than over-fragmenting them.`

/**
 * @constant DEFAULT_SPLIT_PROMPT
 */
export const DEFAULT_SPLIT_PROMPT = `You are splitting an existing group into tighter, more granular sub-groups.
Guidelines:
1. Identify specific sub-topics, projects, channels, or content types within this group.
2. Create concise, descriptive sub-group titles reflecting exact themes (e.g., "API Docs", "React Components").
3. Group closely related items together and avoid single-tab groups unless necessary.`

/**
 * @constant DEFAULT_CLASSIFY_PROMPT
 */
export const DEFAULT_CLASSIFY_PROMPT = `You are organizing new incoming browser tabs.
Guidelines:
1. Check if each new tab logically belongs inside one of the existing window tab groups.
2. If a tab fits an existing group, assign it to that group name.
3. If a tab represents a distinct new topic, create a new concise, descriptive group title.
4. Be conservative about creating new single-tab groups.`

/**
 * @constant DEFAULT_MERGE_PROMPT
 */
export const DEFAULT_MERGE_PROMPT = `Analyze the browser tabs in this target group against the list of other existing tab groups in this window.
Guidelines:
1. Decide if this target group's tabs semantically belong inside one of the existing tab groups.
2. If a strong thematic match exists, select the exact name of that existing group.
3. If no existing group is a strong semantic fit, respond with "KEEP".
4. Be conservative: only merge when topics clearly overlap.`

/**
 * @constant DEFAULT_COHERENCE_PROMPT
 */
const DEFAULT_COHERENCE_PROMPT = `Prioritize placing tabs into the existing group names created in previous batches if there is a strong semantic fit. Only create a new group name if the tab represents a genuinely new topic that cannot belong in any existing group.`

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
    coherencePrompt: DEFAULT_COHERENCE_PROMPT,
    splitPrompt: DEFAULT_SPLIT_PROMPT,
    classifyPrompt: DEFAULT_CLASSIFY_PROMPT,
    mergePrompt: DEFAULT_MERGE_PROMPT,
    maxRetries: 2,
    alwaysLogAIOperations: true,
    openRouterOnlyFree: false,
    openrouterProvider: '',
    openrouterAllowFallbacks: true,
    openrouterSort: 'auto',
    openrouterDataCollection: 'allow',
    openrouterRequireParams: false,
    openrouterIgnoreProviders: '',
    openrouterFallbackModels: '',
    reasoningEffort: 'auto',
    providerSettings: {
      openai: { apiKey: '', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', maxTokens: 16384, batchSize: 20, reasoningEffort: 'auto' },
      claude: { apiKey: '', endpoint: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022', maxTokens: 8192, batchSize: 10 },
      gemini: { apiKey: '', endpoint: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', maxTokens: 65536, batchSize: 30, reasoningEffort: 'auto' },
      openrouter: { apiKey: '', endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', maxTokens: 16384, batchSize: 20, onlyFreeModels: false, openrouterProvider: '', openrouterAllowFallbacks: true, openrouterSort: 'auto', openrouterDataCollection: 'allow', openrouterRequireParams: false, openrouterIgnoreProviders: '', openrouterFallbackModels: '', reasoningEffort: 'auto' },
      custom: { apiKey: '', endpoint: '', model: 'gpt-4o-mini', maxTokens: 16384, batchSize: 20 },
    },
  },
  language: 'auto',
  groupOnStartup: false,
  searchShortcut: 'Ctrl+Shift+F',
  groupIndicatorStyle: 'header',
  smartGroupTitle: true,
  theme: 'system',
  windowWidth: 420,
  windowHeight: 600,
  showRuleGroupsWhenUngrouped: true,
  useSearchPopup: false,
  sortNewTabs: false,
  mcpEnabled: false,
  mcpPort: 8585,
  ecoMode: true,
  fastOverlayMode: true,
}

/**
 * @constant STORAGE_KEYS
 */
export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  TAB_HISTORY: 'tabHistory',
  LAST_AI_RESULT: 'lastAIResult',
  AI_OPERATION_LOGS: 'aiOperationLogs',
} as const

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Gemini
  'gemini-3.6-flash': { input: 1.50, output: 9.00 },
  'gemini-3.5-flash': { input: 1.50, output: 9.00 },
  'gemini-3.5-flash-lite': { input: 0.25, output: 1.50 },
  'gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
  'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
  'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'gemini-3-pro-preview': { input: 2.00, output: 12.00 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
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

  // OpenRouter & Multi-Provider Models
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'openai/gpt-4o': { input: 2.50, output: 10.00 },
  'anthropic/claude-3.7-sonnet': { input: 3.00, output: 15.00 },
  'anthropic/claude-3.5-sonnet': { input: 3.00, output: 15.00 },
  'anthropic/claude-3.5-haiku': { input: 0.80, output: 4.00 },
  'google/gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'google/gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'deepseek/deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek/deepseek-r1': { input: 0.55, output: 2.19 },
  'meta-llama/llama-3.3-70b-instruct': { input: 0.12, output: 0.30 },
  'qwen/qwen-2.5-72b-instruct': { input: 0.35, output: 0.40 },
  'mistralai/mistral-small-3': { input: 0.10, output: 0.30 },

  // OpenRouter Free Models
  'stealth/ox-alpha': { input: 0, output: 0 },
  'meta-llama/llama-3.3-70b-instruct:free': { input: 0, output: 0 },
  'deepseek/deepseek-r1:free': { input: 0, output: 0 },
  'deepseek/deepseek-chat:free': { input: 0, output: 0 },
  'google/gemini-2.0-flash-exp:free': { input: 0, output: 0 },
  'google/gemini-2.0-flash-thinking-exp:free': { input: 0, output: 0 },
  'qwen/qwen-2.5-coder-32b-instruct:free': { input: 0, output: 0 },
  'mistralai/mistral-small-24b-instruct-2501:free': { input: 0, output: 0 },
}

export const PROVIDER_DEFAULTS: Record<string, { input: number; output: number }> = {
  openai: { input: 0.15, output: 0.60 },
  claude: { input: 3.00, output: 15.00 },
  gemini: { input: 0.30, output: 2.50 },
  openrouter: { input: 0.15, output: 0.60 },
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
  ],
  openrouter: [
    // Free models on OpenRouter
    { id: 'stealth/ox-alpha', name: 'Stealth: OX Alpha (Free)', complexity: 'High', costFactor: 'Free', maxTokens: '32K' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B (Free)', complexity: 'Medium', costFactor: 'Free', maxTokens: '8K' },
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek: R1 (Free)', complexity: 'High', costFactor: 'Free', maxTokens: '8K' },
    { id: 'deepseek/deepseek-chat:free', name: 'DeepSeek: V3 (Free)', complexity: 'Low', costFactor: 'Free', maxTokens: '8K' },
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Google: Gemini 2.0 Flash (Free)', complexity: 'Medium', costFactor: 'Free', maxTokens: '8K' },
    { id: 'google/gemini-2.0-flash-thinking-exp:free', name: 'Google: Gemini 2.0 Flash Thinking (Free)', complexity: 'High', costFactor: 'Free', maxTokens: '8K' },
    { id: 'qwen/qwen-2.5-coder-32b-instruct:free', name: 'Qwen: Qwen 2.5 Coder 32B (Free)', complexity: 'Medium', costFactor: 'Free', maxTokens: '8K' },
    { id: 'mistralai/mistral-small-24b-instruct-2501:free', name: 'Mistral: Mistral Small 24B (Free)', complexity: 'Low', costFactor: 'Free', maxTokens: '8K' },

    // Standard popular models
    { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o Mini', complexity: 'Low', costFactor: '6%', maxTokens: '16K' },
    { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', complexity: 'High', costFactor: '100%', maxTokens: '16K' },
    { id: 'anthropic/claude-3.7-sonnet', name: 'Anthropic: Claude 3.7 Sonnet', complexity: 'High', costFactor: '100%', maxTokens: '16K' },
    { id: 'anthropic/claude-3.5-haiku', name: 'Anthropic: Claude 3.5 Haiku', complexity: 'Low', costFactor: '10%', maxTokens: '8K' },
    { id: 'google/gemini-2.5-flash', name: 'Google: Gemini 2.5 Flash', complexity: 'Medium', costFactor: '15%', maxTokens: '65K' },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', complexity: 'High', costFactor: '62%', maxTokens: '65K' },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek: DeepSeek V3', complexity: 'Low', costFactor: '5%', maxTokens: '8K' },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek: DeepSeek R1', complexity: 'High', costFactor: '20%', maxTokens: '8K' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta: Llama 3.3 70B', complexity: 'Medium', costFactor: '12%', maxTokens: '8K' },
    { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen: Qwen 2.5 72B', complexity: 'Medium', costFactor: '15%', maxTokens: '8K' },
    { id: 'mistralai/mistral-small-3', name: 'Mistral: Mistral Small 3', complexity: 'Low', costFactor: '5%', maxTokens: '8K' },
  ]
}

export const MODEL_NAMES: Record<string, string> = Object.values(PREDEFINED_MODELS).flat().reduce((acc, curr) => ({ ...acc, [curr.id]: curr.name }), {} as Record<string, string>)

export const OPENROUTER_PROVIDERS: OpenRouterProviderItem[] = [
  { slug: 'google', name: 'Google' },
  { slug: 'google-vertex', name: 'Google Vertex' },
  { slug: 'nvidia', name: 'NVIDIA' },
  { slug: 'groq', name: 'Groq' },
  { slug: 'together', name: 'Together' },
  { slug: 'deepinfra', name: 'DeepInfra' },
  { slug: 'fireworks', name: 'Fireworks' },
  { slug: 'anthropic', name: 'Anthropic' },
  { slug: 'openai', name: 'OpenAI' },
  { slug: 'mistral', name: 'Mistral' },
  { slug: 'hyperbolic', name: 'Hyperbolic' },
  { slug: 'lambda', name: 'Lambda' },
  { slug: 'sambanova', name: 'SambaNova' },
  { slug: 'chutes', name: 'Chutes' },
  { slug: 'deepseek', name: 'DeepSeek' },
  { slug: 'novita', name: 'Novita' },
  { slug: 'lepton', name: 'Lepton' },
  { slug: 'amazon-bedrock', name: 'Amazon Bedrock' },
  { slug: 'azure', name: 'Azure' },
  { slug: 'cloudflare', name: 'Cloudflare' },
  { slug: 'cohere', name: 'Cohere' },
  { slug: 'perplexity', name: 'Perplexity' },
]

export const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  custom: '',
}

export const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  claude: 'claude-3-5-sonnet-20241022',
  gemini: 'gemini-2.5-flash',
  openrouter: 'openai/gpt-4o-mini',
  custom: 'gpt-4o-mini',
}
