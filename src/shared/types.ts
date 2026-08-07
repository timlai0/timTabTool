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
 * @interface SearchResult
 */
export interface SearchResult {
  tab: TabInfo | TabHistoryEntry
  score: number
  isOpen: boolean
  scoreDetails?: string
}

/**
 * @interface AIConfig
 */
export interface AIConfig {
  enabled: boolean
  provider: 'openai' | 'claude' | 'gemini' | 'custom'
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
  maxRetries?: number
  bypassSafeguards?: boolean
  alwaysLogAIOperations?: boolean
  customModels?: Record<string, { id: string; name: string; complexity: string; costFactor: string; maxTokens: string }[]>
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
  | 'SWITCH_TAB'
  | 'OPEN_URL'
  | 'CANCEL_OPERATION'
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
  | 'CLEANUP_GROUPS'
  | 'GET_AI_LOGS'
  | 'CLEAR_AI_LOGS'
  | 'DELETE_AI_LOG'
  | 'EXTEND_OPERATION'

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
  actionType: 'group' | 'classify' | 'split' | 'merge'
  actionTitle: string
  windowId: number
  tabsProcessed: number
  groupsBefore?: number
  groupsAfter?: number
  createdGroupNames?: string[]
  summary: string
  error?: string
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
 * @interface OperationStatusInfo
 */
export interface OperationStatusInfo {
  type: 'group' | 'classify' | 'split' | 'merge' | null
  error: string | null
  batchCurrent?: number
  batchTotal?: number
  processedTabs?: number
  totalTabs?: number
  statusText?: string
  timeoutRemainingSec?: number
  timeoutEndTimestamp?: number
  lastAutoExtendTimestamp?: number
  autoExtendCount?: number
}

