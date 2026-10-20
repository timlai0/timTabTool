/**
 * @interface TabInfo
 */
export interface TabInfo {
  id: number
  url: string
  title: string
  favIconUrl?: string
  windowId: number
  index: number
  active: boolean
  pinned: boolean
  audible?: boolean
  lastAccessed?: number
  createdAt?: number
  groupId?: number
  groupTitle?: string
  groupColor?: string
}

/**
 * @interface ClassifyResult
 */
export interface ClassifyResult {
  category: GroupCategory
  confidence: number
  method: 'domain' | 'keyword' | 'ai' | 'default'
}

/**
 * @type {GroupCategory}
 */
export type GroupCategory = 'work' | 'dev' | 'learn' | 'social' | 'media' | 'shop' | 'docs' | 'other'

/**
 * @type {ChromeTabGroupColor}
 */
export type ChromeTabGroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'

/**
 * @interface GroupDefinition
 */
export interface GroupDefinition {
  color: ChromeTabGroupColor
  labelKey: string
}

/**
 * @interface GroupedTabs
 */
export interface GroupedTabs {
  category: GroupCategory
  tabs: TabInfo[]
  groupName?: string
  groupColor?: ChromeTabGroupColor
  groupId?: number
  isPinnedGroup?: boolean
}

/**
 * @interface AIGroupResult
 */
export interface AIGroupResult {
  name: string
  tabIndices: number[]
  color?: ChromeTabGroupColor
}

/**
 * @interface TabHistoryEntry
 */
export interface TabHistoryEntry {
  url: string
  title: string
  favIconUrl?: string
  lastAccessed: number
  visitCount: number
  closed: boolean
}

/**
 * @interface ClosedTabEntry
 */
export interface ClosedTabEntry {
  id: string
  url: string
  title: string
  favIconUrl?: string
  closedAt: number
  source: string
  groupTitle?: string
  windowId?: number
  batchId?: string
}

/**
 * @interface SearchResult
 */
export interface SearchResult {
  tab: TabInfo | TabHistoryEntry
  score: number
  isOpen: boolean
  scoreDetails?: string
}

/**
 * @type {AIProvider}
 */
export type AIProvider = 'openai' | 'claude' | 'gemini' | 'openrouter' | 'custom'

/**
 * @type {ReasoningEffort}
 */
export type ReasoningEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'max'

/**
 * @type {OpenRouterSort}
 */
export type OpenRouterSort = 'auto' | 'price' | 'throughput' | 'latency'

/**
 * @type {OpenRouterDataCollection}
 */
export type OpenRouterDataCollection = 'allow' | 'deny'

/**
 * @interface OpenRouterProviderItem
 */
export interface OpenRouterProviderItem {
  slug: string
  name: string
}

/**
 * @interface OpenRouterKeyInfo
 */
export interface OpenRouterKeyInfo {
  label?: string
  usage?: number
  limit?: number | null
  isFreeTier?: boolean
  byokUsage?: number
  byokUsageDaily?: number
  byokUsageWeekly?: number
  byokUsageMonthly?: number
  byokProviders?: string[]
  isByokActive: boolean
}

/**
 * @interface ProviderSettings
 */
export interface ProviderSettings {
  apiKey?: string
  endpoint?: string
  model?: string
  batchSize?: number
  maxTokens?: number
  onlyFreeModels?: boolean
  reasoningEffort?: ReasoningEffort
  openrouterProvider?: string
  openrouterAllowFallbacks?: boolean
  openrouterSort?: OpenRouterSort
  openrouterDataCollection?: OpenRouterDataCollection
  openrouterRequireParams?: boolean
  openrouterIgnoreProviders?: string
  openrouterFallbackModels?: string
  openRouterByokManual?: boolean
  openRouterByokActive?: boolean
  openRouterKeyInfo?: OpenRouterKeyInfo
  customModels?: { id: string; name: string; complexity: string; costFactor: string; maxTokens: string }[]
  customProviders?: OpenRouterProviderItem[]
}

/**
 * @interface AIConfig
 */
