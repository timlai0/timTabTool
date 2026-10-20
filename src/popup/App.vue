<script setup lang="ts">
import { ref, shallowRef, triggerRef, onMounted, computed, watch, onUnmounted, nextTick } from 'vue'
import { getMessage } from '../shared/i18n'
import { STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_GROUPING_PROMPT, MODEL_PRICING, PROVIDER_DEFAULTS, DEFAULT_MODELS } from '../shared/constants'
import { SYSTEM_PROMPT, AIClient } from '../shared/ai-client'
import { getAutoBatchSize, getOptimalFaviconUrl, detectDuplicateTabs, normalizeUrl, getUrlVariantDifferences, parseUrlSegments, formatMarkdown, type MinimalTab } from '../shared/utils'
import type { ExtensionSettings, GroupIndicatorStyle, ThemeMode, WindowGroupsInfo, LastAIResult, OperationStatusInfo } from '../shared/types'
import { APP_VERSION, BUILD_NUMBER, BUILD_STRING } from '../shared/version'
import GroupList from './components/GroupList.vue'
import SettingsView from './components/SettingsView.vue'
import ChatView from './components/ChatView.vue'

/** Current active view */
const currentView = ref<'main' | 'settings' | 'chat'>('main')

/**
 * Checks if the application is running in the standalone search window.
 * @returns {boolean} True if running standalone.
 */
const isStandaloneSearch = computed(() => {
  // Logic: Check if the application is loaded as a sidebar in the standalone search window
  return window.location.href.includes('search.html')
})

watch(currentView, (newView) => {
  if (isStandaloneSearch.value) {
    if (newView === 'settings') {
      document.body.classList.add('settings-active')
    } else {
      document.body.classList.remove('settings-active')
    }
  }
})
const allWindows = shallowRef<WindowGroupsInfo[]>([])
const loading = ref(true)
const tabGroupsSupported = typeof chrome !== 'undefined' && typeof chrome.tabGroups !== 'undefined'
const allActiveOperations = ref<Record<number, OperationStatusInfo>>({})
const showActiveOperationsTray = ref(false)

function isWindowGrouping(wid: number): boolean {
  return allActiveOperations.value[wid]?.type === 'group'
}
function isWindowClassifying(wid: number): boolean {
  return allActiveOperations.value[wid]?.type === 'classify'
}
function isWindowRegrouping(wid: number): boolean {
  return allActiveOperations.value[wid]?.type === 'regroup'
}
function isWindowNaming(wid: number): boolean {
  return allActiveOperations.value[wid]?.type === 'name_window'
}
function isWindowOperating(wid: number): boolean {
  const type = allActiveOperations.value[wid]?.type
  return Boolean(type && type !== null)
}
const isAnyAIOperating = computed(() => {
  return Object.values(allActiveOperations.value).some(op => Boolean(op?.type))
})

const groupingWindowId = computed(() => {
  const entry = Object.entries(allActiveOperations.value).find(([_, op]) => op?.type === 'group')
  return entry ? Number(entry[0]) : null
})
const classifyingWindowId = computed(() => {
  const entry = Object.entries(allActiveOperations.value).find(([_, op]) => op?.type === 'classify')
  return entry ? Number(entry[0]) : null
})
const checkingLast20WindowId = computed(() => {
  const entry = Object.entries(allActiveOperations.value).find(([_, op]) => op?.type === 'regroup')
  return entry ? Number(entry[0]) : null
})
const currentWindowId = ref<number | null>(null)
const indicatorStyle = ref<GroupIndicatorStyle>(DEFAULT_SETTINGS.groupIndicatorStyle)
const windowWidth = ref(DEFAULT_SETTINGS.windowWidth)
const windowHeight = ref(DEFAULT_SETTINGS.windowHeight)
const aiSettings = ref<ExtensionSettings['ai']>(DEFAULT_SETTINGS.ai)
const errorMessage = ref<string | null>(null)
const customWindowNames = ref<Record<number, string>>({})
const editingWindowId = ref<number | null>(null)
const errorWindowId = ref<number | null>(null)
const lastAIResult = ref<LastAIResult | null>(null)
const activeChatWindowId = ref<number | null>(null)

function openWindowChat(windowId: number) {
  activeChatWindowId.value = windowId
  currentView.value = 'chat'
}

/**
 * Formats a timestamp into a human-readable "time ago" string.
 * @param {number} [ts] - Timestamp in milliseconds.
 * @returns {string} Formatted string.
 */
function formatTimeAgo(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/**
 * Shows an error message in the UI for a specific duration.
 * @param {string} msg - The error message.
 * @param {number} [windowId] - Optional window ID to associate the error with.
 */
function showError(msg: string, windowId?: number | null): void {
  errorMessage.value = msg
  if (windowId !== undefined) {
    errorWindowId.value = windowId
  }
  setTimeout(() => {
    if (errorMessage.value === msg) {
      errorMessage.value = null
      errorWindowId.value = null
    }
  }, 10000)
}

async function handleProceedAnyways() {
  const targetWin = errorWindowId.value ?? currentWindowId.value
  errorMessage.value = null
  errorWindowId.value = null
  if (targetWin !== null) {
    await handleGroup(targetWin, undefined, true)
  }
}

// ─── Theme System ───

const themeMode = ref<ThemeMode>('system')
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme(mode: ThemeMode) {
  const isDark = mode === 'dark' || (mode === 'system' && mediaQuery.matches)
  document.documentElement.classList.toggle('dark', isDark)
}

function toggleTheme() {
  const currentlyDark = document.documentElement.classList.contains('dark')
  themeMode.value = currentlyDark ? 'light' : 'dark'
  applyTheme(themeMode.value)
  localStorage.setItem('atm_theme', themeMode.value)
  chrome.storage.local.get(STORAGE_KEYS.SETTINGS).then((data) => {
    const s = (data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined) || { ...DEFAULT_SETTINGS }
    ;(s as ExtensionSettings).theme = themeMode.value
    chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: s })
  })
}

function onSystemThemeChange() {
  if (themeMode.value === 'system') applyTheme('system')
}

watch(themeMode, (mode) => applyTheme(mode))

// ─── Data Loading ───

let refreshTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * Debounces the preview refresh to prevent rapid consecutive calls.
 */
const refreshPreviews = () => {
  // Logic: debounce preview refresh to prevent multiple concurrent loads during tab events
  if (refreshTimeout) {
    clearTimeout(refreshTimeout)
  }
  refreshTimeout = setTimeout(() => {
    refreshTimeout = null
    loadAllPreviews()
  }, 300)
}

function handleStorageChange(changes: { [key: string]: chrome.storage.StorageChange }, namespace: string) {
  if (namespace === 'local') {
    if (changes[STORAGE_KEYS.SETTINGS]) {
      const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue as Partial<ExtensionSettings> | undefined
      if (newSettings?.ai) {
        aiSettings.value = { ...DEFAULT_SETTINGS.ai, ...newSettings.ai }
      }
    }
    if (changes[STORAGE_KEYS.LAST_AI_RESULT]) {
      lastAIResult.value = changes[STORAGE_KEYS.LAST_AI_RESULT].newValue as LastAIResult
    }
    if (changes['customWindowNames'] && changes['customWindowNames'].newValue) {
      customWindowNames.value = (changes['customWindowNames'].newValue as Record<number, string>) || {}
    }
  }
}

onMounted(async () => {
  const urlParams = new URLSearchParams(window.location.search)
  if (urlParams.get('view') === 'chat') {
    currentView.value = 'chat'
    document.documentElement.classList.add('full-view')
    document.body.classList.add('full-view')
    const targetWinId = urlParams.get('windowId')
    if (targetWinId) {
      activeChatWindowId.value = parseInt(targetWinId, 10)
    }
  }
  chrome.storage.onChanged.addListener(handleStorageChange)
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const stored = data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined
  if (stored?.groupIndicatorStyle) {
    indicatorStyle.value = stored.groupIndicatorStyle
  }
  if (stored?.windowWidth !== undefined) {
    windowWidth.value = stored.windowWidth
  }
  if (stored?.windowHeight !== undefined) {
    windowHeight.value = stored.windowHeight
  }
  if (stored?.ai) {
    aiSettings.value = { ...DEFAULT_SETTINGS.ai, ...stored.ai }
  }
  if (stored?.theme) {
    themeMode.value = stored.theme
  } else {
    const saved = localStorage.getItem('atm_theme') as ThemeMode | null
    if (saved) themeMode.value = saved
  }
  
  const namesData = await chrome.storage.local.get(['customWindowNames', STORAGE_KEYS.LAST_AI_RESULT])
  if (namesData.customWindowNames) {
    customWindowNames.value = namesData.customWindowNames as Record<number, string>
  }
  if (namesData[STORAGE_KEYS.LAST_AI_RESULT]) {
    lastAIResult.value = namesData[STORAGE_KEYS.LAST_AI_RESULT] as LastAIResult
  }

  applyTheme(themeMode.value)
  mediaQuery.addEventListener('change', onSystemThemeChange)

  chrome.runtime.onMessage.addListener(handleRuntimeMessage)
  chrome.tabs.onCreated.addListener(refreshPreviews)
  chrome.tabs.onRemoved.addListener(refreshPreviews)
  chrome.tabs.onUpdated.addListener(refreshPreviews)
  if (chrome.tabs.onMoved) chrome.tabs.onMoved.addListener(refreshPreviews)
  if (chrome.tabs.onAttached) chrome.tabs.onAttached.addListener(refreshPreviews)
  if (chrome.tabs.onDetached) chrome.tabs.onDetached.addListener(refreshPreviews)

  // Logic: Register tab group listeners only if the API is available in the browser (not in Firefox)
  // Programming logic: only register tab group listeners if tabGroups API is available
  if (typeof chrome.tabGroups !== 'undefined') {
    chrome.tabGroups.onCreated.addListener(refreshPreviews)
    chrome.tabGroups.onUpdated.addListener(refreshPreviews)
    chrome.tabGroups.onRemoved.addListener(refreshPreviews)
    if (chrome.tabGroups.onMoved) chrome.tabGroups.onMoved.addListener(refreshPreviews)
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  currentWindowId.value = activeTab?.windowId ?? null
  await loadAllPreviews(true)

  document.addEventListener('click', handleDocumentClick)

  // Logic: Scroll to the active group as soon as the popup is opened and rendered
  // Scroll to active group on initial load
  nextTick(() => {
    setTimeout(() => {
      const activeEl = document.querySelector('[data-active-group-header="true"]')
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, 150)
  })
})

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick)
  chrome.storage.onChanged.removeListener(handleStorageChange)
  // Programming logic: clear any pending refresh timeouts
  if (refreshTimeout) {
    clearTimeout(refreshTimeout)
  }
  mediaQuery.removeEventListener('change', onSystemThemeChange)
  stopPollingStatus()
  chrome.runtime.onMessage.removeListener(handleRuntimeMessage)
  chrome.tabs.onCreated.removeListener(refreshPreviews)
  chrome.tabs.onRemoved.removeListener(refreshPreviews)
  chrome.tabs.onUpdated.removeListener(refreshPreviews)
  if (chrome.tabs.onMoved) chrome.tabs.onMoved.removeListener(refreshPreviews)
  if (chrome.tabs.onAttached) chrome.tabs.onAttached.removeListener(refreshPreviews)
  if (chrome.tabs.onDetached) chrome.tabs.onDetached.removeListener(refreshPreviews)

  // Logic: Remove tab group listeners only if the API is available in the browser (not in Firefox)
  // Programming logic: only remove tab group listeners if tabGroups API is available
  if (typeof chrome.tabGroups !== 'undefined') {
    chrome.tabGroups.onCreated.removeListener(refreshPreviews)
    chrome.tabGroups.onUpdated.removeListener(refreshPreviews)
    chrome.tabGroups.onRemoved.removeListener(refreshPreviews)
    if (chrome.tabGroups.onMoved) chrome.tabGroups.onMoved.removeListener(refreshPreviews)
  }
})

const totalTabs = computed(() =>
  allWindows.value.reduce((sum, w) => sum + w.tabCount, 0),
)

const totalGroups = computed(() =>
  allWindows.value.reduce((sum, w) => sum + w.groups.length, 0),
)

const totalWindows = computed(() => allWindows.value.length)

function removeTrackingParams(urlString: string): string {
  return normalizeUrl(urlString)
}

const duplicateAnalysis = computed(() => {
  const allTabs: MinimalTab[] = []
  const seenTabIds = new Set<number>()
  let win: (typeof allWindows.value)[0]
  let group: (typeof win.groups)[0]
  let tab: (typeof group.tabs)[0]
  for (win of allWindows.value) {
    for (group of win.groups) {
      for (tab of group.tabs) {
        if (!tab.url) continue
        if (typeof tab.id === 'number') {
          if (seenTabIds.has(tab.id)) continue
          seenTabIds.add(tab.id)
        }
        allTabs.push({
          id: tab.id,
          url: tab.url,
          title: tab.title || 'Untitled',
          favIconUrl: tab.favIconUrl,
          windowId: win.windowId,
          active: tab.active,
          pinned: tab.pinned,
          audible: tab.audible,
          groupId: group.groupId,
          index: tab.index
        })
      }
    }
  }
  return detectDuplicateTabs(allTabs)
})

const duplicateGroupAnalysis = computed(() => {
  const groupsByNormalizedName = new Map<string, Array<{ id: number; name: string; windowId: number }>>()
  let duplicateCount = 0
  let crossWindowDuplicateCount = 0
  const duplicateGroups: Array<{ normalized: string; originalNames: string[]; count: number; groups: Array<{ id: number; name: string; windowId: number }> }> = []
  const crossWindowDuplicateGroups: Array<{ normalized: string; originalNames: string[]; count: number; groups: Array<{ id: number; name: string; windowId: number }> }> = []

  for (const win of allWindows.value) {
    for (const group of win.groups) {
      if (!group.groupName) continue
      if (group.groupName === 'Pinned' || group.groupName === '_ungrouped_') continue
      
      const normalized = group.groupName.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (!normalized) continue

      const existing = groupsByNormalizedName.get(normalized) || []
      existing.push({ id: group.groupId || 0, name: group.groupName, windowId: win.windowId })
      groupsByNormalizedName.set(normalized, existing)
    }
  }

  for (const [normalized, groups] of groupsByNormalizedName.entries()) {
    if (groups.length > 1) {
      const windowIds = new Set(groups.map(g => g.windowId))
      const isCrossWindow = windowIds.size > 1
      
      const cluster = {
        normalized,
        originalNames: Array.from(new Set(groups.map(g => g.name))),
        count: groups.length,
        groups
      }
      
      if (isCrossWindow) {
        crossWindowDuplicateCount++
        crossWindowDuplicateGroups.push(cluster)
      } else {
        duplicateCount++
        duplicateGroups.push(cluster)
      }
    }
  }

  return { duplicateCount, duplicateGroups, crossWindowDuplicateCount, crossWindowDuplicateGroups }
})

const exactDuplicatesCount = computed(() => duplicateAnalysis.value.exactDuplicateCount)
const exactDuplicateTabs = computed(() => duplicateAnalysis.value.exactDuplicates as Array<{ id: number; title: string; url: string; favIconUrl?: string; windowId: number }>)

const possibleDuplicatesCount = computed(() => duplicateAnalysis.value.possibleDuplicateCount)
const possibleDuplicateClusters = computed(() => duplicateAnalysis.value.possibleDuplicates)

const duplicateGroupsCount = computed(() => duplicateGroupAnalysis.value.duplicateCount)
const duplicateGroupClusters = computed(() => duplicateGroupAnalysis.value.duplicateGroups)

const crossWindowDuplicateGroupsCount = computed(() => duplicateGroupAnalysis.value.crossWindowDuplicateCount)
const crossWindowDuplicateGroupClusters = computed(() => duplicateGroupAnalysis.value.crossWindowDuplicateGroups)

const isDuplicatesPopoverOpen = ref(false)
const clusterKeepTabMap = ref<Record<string, number>>({})

