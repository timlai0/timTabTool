<script setup lang="ts">
import { ref, shallowRef, onMounted, computed, watch, onUnmounted, nextTick } from 'vue'
import { getMessage } from '../shared/i18n'
import { STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_GROUPING_PROMPT, MODEL_PRICING, PROVIDER_DEFAULTS, DEFAULT_MODELS } from '../shared/constants'
import { SYSTEM_PROMPT, AIClient } from '../shared/ai-client'
import { getAutoBatchSize, getOptimalFaviconUrl, detectDuplicateTabs, normalizeUrl } from '../shared/utils'
import type { ExtensionSettings, GroupIndicatorStyle, ThemeMode, WindowGroupsInfo, LastAIResult } from '../shared/types'
import { APP_VERSION, BUILD_NUMBER, BUILD_STRING } from '../shared/version'
import GroupList from './components/GroupList.vue'
import SettingsView from './components/SettingsView.vue'

const currentView = ref<'main' | 'settings'>('main')
const isStandaloneSearch = computed(() => {
  // Logic: Check if the application is loaded as a sidebar in the standalone search window
  // Programming logic: Check if the application is loaded as a sidebar in the standalone search window
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
const groupingWindowId = ref<number | null>(null)
const classifyingWindowId = ref<number | null>(null)
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

function showError(msg: string, windowId?: number | null) {
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

const refreshPreviews = () => {
  // Programming logic: debounce preview refresh to prevent multiple concurrent loads during tab events
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
      const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue
      if (newSettings?.ai) {
        aiSettings.value = { ...DEFAULT_SETTINGS.ai, ...newSettings.ai }
      }
    }
    if (changes[STORAGE_KEYS.LAST_AI_RESULT]) {
      lastAIResult.value = changes[STORAGE_KEYS.LAST_AI_RESULT].newValue as LastAIResult
    }
  }
}

onMounted(async () => {
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
  const allTabs: Array<{ id?: number; url?: string; title?: string; favIconUrl?: string; windowId?: number }> = []
  for (const win of allWindows.value) {
    for (const group of win.groups) {
      for (const tab of group.tabs) {
        if (!tab.url) continue
        allTabs.push({
          id: tab.id,
          url: tab.url,
          title: tab.title || 'Untitled',
          favIconUrl: tab.favIconUrl,
          windowId: win.windowId
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

async function closeExactDuplicates() {
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent()).id!
  await chrome.runtime.sendMessage({ action: 'CLOSE_DUPLICATES', payload: currentWinId })
  await loadAllPreviews()
}

async function closePossibleDuplicates() {
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent()).id!
  await chrome.runtime.sendMessage({ action: 'CLOSE_POSSIBLE_DUPLICATES', payload: currentWinId })
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
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent()).id!
  await chrome.runtime.sendMessage({ action: 'ORGANIZE_POSSIBLE_DUPLICATES', payload: currentWinId })
  await loadAllPreviews()
}

async function closeSingleTab(tabId: number) {
  try {
    await chrome.tabs.remove(tabId)
  } catch (err: any) {
    const errMsg = err?.message || String(err)
    if (!errMsg.includes('No tab with id') && !errMsg.includes('Invalid tab id')) {
      console.error('[timTabTool] Failed to close tab:', err)
    }
  }
  await loadAllPreviews()
}

async function closeClusterDuplicates(cluster: { cleanUrl: string; domain: string; tabs: Array<{ id?: number }> }) {
  const idsToClose = cluster.tabs.slice(1).map(t => t.id).filter((id): id is number => id !== undefined)
  if (idsToClose.length > 0) {
    try {
      await chrome.tabs.remove(idsToClose)
    } catch (err: any) {
      const errMsg = err?.message || String(err)
      if (!errMsg.includes('No tab with id') && !errMsg.includes('Invalid tab id')) {
        console.error('[timTabTool] Failed to close cluster duplicates:', err)
      }
    }
    await loadAllPreviews()
  }
}

async function groupCluster(cluster: { cleanUrl: string; domain: string; tabs: Array<{ id?: number }> }) {
  const tabIds = cluster.tabs.map(t => t.id).filter((id): id is number => id !== undefined)
  if (tabIds.length >= 2) {
    await chrome.runtime.sendMessage({
      action: 'GROUP_CLUSTER',
      payload: { tabIds, title: `Dupes: ${cluster.domain}` }
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

const allActiveOperations = ref<Record<number, { type: 'group' | 'classify' | null; error: string | null }>>({})

const activeAIOperationsList = computed(() => {
  const list: Array<{ windowId: number; type: 'group' | 'classify'; windowName: string }> = []
  for (const [widStr, status] of Object.entries(allActiveOperations.value)) {
    const wid = Number(widStr)
    const opStatus = status as { type: 'group' | 'classify' | null; error: string | null }
    if (opStatus && opStatus.type) {
      const winObj = allWindows.value.find(w => w.windowId === wid)
      const winIndex = allWindows.value.findIndex(w => w.windowId === wid)
      const name = winObj ? windowLabel(winObj, winIndex >= 0 ? winIndex : 0) : `Window ${wid}`
      list.push({
        windowId: wid,
        type: opStatus.type,
        windowName: name,
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
      allActiveOperations.value = activeOps as Record<number, { type: 'group' | 'classify' | null; error: string | null }>
      let isAnyGrouping = false
      let isAnyClassifying = false

      for (const [widStr, status] of Object.entries(activeOps)) {
        const wid = Number(widStr)
        const opStatus = status as { type: 'group' | 'classify' | null; error: string | null }

        if (opStatus.type === 'group') {
          groupingWindowId.value = wid
          isAnyGrouping = true
        } else if (opStatus.type === 'classify') {
          classifyingWindowId.value = wid
          isAnyClassifying = true
        }

        if (opStatus.error) {
          showError(opStatus.error)
          chrome.runtime.sendMessage({ action: 'CLEAR_OPERATION_ERROR', payload: { windowId: wid } }).catch(() => {})
        }
      }

      if (!isAnyGrouping) groupingWindowId.value = null
      if (!isAnyClassifying) classifyingWindowId.value = null

      if (isAnyGrouping || isAnyClassifying) {
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
  } else if (msg?.action === 'ACTIVE_OPERATIONS_UPDATED' && msg.payload) {
    allActiveOperations.value = msg.payload
    for (const [widStr, status] of Object.entries(msg.payload)) {
      const wid = Number(widStr)
      const opStatus = status as { type: 'group' | 'classify' | null; error: string | null }
      if (opStatus.type === 'group') groupingWindowId.value = wid
      if (opStatus.type === 'classify') classifyingWindowId.value = wid
    }
  } else if (msg?.action === 'START_AI_PROGRESS') {
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OPERATIONS' }).then((ops) => {
      if (ops && typeof ops === 'object') {
        allActiveOperations.value = ops
      }
    })
  } else if (msg?.action === 'AI_OPERATION_COMPLETE' || msg?.action === 'AI_OPERATION_FAILED') {
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OPERATIONS' }).then((ops) => {
      if (ops && typeof ops === 'object') {
        allActiveOperations.value = ops
      }
    })
    loadAllPreviews()
  }
}

let pollInterval: number | null = null

function startPollingStatus() {
  if (pollInterval) return
  pollInterval = window.setInterval(async () => {
    if (groupingWindowId.value !== null || classifyingWindowId.value !== null) {
      try {
        const activeOps = await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OPERATIONS' })
        if (activeOps && typeof activeOps === 'object') {
          allActiveOperations.value = activeOps as Record<number, { type: 'group' | 'classify' | null; error: string | null }>
          let isAnyGrouping = false
          let isAnyClassifying = false

          for (const [widStr, status] of Object.entries(activeOps)) {
            const wid = Number(widStr)
            const opStatus = status as { type: 'group' | 'classify' | null; error: string | null }

            if (opStatus.type === 'group') {
              groupingWindowId.value = wid
              isAnyGrouping = true
            } else if (opStatus.type === 'classify') {
              classifyingWindowId.value = wid
              isAnyClassifying = true
            }

            if (opStatus.error) {
              showError(opStatus.error)
              await chrome.runtime.sendMessage({ action: 'CLEAR_OPERATION_ERROR', payload: { windowId: wid } })
            }
          }

          if (!isAnyGrouping && groupingWindowId.value !== null) {
            groupingWindowId.value = null
            await loadAllPreviews()
          }
          if (!isAnyClassifying && classifyingWindowId.value !== null) {
            classifyingWindowId.value = null
            await loadAllPreviews()
          }
        }
      } catch (err) {
        console.error('Polling failed:', err)
      }
    } else {
      stopPollingStatus()
    }
  }, 1500)
}

function stopPollingStatus() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
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

function estimateCostAndTokens(w: WindowGroupsInfo, countType: 'group' | 'classify' | null = 'group') {
  const type = countType === 'classify' ? 'classify' : 'group'
  const tabsCount = type === 'group' ? unpinnedTabsCount(w) : newTabsCount(w)
  
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

async function handleClassifyNew(windowId: number) {
  classifyingWindowId.value = windowId
  allActiveOperations.value = {
    ...allActiveOperations.value,
    [windowId]: { type: 'classify', error: null }
  }
  startPollingStatus()
  try {
    const res = await chrome.runtime.sendMessage({ action: 'CLASSIFY_NEW_TABS', payload: { windowId } })
    if (res && typeof res === 'object' && 'error' in res) {
      showError(String(res.error))
    }
    await loadAllPreviews()
  } catch (err) {
    showError((err as Error).message)
  } finally {
    classifyingWindowId.value = null
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

async function setWindowSort(windowId: number, mode: 'name' | 'size') {
  activeSortMenuWindowId.value = null
  if (windowGroupSort.value[windowId] === mode) {
    windowGroupSort.value[windowId] = 'default'
  } else {
    windowGroupSort.value[windowId] = mode
    if (mode === 'name') {
      await chrome.runtime.sendMessage({ action: 'SORT_GROUPS_BY_NAME', payload: { windowId } })
    } else if (mode === 'size') {
      await chrome.runtime.sendMessage({ action: 'SORT_GROUPS_BY_SIZE', payload: { windowId } })
    }
    await loadAllPreviews()
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

async function runOneShotPrompt(windowId: number, customPrompt?: string) {
  const promptToUse = (customPrompt !== undefined ? customPrompt : oneShotPromptText.value).trim()
  if (!promptToUse) return

  if (!aiSettings.value.enabled || !aiSettings.value.apiKey) {
    showError('AI grouping requires AI feature to be enabled with a valid API key in Settings.')
    return
  }

  activePromptWindowId.value = null
  await handleGroup(windowId, promptToUse)
}

async function handleGroup(windowId: number, customPrompt?: string, bypassSafeguards = false) {
  groupingWindowId.value = windowId
  allActiveOperations.value = {
    ...allActiveOperations.value,
    [windowId]: { type: 'group', error: null }
  }
  startPollingStatus()
  try {
    const payload: { windowId: number; groupingPrompt?: string; bypassSafeguards?: boolean } = { windowId }
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
  } finally {
    groupingWindowId.value = null
  }
}

async function handleUngroup(windowId: number) {
  activeMoreMenuWindowId.value = null
  await chrome.runtime.sendMessage({ action: 'UNGROUP_ALL', payload: { windowId } })
  await loadAllPreviews()
}

async function handleCleanupGroups(windowId: number) {
  activeMoreMenuWindowId.value = null
  // Programming logic: Prompt user for minimum tab threshold with a default of 3
  const input = prompt(getMessage('enterMinTabs') || 'Enter minimum tab count for a group:', '3')
  if (input === null) return
  const minTabs = parseInt(input.trim())
  if (isNaN(minTabs) || minTabs <= 0) return

  // Logic: Dissolve tab groups with fewer than minTabs tabs
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

const activeHoverAction = ref<'group' | 'classify' | null>(null)
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

  <div v-else :style="isStandaloneSearch ? { width: '380px', height: '100%', background: 'var(--bg-primary)' } : { width: Math.max(360, windowWidth) + 'px', height: Math.max(240, Math.min(600, windowHeight || 500)) + 'px', background: 'var(--bg-primary)' }" class="flex flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between px-4 py-3" style="box-shadow: 0 0.5px 0 var(--border);">
      <div class="flex items-center gap-2.5 flex-1 min-w-0 flex-wrap py-0.5">
        <img src="/icons/icon-32.png" alt="" class="w-5 h-5 shrink-0" />
        <div class="flex items-center gap-1.5 shrink-0" :title="BUILD_STRING">
          <h1 class="text-[15px] font-semibold tracking-tight" style="color: var(--text-primary);">timTabTool</h1>
          <span class="text-[9px] font-medium opacity-60 tabular-nums px-1 py-0.2 rounded-xs" style="color: var(--text-secondary); background: var(--hover);">{{ APP_VERSION }}b{{ BUILD_NUMBER }}</span>
        </div>
        <!-- Last AI Operation Result Indicator -->
        <span v-if="lastAIResult && activeAIOperationsCount === 0" class="relative group shrink-0">
          <span 
            class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-md flex items-center gap-1.5 cursor-pointer shadow-xs transition-all hover:opacity-90"
            :style="lastAIResult.error ? 'color: #FF3B30; background: rgba(255,59,48,0.1); border: 1px solid rgba(255,59,48,0.2);' : 'color: var(--accent); background: var(--accent-soft); border: 1px solid var(--border);'"
          >
            <svg v-if="!lastAIResult.error" class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3.25 3.25a.75.75 0 001.06-1.06L10.75 10.44V5z" clip-rule="evenodd" />
            </svg>
            <svg v-else class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" />
            </svg>
            <span>{{ lastAIResult.error ? 'AI Failed' : 'AI: ' + lastAIResult.summary }}</span>
            <svg class="w-2.5 h-2.5 opacity-60" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
            </svg>
          </span>

          <div class="hidden group-hover:block absolute left-0 top-full pt-2 w-[280px] max-w-[calc(100vw-24px)] z-50">
            <div class="p-3 rounded-md shadow-card text-left leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
              <div class="font-semibold mb-1.5 text-xs flex items-center justify-between" :style="lastAIResult.error ? 'color: #FF3B30;' : 'color: var(--accent);'">
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
                <div v-if="lastAIResult.error" class="text-[10.5px] font-medium whitespace-pre-wrap mt-0.5" style="color: #FF3B30;">
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
                        class="px-1.5 py-0.5 rounded text-[9.5px] font-medium"
                        style="background: var(--hover); color: var(--text-primary); border: 0.5px solid var(--border);"
                      >
                        {{ gName }}
                      </span>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </span>

        <!-- Running AI Operations Indicator -->
        <span v-if="activeAIOperationsCount > 0" class="relative group shrink-0">
          <span 
            class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-md flex items-center gap-1.5 cursor-pointer shadow-xs transition-all animate-pulse" 
            style="color: #ffffff; background: var(--accent); border: 1px solid var(--accent);"
          >
            <span class="animate-spin w-2.5 h-2.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
            <span>{{ activeAIOperationsCount }} AI op{{ activeAIOperationsCount > 1 ? 's' : '' }} running</span>
            <svg class="w-2.5 h-2.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
            </svg>
          </span>

          <div class="hidden group-hover:block absolute left-0 top-full pt-2 w-[275px] max-w-[calc(100vw-24px)] z-50">
            <div class="p-3 rounded-md shadow-card text-left leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
              <div class="font-semibold mb-2 text-xs flex items-center justify-between" style="color: var(--accent);">
                <span class="flex items-center gap-1.5">
                  <span class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
                  <span>Active AI Operations ({{ activeAIOperationsCount }})</span>
                </span>
              </div>
              <div class="flex flex-col gap-2">
                <div 
                  v-for="op in activeAIOperationsList" 
                  :key="op.windowId" 
                  class="p-2.5 rounded-md bg-black/5 dark:bg-white/5 border flex flex-col gap-1 text-[10px]"
                  style="border-color: var(--border);"
                >
                  <div class="flex items-center justify-between gap-2 font-medium">
                    <span class="truncate flex-1 font-semibold" style="color: var(--text-primary);">{{ op.windowName }}</span>
                    <span class="text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0" style="background: var(--accent-soft); color: var(--accent);">
                      {{ op.type === 'group' ? 'Grouping' : 'Classifying' }}
                    </span>
                  </div>
                  <div class="flex items-center justify-between gap-2 text-[9.5px] mt-0.5" style="color: var(--text-secondary);">
                    <span class="truncate flex-1" :title="'Processing with ' + activeModel">Processing: {{ activeModel }}</span>
                    <button 
                      @click.stop="op.type === 'group' ? handleCancelGroup(op.windowId) : handleCancelClassify(op.windowId)" 
                      class="text-red-500 hover:underline font-semibold cursor-pointer shrink-0"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </span>

        <span class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-md shrink-0" style="color: var(--text-primary); background: var(--hover); border: 1px solid var(--border);">
          {{ totalTabs }} tabs · {{ totalGroups }} groups · {{ totalWindows }} windows
        </span>

        <div v-if="exactDuplicatesCount > 0 || possibleDuplicatesCount > 0 || duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0" class="relative group flex items-center gap-1 text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-md shrink-0" style="color: var(--text-primary); background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3);">
          <svg class="w-3 h-3" style="color: #ef4444;" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
          </svg>
          <button v-if="exactDuplicatesCount > 0" class="hover:underline focus:outline-none cursor-pointer" @click="closeExactDuplicates" title="Close all exact duplicates">
            {{ exactDuplicatesCount }} exact dupes
          </button>
          <span v-if="exactDuplicatesCount > 0 && possibleDuplicatesCount > 0">·</span>
          <button v-if="possibleDuplicatesCount > 0" class="hover:underline focus:outline-none cursor-pointer" @click="organizePossibleDuplicates" title="Group and view possible duplicates">
            {{ possibleDuplicatesCount }} possible dupes
          </button>
          <span v-if="(exactDuplicatesCount > 0 || possibleDuplicatesCount > 0) && (duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0)">·</span>
          <span v-if="duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0" class="cursor-default" title="Duplicate group names detected">
            {{ duplicateGroupsCount + crossWindowDuplicateGroupsCount }} dup groups
          </span>

          <!-- Single Unified Duplicates Popover Card anchored at left-0 of the red pill badge -->
          <div class="hidden group-hover:block absolute left-0 top-full pt-2 w-[320px] max-w-[calc(100vw-32px)] z-50">
            <div class="p-3 rounded-md shadow-card text-left whitespace-normal leading-relaxed transition-all duration-200 flex flex-col gap-2.5 max-h-[320px] overflow-y-auto scrollbar-thin" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
              
              <!-- Exact Duplicates Section -->
              <div v-if="exactDuplicatesCount > 0">
                <div class="font-semibold mb-1.5 text-xs flex items-center justify-between" style="color: var(--accent);">
                  <span>Exact Duplicates ({{ exactDuplicateTabs.length }})</span>
                  <button @click.stop="closeExactDuplicates" class="text-[9px] px-1.5 py-0.5 rounded font-medium bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors cursor-pointer">
                    Close Exact
                  </button>
                </div>
                <div class="flex flex-col gap-1">
                  <div 
                    v-for="tab in exactDuplicateTabs" 
                    :key="tab.id" 
                    class="flex items-center gap-2 text-[10px] p-1.5 rounded-md cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors border-b border-dashed last:border-b-0 group/tabrow"
                    style="border-color: var(--border);"
                    @click="tab.id !== undefined && tab.windowId !== undefined && focusTab(tab.id, tab.windowId)"
                    @auxclick.prevent.stop="($event) => { if ($event.button === 1 && tab.id !== undefined) closeSingleTab(tab.id); }"
                  >
                    <img v-if="getOptimalFaviconUrl(tab.url, tab.favIconUrl)" :src="getOptimalFaviconUrl(tab.url, tab.favIconUrl)" alt="" class="w-3.5 h-3.5 rounded-xs shrink-0" />
                    <div v-else class="w-3.5 h-3.5 rounded-xs bg-gray-500/20 shrink-0" />
                    <div class="flex-1 min-w-0">
                      <div class="font-medium truncate text-[9.5px]" style="color: var(--text-primary);">{{ tab.title }}</div>
                      <div class="text-[8.5px] truncate" style="color: var(--text-secondary);">{{ tab.url }}</div>
                    </div>
                    <button 
                      v-if="tab.id !== undefined"
                      @click.stop="closeSingleTab(tab.id)"
                      @auxclick.prevent.stop="($event) => { if ($event.button === 1 && tab.id !== undefined) closeSingleTab(tab.id); }"
                      class="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover/tabrow:opacity-100 hover:bg-red-500/20 hover:text-red-500 transition-all shrink-0 cursor-pointer"
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

              <!-- Divider if both exist -->
              <div v-if="exactDuplicatesCount > 0 && possibleDuplicatesCount > 0" class="border-t my-0.5" style="border-color: var(--border);" />

              <!-- Possible Duplicates Section -->
              <div v-if="possibleDuplicatesCount > 0">
                <div class="font-semibold mb-1.5 text-xs flex items-center justify-between" style="color: var(--accent);">
                  <span>Possible Dupes ({{ possibleDuplicatesCount }})</span>
                  <div class="flex items-center gap-1.5">
                    <button @click.stop="closePossibleDuplicates" class="text-[9px] px-1.5 py-0.5 rounded font-medium bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors cursor-pointer">
                      Close Dupes
                    </button>
                    <button @click.stop="organizePossibleDuplicates" class="text-[9px] px-1.5 py-0.5 rounded font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer" style="color: var(--text-primary);">
                      Group All
                    </button>
                  </div>
                </div>
                <div class="flex flex-col gap-2">
                  <div v-for="cluster in possibleDuplicateClusters" :key="cluster.cleanUrl" class="p-2 rounded-md bg-black/5 dark:bg-white/5 border border-dashed border-border flex flex-col gap-1 text-[10px]" style="border-color: var(--border);">
                    <div class="font-medium text-[9.5px] flex items-center justify-between gap-1" style="color: var(--accent);">
                      <span class="truncate min-w-0">{{ cluster.domain }} <span class="opacity-60 text-[9px]" style="color: var(--text-secondary);">({{ cluster.tabs.length }} variants)</span></span>
                      <div class="flex items-center gap-1 shrink-0">
                        <button @click.stop="closeClusterDuplicates(cluster)" class="text-[8.5px] px-1 py-0.2 rounded font-medium bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors cursor-pointer" title="Keep first, close other variants in this cluster">
                          Dedupe
                        </button>
                        <button @click.stop="groupCluster(cluster)" class="text-[8.5px] px-1 py-0.2 rounded font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer" style="color: var(--text-primary);" title="Group these variants into a tab group">
                          Group
                        </button>
                      </div>
                    </div>
                    <div 
                      v-for="tab in cluster.tabs" 
                      :key="tab.id"
                      class="flex items-center gap-1.5 p-1 rounded cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 transition-colors group/tabrow"
                      @click="tab.id !== undefined && tab.windowId !== undefined && focusTab(tab.id, tab.windowId)"
                      @auxclick.prevent.stop="($event) => { if ($event.button === 1 && tab.id !== undefined) closeSingleTab(tab.id); }"
                    >
                      <img v-if="getOptimalFaviconUrl(tab.url || '', tab.favIconUrl)" :src="getOptimalFaviconUrl(tab.url || '', tab.favIconUrl)" alt="" class="w-3 h-3 rounded-xs shrink-0" />
                      <div v-else class="w-3 h-3 rounded-xs bg-gray-500/20 shrink-0" />
                      <div class="flex-1 min-w-0">
                        <div class="truncate text-[9.5px]" style="color: var(--text-primary);">{{ tab.title }}</div>
                        <div class="truncate text-[8.5px]" style="color: var(--text-secondary);">{{ tab.url }}</div>
                      </div>
                      <button 
                        v-if="tab.id !== undefined"
                        @click.stop="closeSingleTab(tab.id)"
                        @auxclick.prevent.stop="($event) => { if ($event.button === 1 && tab.id !== undefined) closeSingleTab(tab.id); }"
                        class="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover/tabrow:opacity-100 hover:bg-red-500/20 hover:text-red-500 transition-all shrink-0 cursor-pointer"
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

              <!-- Divider if needed -->
              <div v-if="(exactDuplicatesCount > 0 || possibleDuplicatesCount > 0) && (duplicateGroupsCount > 0 || crossWindowDuplicateGroupsCount > 0)" class="border-t my-0.5" style="border-color: var(--border);" />

              <!-- Duplicate Groups Section -->
              <div v-if="duplicateGroupsCount > 0">
                <div class="font-semibold mb-1.5 text-xs flex items-center justify-between" style="color: var(--accent);">
                  <span>Duplicate Groups ({{ duplicateGroupsCount }})</span>
                  <button @click.stop="mergeAllDuplicateGroups" class="text-[9px] px-1.5 py-0.5 rounded font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer" style="color: var(--text-primary);">
                    Merge All
                  </button>
                </div>
                <div class="flex flex-col gap-2">
                  <div v-for="cluster in duplicateGroupClusters" :key="cluster.normalized" class="p-2 rounded-md bg-black/5 dark:bg-white/5 border border-dashed border-border flex flex-col gap-1 text-[10px]" style="border-color: var(--border);">
                    <div class="font-medium text-[9.5px] flex items-center justify-between gap-1" style="color: var(--accent);">
                      <span class="truncate min-w-0">{{ cluster.originalNames[0] }} <span class="opacity-60 text-[9px]" style="color: var(--text-secondary);">({{ cluster.count }} duplicate groups)</span></span>
                      <div class="flex items-center gap-1 shrink-0">
                        <button @click.stop="mergeDuplicateGroup(cluster)" class="text-[8.5px] px-1 py-0.2 rounded font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer" style="color: var(--text-primary);" title="Merge these duplicate groups into one">
                          Merge
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Cross-Window Duplicate Groups Section -->
              <div v-if="crossWindowDuplicateGroupsCount > 0">
                <div class="font-semibold mb-1.5 mt-2 text-xs flex items-center justify-between" style="color: var(--accent);">
                  <span title="These duplicate groups span across multiple windows">Duplicate Groups (Cross-Window) ({{ crossWindowDuplicateGroupsCount }})</span>
                </div>
                <div class="flex flex-col gap-2">
                  <div v-for="cluster in crossWindowDuplicateGroupClusters" :key="'cross_'+cluster.normalized" class="p-2 rounded-md bg-black/5 dark:bg-white/5 border border-dashed border-border flex flex-col gap-1 text-[10px]" style="border-color: var(--border);">
                    <div class="font-medium text-[9.5px] flex items-center justify-between gap-1" style="color: var(--accent);">
                      <span class="truncate min-w-0">{{ cluster.originalNames[0] }} <span class="opacity-60 text-[9px]" style="color: var(--text-secondary);">({{ cluster.count }} duplicate groups across windows)</span></span>
                      <div class="flex items-center gap-1 shrink-0">
                        <button @click.stop="mergeDuplicateGroup(cluster)" class="text-[8.5px] px-1 py-0.2 rounded font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors cursor-pointer" style="color: var(--text-primary);" title="Merge these cross-window duplicate groups into one window">
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
      style="background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.25);"
    >
      <svg class="w-3.5 h-3.5 shrink-0 mt-0.5" style="color: #ef4444;" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
      <div class="flex-1 text-[10.5px] leading-normal flex flex-col gap-1.5" style="color: var(--text-primary); font-weight: 500;">
        <div>{{ errorMessage }}</div>
        <button
          v-if="errorMessage.includes('safety safeguard') || errorMessage.includes('safety limit')"
          @click="handleProceedAnyways"
          class="self-start px-2 py-0.5 text-[10px] font-semibold rounded-sm transition-all cursor-pointer flex items-center gap-1 shrink-0"
          style="background: #ef4444; color: #ffffff;"
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
        <div class="w-10 h-10 mx-auto mb-3 rounded-2xl flex items-center justify-center" style="background: var(--bg-secondary);">
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
        style="background: var(--bg-secondary); border-color: var(--border);"
      >
        <div class="sticky top-0 z-20 flex flex-col shadow-sm" style="background: var(--bg-secondary); border-bottom: 1px solid var(--border);">
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
                  class="px-2.5 py-[4px] text-[11px] font-medium rounded-btn flex items-center gap-1 transition-all group whitespace-nowrap"
                  :style="groupingWindowId === w.windowId
                    ? { background: 'var(--group-red)', color: '#fff' }
                    : { background: 'var(--accent)', color: '#fff' }"
                  @click="groupingWindowId === w.windowId ? handleCancelGroup(w.windowId) : handleGroup(w.windowId)"
                  @mouseenter="activeHoverAction = 'group'; hoveredActionWindowId = w.windowId"
                  @mouseleave="activeHoverAction = null; hoveredActionWindowId = null"
                >
                  <span v-if="groupingWindowId === w.windowId" class="inline-flex items-center gap-1">
                    <span class="animate-spin w-2.5 h-2.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
                    <span>Grouping...</span>
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
                  :style="classifyingWindowId === w.windowId
                    ? { background: 'var(--group-red)', color: '#fff' }
                    : { background: 'var(--accent-soft)', color: 'var(--accent)' }"
                  @click="classifyingWindowId === w.windowId ? handleCancelClassify(w.windowId) : handleClassifyNew(w.windowId)"
                  @mouseenter="activeHoverAction = 'classify'; hoveredActionWindowId = w.windowId"
                  @mouseleave="activeHoverAction = null; hoveredActionWindowId = null"
                  :title="getMessage('classifyNewTabs')"
                >
                  <span v-if="classifyingWindowId === w.windowId" class="inline-flex items-center gap-1">
                    <span class="animate-spin w-2.5 h-2.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
                    <span>Classifying...</span>
                  </span>
                  <span v-else class="flex items-center gap-1">
                    <svg class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
                    </svg>
                    <span>Classify ({{ newTabsCount(w) }})</span>
                  </span>
                </button>

                <!-- Custom Prompt Icon Button -->
                <button
                  class="p-[5px] rounded-btn flex items-center justify-center transition-all shrink-0"
                  :style="activePromptWindowId === w.windowId
                    ? { background: 'var(--accent)', color: '#fff' }
                    : { color: 'var(--text-secondary)', background: 'var(--hover)' }"
                  @click="toggleOneShotPromptPopover(w.windowId)"
                  title="One-Shot AI Prompt (Custom tab grouping instruction)"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M15.98 1.804a1 1 0 00-1.96 0l-.24 1.192a1 1 0 01-.784.785l-1.192.238a1 1 0 000 1.962l1.192.238a1 1 0 01.785.785l.238 1.192a1 1 0 001.962 0l.238-1.192a1 1 0 01.785-.785l1.192-.238a1 1 0 000-1.962l-1.192-.238a1 1 0 01-.785-.785l-.238-1.192zM6.948 5.684a1 1 0 00-1.896 0l-.683 2.051a1 1 0 01-.633.633l-2.051.683a1 1 0 000 1.896l2.051.683a1 1 0 01.633.633l.683 2.051a1 1 0 001.896 0l.683-2.051a1 1 0 01.633-.633l2.051-.683a1 1 0 000-1.896l-2.051-.683a1 1 0 01-.633-.633L6.948 5.684z" />
                  </svg>
                </button>

                <!-- Sort Popover -->
                <div class="relative inline-block shrink-0">
                  <button
                    class="p-[5px] rounded-btn flex items-center justify-center transition-all shrink-0"
                    :style="(activeSortMenuWindowId === w.windowId || (windowGroupSort[w.windowId] && windowGroupSort[w.windowId] !== 'default'))
                      ? { background: 'var(--accent)', color: '#fff' }
                      : { color: 'var(--text-secondary)', background: 'var(--hover)' }"
                    @click="toggleSortMenuPopover(w.windowId)"
                    :title="getMessage('sort')"
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M2.24 6.8a.75.75 0 001.06-.04L6 3.94v11.31a.75.75 0 001.5 0V3.94l2.7 2.82a.75.75 0 101.1-1.04l-4-4.17a.75.75 0 00-1.1 0l-4 4.17a.75.75 0 00.04 1.06zm15.52 6.4a.75.75 0 00-1.06.04L14 16.06V4.75a.75.75 0 00-1.5 0v11.31l-2.7-2.82a.75.75 0 10-1.1 1.04l4 4.17a.75.75 0 001.1 0l4-4.17a.75.75 0 00-.04-1.06z" clip-rule="evenodd" />
                    </svg>
                  </button>

                  <div v-if="activeSortMenuWindowId === w.windowId" class="absolute right-0 top-full mt-1 w-44 p-1 rounded-md shadow-card z-50 flex flex-col gap-0.5 text-left" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
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
                <div class="relative inline-block shrink-0">
                  <button
                    class="p-[5px] rounded-btn flex items-center justify-center transition-colors shrink-0"
                    :style="activeMoreMenuWindowId === w.windowId
                      ? { background: 'var(--accent)', color: '#fff' }
                      : { color: 'var(--text-secondary)', background: 'var(--hover)' }"
                    @click="toggleMoreMenuPopover(w.windowId)"
                    title="More actions"
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
                    </svg>
                  </button>

                  <div v-if="activeMoreMenuWindowId === w.windowId" class="absolute right-0 top-full mt-1 w-44 p-1 rounded-md shadow-card z-50 flex flex-col gap-0.5 text-left" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
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

            <!-- One-Shot Prompt Popover -->
            <div v-if="activePromptWindowId === w.windowId" class="w-full p-2.5 rounded-md flex flex-col gap-2 transition-all shadow-card z-40" style="background: var(--bg-elevated); border: 0.5px solid var(--border);">
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
                  style="background: var(--bg-main); color: var(--text-primary); border: 0.5px solid var(--border);"
                  @keydown.enter="runOneShotPrompt(w.windowId)"
                  @keydown.esc="activePromptWindowId = null"
                />
                <button
                  class="px-3 py-1.5 text-[10px] font-medium rounded-sm transition-colors whitespace-nowrap shrink-0"
                  style="background: var(--accent); color: #fff;"
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
            <div v-if="groupingWindowId !== w.windowId && classifyingWindowId !== w.windowId && hoveredActionWindowId === w.windowId && activeHoverAction !== null" class="absolute left-3.5 top-full mt-1.5 block w-[280px] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);">
              <template v-if="aiSettings.enabled && aiSettings.apiKey">
                <div class="font-semibold mb-1" style="color: var(--accent);">
                  {{ activeHoverAction === 'group' ? 'AI Grouping Preview' : 'AI Classification Preview' }}
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
                  {{ activeHoverAction === 'group' ? getGroupingPrompt() : getClassifyPrompt(w) }}
                </div>
                
                <div class="mt-2 pt-2 border-t flex flex-col gap-1.5" style="border-color: var(--border);">
                  <div class="flex items-center justify-between text-[10px]">
                    <span style="color: var(--text-secondary);">
                      Est. Requests: <span class="font-bold tabular-nums" style="color: var(--text-primary);">
                        {{ activeHoverAction === 'group' ? Math.ceil(unpinnedTabsCount(w) / (aiSettings.batchSize || getAutoBatchSize(aiSettings.maxTokens))) : Math.ceil(newTabsCount(w) / (aiSettings.batchSize || getAutoBatchSize(aiSettings.maxTokens))) }}
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
                  {{ activeHoverAction === 'group' ? 'Rule-based Grouping Preview' : 'Rule-based Classification Preview' }}
                </div>
                <div class="flex items-center gap-1.5 text-[9px] mb-2" style="color: var(--text-tertiary);">
                  <span>Mode: <span class="font-semibold" style="color: var(--text-secondary);">Local Rule Engine</span></span>
                  <span class="opacity-40">•</span>
                  <span>Privacy: <span class="font-semibold" style="color: var(--text-secondary);">100% Offline</span></span>
                </div>
                
                <div class="mb-1 text-[9px] uppercase font-bold tracking-wider mt-2" style="color: var(--text-tertiary);">Description</div>
                <div class="text-[10px] mb-2 leading-relaxed" style="color: var(--text-secondary);">
                  {{ activeHoverAction === 'group' 
                    ? 'Tabs will be organized instantly using high-performance local heuristics. Priority is given to matching exact domains, parent domains, and tab title keywords.' 
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