export interface AIConfig {
  enabled: boolean
  provider: AIProvider
  apiKey: string
  endpoint?: string
  model?: string
  sendFullUrl?: boolean
  sendRandomOrder?: boolean
  batchSize?: number
  customPrompt?: string
  groupingPrompt?: string
  fallbackToSort?: boolean
  maxTokens?: number
  coherencePrompt?: string
  splitPrompt?: string
  classifyPrompt?: string
  mergePrompt?: string
  windowNamingPrompt?: string
  maxRetries?: number
  bypassSafeguards?: boolean
  alwaysLogAIOperations?: boolean
  openRouterOnlyFree?: boolean
  openrouterProvider?: string
  openrouterAllowFallbacks?: boolean
  openrouterSort?: OpenRouterSort
  openrouterDataCollection?: OpenRouterDataCollection
  openrouterRequireParams?: boolean
  openrouterIgnoreProviders?: string
  openrouterFallbackModels?: string
  openRouterByokManual?: boolean
  openRouterByokActive?: boolean
  openRouterKeyInfo?: OpenRouterKeyInfo
  reasoningEffort?: ReasoningEffort
  customModels?: Record<string, { id: string; name: string; complexity: string; costFactor: string; maxTokens: string }[]>
  customProviders?: Record<string, OpenRouterProviderItem[]>
  providerSettings?: Partial<Record<AIProvider, ProviderSettings>>
}

/**
 * @type {GroupIndicatorStyle}
 */
export type GroupIndicatorStyle = 'header' | 'bar'

/**
 * @type {ThemeMode}
 */
export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * @interface ExtensionSettings
 */
export interface ExtensionSettings {
  ai: AIConfig
  language: 'auto' | 'en' | 'zh_CN'
  groupOnStartup: boolean
  searchShortcut: string
  groupIndicatorStyle: GroupIndicatorStyle
  smartGroupTitle: boolean
  theme: ThemeMode
  windowWidth: number
  windowHeight: number
  showRuleGroupsWhenUngrouped: boolean
  useSearchPopup?: boolean
  sortNewTabs?: boolean
  mcpEnabled?: boolean
  mcpPort?: number
  /** Allows the MCP `execute_script` command (arbitrary JS in any tab). Off by default. */
  mcpAllowScriptExecution?: boolean
  ecoMode?: boolean
  fastOverlayMode?: boolean
}

/**
 * @interface WindowGroupsInfo
 */
export interface WindowGroupsInfo {
  windowId: number
  tabCount: number
  unpinnedTabCount: number
  focused: boolean
  groups: GroupedTabs[]
  hasGroups: boolean
  titlesHidden: boolean
}

/**
 * @type {MessageAction}
 */