function getClusterKeepTabId(cluster: { cleanUrl: string; tabs: Array<{ id?: number; active?: boolean }>; primaryTabId?: number }): number | undefined {
  if (clusterKeepTabMap.value[cluster.cleanUrl] !== undefined) {
    return clusterKeepTabMap.value[cluster.cleanUrl]
  }
  return cluster.primaryTabId ?? cluster.tabs.find(t => t.active)?.id ?? cluster.tabs[0]?.id
}

function setClusterKeepTab(clusterCleanUrl: string, tabId: number) {
  clusterKeepTabMap.value[clusterCleanUrl] = tabId
}

async function closeExactDuplicates() {
  const ids = exactDuplicateTabs.value.map(t => t.id).filter((id): id is number => typeof id === 'number')
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent().catch(() => null))?.id
  await chrome.runtime.sendMessage({ action: 'CLOSE_DUPLICATES', payload: { windowId: currentWinId, tabIds: ids.length > 0 ? ids : undefined } })
  await loadAllPreviews()
}

async function closePossibleDuplicates() {
  const idsToClose: number[] = []
  for (const cluster of possibleDuplicateClusters.value) {
    const keepId = getClusterKeepTabId(cluster)
    for (const tab of cluster.tabs) {
      if (tab.id !== undefined && tab.id !== keepId) {
        idsToClose.push(tab.id)
      }
    }
  }
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent().catch(() => null))?.id
  await chrome.runtime.sendMessage({ action: 'CLOSE_POSSIBLE_DUPLICATES', payload: { windowId: currentWinId, tabIds: idsToClose.length > 0 ? idsToClose : undefined } })
  await loadAllPreviews()
}

async function _mergeCluster(cluster: any) {
  if (!cluster || !cluster.groups || cluster.groups.length < 2) return
  const targetGroup = cluster.groups[0]
  let tabIdsToMove: number[] = []
  
  for (let i = 1; i < cluster.groups.length; i++) {
    const sourceGroup = cluster.groups[i]
    const tabs = await chrome.tabs.query({ groupId: sourceGroup.id })
    const ids = tabs.map(t => t.id!).filter(id => id !== undefined)
    tabIdsToMove.push(...ids)
  }
  
  if (tabIdsToMove.length > 0) {
    // move all to target window's end first to ensure they are physically adjacent and in the right window
    await chrome.tabs.move(tabIdsToMove, { windowId: targetGroup.windowId, index: -1 })
    await chrome.tabs.group({ groupId: targetGroup.id, tabIds: tabIdsToMove as [number, ...number[]] })
  }
}

async function mergeDuplicateGroup(cluster: any) {
  await _mergeCluster(cluster)
  await loadAllPreviews()
}

async function mergeAllDuplicateGroups() {
  for (const cluster of duplicateGroupClusters.value) {
    await _mergeCluster(cluster)
  }
  await loadAllPreviews()
}

async function renameDuplicateGroup(cluster: any) {
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent().catch(() => null))?.id
  await chrome.runtime.sendMessage({
    action: 'RENAME_DUPLICATE_GROUPS',
    payload: {
      clusters: [cluster],
      windowId: currentWinId,
    }
  })
  await loadAllPreviews(true)
}

async function renameAllDuplicateGroups() {
  const allClusters = [...duplicateGroupClusters.value]
  if (allClusters.length === 0) return
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent().catch(() => null))?.id
  await chrome.runtime.sendMessage({
    action: 'RENAME_DUPLICATE_GROUPS',
    payload: {
      clusters: allClusters,
      windowId: currentWinId,
    }
  })
  await loadAllPreviews(true)
}

async function renameCrossWindowDuplicateGroups() {
  const allClusters = [...crossWindowDuplicateGroupClusters.value]
  if (allClusters.length === 0) return
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent().catch(() => null))?.id
  await chrome.runtime.sendMessage({
    action: 'RENAME_DUPLICATE_GROUPS',
    payload: {
      clusters: allClusters,
      windowId: currentWinId,
    }
  })
  await loadAllPreviews(true)
}

async function focusTab(tabId: number, windowId: number) {
  // Logic: Activate the selected tab and bring its window to the foreground
  // Programming logic: Activate the selected tab and bring its window to the foreground
  await chrome.tabs.update(tabId, { active: true })
  await chrome.windows.update(windowId, { focused: true })
  if (!isStandaloneSearch.value) {
    window.close() // Close popup only if not in standalone search page
  }
}

async function organizePossibleDuplicates() {
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent().catch(() => null))?.id
  await chrome.runtime.sendMessage({ action: 'ORGANIZE_POSSIBLE_DUPLICATES', payload: { windowId: currentWinId } })
  await loadAllPreviews()
}

async function closeSingleTab(tabId: number) {
  // Logic: optimistically remove closed tab from shallowRef allWindows for immediate UI responsiveness
  let removed = false
  for (const win of allWindows.value) {
    for (const group of win.groups) {
      const idx = group.tabs.findIndex(t => t.id === tabId)
      if (idx !== -1) {
        group.tabs.splice(idx, 1)
        removed = true
        break
      }
    }
    if (removed) break
  }
  if (removed) {
    triggerRef(allWindows)
  }

  try {
    await chrome.runtime.sendMessage({ action: 'CLOSE_TAB', payload: { tabId } })
  } catch (err) {
    console.error('Failed to close tab:', err)
  } finally {
    await loadAllPreviews()
  }
}

async function closeClusterDuplicates(cluster: { cleanUrl: string; domain: string; tabs: Array<{ id?: number; active?: boolean }>; primaryTabId?: number }, keepTabId?: number) {
  const targetKeepId = keepTabId ?? getClusterKeepTabId(cluster)
  const idsToClose = cluster.tabs.map(t => t.id).filter((id): id is number => id !== undefined && id !== targetKeepId)
  if (idsToClose.length > 0) {
    const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent().catch(() => null))?.id
    await chrome.runtime.sendMessage({ action: 'CLOSE_POSSIBLE_DUPLICATES', payload: { windowId: currentWinId, tabIds: idsToClose } })
    await loadAllPreviews()
  }
}

async function groupCluster(cluster: { cleanUrl: string; domain: string; title?: string; tabs: Array<{ id?: number; title?: string }> }) {
  const tabIds = cluster.tabs.map(t => t.id).filter((id): id is number => id !== undefined)
  if (tabIds.length >= 2) {
    const titleSnippet = (cluster.title || cluster.tabs[0]?.title || '').trim().slice(0, 24)
    const groupTitle = titleSnippet ? `Dupes: ${titleSnippet}` : `Dupes: ${cluster.domain}`
    await chrome.runtime.sendMessage({
      action: 'GROUP_CLUSTER',
      payload: { tabIds, title: groupTitle }
    })
    await loadAllPreviews()
  }
}

async function jumpToMostRecentTab(windowId?: number) {
  let targetTabId: number | null = null
  let targetWindowId: number | null = null
  let maxTime = -1
  let activeTab: { id: number; windowId: number } | null = null

  const targetWindows = windowId !== undefined 
    ? allWindows.value.filter(w => w.windowId === windowId)
    : allWindows.value

  for (const w of targetWindows) {
    for (const g of w.groups) {
      for (const t of g.tabs) {
        if (t.id === undefined) continue
        if (t.active) {
          activeTab = { id: t.id, windowId: w.windowId }
        }
        const time = t.lastAccessed || 0
        if (time > maxTime) {
          maxTime = time
          targetTabId = t.id
          targetWindowId = w.windowId
        }
      }
    }
  }

  if (activeTab) {
    targetTabId = activeTab.id
    targetWindowId = activeTab.windowId
  }

  if (!targetTabId || !targetWindowId) return

  if (windowTitlesHidden.value[targetWindowId]) {
    windowTitlesHidden.value[targetWindowId] = false
  }

  // Ensure all groups are uncollapsed so tab DOM elements exist in DOM
  expandTriggers.value[targetWindowId] = (expandTriggers.value[targetWindowId] || 0) + 1
  await nextTick()

  // Activate tab in Chrome
  try {
    await chrome.tabs.update(targetTabId, { active: true })
    await chrome.windows.update(targetWindowId, { focused: true })
  } catch (err) {
    console.warn('[timTabTool] Could not activate tab in Chrome:', err)
  }

  setTimeout(() => {
    const el = document.querySelector(`[data-tab-id="${targetTabId}"]`) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.style.boxShadow = '0 0 0 2px var(--accent)'
      el.style.borderRadius = '4px'
      el.style.transition = 'box-shadow 0.3s ease'
      setTimeout(() => {
        el.style.boxShadow = ''
      }, 2500)
    }
  }, 100)
}

const isDarkActive = computed(() => document.documentElement.classList.contains('dark'))

