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
}

export interface ClassifyResult {
  category: GroupCategory
  confidence: number
  method: 'domain' | 'keyword' | 'ai' | 'default'
}

export type GroupCategory = 'work' | 'dev' | 'learn' | 'social' | 'media' | 'shop' | 'docs' | 'other'

export type ChromeTabGroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'

export interface GroupDefinition {
  color: ChromeTabGroupColor
  labelKey: string
}

export interface GroupedTabs {
  category: GroupCategory
  tabs: TabInfo[]
  groupName?: string
  groupColor?: ChromeTabGroupColor
  groupId?: number
  isPinnedGroup?: boolean
}

export interface AIGroupResult {
  name: string
  tabIndices: number[]
  color?: ChromeTabGroupColor
}

export interface TabHistoryEntry {
  url: string
  title: string
  favIconUrl?: string
  lastAccessed: number
  visitCount: number
  closed: boolean
}

export interface SearchResult {
  tab: TabInfo | TabHistoryEntry
  score: number
  isOpen: boolean
  scoreDetails?: string
}

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
  customModels?: Record<string, { id: string; name: string; complexity: string; costFactor: string; maxTokens: string }[]>
}

export type GroupIndicatorStyle = 'header' | 'bar'

export type ThemeMode = 'light' | 'dark' | 'system'

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

export interface WindowGroupsInfo {
  windowId: number
  tabCount: number
  unpinnedTabCount: number
  focused: boolean
  groups: GroupedTabs[]
  hasGroups: boolean
  titlesHidden: boolean
}

export type MessageAction =
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
  | 'GET_MCP_STATUS'
  | 'RECONNECT_MCP'
  | 'CLEANUP_GROUPS'

export interface ExtensionMessage {
  action: MessageAction
  payload?: unknown
}

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
}