type MessageAction =
  | 'GROUP_TABS'
  | 'UNGROUP_ALL'
  | 'UNGROUP_GROUP'
  | 'CLOSE_GROUP'
  | 'CLASSIFY_NEW_TABS'
  | 'CHECK_LAST_20_TABS'
  | 'EXPAND_ALL_GROUPS'
  | 'COLLAPSE_ALL_GROUPS'
  | 'TOGGLE_GROUP_TITLES'
  | 'SEARCH_TABS'
  | 'GET_GROUPS_PREVIEW'
  | 'REFRESH_GROUPS_PREVIEW'
  | 'GET_ALL_WINDOWS_PREVIEW'
  | 'GET_SETTINGS'
  | 'SAVE_SETTINGS'
  | 'TOGGLE_SEARCH_OVERLAY'
  | 'OPEN_CHAT_WINDOW'
  | 'OPEN_CHAT_TAB'
  | 'SWITCH_TAB'
  | 'OPEN_URL'
  | 'CANCEL_OPERATION'
  | 'STOP_AND_APPLY_OPERATION'
  | 'CLOSE_TAB'
  | 'GET_ACTIVE_OPERATIONS'
  | 'CLEAR_OPERATION_ERROR'
  | 'SPLIT_GROUP'
  | 'SPLIT_CURRENT_GROUP'
  | 'MERGE_GROUP'
  | 'MERGE_CURRENT_GROUP'
  | 'GET_SEARCH_OVERLAY_METRICS'
  | 'GROUP_TABS_SINGLE'
  | 'GROUP_TABS_GEMINI_FLASH'
  | 'GROUP_TABS_GEMINI_2_5_FLASH'
  | 'GROUP_TABS_GPT_MINI'
  | 'GROUP_TABS_GPT_4O'
  | 'GROUP_TABS_CLAUDE_SONNET'
  | 'CLASSIFY_NEW_TABS_GEMINI'
  | 'CLASSIFY_NEW_TABS_GPT'
  | 'CLOSE_DUPLICATES'
  | 'CLOSE_POSSIBLE_DUPLICATES'
  | 'ORGANIZE_POSSIBLE_DUPLICATES'
  | 'RENAME_DUPLICATE_GROUPS'
  | 'GROUP_CLUSTER'
  | 'CLOSE_DOMAIN'
  | 'ISOLATE_DOMAIN'
  | 'SORT_TABS'
  | 'SORT_GROUPS_BY_NAME'
  | 'SORT_GROUPS_BY_SIZE'
  | 'MERGE_WINDOWS'
  | 'MUTE_ALL'
  | 'UNMUTE_ALL'
  | 'CLOSE_LEFT'
  | 'CLOSE_RIGHT'
  | 'BACKUP_GROUPS'
  | 'GET_MCP_STATUS'
  | 'RECONNECT_MCP'
  | 'SET_AI_MODEL'
  | 'GET_MCP_TOKEN'
  | 'REGENERATE_MCP_TOKEN'
  | 'CLEANUP_GROUPS'
  | 'GET_AI_LOGS'
  | 'CLEAR_AI_LOGS'
  | 'DELETE_AI_LOG'
  | 'EXTEND_OPERATION'
  | 'GET_CLOSED_TABS'
  | 'RESTORE_CLOSED_TAB'
  | 'RESTORE_ALL_CLOSED_TABS'
  | 'DELETE_CLOSED_TAB'
  | 'RESTORE_CLOSED_BATCH'
  | 'DELETE_CLOSED_BATCH'
  | 'CLEAR_CLOSED_TAB'
  | 'CLEAR_CLOSED_TABS'
  | 'GENERATE_WINDOW_NAME'
  | 'GENERATE_ALL_WINDOW_NAMES'

/**
 * @interface ExtensionMessage
 */
export interface ExtensionMessage {
  action: MessageAction
  payload?: unknown
}

/**
 * @interface LastAIResult
 */
export interface LastAIResult {
  timestamp: number
  actionType: 'group' | 'classify' | 'split' | 'merge' | 'regroup' | 'rename' | 'name_window'
  actionTitle: string
  windowId: number
  tabsProcessed: number
  groupsBefore?: number
  groupsAfter?: number
  createdGroupNames?: string[]
  summary: string
  error?: string
  reasoning?: string
  reasoningSnippet?: string
}

/**
 * @interface AILogStep
 */
export interface AILogStep {
  timestamp: number
  step: string
  detail: string
  metadata?: Record<string, unknown>
}

/**
 * @interface AILogRawRequest
 */
export interface AILogRawRequest {
  batchIndex: number
  endpoint: string
  payloadSummary: string
  systemMessage?: string
  userMessage?: string
  requestTimestamp: number
}

/**
 * @interface AILogRawResponse
 */
export interface AILogRawResponse {
  batchIndex: number
  statusCode?: number
  responseTimeMs?: number
  responseBody?: string
  parsedJson?: unknown
  error?: string
  responseTimestamp: number
}

/**
 * @interface AIOperationLogEntry
 */