function formatTimer(ms?: number): string {
  if (!ms || ms <= 0) return '0s'
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec}s`
  return `${min}m ${sec}s`
}

const activeAIOperationsList = computed(() => {
  const list: Array<{
    windowId: number
    type: 'group' | 'classify' | 'split' | 'merge' | 'sort' | 'regroup' | 'rename' | 'name_window'
    windowName: string
    stage?: string
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
    retry?: { attempt: number; maxRetries: number; delayMs: number; reason: string }
    tokenEstimate?: { tokens: number; costStr: string }
    timeoutRemainingSec?: number
    elapsedMs?: number
    estimatedRemainingMs?: number
    percent: number
  }> = []

  for (const [widStr, status] of Object.entries(allActiveOperations.value)) {
    const wid = Number(widStr)
    const opStatus = status as OperationStatusInfo
    if (opStatus && opStatus.type) {
      const winObj = allWindows.value.find(w => w.windowId === wid)
      const winIndex = allWindows.value.findIndex(w => w.windowId === wid)
      const name = winObj ? windowLabel(winObj, winIndex >= 0 ? winIndex : 0) : `Window ${wid}`
      
      let pct = 0
      if (opStatus.stage === 'completed') {
        pct = 100
      } else if (opStatus.batchTotal && opStatus.batchTotal > 0 && opStatus.batchCurrent) {
        if (opStatus.stage === 'applying') {
          pct = 90
        } else {
          pct = Math.min(90, Math.round(((opStatus.batchCurrent - 0.5) / opStatus.batchTotal) * 100))
        }
      } else if (opStatus.stage === 'applying') {
        pct = 85
      } else if (opStatus.stage === 'querying') {
        pct = 40
      } else if (opStatus.stage === 'preparing') {
        pct = 10
      }

      list.push({
        windowId: wid,
        type: opStatus.type,
        windowName: name,
        stage: opStatus.stage || 'querying',
        statusText: opStatus.statusText,
        batchCurrent: opStatus.batchCurrent,
        batchTotal: opStatus.batchTotal,
        processedTabs: opStatus.processedTabs,
        totalTabs: opStatus.totalTabs,
        tabStartIndex: opStatus.tabStartIndex,
        tabEndIndex: opStatus.tabEndIndex,
        model: opStatus.model || activeModel.value,
        provider: opStatus.provider || aiSettings.value.provider,
        discoveredGroupNames: opStatus.discoveredGroupNames,
        liveReasoning: opStatus.liveReasoning,
        reasoningSnippet: opStatus.reasoningSnippet,
        retry: opStatus.retry,
        tokenEstimate: opStatus.tokenEstimate,
        timeoutRemainingSec: opStatus.timeoutRemainingSec,
        elapsedMs: opStatus.elapsedMs,
        estimatedRemainingMs: opStatus.estimatedRemainingMs,
        percent: Math.max(5, Math.min(100, pct)),
      })
    }
  }
  return list
})

const activeAIOperationsCount = computed(() => activeAIOperationsList.value.length)

async function loadAllPreviews(showLoading = false) {
  // Programming logic: only set loading to true on initial load or when requested/empty
  if (showLoading || allWindows.value.length === 0) {
    loading.value = true
  }
  try {
    // Eagerly fetch active operations so the UI can instantly display the animated spinner
    const activeOps = await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OPERATIONS' }).catch(() => null)
    
    // Process active operations and errors immediately
    if (activeOps && typeof activeOps === 'object') {
      allActiveOperations.value = activeOps as Record<number, OperationStatusInfo>
      for (const [widStr, status] of Object.entries(activeOps)) {
        const wid = Number(widStr)
        const opStatus = status as OperationStatusInfo
        if (opStatus.error) {
          showError(opStatus.error, wid)
          chrome.runtime.sendMessage({ action: 'CLEAR_OPERATION_ERROR', payload: { windowId: wid } }).catch(() => {})
        }
      }

      if (isAnyAIOperating.value) {
        startPollingStatus()
      }
    } else {
      allActiveOperations.value = {}
    }

    // Now fetch the heavier previews which might take 100-200ms if cache is empty
    const result = await chrome.runtime.sendMessage({ action: 'GET_ALL_WINDOWS_PREVIEW' })
    
    if (Array.isArray(result)) {
      const sorted = (result as WindowGroupsInfo[]).sort((a, b) => {
        if (a.windowId === currentWindowId.value) return -1
        if (b.windowId === currentWindowId.value) return 1
        return 0
      })
      allWindows.value = sorted
      const titlesState: Record<number, boolean> = {}
      for (const w of sorted) {
        titlesState[w.windowId] = w.titlesHidden
      }
      windowTitlesHidden.value = titlesState
    }
  } catch (err) {
    console.error('Failed to load preview:', err)
  } finally {
    loading.value = false
  }
}

function handleRuntimeMessage(msg: any) {
  if (msg?.action === 'LAST_AI_RESULT_UPDATED' && msg.payload) {
    lastAIResult.value = msg.payload
  } else if (msg?.action === 'WINDOW_NAMES_UPDATED' && msg.payload) {
    customWindowNames.value = { ...msg.payload }
  } else if (msg?.action === 'ACTIVE_OPERATIONS_UPDATED' && msg.payload) {
    allActiveOperations.value = msg.payload
    if (isAnyAIOperating.value) {
      startPollingStatus()
    }
  } else if (msg?.action === 'AI_OPERATION_PROGRESS' && msg.payload) {
    const { windowId, status } = msg.payload
    if (windowId !== undefined && status) {
      allActiveOperations.value = {
        ...allActiveOperations.value,
        [windowId]: status
      }
    }
  } else if (msg?.action === 'START_AI_PROGRESS') {
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OPERATIONS' }).then((ops) => {
      if (ops && typeof ops === 'object') {
        allActiveOperations.value = ops
        if (isAnyAIOperating.value) {
          startPollingStatus()
        }
      }
    }).catch(() => {})
  } else if (msg?.action === 'AI_OPERATION_COMPLETE' || msg?.action === 'AI_OPERATION_FAILED') {
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OPERATIONS' }).then((ops) => {
      if (ops && typeof ops === 'object') {
        allActiveOperations.value = ops
      }
    }).catch(() => {})
    loadAllPreviews().catch(() => {})
  }
}

let pollInterval: number | null = null

function stopPollingStatus() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

function startPollingStatus() {
  if (pollInterval) return
  pollInterval = window.setInterval(async () => {
    if (!isAnyAIOperating.value) {
      stopPollingStatus()
      return
    }
    try {
      const activeOps = await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OPERATIONS' })
      if (activeOps && typeof activeOps === 'object') {
        const prevOpsCount = Object.values(allActiveOperations.value).filter(o => Boolean(o?.type)).length
        allActiveOperations.value = activeOps as Record<number, OperationStatusInfo>
        const currOpsCount = Object.values(allActiveOperations.value).filter(o => Boolean(o?.type)).length

        for (const [widStr, status] of Object.entries(activeOps)) {
          const wid = Number(widStr)
          const opStatus = status as OperationStatusInfo
          if (opStatus.error) {
            showError(opStatus.error, wid)
            await chrome.runtime.sendMessage({ action: 'CLEAR_OPERATION_ERROR', payload: { windowId: wid } }).catch(() => {})
          }
        }

        if (prevOpsCount > currOpsCount) {
          await loadAllPreviews().catch(() => {})
        }
      }
    } catch (err) {
      console.error('Polling failed:', err)
    }
  }, 1000)
}

function windowLabel(w: WindowGroupsInfo, idx: number): string {
  if (customWindowNames.value[w.windowId]) {
    return customWindowNames.value[w.windowId]
  }
  const isCurrent = w.windowId === currentWindowId.value
  const label = isCurrent ? getMessage('currentWindow') : `${getMessage('windowLabel')} ${idx + 1}`
  return `${label}`
}

async function saveWindowName(windowId: number, event: Event) {
  const input = event.target as HTMLInputElement
  const newName = input.value.trim()
  
  if (newName) {
    customWindowNames.value = { ...customWindowNames.value, [windowId]: newName }
  } else {
    const newNames = { ...customWindowNames.value }
    delete newNames[windowId]
    customWindowNames.value = newNames
  }
  
  await chrome.storage.local.set({ customWindowNames: customWindowNames.value })
  editingWindowId.value = null
}

async function handleGenerateWindowName(windowId: number, shiftKey = false) {
  if (isAnyAIOperating.value) return
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'GENERATE_WINDOW_NAME',
      payload: { windowId, shiftKey }
    }) as any
    if (res?.error) {
      showError(res.error, windowId)
    } else if (res?.result?.name) {
      customWindowNames.value = { ...customWindowNames.value, [windowId]: res.result.name }
      if (editingWindowId.value === windowId) {
        editingWindowId.value = null
      }
    }
  } catch (err: any) {
    showError(err?.message || 'Failed to generate window name', windowId)
  }
}

async function handleGenerateAllWindowsNames(shiftKey = false) {
  if (isAnyAIOperating.value) return
  try {
    const targetWin = currentWindowId.value || allWindows.value[0]?.windowId || 0
    const res = await chrome.runtime.sendMessage({
      action: 'GENERATE_ALL_WINDOW_NAMES',
      payload: { windowId: targetWin, shiftKey }
    }) as any
    if (res?.error) {
      showError(res.error, targetWin)
    } else if (res?.result?.results) {
      const newNames = { ...customWindowNames.value }
      for (const r of res.result.results) {
        newNames[r.windowId] = r.name
      }
      customWindowNames.value = newNames
    }
  } catch (err: any) {
    showError(err?.message || 'Failed to generate window names')
  }
}

// removed duplicate unpinnedTabsCount

function getSystemPrompt() {
  if (aiSettings.value.customPrompt?.trim()) {
    return `${SYSTEM_PROMPT}\n\nUser Instructions:\n${aiSettings.value.customPrompt.trim()}`
  }
  return SYSTEM_PROMPT
}

function getGroupingPrompt() {
  return aiSettings.value.groupingPrompt?.trim() || DEFAULT_GROUPING_PROMPT
}


const activeModel = computed(() => {
  if (aiSettings.value.model) {
    return aiSettings.value.model
  }
  return DEFAULT_MODELS[aiSettings.value.provider] || 'gpt-4o-mini'
})

const isAIConfigured = computed(() => {
  return Boolean(
    aiSettings.value.enabled &&
    (aiSettings.value.apiKey || aiSettings.value.provider === 'custom')
  )
})

function estimateCostAndTokens(w: WindowGroupsInfo, countType: 'group' | 'classify' | 'regroup' | null = 'group') {
  const type = countType || 'group'
  const tabsCount = type === 'group'
    ? unpinnedTabsCount(w)
    : type === 'regroup'
      ? Math.min(unpinnedTabsCount(w), 20)
      : newTabsCount(w)
  
  const existingGroupNames = type === 'group' 
    ? [] // Group mode doesn't load existing group names here
    : w.groups
      .filter(g => g.groupId !== undefined && g.groupName && !g.isPinnedGroup)
      .map(g => g.groupName as string)
      
  const est = AIClient.estimateCostAndTokens(
    aiSettings.value as any,
    tabsCount,
    type,
    activeModel.value,
    aiSettings.value.provider,
    existingGroupNames
  )
  
  return { tokens: est.tokens, costStr: est.costStr, tokensPerRequest: est.tokensPerRequest }
}

function newTabsCount(w: WindowGroupsInfo): number {
  // Logic: Count all unpinned tabs that are ungrouped (without group ID and not pinned group)
  let count = 0
  for (const g of w.groups) {
    if (g.groupId === undefined && !g.isPinnedGroup) {
      count += g.tabs.filter(t => !t.pinned).length
    }
  }
  return count
}

function unpinnedTabsCount(w: WindowGroupsInfo): number {
  return w.unpinnedTabCount
}

async function handleCancelGroup(windowId: number) {
  try {
    await chrome.runtime.sendMessage({ action: 'CANCEL_OPERATION', payload: { windowId } })
  } catch (err) {
    console.error('Failed to cancel grouping:', err)
  }
}

async function handleCancelClassify(windowId: number) {
  try {
    await chrome.runtime.sendMessage({ action: 'CANCEL_OPERATION', payload: { windowId } })
  } catch (err) {
    console.error('Failed to cancel classification:', err)
  }
}

async function handleStopAndApply(windowId: number) {
  try {
    await chrome.runtime.sendMessage({ action: 'CANCEL_OPERATION', payload: { windowId, applyCompleted: true } })
  } catch (err) {
    console.error('Failed to stop and apply operation:', err)
  }
}

async function handleClassifyNew(windowId: number, shiftKey = false) {
  startPopupTimeoutTimer(windowId)
  allActiveOperations.value = {
    ...allActiveOperations.value,
    [windowId]: { type: 'classify', error: null, stage: 'preparing', statusText: 'Classifying tabs...' }
  }
  startPollingStatus()
  try {
    const res = await chrome.runtime.sendMessage({ action: 'CLASSIFY_NEW_TABS', payload: { windowId, shiftKey } })
    if (res && typeof res === 'object' && 'error' in res) {
      showError(String(res.error), windowId)
    }
    await loadAllPreviews()
  } catch (err) {
    showError((err as Error).message, windowId)
  }
}

async function handleCancelCheckLast20(windowId: number) {
  try {
    await chrome.runtime.sendMessage({ action: 'CANCEL_OPERATION', payload: { windowId } })
  } catch (err) {
    console.error('Failed to cancel check last 20 tabs:', err)
  }
}

async function handleCheckLast20Tabs(windowId: number, shiftKey = false) {
  if (!aiSettings.value.enabled || !aiSettings.value.apiKey) {
    showError('AI feature must be enabled with a valid API key in Settings.')
    return
  }
  startPopupTimeoutTimer(windowId)
  allActiveOperations.value = {
    ...allActiveOperations.value,
    [windowId]: { type: 'regroup', error: null, stage: 'preparing', statusText: 'Analyzing last 20 tabs...' }
  }
  startPollingStatus()
  try {
    const payload = { windowId, shiftKey }
    const res = await chrome.runtime.sendMessage({ action: 'CHECK_LAST_20_TABS', payload })
    if (res && typeof res === 'object' && 'error' in res) {
      showError(String(res.error), windowId)
    }
    await loadAllPreviews()
  } catch (err) {
    showError((err as Error).message, windowId)
  }
}

const activePromptWindowId = ref<number | null>(null)
const activeSortMenuWindowId = ref<number | null>(null)
const activeMoreMenuWindowId = ref<number | null>(null)
const oneShotPromptText = ref<string>('sort all google tabs into 1 group')
const windowGroupSort = ref<Record<number, 'name' | 'size' | 'default'>>({})

function toggleOneShotPromptPopover(windowId: number) {
  activeSortMenuWindowId.value = null
  activeMoreMenuWindowId.value = null
  if (activePromptWindowId.value === windowId) {
    activePromptWindowId.value = null
  } else {
    activePromptWindowId.value = windowId
    if (!oneShotPromptText.value) {
      oneShotPromptText.value = 'sort all google tabs into 1 group'
    }
  }
}

function toggleSortMenuPopover(windowId: number) {
  activePromptWindowId.value = null
  activeMoreMenuWindowId.value = null
  if (activeSortMenuWindowId.value === windowId) {
    activeSortMenuWindowId.value = null
  } else {
    activeSortMenuWindowId.value = windowId
  }
}

function toggleMoreMenuPopover(windowId: number) {
  activePromptWindowId.value = null
  activeSortMenuWindowId.value = null
  if (activeMoreMenuWindowId.value === windowId) {
    activeMoreMenuWindowId.value = null
  } else {
    activeMoreMenuWindowId.value = windowId
  }
}

function isWindowActivePopover(windowId: number): boolean {
  return (
    activeMoreMenuWindowId.value === windowId ||
    activeSortMenuWindowId.value === windowId ||
    (hoveredActionWindowId.value === windowId && activeHoverAction.value !== null)
  )
}

function handleDocumentClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target?.closest('.popover-container')) {
    activeMoreMenuWindowId.value = null
    activeSortMenuWindowId.value = null
  }
  if (!target?.closest('.duplicates-popover-container') && !target?.closest('.duplicates-badge-trigger')) {
    isDuplicatesPopoverOpen.value = false
  }
}

async function setWindowSort(windowId: number, mode: 'name' | 'size') {
  activeSortMenuWindowId.value = null
  if (windowGroupSort.value[windowId] === mode) {
    windowGroupSort.value[windowId] = 'default'
  } else {
    windowGroupSort.value[windowId] = mode
  }
}

function getSortedGroups(w: WindowGroupsInfo) {
  const mode = windowGroupSort.value[w.windowId] || 'default'
  if (mode === 'default' || !w.groups) return w.groups

  const pinnedGroup = w.groups.find((g) => g.isPinnedGroup)
  const regularGroups = w.groups.filter((g) => !g.isPinnedGroup)

  const sorted = [...regularGroups].sort((a, b) => {
    if (mode === 'name') {
      const nameA = (a.groupName || a.category || '').trim()
      const nameB = (b.groupName || b.category || '').trim()
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true })
    } else {
      const countA = a.tabs?.length ?? 0
      const countB = b.tabs?.length ?? 0
      if (countB !== countA) return countB - countA
      const nameA = (a.groupName || a.category || '').trim()
      const nameB = (b.groupName || b.category || '').trim()
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true })
    }
  })

  return pinnedGroup ? [pinnedGroup, ...sorted] : sorted
}

async function runOneShotPrompt(windowId: number, customPrompt?: string, shiftKey = false) {
  const promptToUse = (customPrompt !== undefined ? customPrompt : oneShotPromptText.value).trim()
  if (!promptToUse) return

  if (!aiSettings.value.enabled || !aiSettings.value.apiKey) {
    showError('AI grouping requires AI feature to be enabled with a valid API key in Settings.')
    return
  }

  activePromptWindowId.value = null
  await handleGroup(windowId, promptToUse, false, shiftKey)
}

async function handleGroup(windowId: number, customPrompt?: string, bypassSafeguards = false, shiftKey = false) {
  startPopupTimeoutTimer(windowId)
  allActiveOperations.value = {
    ...allActiveOperations.value,
    [windowId]: { type: 'group', error: null, stage: 'preparing', statusText: 'Preparing AI grouping...' }
  }
  startPollingStatus()
  try {
    const payload: { windowId: number; groupingPrompt?: string; bypassSafeguards?: boolean; shiftKey?: boolean } = { windowId, shiftKey }
    if (customPrompt) {
      payload.groupingPrompt = customPrompt
    }
    if (bypassSafeguards) {
      payload.bypassSafeguards = true
    }
    const res = await chrome.runtime.sendMessage({ action: 'GROUP_TABS', payload })
    if (res && typeof res === 'object' && 'error' in res) {
      showError(String(res.error), windowId)
    }
    await loadAllPreviews()
  } catch (err) {
    showError((err as Error).message, windowId)
  }
}

const extendedSuccessMap = ref<Record<number, boolean>>({})
const operationTimeoutMap = ref<Record<number, number>>({})
let popupTimeoutInterval: ReturnType<typeof setInterval> | null = null

function formatTimeoutTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function startPopupTimeoutTimer(windowId: number) {
  operationTimeoutMap.value = { ...operationTimeoutMap.value, [windowId]: 270 }
  if (!popupTimeoutInterval) {
    popupTimeoutInterval = setInterval(() => {
      const updated: Record<number, number> = { ...operationTimeoutMap.value }
      let activeCount = 0
      for (const wId of Object.keys(updated).map(Number)) {
        if (updated[wId] > 0) {
          updated[wId]--
          activeCount++
        }
      }
      operationTimeoutMap.value = updated
      if (activeCount === 0 && popupTimeoutInterval) {
        clearInterval(popupTimeoutInterval)
        popupTimeoutInterval = null
      }
    }, 1000)
  }
}

async function handleExtendOperation(windowId: number) {
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'EXTEND_OPERATION',
      payload: { windowId }
    })
    if (res && res.ok) {
      operationTimeoutMap.value = { ...operationTimeoutMap.value, [windowId]: 270 }
      extendedSuccessMap.value = { ...extendedSuccessMap.value, [windowId]: true }
      setTimeout(() => {
        extendedSuccessMap.value = { ...extendedSuccessMap.value, [windowId]: false }
      }, 1500)
    }
  } catch (err) {
    console.error('Failed to extend operation:', err)
  }
}

async function handleUngroup(windowId: number) {
  activeMoreMenuWindowId.value = null
  if (confirm(getMessage('confirmUngroupAll') || 'Are you sure you want to ungroup all tabs in this window?')) {
    await chrome.runtime.sendMessage({ action: 'UNGROUP_ALL', payload: { windowId } })
    await loadAllPreviews()
  }
}

async function handleCleanupGroups(windowId: number) {
  activeMoreMenuWindowId.value = null
  // Programming logic: Prompt user for minimum tab threshold with a default of 3
  const input = prompt(getMessage('enterMinTabs') || 'Enter minimum tab count for a group (tabs in smaller groups will be ungrouped):', '3')
  if (input === null) return
  const minTabs = parseInt(input.trim())
  if (isNaN(minTabs) || minTabs <= 0) return

  // Logic: Ungroup tab groups with fewer than minTabs tabs
  await chrome.runtime.sendMessage({
    action: 'CLEANUP_GROUPS',
    payload: { windowId, minTabs }
  })
  await loadAllPreviews()
}

const copiedWindowId = ref<number | null>(null)

async function copyWindowUrlsAsMarkdown(w: WindowGroupsInfo) {
  let markdown = ''
  for (const group of w.groups) {
    for (const tab of group.tabs) {
      if (tab.url) {
        // Fallback to URL if title is missing
        const title = tab.title || tab.url
        markdown += `- [${title}](${tab.url})\n`
      }
    }
  }
  
  if (markdown) {
    try {
      await navigator.clipboard.writeText(markdown)
      copiedWindowId.value = w.windowId
      setTimeout(() => {
        if (copiedWindowId.value === w.windowId) {
          copiedWindowId.value = null
        }
      }, 2000)
    } catch (err) {
      console.error('Failed to copy', err)
      showError('Failed to copy URLs')
    }
  }
}

async function handleSettingsBack() {
  currentView.value = 'main'
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const stored = data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined
  if (stored?.groupIndicatorStyle) {
    indicatorStyle.value = stored.groupIndicatorStyle
  }
  if (stored?.theme) {
    themeMode.value = stored.theme
    applyTheme(themeMode.value)
  }
  if (stored?.windowWidth !== undefined) {
    windowWidth.value = stored.windowWidth
  }
  if (stored?.windowHeight !== undefined) {
    windowHeight.value = stored.windowHeight
  }
  if (stored?.ai) {
    aiSettings.value = { ...DEFAULT_SETTINGS.ai, ...stored.ai }
  }
}

const expandTriggers = ref<Record<number, number>>({})
const collapseTriggers = ref<Record<number, number>>({})
const windowCollapsedState = ref<Record<number, boolean>>({})

function isWindowCollapsed(windowId: number): boolean {
  return windowCollapsedState.value[windowId] ?? (indicatorStyle.value === 'header')
}

async function handleToggleAllGroups(windowId: number) {
  activeMoreMenuWindowId.value = null
  const collapsed = isWindowCollapsed(windowId)
  if (collapsed) {
    expandTriggers.value = { ...expandTriggers.value, [windowId]: (expandTriggers.value[windowId] || 0) + 1 }
    await chrome.runtime.sendMessage({ action: 'EXPAND_ALL_GROUPS', payload: { windowId } })
  } else {
    collapseTriggers.value = { ...collapseTriggers.value, [windowId]: (collapseTriggers.value[windowId] || 0) + 1 }
    await chrome.runtime.sendMessage({ action: 'COLLAPSE_ALL_GROUPS', payload: { windowId } })
  }
  windowCollapsedState.value = { ...windowCollapsedState.value, [windowId]: !collapsed }
}

const windowSectionCollapsed = ref<Record<number, boolean>>({})

function isWindowSectionCollapsed(windowId: number): boolean {
  return windowSectionCollapsed.value[windowId] ?? false
}

function toggleWindowSection(windowId: number) {
  windowSectionCollapsed.value = {
    ...windowSectionCollapsed.value,
    [windowId]: !isWindowSectionCollapsed(windowId),
  }
}

async function focusWindow(windowId: number) {
  try {
    await chrome.windows.update(windowId, { focused: true })
  } catch (err) {
    console.error('[timTabTool] Failed to focus window:', err)
  }
}

async function moveTabsToCurrentWindow(sourceWindowId: number) {
  if (!currentWindowId.value) return
  // Logik: Verschiebt alle Tabs eines Fensters in das aktuelle Hauptfenster
  try {
    // Get all tabs in the source window
    const tabs = await chrome.tabs.query({ windowId: sourceWindowId })
    const tabIds = tabs.map(t => t.id).filter((id): id is number => id !== undefined)
    if (tabIds.length > 0) {
      // Move all tabs to the current window at the end
      await chrome.tabs.move(tabIds, { windowId: currentWindowId.value, index: -1 })
      await loadAllPreviews()
    }
  } catch (err) {
    console.error('[timTabTool] Failed to move tabs:', err)
    showError(getMessage('failed') + ': ' + (err as Error).message)
  }
}

async function handleMergeAllWindows(targetWindowId: number) {
  activeMoreMenuWindowId.value = null
  // Logic: Merges all other windows into this target window
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'MERGE_WINDOWS',
      payload: { windowId: targetWindowId },
    })
    if (result && !result.ok && result.error) {
      showError(result.error)
    }
    await loadAllPreviews()
  } catch (err) {
    console.error('[timTabTool] Failed to merge windows:', err)
    showError(getMessage('failed') + ': ' + (err as Error).message)
  }
}

const windowTitlesHidden = ref<Record<number, boolean>>({})

function isTitlesHidden(windowId: number): boolean {
  return windowTitlesHidden.value[windowId] ?? false
}

async function handleToggleGroupTitles(windowId: number) {
  activeMoreMenuWindowId.value = null
  const result = await chrome.runtime.sendMessage({ action: 'TOGGLE_GROUP_TITLES', payload: { windowId } })
  if (result?.hidden !== undefined) {
    windowTitlesHidden.value = { ...windowTitlesHidden.value, [windowId]: result.hidden }
  }
}

async function openSearchOverlay() {
  await chrome.runtime.sendMessage({ action: 'TOGGLE_SEARCH_OVERLAY' })
  if (!isStandaloneSearch.value) {
    window.close()
  }
}

const activeHoverAction = ref<'group' | 'classify' | 'regroup' | null>(null)
const hoveredActionWindowId = ref<number | null>(null)

function getClassifyPrompt(w: WindowGroupsInfo) {
  const existingGroupNames = w.groups
    .filter(g => g.groupId !== undefined && g.groupName && !g.isPinnedGroup)
    .map(g => g.groupName)
  const uniqueNames = [...new Set(existingGroupNames.filter((n): n is string => !!n))]
  
  let groupListStr = 'None'
  if (uniqueNames.length > 0) {
    if (uniqueNames.length > 8) {
      groupListStr = uniqueNames.slice(0, 8).map(n => `"${n}"`).join(', ') + `, ... and ${uniqueNames.length - 8} more`
    } else {
      groupListStr = uniqueNames.map((n) => `"${n}"`).join(', ')
    }
  }

  return `I have these existing tab groups: ${groupListStr}.

