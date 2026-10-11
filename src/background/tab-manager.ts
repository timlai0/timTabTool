'use strict';

/**
 * Unified TabManager Facade
 * 
 * Provides backwards-compatible exports delegating to cohesive, single-responsibility modules:
 * - operations/operation-registry: Operation timeouts, abort controllers, auto-extend, and progress
 * - operations/badge-service: Action badge text and color updates
 * - cache/tab-cache: Preview caching, debounce logic, and tab creation timestamps
 * - tabs/tab-common: Common helpers, retry logic, and title tracking state
 * - tabs/tab-actions: Deterministic tab, group, audio, domain, and duplicate operations
 * - tabs/ai-tab-operations: AI grouping, classification, regrouping, splitting, and merging
 * - tabs/live-tab-tracker: In-memory live tab tracking and mass close interception
 */

export type { OperationStatus } from './operations/operation-registry'
export {
  registerOperationTab,
  unregisterOperationTab,
  isAnyAIOperationRunning,
  setupOperationTimeout,
  registerTimeoutLogger,
  clearOperationTimeout,
  extendOperationTimeout,
  autoExtendOperationTimeout,
  updateOperationProgress,
  setActiveOperation,
  getActiveOperations,
  clearOperationError,
} from './operations/operation-registry'

export {
  updateNewTabsBadge,
  debouncedUpdateNewTabsBadge,
  setAIBadge,
} from './operations/badge-service'

export {
  recordTabCreatedTime,
  removeTabCreatedTime,
  invalidatePreviewCache,
  cacheAddTab,
  cacheRemoveTab,
  cacheUpdateTab,
  clearWindowCache,
  debouncedCacheRebuild,
  getGroupsPreview,
} from './cache/tab-cache'

export {
  isRestrictedUrl,
  sortTabsByDomainAndTitleHelper,
} from './tabs/tab-common'

export {
  closeGroupTabs,
  expandAllGroups,
  collapseAllGroups,
  areGroupTitlesHidden,
  toggleGroupTitles,
  ungroupAllTabs,
  ungroupGroupTabs,
  handleTabGroupUpdated,
  handleTabGroupRemoved,
  closeDuplicateTabs,
  closePossibleDuplicateTabs,
  organizePossibleDuplicateGroups,
  closeDomainTabs,
  isolateDomainTabs,
  sortTabsByDomainAndTitle,
  sortGroupsByName,
  sortGroupsBySize,
  mergeAllWindows,
  muteAllTabs,
  unmuteAllTabs,
  closeLeftTabs,
  closeRightTabs,
  cleanupTabGroups,
} from './tabs/tab-actions'

export {
  cancelActiveOperation,
  autoGroupNewTab,
  groupAllTabs,
  classifyNewTabs,
  checkAndRegroupLast20Tabs,
  splitGroup,
  mergeGroup,
  renameDuplicateGroups,
  generateWindowName,
  generateAllWindowsNames,
} from './tabs/ai-tab-operations'

export type { CachedLiveTab, TabRemoveInfo } from './tabs/live-tab-tracker'
export {
  markTabIdsClosedByExtension,
  isTabClosedByExtension,
  initLiveTabTracker,
  trackLiveTab,
  untrackLiveTab,
  handleTabRemovalForMassClose,
  flushPendingClosedTabs,
  getLiveTabCount,
  clearLiveTabs,
} from './tabs/live-tab-tracker'