export interface AIOperationLogEntry {
  id: string
  timestamp: number
  endTime?: number
  durationMs?: number
  actionType: string
  triggeredWithShift: boolean
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CRASHED'
  windowId?: number
  tabsCount: number
  configSnapshot: {
    provider: string
    model?: string
    endpoint?: string
    sendFullUrl?: boolean
    batchSize?: number
    maxTokens?: number
    maxRetries?: number
    bypassSafeguards?: boolean
    openrouterProvider?: string
    openrouterAllowFallbacks?: boolean
  }
  tabsInput: Array<{
    index: number
    title: string
    url?: string
    groupId?: number
    groupTitle?: string
  }>
  prompts: {
    systemPrompt?: string
    userPrompt?: string
    customPrompt?: string
    coherencePrompt?: string
  }
  steps: AILogStep[]
  rawRequests: AILogRawRequest[]
  rawResponses: AILogRawResponse[]
  results?: {
    createdGroupsCount?: number
    createdGroupNames?: string[]
    groupsBefore?: number
    groupsAfter?: number
    summary?: string
  }
  tokenUsage?: {
    estimatedInputTokens?: number
    estimatedOutputTokens?: number
    estimatedCostStr?: string
    actualInputTokens?: number
    actualOutputTokens?: number
    actualCostStr?: string
  }
  error?: {
    message: string
    name?: string
    stack?: string
    failedBatchIndex?: number
  }
}
/**
 * @type {OperationStage}
 * Represents granular progress stages of an active AI operation.
 */
export type OperationStage =
  | 'idle'
  | 'preparing'
  | 'querying'
  | 'evaluating'
  | 'retrying'
  | 'parsing'
  | 'applying'
  | 'completed'
  | 'failed'

/**
 * @interface OperationRetryInfo
 * Information about an active retry attempt due to rate limits or transient errors.
 */
export interface OperationRetryInfo {
  attempt: number
  maxRetries: number
  delayMs: number
  reason: string
}

/**
 * @interface AIProgressUpdate
 * Payload emitted by AIClient and TabManager during progress events.
 */
export interface AIProgressUpdate {
  stage?: OperationStage
  statusText?: string
  batchCurrent?: number
  batchTotal?: number
  tabStartIndex?: number
  tabEndIndex?: number
  totalTabs?: number
  processedTabs?: number
  discoveredGroupNames?: string[]
  liveReasoning?: string
  reasoningSnippet?: string
  liveContent?: string
  retry?: OperationRetryInfo
}

/**
 * @type {AIProgressCallback}
 */
export type AIProgressCallback = (update: AIProgressUpdate) => void

/**
 * @interface OperationStatusInfo
 * Complete real-time status of an active operation per window.
 */
export interface OperationStatusInfo {
  type: 'group' | 'classify' | 'split' | 'merge' | 'sort' | 'regroup' | 'rename' | 'name_window' | null
  error: string | null
  stage?: OperationStage
  statusText?: string
  batchCurrent?: number
  batchTotal?: number
  processedTabs?: number
  totalTabs?: number
  tabStartIndex?: number
  tabEndIndex?: number
  model?: string
  provider?: string
  discoveredGroupNames?: string[]
  liveReasoning?: string
  reasoningSnippet?: string
  retry?: OperationRetryInfo
  tokenEstimate?: {
    tokens: number
    costStr: string
  }
  startTimestamp?: number
  elapsedMs?: number
  estimatedRemainingMs?: number
  timeoutRemainingSec?: number
  timeoutEndTimestamp?: number
  lastAutoExtendTimestamp?: number
  autoExtendCount?: number
}

/**
 * @interface ReviewAndRegroupTabInput
 */
export interface ReviewAndRegroupTabInput {
  url: string
  title: string
  currentGroup?: string
  lastAccessed?: number
  createdAt?: number
}

/**
 * @interface ReviewAndRegroupDecision
 */
export interface ReviewAndRegroupDecision {
  index: number
  group: string
  newGroupName?: string
  newGroupColor?: string
}

/**
 * @interface RegroupLast20Result
 */
export interface RegroupLast20Result {
  checkedCount: number
  regroupedCount: number
  unchangedCount: number
  summary: string
}

export interface DuplicateGroupClusterItem {
  groupId: number
  name: string
  tabs: Array<{ title: string; url: string }>
}

export interface DistinctGroupRenameResult {
  groupId: number
  oldName: string
  newName: string
}

export interface WindowNameResult {
  windowId: number
  name: string
}