New tabs to classify:
1. [Example Tab] example.com

For each tab, decide which existing group it belongs to. If none fit, use "NEW" and suggest a name and color.`
}
</script>

<template>
  <SettingsView v-if="currentView === 'settings'" :is-standalone-search="isStandaloneSearch" @back="handleSettingsBack" />
  <ChatView v-else-if="currentView === 'chat'" :all-windows="allWindows" :current-window-id="activeChatWindowId || currentWindowId" @back="currentView = 'main'" />

  <div v-else :style="isStandaloneSearch ? { width: '380px', height: '100%', background: 'var(--bg-primary)' } : { width: Math.max(360, windowWidth) + 'px', height: Math.max(240, Math.min(600, windowHeight || 500)) + 'px', background: 'var(--bg-primary)' }" class="flex flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between px-4 py-3 relative z-50" style="box-shadow: 0 0.5px 0 var(--border);">
      <div class="flex items-center gap-2.5 flex-1 min-w-0 flex-wrap py-0.5">
        <img src="/icons/icon-32.png" alt="" class="w-5 h-5 shrink-0" />
        <div class="flex items-center gap-1.5 shrink-0" :title="BUILD_STRING">
          <h1 class="text-[15px] font-semibold tracking-tight" style="color: var(--text-primary);">timTabTool</h1>
          <span class="text-[9px] font-medium opacity-60 tabular-nums px-1 py-0.2 rounded-xs" style="color: var(--text-secondary); background: var(--hover);">{{ APP_VERSION }}b{{ BUILD_NUMBER }}</span>
        </div>
        <!-- Running AI Operations Indicator -->
        <span v-if="activeAIOperationsCount > 0" class="relative group shrink-0">
          <span 
            @click.stop="showActiveOperationsTray = !showActiveOperationsTray"
            class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-sm flex items-center gap-1.5 cursor-pointer shadow-xs transition-all animate-pulse text-white select-none" 
            style="background: var(--accent); border: 1px solid var(--accent);"
            title="Click to toggle active operations panel"
          >
            <span class="animate-spin w-2.5 h-2.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
            <span>{{ activeAIOperationsCount }} AI op{{ activeAIOperationsCount > 1 ? 's' : '' }} running</span>
            <svg class="w-2.5 h-2.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
            </svg>
          </span>

          <div 
            :class="showActiveOperationsTray ? 'block' : 'hidden group-hover:block'"
            class="absolute left-0 top-full pt-2 w-[340px] max-w-[calc(100vw-24px)] z-50"
          >
            <div class="p-3 rounded-sm shadow-card text-left leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
              <div class="font-semibold mb-2 text-xs flex items-center justify-between" style="color: var(--accent);">
                <span class="flex items-center gap-1.5">
                  <span class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
                  <span>Active AI Operations ({{ activeAIOperationsCount }})</span>
                </span>
              </div>
              <div class="flex flex-col gap-2.5">
                <div 
                  v-for="op in activeAIOperationsList" 
                  :key="op.windowId" 
                  class="p-2.5 rounded-sm bg-black/5 dark:bg-white/5 border flex flex-col gap-1.5 text-[10px]"
                  style="border-color: var(--border);"
                >
                  <div class="flex items-center justify-between gap-2 font-medium">
                    <span class="truncate flex-1 font-semibold" style="color: var(--text-primary);">{{ op.windowName }}</span>
                    <span 
                      class="text-[9px] px-1.5 py-0.5 rounded-sm font-semibold uppercase tracking-wider shrink-0" 
                      :style="op.stage === 'retrying' ? 'background: rgba(255,159,10,0.15); color: var(--group-yellow);' : 'background: var(--accent-soft); color: var(--accent);'"
                    >
                      {{ op.stage === 'retrying' ? 'Retrying' : (op.stage === 'applying' ? 'Applying' : (op.type === 'group' ? 'Grouping' : (op.type === 'split' ? 'Splitting' : (op.type === 'merge' ? 'Merging' : 'Classifying')))) }}
                    </span>
                  </div>

                  <!-- Progress Bar -->
                  <div class="w-full bg-black/10 dark:bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div 
                      class="h-full rounded-full transition-all duration-300" 
                      :style="{
                        width: op.percent + '%',
                        background: op.stage === 'retrying' ? 'var(--group-yellow)' : (op.stage === 'applying' ? 'var(--group-green)' : 'var(--accent)')
                      }"
                    />
                  </div>

                  <!-- Status Text / Batch Info -->
                  <div class="text-[9.5px] leading-tight font-medium" style="color: var(--text-primary);">
                    {{ op.statusText || 'Processing...' }}
                  </div>

                  <!-- Batch & Tab Count Metrics -->
                  <div class="flex items-center justify-between gap-2 text-[9px]" style="color: var(--text-secondary);">
                    <span>
                      <template v-if="op.batchTotal && op.batchTotal > 1">
                        Batch {{ op.batchCurrent }}/{{ op.batchTotal }} · 
                      </template>
                      <template v-if="op.totalTabs">
                        {{ op.tabStartIndex && op.tabEndIndex ? `Tabs ${op.tabStartIndex}–${op.tabEndIndex} of ${op.totalTabs}` : `${op.totalTabs} tabs total` }}
                      </template>
                    </span>
                    <span v-if="op.tokenEstimate" class="tabular-nums opacity-90">
                      {{ op.tokenEstimate.costStr }}
                    </span>
                  </div>

                  <!-- Discovered Group Chips (if any) -->
                  <div v-if="op.discoveredGroupNames && op.discoveredGroupNames.length > 0" class="flex flex-wrap gap-1 pt-0.5">
                    <span 
                      v-for="gName in op.discoveredGroupNames.slice(0, 4)" 
                      :key="gName" 
                      class="px-1.5 py-0.5 rounded-sm text-[8.5px] font-medium truncate max-w-[120px]"
                      style="background: var(--hover); color: var(--text-primary); border: 0.5px solid var(--border);"
                    >
                      {{ gName }}
                    </span>
                    <span v-if="op.discoveredGroupNames.length > 4" class="text-[8.5px] self-center opacity-70">
                      +{{ op.discoveredGroupNames.length - 4 }} more
                    </span>
                  </div>

                  <!-- Live Model Thinking Stream -->
                  <div v-if="op.liveReasoning || op.reasoningSnippet" class="pt-1 flex flex-col gap-1">
                    <details class="group/reasoning text-[9px]" open>
                      <summary class="cursor-pointer font-medium flex items-center justify-between hover:underline select-none" style="color: var(--accent);" title="Click to collapse or expand thought stream">
                        <span class="flex items-center gap-1.5">
                          <span class="w-1.5 h-1.5 rounded-full animate-ping" style="background: var(--accent);" />
                          <span class="font-semibold">Live Model Thinking</span>
                          <span class="text-[8px] opacity-60 font-normal">({{ (op.liveReasoning || op.reasoningSnippet || '').length }} chars)</span>
                        </span>
                        <span class="text-[8px] opacity-70 group-open/reasoning:hidden" style="color: var(--text-tertiary);">Expand</span>
                      </summary>
                      <div 
                        class="mt-1 p-2 rounded-xs text-[9px] leading-relaxed max-h-[140px] overflow-y-auto select-text scrollbar-thin border border-black/5 dark:border-white/5" 
                        style="background: var(--bg-primary); color: var(--text-secondary);"
                        v-html="formatMarkdown(op.liveReasoning || op.reasoningSnippet || '')"
                      />
                    </details>
                  </div>

                  <!-- Elapsed & ETA & Controls -->
                  <div class="flex items-center justify-between gap-2 text-[9px] pt-0.5 border-t border-black/5 dark:border-white/5" style="color: var(--text-secondary);">
                    <div class="flex items-center gap-1.5 tabular-nums">
                      <span v-if="op.elapsedMs">{{ formatTimer(op.elapsedMs) }} elapsed</span>
                      <span v-if="op.estimatedRemainingMs && op.estimatedRemainingMs > 0">· ~{{ formatTimer(op.estimatedRemainingMs) }} left</span>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <button 
                        @click.stop="handleExtendOperation(op.windowId)" 
                        class="text-accent hover:underline font-semibold cursor-pointer"
                        title="Extend timeout by +5 minutes"
                      >
                        +5m
                      </button>
                      <button 
                        v-if="op.batchCurrent && op.batchCurrent > 1"
                        @click.stop="handleStopAndApply(op.windowId)" 
                        class="text-amber-500 hover:underline font-semibold cursor-pointer"
                        title="Stop further AI querying and apply completed batches"
                      >
                        Apply Done
                      </button>
                      <button 
                        @click.stop="op.type === 'group' ? handleCancelGroup(op.windowId) : op.type === 'regroup' ? handleCancelCheckLast20(op.windowId) : handleCancelClassify(op.windowId)" 
                        class="text-red-500 hover:underline font-semibold cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </span>

        <!-- Last AI Operation Result Indicator -->
        <span v-else-if="lastAIResult" class="relative group shrink-0">
          <span 
            class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-sm flex items-center gap-1.5 cursor-pointer shadow-xs transition-all hover:opacity-90 max-w-[200px] min-w-0"
            :style="lastAIResult.error ? 'color: var(--group-red); background: rgba(255,59,48,0.1); border: 1px solid rgba(255,59,48,0.2);' : 'color: var(--accent); background: var(--accent-soft); border: 1px solid var(--border);'"
          >
            <svg v-if="!lastAIResult.error" class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3.25 3.25a.75.75 0 001.06-1.06L10.75 10.44V5z" clip-rule="evenodd" />
            </svg>
            <svg v-else class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" />
            </svg>
            <span class="truncate">{{ lastAIResult.error ? 'AI Failed' : 'AI: ' + lastAIResult.summary }}</span>
            <svg class="w-2.5 h-2.5 opacity-60 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
            </svg>
          </span>

          <div class="hidden group-hover:block absolute left-0 top-full pt-2 w-[320px] max-w-[calc(100vw-24px)] z-50">
            <div class="p-3 rounded-sm shadow-card text-left leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
              <div class="font-semibold mb-1.5 text-xs flex items-center justify-between" :style="lastAIResult.error ? 'color: var(--group-red);' : 'color: var(--accent);'">
                <span class="flex items-center gap-1.5 min-w-0">
                  <svg v-if="!lastAIResult.error" class="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3.25 3.25a.75.75 0 001.06-1.06L10.75 10.44V5z" clip-rule="evenodd" />
                  </svg>
                  <svg v-else class="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" />
                  </svg>
                  <span class="truncate">{{ lastAIResult.actionTitle || 'Last AI Operation' }}</span>
                </span>
                <span class="text-[9px] opacity-60 font-normal shrink-0" style="color: var(--text-tertiary);">{{ formatTimeAgo(lastAIResult.timestamp) }}</span>
              </div>

              <div class="flex flex-col gap-1.5 text-[10px]">
                <div v-if="lastAIResult.error" class="text-[10.5px] font-medium whitespace-pre-wrap mt-0.5" style="color: var(--group-red);">
                  {{ lastAIResult.error }}
                </div>
                <template v-else>
                  <div class="flex items-center justify-between" style="color: var(--text-secondary);">
                    <span>Tabs Processed:</span>
                    <span class="font-semibold tabular-nums" style="color: var(--text-primary);">{{ lastAIResult.tabsProcessed }} tabs</span>
                  </div>
                  <div v-if="lastAIResult.groupsBefore !== undefined && lastAIResult.groupsAfter !== undefined" class="flex items-center justify-between" style="color: var(--text-secondary);">
                    <span>Group Count:</span>
                    <span class="font-semibold tabular-nums" style="color: var(--text-primary);">{{ lastAIResult.groupsBefore }} → {{ lastAIResult.groupsAfter }} groups</span>
                  </div>

                  <div v-if="lastAIResult.createdGroupNames && lastAIResult.createdGroupNames.length > 0" class="mt-1 pt-1.5 border-t" style="border-color: var(--border);">
                    <div class="text-[9px] uppercase font-bold tracking-wider mb-1" style="color: var(--text-tertiary);">Groups Created / Categorized</div>
                    <div class="flex flex-wrap gap-1">
                      <span 
                        v-for="gName in lastAIResult.createdGroupNames" 
                        :key="gName"
                        class="px-1.5 py-0.5 rounded-sm text-[9.5px] font-medium"
                        style="background: var(--hover); color: var(--text-primary); border: 0.5px solid var(--border);"
                      >
                        {{ gName }}
                      </span>
                    </div>
                  </div>

                  <!-- Persisted Model Reasoning Trace -->
                  <div v-if="lastAIResult.reasoning || lastAIResult.reasoningSnippet" class="mt-1 pt-1.5 border-t" style="border-color: var(--border);">
                    <details class="group/historyReasoning text-[9px]">
                      <summary class="cursor-pointer font-medium flex items-center justify-between hover:underline select-none" style="color: var(--accent);" title="Click to inspect model reasoning trace">
                        <span class="flex items-center gap-1.5">
                          <svg class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14H8v-1h4v1zM6 8a4 4 0 118 0c0 1.098-.5 2.1-1.3 2.7-.4.3-.7.8-.7 1.3H8c0-.5-.3-1-.7-1.3C6.5 10.1 6 9.1 6 8z" />
                          </svg>
                          <span class="font-semibold">Model Reasoning</span>
                          <span class="text-[8px] opacity-60 font-normal">({{ (lastAIResult.reasoning || lastAIResult.reasoningSnippet || '').length }} chars)</span>
                        </span>
                        <span class="text-[8px] opacity-70 group-open/historyReasoning:hidden" style="color: var(--text-tertiary);">Show</span>
                      </summary>
                      <div 
                        class="mt-1 p-2 rounded-xs text-[9px] leading-relaxed max-h-[160px] overflow-y-auto select-text scrollbar-thin border border-black/5 dark:border-white/5" 
                        style="background: var(--bg-primary); color: var(--text-secondary);"
                        v-html="formatMarkdown(lastAIResult.reasoning || lastAIResult.reasoningSnippet || '')"
                      />
                    </details>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </span>

        <!-- Active AI Model Status Chip (When AI is configured and idle) -->
        <span v-else-if="isAIConfigured" class="relative group shrink-0">
          <button 
            @click="currentView = 'settings'"
            class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-sm flex items-center gap-1.5 cursor-pointer shadow-xs transition-all hover:opacity-90"
            style="color: var(--accent); background: var(--accent-soft); border: 1px solid var(--border);"
            title="AI Configured: Click to open Settings"
          >
            <svg class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.949 5.684a1 1 0 00-1.898 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.898l2.051.684a1 1 0 01.633.632l.683 2.051a1 1 0 001.898 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.898l-2.051-.684a1 1 0 01-.633-.632L6.95 5.684z" />
            </svg>
            <span class="truncate max-w-[130px]">AI: {{ activeModel }}</span>
          </button>

          <!-- AI Model Quick Info Popover -->
          <div class="hidden group-hover:block absolute left-0 top-full pt-2 w-[240px] max-w-[calc(100vw-24px)] z-50">
            <div class="p-2.5 rounded-sm shadow-card text-left leading-relaxed transition-all duration-200 flex flex-col gap-1.5 text-[10px]" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
              <div class="font-semibold text-xs flex items-center justify-between" style="color: var(--accent);">
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.949 5.684a1 1 0 00-1.898 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.898l2.051.684a1 1 0 01.633.632l.683 2.051a1 1 0 001.898 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.898l-2.051-.684a1 1 0 01-.633-.632L6.95 5.684z" />
                  </svg>
                  <span>AI Configured</span>
                </span>
                <span class="text-[9px] uppercase px-1.5 py-0.2 rounded-xs font-semibold" style="background: var(--hover); color: var(--text-secondary);">
                  {{ aiSettings.provider }}
                </span>
              </div>
              <div class="flex items-center justify-between" style="color: var(--text-secondary);">
                <span>Active Model:</span>
                <span class="font-semibold truncate ml-2" style="color: var(--text-primary);">{{ activeModel }}</span>
              </div>
              <div class="flex items-center justify-between" style="color: var(--text-secondary);">
                <span>Provider:</span>
                <span class="font-semibold capitalize" style="color: var(--text-primary);">{{ aiSettings.provider }}</span>
              </div>
              <div v-if="aiSettings.provider === 'openrouter' || aiSettings.provider === 'openai' || aiSettings.provider === 'gemini' || (aiSettings.reasoningEffort && aiSettings.reasoningEffort !== 'auto')" class="flex items-center justify-between" style="color: var(--text-secondary);">
                <span>Reasoning:</span>
                <span class="font-semibold capitalize" style="color: var(--text-primary);">{{ aiSettings.reasoningEffort || 'auto' }}</span>
              </div>
              <div class="flex items-center justify-between" style="color: var(--text-secondary);">
                <span>Batch Size:</span>
                <span class="font-semibold" style="color: var(--text-primary);">{{ aiSettings.batchSize ? `${aiSettings.batchSize} tabs` : `${getAutoBatchSize(aiSettings.maxTokens)} tabs (Auto)` }}</span>
              </div>
              <div v-if="aiSettings.provider === 'openrouter' && aiSettings.openrouterSort && aiSettings.openrouterSort !== 'auto'" class="flex items-center justify-between" style="color: var(--text-secondary);">
                <span>Routing:</span>
                <span class="font-semibold capitalize" style="color: var(--text-primary);">{{ aiSettings.openrouterSort }}</span>
              </div>
              <div v-if="aiSettings.provider === 'openrouter' && aiSettings.openRouterOnlyFree" class="text-[9px] px-1.5 py-0.5 rounded-xs" style="background: rgba(52, 199, 89, 0.15); color: var(--group-green);">
                Free Models Only Active
              </div>
              <div v-if="aiSettings.provider === 'openrouter' && (aiSettings.openRouterByokManual || aiSettings.openRouterByokActive || aiSettings.openRouterKeyInfo?.isByokActive)" class="text-[9px] px-1.5 py-0.5 rounded-xs font-medium" style="background: rgba(52, 199, 89, 0.15); color: var(--group-green);">
                BYOK Direct Billing Active
              </div>
              <div v-if="aiSettings.provider === 'openrouter' && aiSettings.openrouterDataCollection === 'deny'" class="text-[9px] px-1.5 py-0.5 rounded-xs font-medium" style="background: rgba(0, 122, 255, 0.15); color: var(--accent);">
                Zero Data Retention (Privacy)
              </div>
              <button 
                @click="currentView = 'settings'"
                class="mt-1 w-full py-1 text-center font-medium rounded-sm hover:opacity-90 transition-opacity cursor-pointer text-[10px]"
                style="background: var(--accent); color: #fff;"
              >
                Configure in Settings
              </button>
            </div>
          </div>
        </span>

        <span class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-sm shrink-0" style="color: var(--text-primary); background: var(--hover); border: 1px solid var(--border);">
          {{ totalTabs }} tabs · {{ totalGroups }} groups · {{ totalWindows }} windows
        </span>

        <!-- Duplicates Pill Badge & Popover Menu -->
        <div 
          v-if="exactDuplicatesCount > 0 || possibleDuplicatesCount > 0 || duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0" 
          class="relative duplicates-badge-container flex items-center shrink-0"
        >
          <button 
            @click.stop="isDuplicatesPopoverOpen = !isDuplicatesPopoverOpen"
            class="duplicates-badge-trigger flex items-center gap-1 text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-sm hover:opacity-90 transition-all cursor-pointer select-none"
            :class="{ 'ring-1 ring-red-500/50 shadow-xs': isDuplicatesPopoverOpen }"
            style="color: var(--text-primary); background: rgba(255, 59, 48, 0.15); border: 1px solid rgba(255, 59, 48, 0.35);"
            title="Click to view and manage duplicate tabs and duplicate groups"
          >
            <svg class="w-3 h-3 shrink-0" style="color: var(--group-red);" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
            </svg>
            <span v-if="exactDuplicatesCount > 0">{{ exactDuplicatesCount }} exact</span>
            <span v-if="exactDuplicatesCount > 0 && (possibleDuplicatesCount > 0 || duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0)">·</span>
            <span v-if="possibleDuplicatesCount > 0">{{ possibleDuplicatesCount }} possible dupes</span>
            <span v-if="possibleDuplicatesCount > 0 && (duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0)">·</span>
            <span v-if="duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0">{{ duplicateGroupsCount + crossWindowDuplicateGroupsCount }} dup groups</span>
            <svg class="w-2.5 h-2.5 opacity-60 shrink-0 transition-transform duration-150" :class="{ 'rotate-180': isDuplicatesPopoverOpen }" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
            </svg>
          </button>

          <!-- Single Unified Duplicates Popover Card anchored at left-0 of the red pill badge -->
          <div 
            v-if="isDuplicatesPopoverOpen"
            class="duplicates-popover-container absolute left-0 top-full pt-2 w-[355px] sm:w-[370px] max-w-[calc(100vw-24px)] z-[100] animate-in fade-in zoom-in-95 duration-100"
          >
            <div class="p-3 rounded-sm shadow-card text-left whitespace-normal leading-relaxed transition-all duration-200 flex flex-col gap-3 max-h-[460px] overflow-y-auto scrollbar-thin" style="background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border);">
              
              <!-- Popover Header Bar -->
              <div class="flex items-center justify-between border-b pb-2" style="border-color: var(--border);">
                <div class="flex items-center gap-1.5 font-semibold text-xs" style="color: var(--accent);">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
                  </svg>
                  <span>Duplicates & Variants</span>
                </div>
                <button 
                  @click.stop="isDuplicatesPopoverOpen = false" 
                  class="w-5 h-5 rounded-sm flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
                  title="Close Inspector"
                >
                  <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              </div>

              <!-- Exact Duplicates Section -->
              <div v-if="exactDuplicatesCount > 0" class="flex flex-col gap-1.5">
                <div class="font-semibold text-xs flex items-center justify-between" style="color: var(--accent);">
                  <span class="flex items-center gap-1.5">
                    <span>Exact Duplicates</span>
                    <span class="text-[9.5px] px-1.5 py-0.2 rounded-xs font-medium bg-red-500/20 text-red-500">{{ exactDuplicateTabs.length }}</span>
                  </span>
                  <button @click.stop="closeExactDuplicates" class="text-[9px] px-2 py-0.5 rounded-sm font-medium bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors cursor-pointer" title="Close all exact duplicate copies, keeping original">
                    Close All Exact
                  </button>
                </div>
                <div class="flex flex-col gap-1 rounded-sm p-1 bg-black/5 dark:bg-white/5 border border-dashed" style="border-color: var(--border);">
                  <div 
                    v-for="tab in exactDuplicateTabs" 
                    :key="tab.id" 
                    class="flex items-center gap-2 text-[10px] p-1.5 rounded-sm cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 transition-colors group/tabrow select-none"
                    @click.left="tab.id !== undefined && tab.windowId !== undefined && focusTab(tab.id, tab.windowId)"
                    @mousedown.middle.prevent.stop=""
                    @click.middle.prevent.stop="tab.id !== undefined && closeSingleTab(tab.id)"
                    @auxclick.prevent.stop="($event) => { if ($event.button === 1 && tab.id !== undefined) closeSingleTab(tab.id); }"
                  >
                    <img v-if="getOptimalFaviconUrl(tab.url, tab.favIconUrl)" :src="getOptimalFaviconUrl(tab.url, tab.favIconUrl)" alt="" class="w-3.5 h-3.5 rounded-xs shrink-0" />
                    <div v-else class="w-3.5 h-3.5 rounded-xs bg-gray-500/20 shrink-0" />
                    <div class="flex-1 min-w-0">
                      <div class="font-medium truncate text-[9.5px]" style="color: var(--text-primary);" :title="tab.title">{{ tab.title }}</div>
                      <div class="text-[8.5px] truncate font-mono opacity-70" style="color: var(--text-secondary);" :title="tab.url">{{ tab.url }}</div>
                    </div>
                    <button 
                      v-if="tab.id !== undefined"
                      @click.stop="closeSingleTab(tab.id)"
                      @mousedown.middle.prevent.stop=""
                      @click.middle.prevent.stop="closeSingleTab(tab.id)"
                      @auxclick.prevent.stop="($event) => { if ($event.button === 1 && tab.id !== undefined) closeSingleTab(tab.id); }"
                      class="w-4 h-4 rounded-sm flex items-center justify-center opacity-0 group-hover/tabrow:opacity-100 hover:bg-red-500/20 hover:text-red-500 transition-all shrink-0 cursor-pointer"
                      style="color: var(--text-tertiary);"
                      title="Close this tab (or Middle-click row)"
                    >
                      <svg class="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <!-- Possible Duplicates Section -->
              <div v-if="possibleDuplicatesCount > 0" class="flex flex-col gap-2">
                <div class="font-semibold text-xs flex items-center justify-between" style="color: var(--accent);">
                  <div class="flex items-center gap-1.5">
                    <span>Possible Dupes</span>
                    <span class="text-[9.5px] px-1.5 py-0.2 rounded-xs font-medium bg-amber-500/20 text-amber-500">{{ possibleDuplicateClusters.length }} clusters · {{ possibleDuplicatesCount }} variants</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <button @click.stop="closePossibleDuplicates" class="text-[9px] px-2 py-0.5 rounded-sm font-medium bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors cursor-pointer" title="Keep primary in each cluster and close variant copies">
                      Dedupe All
                    </button>
                    <button @click.stop="organizePossibleDuplicates" class="text-[9px] px-2 py-0.5 rounded-sm font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer" style="color: var(--text-primary);" title="Group all clusters into distinct named tab groups">
                      Group All
                    </button>
                  </div>
                </div>

                <!-- Cluster Cards List -->
                <div class="flex flex-col gap-2.5">
                  <div 
                    v-for="cluster in possibleDuplicateClusters" 
                    :key="cluster.cleanUrl" 
                    class="p-2 rounded-sm bg-black/5 dark:bg-white/5 border border-dashed flex flex-col gap-1.5 text-[10px]" 
                    style="border-color: var(--border);"
                  >
                    <!-- Cluster Header -->
                    <div class="flex items-center justify-between gap-1.5">
                      <div class="flex items-center gap-1.5 min-w-0 flex-1">
                        <img 
                          v-if="cluster.tabs[0] && getOptimalFaviconUrl(cluster.tabs[0].url || '', cluster.tabs[0].favIconUrl)" 
                          :src="getOptimalFaviconUrl(cluster.tabs[0].url || '', cluster.tabs[0].favIconUrl)" 
                          alt="" 
                          class="w-3.5 h-3.5 rounded-xs shrink-0" 
                        />
                        <div class="min-w-0 flex-1">
                          <div class="font-medium text-[10px] truncate" style="color: var(--text-primary);" :title="cluster.title || cluster.cleanUrl">
                            {{ cluster.title || cluster.domain }}
                          </div>
                          <div class="text-[8.5px] font-mono truncate opacity-60 flex items-center gap-1.5" style="color: var(--text-secondary);" :title="cluster.cleanUrl">
                            <span>{{ cluster.domain }} · {{ cluster.tabs.length }} variants</span>
                            <span v-for="tag in cluster.matchReasons" :key="tag" class="px-1 py-0.2 rounded-xs uppercase text-[7px] font-medium bg-black/5 dark:bg-white/10" style="color: var(--text-secondary);">
                              {{ tag.replace('_', ' ') }}
                            </span>
                          </div>
                        </div>
                      </div>
                      
                      <!-- Cluster Action Buttons -->
                      <div class="flex items-center gap-1 shrink-0">
                        <button 
                          @click.stop="closeClusterDuplicates(cluster)" 
                          class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors cursor-pointer" 
                          title="Keep the designated primary tab, close all other variants in this cluster"
                        >
                          Dedupe
                        </button>
                        <button 
                          @click.stop="groupCluster(cluster)" 
                          class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer" 
                          style="color: var(--text-primary);" 
                          title="Group these variants into a tab group"
                        >
                          Group
                        </button>
                      </div>
                    </div>

                    <!-- Canonical URL snippet with highlighted components -->
                    <div 
                      class="px-2 py-1 rounded-xs text-[8.5px] font-mono select-all flex items-center gap-1.5 overflow-hidden" 
                      style="background: rgba(0, 122, 255, 0.08); border: 0.5px solid rgba(0, 122, 255, 0.2);" 
                      :title="`Canonical URL: ${cluster.cleanUrl}`"
                    >
                      <span class="font-semibold uppercase tracking-wider text-[7px] px-1 py-0.2 rounded-xs shrink-0 select-none" style="background: rgba(0, 122, 255, 0.18); color: var(--accent);">
                        canonical
                      </span>
                      
                      <div class="truncate flex items-center flex-1 min-w-0">
                        <!-- Protocol and www (dimmed boilerplate) -->
                        <span class="opacity-35 select-none shrink-0">{{ parseUrlSegments(cluster.cleanUrl).protocol }}</span>
                        <span v-if="parseUrlSegments(cluster.cleanUrl).subdomainPrefix" class="opacity-35 select-none shrink-0">{{ parseUrlSegments(cluster.cleanUrl).subdomainPrefix }}</span>
                        
                        <!-- Domain (context) -->
                        <span class="opacity-75 shrink-0" style="color: var(--text-secondary);">{{ parseUrlSegments(cluster.cleanUrl).domain }}</span>
                        
                        <!-- Pathname (important structure - highlighted bold) -->
                        <span v-if="parseUrlSegments(cluster.cleanUrl).pathname" class="font-semibold shrink-0" style="color: var(--text-primary);">
                          {{ parseUrlSegments(cluster.cleanUrl).pathname }}
                        </span>
                        
                        <!-- Search Query (canonical parameters / IDs - highlighted in accent color) -->
                        <span v-if="parseUrlSegments(cluster.cleanUrl).search" class="font-bold shrink-0 px-1 py-0.2 ml-0.5 rounded-xs" style="color: var(--accent); background: rgba(0, 122, 255, 0.12);">
                          {{ parseUrlSegments(cluster.cleanUrl).search }}
                        </span>

                        <!-- Hash fragment if present -->
                        <span v-if="parseUrlSegments(cluster.cleanUrl).hash" class="font-semibold shrink-0 px-1 py-0.2 ml-0.5 rounded-xs" style="color: var(--group-yellow); background: rgba(255, 159, 10, 0.12);">
                          {{ parseUrlSegments(cluster.cleanUrl).hash }}
                        </span>
                      </div>
                    </div>

                    <!-- Variant Tabs List -->
                    <div class="flex flex-col gap-1">
                      <div 
                        v-for="tab in cluster.tabs" 
                        :key="tab.id"
                        class="flex items-center gap-1.5 p-1 rounded-sm cursor-pointer transition-colors group/tabrow select-none"
                        :class="[
                          getClusterKeepTabId(cluster) === tab.id 
                            ? 'bg-emerald-500/10 border border-emerald-500/30' 
                            : 'hover:bg-black/10 dark:hover:bg-white/10 border border-transparent'
                        ]"
                        @click.left="tab.id !== undefined && tab.windowId !== undefined && focusTab(tab.id, tab.windowId)"
                        @mousedown.middle.prevent.stop=""
                        @click.middle.prevent.stop="tab.id !== undefined && closeSingleTab(tab.id)"
                        @auxclick.prevent.stop="($event) => { if ($event.button === 1 && tab.id !== undefined) closeSingleTab(tab.id); }"
                      >
                        <img v-if="getOptimalFaviconUrl(tab.url || '', tab.favIconUrl)" :src="getOptimalFaviconUrl(tab.url || '', tab.favIconUrl)" alt="" class="w-3 h-3 rounded-xs shrink-0" />
                        <div v-else class="w-3 h-3 rounded-xs bg-gray-500/20 shrink-0" />
                        
                        <div class="flex-1 min-w-0">
                          <div class="truncate text-[9px] font-medium" style="color: var(--text-primary);" :title="tab.title">
                            {{ tab.title }}
                          </div>
                          <div class="flex items-center gap-1 truncate text-[8px] font-mono" style="color: var(--text-secondary);">
                            <span class="truncate" :title="tab.url">{{ tab.url }}</span>
                            <span 
                              v-if="tab.isExactDuplicate" 
                              class="shrink-0 px-1 rounded-xs text-[7.5px] bg-red-500/15 text-red-600 dark:text-red-400 font-medium"
                              title="Exact duplicate of the designated keeper tab"
                            >
                              exact copy
                            </span>
                            <template v-else-if="tab.diff && tab.diff.reasons.length > 0">
                              <span 
                                v-for="reason in tab.diff.reasons" 
                                :key="reason"
                                class="shrink-0 px-1 rounded-xs text-[7.5px] bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                :title="`Variant difference: ${reason}`"
                              >
                                {{ reason }}
                              </span>
                            </template>
                          </div>
                        </div>

                        <!-- Keep / Variant Pill & Action -->
                        <div class="flex items-center gap-1 shrink-0">
                          <span 
                            v-if="getClusterKeepTabId(cluster) === tab.id" 
                            class="text-[7.5px] uppercase font-semibold px-1 py-0.2 rounded-xs bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                            title="This tab will be retained when deduplicating"
                          >
                            Keep
                          </span>
                          <button 
                            v-else-if="tab.id !== undefined"
                            @click.stop="setClusterKeepTab(cluster.cleanUrl, tab.id)"
                            @mousedown.middle.stop=""
                            @auxclick.stop=""
                            class="text-[7.5px] opacity-0 group-hover/tabrow:opacity-100 px-1 py-0.2 rounded-xs hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-opacity cursor-pointer"
                            title="Set this tab as the one to keep"
                          >
                            Keep this
                          </button>

                          <!-- Close Single Tab -->
                          <button 
                            v-if="tab.id !== undefined"
                            @click.stop="closeSingleTab(tab.id)"
                            @mousedown.middle.prevent.stop=""
                            @click.middle.prevent.stop="closeSingleTab(tab.id)"
                            @auxclick.prevent.stop="($event) => { if ($event.button === 1 && tab.id !== undefined) closeSingleTab(tab.id); }"
                            class="w-3.5 h-3.5 rounded-xs flex items-center justify-center opacity-0 group-hover/tabrow:opacity-100 hover:bg-red-500/20 hover:text-red-500 transition-all shrink-0 cursor-pointer"
                            style="color: var(--text-tertiary);"
                            title="Close this tab (or Middle-click row)"
                          >
                            <svg class="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Duplicate Groups Section -->
              <div v-if="duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0" class="flex flex-col gap-2">
                <div class="border-t my-0.5" style="border-color: var(--border);" />
                
                <div v-if="duplicateGroupsCount > 0" class="flex flex-col gap-1.5">
                  <div class="font-semibold text-xs flex items-center justify-between" style="color: var(--accent);">
                    <span class="flex items-center gap-1.5">
                      <span>Duplicate Groups</span>
                      <span class="text-[9.5px] px-1.5 py-0.2 rounded-xs font-medium bg-black/10 dark:bg-white/10" style="color: var(--text-secondary);">{{ duplicateGroupsCount }}</span>
                    </span>
                    <div class="flex items-center gap-1">
                      <button @click.stop="renameAllDuplicateGroups" :disabled="isAnyAIOperating" class="text-[9px] px-2 py-0.5 rounded-sm font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 hover:bg-purple-500/25 transition-colors cursor-pointer disabled:opacity-50" title="AI generate distinct names for all duplicate groups">
                        AI Rename All
                      </button>
                      <button @click.stop="mergeAllDuplicateGroups" class="text-[9px] px-2 py-0.5 rounded-sm font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer" style="color: var(--text-primary);">
                        Merge All
                      </button>
                    </div>
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <div v-for="cluster in duplicateGroupClusters" :key="cluster.normalized" class="p-1.5 rounded-sm bg-black/5 dark:bg-white/5 border border-dashed flex items-center justify-between gap-1 text-[10px]" style="border-color: var(--border);">
                      <span class="truncate min-w-0 font-medium" style="color: var(--text-primary);">
                        {{ cluster.originalNames[0] }} 
                        <span class="opacity-60 text-[8.5px]" style="color: var(--text-secondary);">({{ cluster.count }} duplicate groups)</span>
                      </span>
                      <div class="flex items-center gap-1 shrink-0">
                        <button @click.stop="renameDuplicateGroup(cluster)" :disabled="isAnyAIOperating" class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 hover:bg-purple-500/25 transition-colors cursor-pointer disabled:opacity-50" title="AI generate distinct names for these groups">
                          AI Rename
                        </button>
                        <button @click.stop="mergeDuplicateGroup(cluster)" class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer shrink-0" style="color: var(--text-primary);" title="Merge these duplicate groups into one">
                          Merge
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-if="crossWindowDuplicateGroupsCount > 0" class="flex flex-col gap-1.5">
                  <div class="font-semibold text-xs flex items-center justify-between" style="color: var(--accent);">
                    <span class="flex items-center gap-1.5">
                      <span>Duplicate Groups (Cross-Window)</span>
                      <span class="text-[9.5px] px-1.5 py-0.2 rounded-xs font-medium bg-black/10 dark:bg-white/10" style="color: var(--text-secondary);">{{ crossWindowDuplicateGroupsCount }}</span>
                    </span>
                    <button @click.stop="renameCrossWindowDuplicateGroups" :disabled="isAnyAIOperating" class="text-[9px] px-2 py-0.5 rounded-sm font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 hover:bg-purple-500/25 transition-colors cursor-pointer disabled:opacity-50" title="AI generate distinct names for all cross-window duplicate groups">
                      AI Rename All
                    </button>
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <div v-for="cluster in crossWindowDuplicateGroupClusters" :key="'cross_'+cluster.normalized" class="p-1.5 rounded-sm bg-black/5 dark:bg-white/5 border border-dashed flex items-center justify-between gap-1 text-[10px]" style="border-color: var(--border);">
                      <span class="truncate min-w-0 font-medium" style="color: var(--text-primary);">
                        {{ cluster.originalNames[0] }} 
                        <span class="opacity-60 text-[8.5px]" style="color: var(--text-secondary);">({{ cluster.count }} groups across windows)</span>
                      </span>
                      <div class="flex items-center gap-1 shrink-0">
                        <button @click.stop="renameDuplicateGroup(cluster)" :disabled="isAnyAIOperating" class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 hover:bg-purple-500/25 transition-colors cursor-pointer disabled:opacity-50" title="AI generate distinct names for these cross-window groups">
                          AI Rename
                        </button>
                        <button @click.stop="mergeDuplicateGroup(cluster)" class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer shrink-0" style="color: var(--text-primary);" title="Merge these cross-window duplicate groups into one window">
                          Merge
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-0.5">
        <!-- AI Name All Windows -->
        <button
          v-if="allWindows.length > 1"
          @click="handleGenerateAllWindowsNames($event.shiftKey)"
          :disabled="isAnyAIOperating"
          class="w-7 h-7 flex items-center justify-center rounded-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer disabled:opacity-40"
          style="color: var(--accent);"
          title="AI Name All Windows. Hold Shift + click for verbose log."
        >
          <svg class="w-[15px] h-[15px]" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.948 5.684a1 1 0 00-1.896 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.896l2.051.683a1 1 0 01.633.633l.683 2.051a1 1 0 001.896 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.896l-2.051-.683a1 1 0 01-.633-.633L6.948 5.684z" clip-rule="evenodd" />
          </svg>
        </button>
        <!-- Jump to Most Recent Tab -->
        <button
          @click="jumpToMostRecentTab()"
          class="w-7 h-7 flex items-center justify-center rounded-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          style="color: var(--text-secondary);"
          title="Jump to Most Recently Used / Active Tab in List"
        >
          <svg class="w-[15px] h-[15px]" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3.25 3.25a.75.75 0 001.06-1.06L10.75 10.44V5z" clip-rule="evenodd" />
          </svg>
        </button>
        <!-- Search -->
        <button
          @click="openSearchOverlay"
          class="w-7 h-7 flex items-center justify-center rounded-sm"
          style="color: var(--text-secondary);"
          title="Open Search (Ctrl+Shift+F)"
        >
          <svg class="w-[15px] h-[15px]" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
          </svg>
        </button>
        <!-- Theme toggle -->
        <button
          @click="toggleTheme"
          class="w-7 h-7 flex items-center justify-center rounded-sm"
          style="color: var(--text-secondary);"
          :title="themeMode === 'dark' ? 'Switch to Light' : 'Switch to Dark'"
        >
          <!-- Sun icon (shown in dark mode) -->
          <svg v-if="themeMode === 'dark' || (themeMode === 'system' && isDarkActive)" class="w-[15px] h-[15px]" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 2a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 2zM10 15a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 15zM10 7a3 3 0 100 6 3 3 0 000-6zM15.657 5.404a.75.75 0 10-1.06-1.06l-1.061 1.06a.75.75 0 001.06 1.06l1.06-1.06zM6.464 14.596a.75.75 0 10-1.06-1.06l-1.06 1.06a.75.75 0 001.06 1.06l1.06-1.06zM18 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0118 10zM5 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 015 10zM14.596 15.657a.75.75 0 001.06-1.06l-1.06-1.061a.75.75 0 10-1.06 1.06l1.06 1.06zM5.404 6.464a.75.75 0 001.06-1.06l-1.06-1.06a.75.75 0 10-1.06 1.06l1.06 1.06z" />
          </svg>
          <!-- Moon icon (shown in light mode) -->
          <svg v-else class="w-[15px] h-[15px]" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z" clip-rule="evenodd" />
          </svg>
        </button>
        <!-- Settings -->
        <button
          class="w-7 h-7 flex items-center justify-center rounded-sm"
          style="color: var(--text-secondary);"
          @click="currentView = 'settings'"
          :title="getMessage('settings')"
        >
          <svg class="w-[15px] h-[15px]" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
          </svg>
        </button>
      </div>
    </header>

    <!-- Error Banner -->
    <div
      v-if="errorMessage"
      class="mx-3 mt-2 p-2.5 rounded-sm flex items-start gap-2 shadow-xs border transition-all duration-300"
      style="background: rgba(255, 59, 48, 0.08); border-color: rgba(255, 59, 48, 0.25);"
    >
      <svg class="w-3.5 h-3.5 shrink-0 mt-0.5" style="color: var(--group-red);" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
      <div class="flex-1 text-[10.5px] leading-normal flex flex-col gap-1.5" style="color: var(--text-primary); font-weight: 500;">
        <div>{{ errorMessage }}</div>
        <button
          v-if="errorMessage.includes('safety safeguard') || errorMessage.includes('safety limit')"
          @click="handleProceedAnyways"
          class="self-start px-2 py-0.5 text-[10px] font-semibold rounded-sm transition-all cursor-pointer flex items-center gap-1 shrink-0 text-white"
          style="background: var(--group-red);"
        >
          <span>Proceed Anyways</span>
          <svg class="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd" />
          </svg>
        </button>
      </div>
      <button
        @click="errorMessage = null"
        class="w-4 h-4 flex items-center justify-center rounded-sm hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
        style="color: var(--text-secondary);"
      >
        <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      </button>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="flex-1 flex items-center justify-center py-16">
      <div class="flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full animate-pulse" style="background: var(--accent); animation-delay: 0ms;" />
        <span class="w-1.5 h-1.5 rounded-full animate-pulse" style="background: var(--accent); animation-delay: 150ms;" />
        <span class="w-1.5 h-1.5 rounded-full animate-pulse" style="background: var(--accent); animation-delay: 300ms;" />
      </div>
    </div>

    <!-- Empty state -->
    <div v-else-if="totalTabs === 0" class="flex-1 flex items-center justify-center py-16">
      <div class="text-center">
        <div class="w-10 h-10 mx-auto mb-3 rounded-sm flex items-center justify-center" style="background: var(--bg-secondary);">
          <svg class="w-5 h-5" style="color: var(--text-tertiary);" viewBox="0 0 20 20" fill="currentColor">
            <path d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" />
          </svg>
        </div>
        <p class="text-xs" style="color: var(--text-tertiary);">{{ getMessage('noTabs') }}</p>
      </div>
    </div>

    <!-- All windows groups -->
    <div v-else class="flex-1 overflow-y-auto">
      <div
        v-for="(w, idx) in allWindows"
        :key="w.windowId"
        class="rounded-none border-b"
        :class="{ 'relative z-30': isWindowActivePopover(w.windowId) }"
        style="background: var(--bg-secondary); border-color: var(--border);"
      >
        <div
          class="sticky top-0 flex flex-col shadow-sm"
          :class="isWindowActivePopover(w.windowId) ? 'z-30' : 'z-20'"
          style="background: var(--bg-secondary); border-bottom: 1px solid var(--border);"
        >
          <!-- Window section header (clickable to collapse/expand) -->
          <div
            class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
            @click="toggleWindowSection(w.windowId)"
          >
            <svg
              class="w-3 h-3 shrink-0 transition-transform duration-200"
              :class="isWindowSectionCollapsed(w.windowId) ? '' : 'rotate-90'"
              style="color: var(--text-tertiary);"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
            </svg>
            <svg class="w-3.5 h-3.5 shrink-0" style="color: var(--text-tertiary);" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v8.5A2.25 2.25 0 0115.75 15h-3.105a3.501 3.501 0 01-5.29 0H4.25A2.25 2.25 0 012 12.75v-8.5zM4.25 3.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h3.105a.75.75 0 01.672.418 2.001 2.001 0 003.946 0 .75.75 0 01.672-.418h3.105a.75.75 0 00.75-.75v-8.5a.75.75 0 00-.75-.75H4.25z" clip-rule="evenodd" />
            </svg>
            <div class="flex-1 min-w-0 flex items-center group/title" @click.stop>
              <input
                v-if="editingWindowId === w.windowId"
                type="text"
                class="text-[11px] font-semibold bg-transparent border-b border-gray-400 outline-none w-full"
                :style="{ color: w.windowId === currentWindowId ? 'var(--accent)' : 'var(--text-primary)' }"
                :value="customWindowNames[w.windowId] || ''"
                :placeholder="windowLabel(w, idx)"
                @blur="saveWindowName(w.windowId, $event)"
                @keydown.enter="saveWindowName(w.windowId, $event)"
                @keydown.esc="editingWindowId = null"
                autofocus
              />
              <span
                v-else
                class="text-[11px] font-semibold truncate hover:underline cursor-pointer"
                :style="{ color: w.windowId === currentWindowId ? 'var(--accent)' : 'var(--text-primary)' }"
                @click="focusWindow(w.windowId)"
                @dblclick="editingWindowId = w.windowId"
                title="Focus this window (Double-click to rename)"
              >
                {{ windowLabel(w, idx) }}
              </span>
              <button
                v-if="editingWindowId !== w.windowId"
                class="ml-1 opacity-0 group-hover/title:opacity-100 p-0.5 rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-opacity focus:outline-none"
                style="color: var(--text-tertiary);"
                @click.stop="editingWindowId = w.windowId"
                title="Rename Window"
              >
                <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
                </svg>
              </button>
              <button
                v-if="editingWindowId !== w.windowId"
                class="ml-0.5 p-0.5 rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-all focus:outline-none cursor-pointer"
                :class="isWindowNaming(w.windowId) ? 'opacity-100' : 'opacity-0 group-hover/title:opacity-100'"
                :disabled="isAnyAIOperating"
                style="color: var(--accent);"
                @click.stop="handleGenerateWindowName(w.windowId, $event.shiftKey)"
                title="AI Generate Window Name. Hold Shift + click for verbose log."
              >
                <span v-if="isWindowNaming(w.windowId)" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full inline-block shrink-0" />
                <svg v-else class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.948 5.684a1 1 0 00-1.896 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.896l2.051.683a1 1 0 01.633.633l.683 2.051a1 1 0 001.896 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.896l-2.051-.683a1 1 0 01-.633-.633L6.948 5.684z" clip-rule="evenodd" />
                </svg>
              </button>
            </div>
            <span class="text-[10px] tabular-nums" style="color: var(--text-tertiary);">{{ w.tabCount }} {{ getMessage('tabs') }}</span>
            <button
              v-if="w.windowId !== currentWindowId"
              class="px-2 py-[2px] text-[10px] font-medium rounded-sm focus:outline-none shrink-0"
              style="background: var(--accent-soft); color: var(--accent); border: 0.5px solid var(--border);"
              @click.stop="moveTabsToCurrentWindow(w.windowId)"
              :title="getMessage('moveToCurrentTooltip')"
            >
              {{ getMessage('moveToCurrent') }}
            </button>
            <span v-if="w.hasGroups" class="w-1.5 h-1.5 rounded-full" style="background: var(--group-green);" :title="getMessage('grouped')" />
          </div>

          <!-- Action buttons -->
          <div v-if="!isWindowSectionCollapsed(w.windowId) && tabGroupsSupported" class="flex flex-col px-3.5 pb-2 relative gap-1.5">
            <div class="flex items-center justify-between w-full gap-1">
              <!-- Left Action Group (Non-wrapping flex row) -->
              <div class="flex items-center gap-1 shrink-0">
                <!-- Group Tabs Hero Button -->
                <button
                  class="px-2.5 py-[4px] text-[11px] font-medium rounded-btn flex items-center gap-1 transition-all group whitespace-nowrap text-white"
                  :style="isWindowGrouping(w.windowId)
                    ? { background: 'var(--group-red)' }
                    : { background: 'var(--accent)' }"
                  @click="isWindowGrouping(w.windowId) ? handleCancelGroup(w.windowId) : handleGroup(w.windowId, undefined, false, $event.shiftKey)"
                  @mouseenter="activeHoverAction = 'group'; hoveredActionWindowId = w.windowId"
                  @mouseleave="activeHoverAction = null; hoveredActionWindowId = null"
                  title="Group Tabs (AI). Hold Shift + click to save a detailed verbose log in Settings."
                >
                  <span v-if="isWindowGrouping(w.windowId)" class="inline-flex items-center gap-1">
                    <span class="animate-spin w-2.5 h-2.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
                    <span>Cancel</span>
                  </span>
                  <span v-else class="flex items-center gap-1">
                    <svg class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.948 5.684a1 1 0 00-1.896 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.896l2.051.683a1 1 0 01.633.633l.683 2.051a1 1 0 001.896 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.896l-2.051-.683a1 1 0 01-.633-.633L6.948 5.684z" clip-rule="evenodd" />
                    </svg>
                    <span>{{ getMessage('groupTabs') }}</span>
                  </span>
                </button>

                <!-- Classify New Button -->
                <button
                  v-if="newTabsCount(w) > 0"
                  class="px-2 py-[4px] text-[11px] font-medium rounded-btn flex items-center gap-1 transition-all group whitespace-nowrap shrink-0"
                  :style="isWindowClassifying(w.windowId)
                    ? { background: 'var(--group-red)', color: '#ffffff' }
                    : { background: 'var(--accent-soft)', color: 'var(--accent)' }"
                  @click="isWindowClassifying(w.windowId) ? handleCancelClassify(w.windowId) : handleClassifyNew(w.windowId, $event.shiftKey)"
                  @mouseenter="activeHoverAction = 'classify'; hoveredActionWindowId = w.windowId"
                  @mouseleave="activeHoverAction = null; hoveredActionWindowId = null"
                  title="Classify New Tabs. Hold Shift + click to save a detailed verbose log in Settings."
                >
                  <span v-if="isWindowClassifying(w.windowId)" class="inline-flex items-center gap-1">
                    <span class="animate-spin w-2.5 h-2.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
                    <span>Cancel</span>
                  </span>
                  <span v-else class="flex items-center gap-1">
                    <svg class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
                    </svg>
                    <span>Classify ({{ newTabsCount(w) }})</span>
                  </span>
                </button>

                <!-- Check & Regroup Last 20 Tabs Button -->
                <button
                  v-if="unpinnedTabsCount(w) > 0"
                  class="p-[5px] rounded-btn flex items-center justify-center transition-all shrink-0 cursor-pointer relative"
                  :style="isWindowRegrouping(w.windowId)
                    ? { background: 'var(--group-red)', color: '#ffffff' }
                    : { color: 'var(--text-secondary)', background: 'var(--hover)' }"
                  @click="isWindowRegrouping(w.windowId) ? handleCancelCheckLast20(w.windowId) : handleCheckLast20Tabs(w.windowId, $event.shiftKey)"
                  @mouseenter="activeHoverAction = 'regroup'; hoveredActionWindowId = w.windowId"
                  @mouseleave="activeHoverAction = null; hoveredActionWindowId = null"
                  :title="isWindowRegrouping(w.windowId) ? 'Cancel' : getMessage('checkLast20Tooltip')"
                >
                  <span v-if="isWindowRegrouping(w.windowId)" class="inline-flex items-center">
                    <span class="animate-spin w-3.5 h-3.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
                  </span>
                  <svg v-else class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                  </svg>
                </button>

                <!-- Window Chat Icon Button -->
                <button
                  class="p-[5px] rounded-btn flex items-center justify-center transition-all shrink-0 cursor-pointer"
                  style="color: var(--text-secondary); background: var(--hover);"
                  @click="openWindowChat(w.windowId)"
                  :title="'Window Chat (' + (w.windowId === currentWindowId ? 'Current window' : 'Window #' + w.windowId) + ')'"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 2c-4.418 0-8 3.134-8 7 0 2.222 1.166 4.2 3 5.485V18l2.909-1.939c.677.167 1.385.253 2.091.253 4.418 0 8-3.134 8-7s-3.582-7-8-7z" clip-rule="evenodd" />
                  </svg>
                </button>

                <!-- Sort Popover -->
                <div class="relative inline-block shrink-0 popover-container">
                  <button
                    class="p-[5px] rounded-btn flex items-center justify-center transition-all shrink-0"
                    :style="(activeSortMenuWindowId === w.windowId || (windowGroupSort[w.windowId] && windowGroupSort[w.windowId] !== 'default'))
                      ? { background: 'var(--accent)', color: '#ffffff' }
                      : { color: 'var(--text-secondary)', background: 'var(--hover)' }"
                    @click.stop="toggleSortMenuPopover(w.windowId)"
                    :title="getMessage('sort')"
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M2.24 6.8a.75.75 0 001.06-.04L6 3.94v11.31a.75.75 0 001.5 0V3.94l2.7 2.82a.75.75 0 101.1-1.04l-4-4.17a.75.75 0 00-1.1 0l-4 4.17a.75.75 0 00.04 1.06zm15.52 6.4a.75.75 0 00-1.06.04L14 16.06V4.75a.75.75 0 00-1.5 0v11.31l-2.7-2.82a.75.75 0 10-1.1 1.04l4 4.17a.75.75 0 001.1 0l4-4.17a.75.75 0 00-.04-1.06z" clip-rule="evenodd" />
                    </svg>
                  </button>

                  <div v-if="activeSortMenuWindowId === w.windowId" class="absolute right-0 top-full mt-1 w-44 p-1 rounded-sm shadow-card z-50 flex flex-col gap-0.5 text-left" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
                    <button
                      @click="setWindowSort(w.windowId, 'name')"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                      :style="windowGroupSort[w.windowId] === 'name' ? { background: 'var(--hover)', color: 'var(--accent)' } : { color: 'var(--text-primary)' }"
                    >
                      <svg class="w-3.5 h-3.5 shrink-0" :style="{ color: windowGroupSort[w.windowId] === 'name' ? 'var(--accent)' : 'var(--text-secondary)' }" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M3 3.5A.75.75 0 013.75 3h12.5a.75.75 0 010 1.5H3.75A.75.75 0 013 3.5zm0 4.5A.75.75 0 013.75 7h9.5a.75.75 0 010 1.5H3.75A.75.75 0 013 8zm0 4.5a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5a.75.75 0 01-.75-.75z" clip-rule="evenodd" />
                      </svg>
                      <span class="flex-1">{{ getMessage('sortGroupsByName') }}</span>
                      <svg v-if="windowGroupSort[w.windowId] === 'name'" class="w-3 h-3 shrink-0" style="color: var(--accent);" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.815a.75.75 0 011.05-.145z" clip-rule="evenodd" />
                      </svg>
                    </button>
                    <button
                      @click="setWindowSort(w.windowId, 'size')"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                      :style="windowGroupSort[w.windowId] === 'size' ? { background: 'var(--hover)', color: 'var(--accent)' } : { color: 'var(--text-primary)' }"
                    >
                      <svg class="w-3.5 h-3.5 shrink-0" :style="{ color: windowGroupSort[w.windowId] === 'size' ? 'var(--accent)' : 'var(--text-secondary)' }" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M2 3.75A.75.75 0 012.75 3h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 8.25zm0 4.5a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 8.25zm0 4.5a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5a.75.75 0 01-.75-.75z" clip-rule="evenodd" />
                      </svg>
                      <span class="flex-1">{{ getMessage('sortGroupsBySize') }}</span>
                      <svg v-if="windowGroupSort[w.windowId] === 'size'" class="w-3 h-3 shrink-0" style="color: var(--accent);" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.815a.75.75 0 011.05-.145z" clip-rule="evenodd" />
                      </svg>
                    </button>
                  </div>
                </div>

                <!-- Copy URLs Markdown Icon Button -->
                <button
                  class="p-[5px] rounded-btn flex items-center justify-center transition-colors shrink-0"
                  style="color: var(--text-secondary); background: var(--hover);"
                  @click="copyWindowUrlsAsMarkdown(w)"
                  title="Copy all URLs as Markdown"
                >
                  <svg v-if="copiedWindowId === w.windowId" class="w-3.5 h-3.5" style="color: var(--group-green);" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.815a.75.75 0 011.05-.145z" clip-rule="evenodd" />
                  </svg>
                  <svg v-else class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z" />
                    <path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" />
                  </svg>
                </button>

                <!-- Jump to Most Recent Tab in Window -->
                <button
                  class="p-[5px] rounded-btn flex items-center justify-center transition-colors shrink-0 cursor-pointer"
                  style="color: var(--text-secondary); background: var(--hover);"
                  @click="jumpToMostRecentTab(w.windowId)"
                  title="Jump to Most Recently Used / Active Tab in this Window"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3.25 3.25a.75.75 0 001.06-1.06L10.75 10.44V5z" clip-rule="evenodd" />
                  </svg>
                </button>

                <!-- Overflow Menu ⋯ Popover -->
                <div class="relative inline-block shrink-0 popover-container">
                  <button
                    class="p-[5px] rounded-btn flex items-center justify-center transition-colors shrink-0"
                    :style="activeMoreMenuWindowId === w.windowId
                      ? { background: 'var(--accent)', color: '#ffffff' }
                      : { color: 'var(--text-secondary)', background: 'var(--hover)' }"
                    @click.stop="toggleMoreMenuPopover(w.windowId)"
                    title="More actions"
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
                    </svg>
                  </button>

                  <div v-if="activeMoreMenuWindowId === w.windowId" class="absolute right-0 top-full mt-1 w-52 p-1 rounded-sm shadow-card z-50 flex flex-col gap-0.5 text-left" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
                    <button
                      @click="toggleOneShotPromptPopover(w.windowId)"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                      style="color: var(--text-primary);"
                      title="One-Shot AI Prompt (Custom tab grouping instruction)"
                    >
                      <svg class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.948 5.684a1 1 0 00-1.896 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.896l2.051.683a1 1 0 01.633.633l.683 2.051a1 1 0 001.896 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.896l-2.051-.683a1 1 0 01-.633-.633L6.948 5.684z" />
                      </svg>
                      <span>{{ getMessage('oneShotPrompt') }}</span>
                    </button>
                    <button
                      @click="handleGenerateWindowName(w.windowId, $event.shiftKey); activeMoreMenuWindowId = null"
                      :disabled="isAnyAIOperating"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer disabled:opacity-50"
                      style="color: var(--text-primary);"
                      title="AI Generate Window Name. Hold Shift + click for verbose log."
                    >
                      <svg class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.948 5.684a1 1 0 00-1.896 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.896l2.051.683a1 1 0 01.633.633l.683 2.051a1 1 0 001.896 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.896l-2.051-.683a1 1 0 01-.633-.633L6.948 5.684z" clip-rule="evenodd" />
                      </svg>
                      <span>{{ getMessage('generateWindowName') }}</span>
                    </button>
                    <button
                      v-if="allWindows.length > 1"
                      @click="handleGenerateAllWindowsNames($event.shiftKey); activeMoreMenuWindowId = null"
                      :disabled="isAnyAIOperating"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer disabled:opacity-50"
                      style="color: var(--text-primary);"
                      title="AI Name All Windows. Hold Shift + click for verbose log."
                    >
                      <svg class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.948 5.684a1 1 0 00-1.896 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.896l2.051.683a1 1 0 01.633.633l.683 2.051a1 1 0 001.896 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.896l-2.051-.683a1 1 0 01-.633-.633L6.948 5.684z" clip-rule="evenodd" />
                      </svg>
                      <span>{{ getMessage('generateAllWindowsNames') }}</span>
                    </button>
                    <button
                      @click="handleUngroup(w.windowId)"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                      style="color: var(--text-primary);"
                    >
                      <svg class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M3 4.25A2.25 2.25 0 015.25 2h9.5A2.25 2.25 0 0117 4.25v2.5A2.25 2.25 0 0114.75 9h-9.5A2.25 2.25 0 013 6.75v-2.5zm2.25-.75a.75.75 0 00-.75.75v2.5c0 .414.336.75.75.75h9.5a.75.75 0 00.75-.75v-2.5a.75.75 0 00-.75-.75h-9.5zM2 13.25A.75.75 0 012.75 12.5h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 13.25z" clip-rule="evenodd" />
                      </svg>
                      <span>{{ getMessage('ungroupAll') }}</span>
                    </button>
                    <button
                      @click="handleCleanupGroups(w.windowId)"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                      style="color: var(--text-primary);"
                    >
                      <svg class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.21-2.35.398a.75.75 0 00-.56.885l.135.539a.75.75 0 00.885.56 25.1 25.1 0 011.89-.37v10.55A2.75 2.75 0 008.75 19h2.5a2.75 2.75 0 002.75-2.75V5.727c.642.096 1.272.22 1.89.37a.75.75 0 00.885-.56l.135-.539a.75.75 0 00-.56-.885 26.6 26.6 0 00-2.35-.398V3.75A2.75 2.75 0 0011.25 1h-2.5zm1.25 1.5c.69 0 1.25.56 1.25 1.25v.266c-.83-.04-1.67-.04-2.5 0V3.75c0-.69.56-1.25 1.25-1.25z" clip-rule="evenodd" />
                      </svg>
                      <span>{{ getMessage('cleanupGroups') }}</span>
                    </button>
                    <button
                      @click="isWindowRegrouping(w.windowId) ? handleCancelCheckLast20(w.windowId) : handleCheckLast20Tabs(w.windowId); activeMoreMenuWindowId = null"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                      :style="{ color: isWindowRegrouping(w.windowId) ? 'var(--group-red)' : 'var(--text-primary)' }"
                      :title="isWindowRegrouping(w.windowId) ? 'Cancel' : getMessage('checkLast20Tooltip')"
                    >
                      <span v-if="isWindowRegrouping(w.windowId)" class="animate-spin w-3.5 h-3.5 border border-current border-t-transparent rounded-full shrink-0" />
                      <svg v-else class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                      </svg>
                      <span>{{ isWindowRegrouping(w.windowId) ? 'Cancel' : getMessage('checkLast20Tabs') }}</span>
                    </button>
                    <button
                      v-if="allWindows.length > 1"
                      @click="handleMergeAllWindows(w.windowId)"
                      class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                      style="color: var(--text-primary);"
                    >
                      <svg class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v8.5A2.25 2.25 0 0115.75 15h-3.105a3.501 3.501 0 01-5.29 0H4.25A2.25 2.25 0 012 12.75v-8.5zM4.25 3.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h3.105a.75.75 0 01.672.418 2.001 2.001 0 003.946 0 .75.75 0 01.672-.418h3.105a.75.75 0 00.75-.75v-8.5a.75.75 0 00-.75-.75H4.25z" clip-rule="evenodd" />
                      </svg>
                      <span>{{ getMessage('mergeAllWindowsIntoThis') }}</span>
                    </button>

                    <template v-if="w.hasGroups">
                      <div class="my-0.5 border-t" style="border-color: var(--border);" />
                      <button
                        @click="handleToggleGroupTitles(w.windowId)"
                        class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                        style="color: var(--text-primary);"
                      >
                        <svg class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M2.5 2a.5.5 0 00-.5.5v3.5a.5.5 0 00.146.354l5.5 5.5a.5.5 0 00.708 0l3.5-3.5a.5.5 0 000-.708l-5.5-5.5A.5.5 0 006 2H2.5zm1.5 2a1 1 0 110 2 1 1 0 010-2z" />
                        </svg>
                        <span>{{ isTitlesHidden(w.windowId) ? getMessage('showGroupTitles') : getMessage('hideGroupTitles') }}</span>
                      </button>
                      <button
                        @click="handleToggleAllGroups(w.windowId)"
                        class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors w-full text-left font-medium cursor-pointer"
                        style="color: var(--text-primary);"
                      >
                        <svg v-if="isWindowCollapsed(w.windowId)" class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M4 3.5l4 4 4-4" />
                          <path d="M4 8.5l4 4 4-4" />
                        </svg>
                        <svg v-else class="w-3.5 h-3.5 shrink-0 opacity-70" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M4 7l4-4 4 4" />
                          <path d="M4 12.5l4-4 4 4" />
                        </svg>
                        <span>{{ isWindowCollapsed(w.windowId) ? getMessage('expandAll') : getMessage('collapseAll') }}</span>
                      </button>
                    </template>
                  </div>
                </div>
              </div>
            </div>

            <!-- Active Operation Progress Status Line -->
            <div 
              v-if="isWindowOperating(w.windowId) && allActiveOperations[w.windowId]?.statusText" 
              class="flex flex-col gap-1 px-1 transition-all"
            >
              <div 
                class="text-[9.5px] font-medium flex items-center gap-1.5"
                style="color: var(--accent);"
              >
                <span class="animate-spin w-2 h-2 border border-current border-t-transparent rounded-full shrink-0" />
                <span class="truncate">{{ allActiveOperations[w.windowId]?.statusText }}</span>
              </div>
              <div 
                v-if="allActiveOperations[w.windowId]?.totalTabs && (allActiveOperations[w.windowId]?.totalTabs || 0) > 0"
                class="w-full h-1 rounded-full overflow-hidden bg-black/10 dark:bg-white/10"
              >
                <div 
                  class="h-full rounded-full transition-all duration-300"
                  style="background: var(--accent);"
                  :style="{ width: `${Math.min(100, Math.round(((allActiveOperations[w.windowId]?.processedTabs || 0) / (allActiveOperations[w.windowId]?.totalTabs || 1)) * 100))}%` }"
                />
              </div>
            </div>

            <!-- One-Shot Prompt Popover -->
            <div v-if="activePromptWindowId === w.windowId" class="w-full p-2.5 rounded-sm flex flex-col gap-2 transition-all shadow-card z-40" style="background: var(--bg-elevated); border: 0.5px solid var(--border);">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5 text-[11px] font-semibold" style="color: var(--accent);">
                  <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.948 5.684a1 1 0 00-1.896 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.896l2.051.683a1 1 0 01.633.633l.683 2.051a1 1 0 001.896 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.896l-2.051-.683a1 1 0 01-.633-.633L6.948 5.684z" />
                  </svg>
                  <span>{{ getMessage('oneShotPrompt') }}</span>
                </div>
                <button @click="activePromptWindowId = null" class="text-[11px] opacity-60 hover:opacity-100 focus:outline-none" style="color: var(--text-secondary);">✕</button>
              </div>
              <div class="relative flex items-center gap-1.5">
                <input
                  v-model="oneShotPromptText"
                  type="text"
                  :placeholder="getMessage('enterCustomPromptPlaceholder')"
                  class="w-full px-2.5 py-1.5 text-[11px] rounded-sm focus:outline-none"
                  style="background: var(--bg-primary); color: var(--text-primary); border: 0.5px solid var(--border);"
                  @keydown.enter="runOneShotPrompt(w.windowId)"
                  @keydown.esc="activePromptWindowId = null"
                />
                <button
                  class="px-3 py-1.5 text-[10px] font-medium rounded-sm transition-colors whitespace-nowrap shrink-0 text-white"
                  style="background: var(--accent);"
                  @click="runOneShotPrompt(w.windowId)"
                >
                  {{ getMessage('runPrompt') }}
                </button>
              </div>
              <div class="flex items-center gap-1.5 flex-wrap text-[9px]" style="color: var(--text-tertiary);">
                <span class="font-medium">Try:</span>
                <button
                  @click="runOneShotPrompt(w.windowId, 'sort all google tabs into 1 group')"
                  class="px-1.5 py-0.5 rounded-sm hover:underline cursor-pointer"
                  style="background: var(--hover); color: var(--text-secondary);"
                >
                  sort all google tabs into 1 group
                </button>
                <button
                  @click="runOneShotPrompt(w.windowId, 'group tabs by project topic')"
                  class="px-1.5 py-0.5 rounded-sm hover:underline cursor-pointer"
                  style="background: var(--hover); color: var(--text-secondary);"
                >
                  group by project topic
                </button>
              </div>
            </div>

            <!-- Tooltip (Shows on hover of Group Tabs or Classify New inside relative actions container) -->
            <div v-if="!isWindowOperating(w.windowId) && hoveredActionWindowId === w.windowId && activeHoverAction !== null" class="absolute left-3.5 top-full mt-1.5 block w-[280px] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
              <template v-if="aiSettings.enabled && aiSettings.apiKey">
                <div class="font-semibold mb-1" style="color: var(--accent);">
                  {{ activeHoverAction === 'group' ? 'AI Grouping Preview' : activeHoverAction === 'regroup' ? 'AI Check & Regroup Preview' : 'AI Classification Preview' }}
                </div>
                <div class="flex items-center gap-1.5 text-[9px] mb-2" style="color: var(--text-tertiary);">
                  <span>Model: <span class="font-semibold" style="color: var(--text-secondary);">{{ activeModel }}</span></span>
                  <span class="opacity-40">•</span>
                  <span>Batch Size: <span class="font-semibold" style="color: var(--text-secondary);">{{ aiSettings.batchSize || `${getAutoBatchSize(aiSettings.maxTokens)} (Auto)` }}</span></span>
                </div>
                
                <div class="mb-1 text-[9px] uppercase font-bold tracking-wider mt-2" style="color: var(--text-tertiary);">System Prompt</div>
                <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
                  {{ getSystemPrompt() }}
                </div>
                
                <div class="mb-1 text-[9px] uppercase font-bold tracking-wider" style="color: var(--text-tertiary);">User Prompt</div>
                <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
                  {{ activeHoverAction === 'group' ? getGroupingPrompt() : activeHoverAction === 'regroup' ? 'Review last 20 tabs to verify if in correct groups, and regroup if needed.' : getClassifyPrompt(w) }}
                </div>
                
                <div class="mt-2 pt-2 border-t flex flex-col gap-1.5" style="border-color: var(--border);">
                  <div class="flex items-center justify-between text-[10px]">
                    <span style="color: var(--text-secondary);">
                      Est. Requests: <span class="font-bold tabular-nums" style="color: var(--text-primary);">
                        {{ activeHoverAction === 'group' ? Math.ceil(unpinnedTabsCount(w) / (aiSettings.batchSize || getAutoBatchSize(aiSettings.maxTokens))) : activeHoverAction === 'regroup' ? Math.ceil(Math.min(unpinnedTabsCount(w), 20) / (aiSettings.batchSize || getAutoBatchSize(aiSettings.maxTokens))) : Math.ceil(newTabsCount(w) / (aiSettings.batchSize || getAutoBatchSize(aiSettings.maxTokens))) }}
                      </span>
                    </span>
                    <span class="font-bold tabular-nums" style="color: var(--text-primary);">{{ estimateCostAndTokens(w, activeHoverAction).costStr }}</span>
                  </div>
                  <div class="flex items-center justify-between text-[9px]" style="color: var(--text-tertiary);">
                    <span>Total: <span class="font-semibold tabular-nums" style="color: var(--text-secondary);">~{{ estimateCostAndTokens(w, activeHoverAction).tokens }}</span> tokens</span>
                    <span>Rate: <span class="font-semibold tabular-nums" style="color: var(--text-secondary);">~{{ estimateCostAndTokens(w, activeHoverAction).tokensPerRequest }}</span> tok/req</span>
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="font-semibold mb-1" style="color: var(--accent);">
                  {{ activeHoverAction === 'group' ? 'Rule-based Grouping Preview' : activeHoverAction === 'regroup' ? 'AI Check & Regroup' : 'Rule-based Classification Preview' }}
                </div>
                <div class="flex items-center gap-1.5 text-[9px] mb-2" style="color: var(--text-tertiary);">
                  <span>Mode: <span class="font-semibold" style="color: var(--text-secondary);">{{ activeHoverAction === 'regroup' ? 'Requires AI' : 'Local Rule Engine' }}</span></span>
                  <span class="opacity-40">•</span>
                  <span>Privacy: <span class="font-semibold" style="color: var(--text-secondary);">{{ activeHoverAction === 'regroup' ? 'AI Cloud' : '100% Offline' }}</span></span>
                </div>
                
                <div class="mb-1 text-[9px] uppercase font-bold tracking-wider mt-2" style="color: var(--text-tertiary);">Description</div>
                <div class="text-[10px] mb-2 leading-relaxed" style="color: var(--text-secondary);">
                  {{ activeHoverAction === 'group' 
                    ? 'Tabs will be organized instantly using high-performance local heuristics. Priority is given to matching exact domains, parent domains, and tab title keywords.' 
                    : activeHoverAction === 'regroup'
                    ? 'Checking if the last 20 tabs are in correct groups requires AI to be enabled and configured with an API key in Settings.'
                    : 'New tabs will be classified instantly into matching existing groups using high-performance local heuristics (domain, parent domain, and keyword match).' }}
                </div>
                
                <div class="mb-1 text-[9px] uppercase font-bold tracking-wider" style="color: var(--text-tertiary);">Built-in Categories</div>
                <div class="text-[10px] mb-2 flex flex-wrap gap-1" style="color: var(--text-secondary);">
                  <span class="px-1.5 py-0.5 rounded-sm text-[9px]" style="background: var(--hover); border: 0.5px solid var(--border);">Work</span>
                  <span class="px-1.5 py-0.5 rounded-sm text-[9px]" style="background: var(--hover); border: 0.5px solid var(--border);">Development</span>
                  <span class="px-1.5 py-0.5 rounded-sm text-[9px]" style="background: var(--hover); border: 0.5px solid var(--border);">Learning</span>
                  <span class="px-1.5 py-0.5 rounded-sm text-[9px]" style="background: var(--hover); border: 0.5px solid var(--border);">Social</span>
                  <span class="px-1.5 py-0.5 rounded-sm text-[9px]" style="background: var(--hover); border: 0.5px solid var(--border);">Entertainment</span>
                  <span class="px-1.5 py-0.5 rounded-sm text-[9px]" style="background: var(--hover); border: 0.5px solid var(--border);">Shopping</span>
                  <span class="px-1.5 py-0.5 rounded-sm text-[9px]" style="background: var(--hover); border: 0.5px solid var(--border);">Docs</span>
                </div>
                
                <div class="flex items-center justify-between mt-2 pt-2 border-t" style="border-color: var(--border);">
                  <span class="text-[10px] font-medium" style="color: var(--text-secondary);">
                    Est. Requests: <span class="font-bold tabular-nums" style="color: var(--text-primary);">0 (No API calls)</span>
                  </span>
                  <span class="text-[10px] font-bold tabular-nums" style="color: var(--group-green);">Free</span>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Groups for this window -->
        <div v-if="!isWindowSectionCollapsed(w.windowId)" style="background: var(--bg-primary); border-top: 0.5px solid var(--border);">
          <GroupList
            :groups="getSortedGroups(w)"
            :indicator-style="indicatorStyle"
            :expand-trigger="expandTriggers[w.windowId] || 0"
            :collapse-trigger="collapseTriggers[w.windowId] || 0"
            :is-current-window="w.windowId === currentWindowId"
            @close-group="loadAllPreviews"
            @split-group="loadAllPreviews"
            @error="showError"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
button:hover {
  opacity: 0.85;
}
button:active {
  transform: scale(0.97);
}
button:disabled {
  opacity: 0.4;
  pointer-events: none;
}
</style>
