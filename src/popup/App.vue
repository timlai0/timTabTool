<script setup lang="ts">
import { ref, onMounted, computed, watch, onUnmounted } from 'vue'
import { getMessage } from '../shared/i18n'
import { STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_GROUPING_PROMPT } from '../shared/constants'
import { SYSTEM_PROMPT } from '../shared/ai-client'
import { getAutoBatchSize } from '../shared/utils'
import type { ExtensionSettings, GroupIndicatorStyle, ThemeMode, WindowGroupsInfo } from '../shared/types'
import GroupList from './components/GroupList.vue'
import SettingsView from './components/SettingsView.vue'

const currentView = ref<'main' | 'settings'>('main')
const allWindows = ref<WindowGroupsInfo[]>([])
const loading = ref(true)
const groupingWindowId = ref<number | null>(null)
const classifyingWindowId = ref<number | null>(null)
const currentWindowId = ref<number | null>(null)
const indicatorStyle = ref<GroupIndicatorStyle>(DEFAULT_SETTINGS.groupIndicatorStyle)
const windowWidth = ref(DEFAULT_SETTINGS.windowWidth)
const windowHeight = ref(DEFAULT_SETTINGS.windowHeight)
const aiSettings = ref<ExtensionSettings['ai']>(DEFAULT_SETTINGS.ai)
const errorMessage = ref<string | null>(null)

function showError(msg: string) {
  errorMessage.value = msg
  setTimeout(() => {
    if (errorMessage.value === msg) {
      errorMessage.value = null
    }
  }, 10000)
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

const refreshPreviews = () => {
  loadAllPreviews()
}

onMounted(async () => {
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
  applyTheme(themeMode.value)
  mediaQuery.addEventListener('change', onSystemThemeChange)

  // Listen to Chrome events to dynamically update the popup in real-time
  chrome.tabs.onCreated.addListener(refreshPreviews)
  chrome.tabs.onRemoved.addListener(refreshPreviews)
  chrome.tabs.onUpdated.addListener(refreshPreviews)
  chrome.tabGroups.onCreated.addListener(refreshPreviews)
  chrome.tabGroups.onUpdated.addListener(refreshPreviews)
  chrome.tabGroups.onRemoved.addListener(refreshPreviews)

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  currentWindowId.value = activeTab?.windowId ?? null
  await loadAllPreviews()
})

onUnmounted(() => {
  mediaQuery.removeEventListener('change', onSystemThemeChange)
  stopPollingStatus()
  chrome.tabs.onCreated.removeListener(refreshPreviews)
  chrome.tabs.onRemoved.removeListener(refreshPreviews)
  chrome.tabs.onUpdated.removeListener(refreshPreviews)
  chrome.tabGroups.onCreated.removeListener(refreshPreviews)
  chrome.tabGroups.onUpdated.removeListener(refreshPreviews)
  chrome.tabGroups.onRemoved.removeListener(refreshPreviews)
})

const totalTabs = computed(() =>
  allWindows.value.reduce((sum, w) => sum + w.tabCount, 0),
)

const totalGroups = computed(() =>
  allWindows.value.reduce((sum, w) => sum + w.groups.length, 0),
)

const totalWindows = computed(() => allWindows.value.length)

function removeTrackingParams(urlString: string): string {
  try {
    const url = new URL(urlString)
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', '_gl', 'msclkid', 'mc_cid', 'mc_eid']
    for (const param of trackingParams) {
      url.searchParams.delete(param)
    }
    return url.toString()
  } catch {
    return urlString
  }
}

const exactDuplicatesCount = computed(() => {
  const urlSeen = new Set<string>()
  let count = 0
  for (const win of allWindows.value) {
    for (const group of win.groups) {
      for (const tab of group.tabs) {
        if (!tab.url) continue
        if (urlSeen.has(tab.url)) {
          count++
        } else {
          urlSeen.add(tab.url)
        }
      }
    }
  }
  return count
})

const possibleDuplicatesCount = computed(() => {
  const cleanUrlCounts = new Map<string, number>()
  const exactUrlSeen = new Set<string>()
  let exactDupes = 0
  let cleanDupes = 0
  
  for (const win of allWindows.value) {
    for (const group of win.groups) {
      for (const tab of group.tabs) {
        if (!tab.url) continue
        
        if (exactUrlSeen.has(tab.url)) {
          exactDupes++
        } else {
          exactUrlSeen.add(tab.url)
        }
        
        const cleanUrl = removeTrackingParams(tab.url)
        const current = cleanUrlCounts.get(cleanUrl) || 0
        if (current > 0) {
          cleanDupes++
        }
        cleanUrlCounts.set(cleanUrl, current + 1)
      }
    }
  }
  return cleanDupes - exactDupes
})

async function closeExactDuplicates() {
  const urlSeen = new Set<string>()
  const tabIdsToRemove: number[] = []
  
  for (const win of allWindows.value) {
    for (const group of win.groups) {
      for (const tab of group.tabs) {
        if (!tab.url || tab.id === undefined) continue
        if (urlSeen.has(tab.url)) {
          tabIdsToRemove.push(tab.id)
        } else {
          urlSeen.add(tab.url)
        }
      }
    }
  }
  
  if (tabIdsToRemove.length > 0) {
    await chrome.tabs.remove(tabIdsToRemove)
    await loadAllPreviews()
  }
}

async function organizePossibleDuplicates() {
  const cleanUrlToTabs = new Map<string, number[]>()
  
  for (const win of allWindows.value) {
    for (const group of win.groups) {
      for (const tab of group.tabs) {
        if (!tab.url || tab.id === undefined) continue
        const cleanUrl = removeTrackingParams(tab.url)
        const arr = cleanUrlToTabs.get(cleanUrl) || []
        arr.push(tab.id)
        cleanUrlToTabs.set(cleanUrl, arr)
      }
    }
  }
  
  const dupesGroups = Array.from(cleanUrlToTabs.values()).filter(arr => arr.length > 1)
  if (dupesGroups.length === 0) return
  
  const currentWinId = currentWindowId.value || (await chrome.windows.getCurrent()).id!
  let firstTabIdToOpen: number | null = null

  const allTabIdsToMove: number[] = []
  for (const group of dupesGroups) {
    if (!firstTabIdToOpen) firstTabIdToOpen = group[0]
    allTabIdsToMove.push(...group)
  }
  
  if (allTabIdsToMove.length > 0) {
    await chrome.tabs.move(allTabIdsToMove, { windowId: currentWinId, index: -1 })
  }
  
  if (firstTabIdToOpen) {
    await chrome.tabs.update(firstTabIdToOpen, { active: true })
    await chrome.windows.update(currentWinId, { focused: true })
  }
  
  await loadAllPreviews()
}

const isDarkActive = computed(() => document.documentElement.classList.contains('dark'))

async function loadAllPreviews() {
  loading.value = true
  try {
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

    // Query active operations and errors from the background
    const activeOps = await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OPERATIONS' })
    if (activeOps && typeof activeOps === 'object') {
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

      if (!isAnyGrouping) groupingWindowId.value = null
      if (!isAnyClassifying) classifyingWindowId.value = null

      if (isAnyGrouping || isAnyClassifying) {
        startPollingStatus()
      }
    }
  } catch (err) {
    console.error('Failed to load preview:', err)
  } finally {
    loading.value = false
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
  const isCurrent = w.windowId === currentWindowId.value
  const label = isCurrent ? getMessage('currentWindow') : `${getMessage('windowLabel')} ${idx + 1}`
  return `${label}`
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

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
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

const PROVIDER_DEFAULTS: Record<string, { input: number; output: number }> = {
  openai: { input: 0.15, output: 0.60 },
  claude: { input: 3.00, output: 15.00 },
  gemini: { input: 1.50, output: 9.00 },
  custom: { input: 0.15, output: 0.60 },
}

const activeModel = computed(() => {
  if (aiSettings.value.model) {
    return aiSettings.value.model
  }
  const defaults: Record<string, string> = {
    openai: 'gpt-4o-mini',
    claude: 'claude-sonnet-4-20250514',
    gemini: 'gemini-3.5-flash',
    custom: 'gpt-4o-mini',
  }
  return defaults[aiSettings.value.provider] || 'gpt-4o-mini'
})

function estimateCostAndTokens(w: WindowGroupsInfo, countType: 'group' | 'classify' | null = 'group') {
  const type = countType === 'classify' ? 'classify' : 'group'
  const tabs = type === 'group' ? unpinnedTabsCount(w) : newTabsCount(w)
  if (tabs === 0) {
    return { tokens: 0, costStr: 'Free', tokensPerRequest: 0 }
  }
  const batches = Math.ceil(tabs / (aiSettings.value.batchSize || getAutoBatchSize(aiSettings.value.maxTokens)))
  const promptLen = getSystemPrompt().length + (type === 'group' ? getGroupingPrompt().length : getClassifyPrompt(w).length)
  const promptTokens = Math.ceil(promptLen / 4)
  const inputTokens = batches * promptTokens + tabs * 20
  const outputTokens = batches * 50
  const totalTokens = inputTokens + outputTokens
  
  const provider = aiSettings.value.provider
  const model = activeModel.value
  
  let rates = MODEL_PRICING[model]
  if (!rates) {
    rates = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai
  }
  
  const cost = (inputTokens * rates.input + outputTokens * rates.output) / 1000000
  
  let costStr = ''
  if (cost === 0) costStr = 'Free'
  else if (cost < 0.0001) costStr = '< $0.0001'
  else costStr = `~$${cost.toFixed(4)}`
  
  return { tokens: totalTokens, costStr, tokensPerRequest: Math.round(totalTokens / batches) }
}

function newTabsCount(w: WindowGroupsInfo): number {
  const group = w.groups.find((g) => g.groupName === 'New Tabs')
  return group ? group.tabs.length : 0
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

async function handleGroup(windowId: number) {
  groupingWindowId.value = windowId
  startPollingStatus()
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GROUP_TABS', payload: { windowId } })
    if (res && typeof res === 'object' && 'error' in res) {
      showError(String(res.error))
    }
    await loadAllPreviews()
  } catch (err) {
    showError((err as Error).message)
  } finally {
    groupingWindowId.value = null
  }
}

async function handleUngroup(windowId: number) {
  await chrome.runtime.sendMessage({ action: 'UNGROUP_ALL', payload: { windowId } })
  await loadAllPreviews()
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
    console.error('[TabPilot] Failed to focus window:', err)
  }
}

const windowTitlesHidden = ref<Record<number, boolean>>({})

function isTitlesHidden(windowId: number): boolean {
  return windowTitlesHidden.value[windowId] ?? false
}

async function handleToggleGroupTitles(windowId: number) {
  const result = await chrome.runtime.sendMessage({ action: 'TOGGLE_GROUP_TITLES', payload: { windowId } })
  if (result?.hidden !== undefined) {
    windowTitlesHidden.value = { ...windowTitlesHidden.value, [windowId]: result.hidden }
  }
}

async function openSearchOverlay() {
  await chrome.runtime.sendMessage({ action: 'TOGGLE_SEARCH_OVERLAY' })
  window.close()
}

const activeHoverAction = ref<'group' | 'classify' | null>(null)
const hoveredActionWindowId = ref<number | null>(null)

function getClassifyPrompt(w: WindowGroupsInfo) {
  const existingGroupNames = w.groups.filter(g => g.groupName !== 'New Tabs').map(g => g.groupName)
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
  <SettingsView v-if="currentView === 'settings'" @back="handleSettingsBack" />

  <div v-else :style="{ width: Math.max(360, windowWidth) + 'px', height: Math.max(240, Math.min(600, windowHeight || 500)) + 'px', background: 'var(--bg-primary)' }" class="flex flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between px-4 py-3" style="box-shadow: 0 0.5px 0 var(--border);">
      <div class="flex items-center gap-2.5 flex-1 min-w-0 flex-wrap py-0.5">
        <img src="/icons/icon-32.png" alt="" class="w-5 h-5 shrink-0" />
        <h1 class="text-[15px] font-semibold tracking-tight shrink-0" style="color: var(--text-primary);">TabPilot</h1>
        <span class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-md shrink-0" style="color: var(--text-primary); background: var(--hover); border: 1px solid var(--border);">
          {{ totalTabs }} tabs · {{ totalGroups }} groups · {{ totalWindows }} windows
        </span>
        <span v-if="exactDuplicatesCount > 0 || possibleDuplicatesCount > 0" class="text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-md shrink-0 flex items-center gap-1" style="color: var(--text-primary); background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3);">
          <svg class="w-3 h-3" style="color: #ef4444;" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
          </svg>
          <button v-if="exactDuplicatesCount > 0" class="hover:underline focus:outline-none" @click="closeExactDuplicates" title="Close all exact duplicates">
            {{ exactDuplicatesCount }} exact dupes
          </button>
          <span v-if="exactDuplicatesCount > 0 && possibleDuplicatesCount > 0">·</span>
          <button v-if="possibleDuplicatesCount > 0" class="hover:underline focus:outline-none" @click="organizePossibleDuplicates" title="Group and view possible duplicates">
            {{ possibleDuplicatesCount }} possible dupes
          </button>
        </span>
      </div>
      <div class="flex items-center gap-0.5">
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
      <div class="flex-1 text-[10.5px] leading-normal" style="color: var(--text-primary); font-weight: 500;">
        {{ errorMessage }}
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
          <span
            class="text-[11px] font-semibold flex-1 truncate hover:underline"
            :style="{ color: w.windowId === currentWindowId ? 'var(--accent)' : 'var(--text-primary)' }"
            @click.stop="focusWindow(w.windowId)"
            title="Focus this window"
          >
            {{ windowLabel(w, idx) }}
          </span>
          <span class="text-[10px] tabular-nums" style="color: var(--text-tertiary);">{{ w.tabCount }} {{ getMessage('tabs') }}</span>
          <span v-if="w.hasGroups" class="w-1.5 h-1.5 rounded-full" style="background: var(--group-green);" :title="getMessage('grouped')" />
        </div>

        <!-- Collapsible content -->
        <template v-if="!isWindowSectionCollapsed(w.windowId)">
          <!-- Action buttons -->
          <div class="flex items-center px-3.5 pb-2 relative">
            <div class="flex items-center gap-1.5">
              <button
                class="px-3 py-[4px] text-[11px] font-medium rounded-btn flex items-center gap-1 transition-all group"
                :style="groupingWindowId === w.windowId
                  ? { background: 'var(--group-red)', color: '#fff' }
                  : { background: 'var(--accent)', color: '#fff' }"
                @click="groupingWindowId === w.windowId ? handleCancelGroup(w.windowId) : handleGroup(w.windowId)"
                @mouseenter="activeHoverAction = 'group'; hoveredActionWindowId = w.windowId"
                @mouseleave="activeHoverAction = null; hoveredActionWindowId = null"
              >
                <span v-if="groupingWindowId === w.windowId" class="inline-flex items-center gap-1">
                  <span class="animate-spin w-2.5 h-2.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
                  <span>Grouping with {{ activeModel }}...</span>
                </span>
                <span v-else>{{ getMessage('groupTabs') }}</span>
              </button>
              <button
                class="px-3 py-[4px] text-[11px] rounded-btn"
                style="color: var(--text-secondary); background: var(--hover);"
                @click="handleUngroup(w.windowId)"
              >
                {{ getMessage('ungroupAll') }}
              </button>
              <button
                v-if="newTabsCount(w) > 0"
                class="px-3 py-[4px] text-[11px] font-medium rounded-btn flex items-center gap-1 transition-all group"
                :style="classifyingWindowId === w.windowId
                  ? { background: 'var(--group-red)', color: '#fff' }
                  : { background: 'var(--accent-soft)', color: 'var(--accent)' }"
                @click="classifyingWindowId === w.windowId ? handleCancelClassify(w.windowId) : handleClassifyNew(w.windowId)"
                @mouseenter="activeHoverAction = 'classify'; hoveredActionWindowId = w.windowId"
                @mouseleave="activeHoverAction = null; hoveredActionWindowId = null"
              >
                <span v-if="classifyingWindowId === w.windowId" class="inline-flex items-center gap-1">
                  <span class="animate-spin w-2.5 h-2.5 border border-white/60 border-t-transparent rounded-full shrink-0" />
                  <span>Classifying with {{ activeModel }}...</span>
                </span>
                <span v-else>{{ getMessage('classifyNewTabs') }} ({{ newTabsCount(w) }})</span>
              </button>

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
            <div class="flex-1" />
            <!-- Toolbar icons -->
            <div v-if="w.hasGroups" class="flex items-center gap-0">
              <button
                class="w-6 h-6 flex items-center justify-center rounded-md"
                :style="{ color: isTitlesHidden(w.windowId) ? 'var(--accent)' : 'var(--text-tertiary)' }"
                :title="isTitlesHidden(w.windowId) ? getMessage('showGroupTitles') : getMessage('hideGroupTitles')"
                @click="handleToggleGroupTitles(w.windowId)"
              >
                <svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2.5 2a.5.5 0 00-.5.5v3.5a.5.5 0 00.146.354l5.5 5.5a.5.5 0 00.708 0l3.5-3.5a.5.5 0 000-.708l-5.5-5.5A.5.5 0 006 2H2.5zm1.5 2a1 1 0 110 2 1 1 0 010-2z" />
                </svg>
              </button>
              <button
                class="w-6 h-6 flex items-center justify-center rounded-md"
                style="color: var(--text-tertiary);"
                :title="isWindowCollapsed(w.windowId) ? getMessage('expandAll') : getMessage('collapseAll')"
                @click="handleToggleAllGroups(w.windowId)"
              >
                <svg v-if="isWindowCollapsed(w.windowId)" class="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 3.5l4 4 4-4" />
                  <path d="M4 8.5l4 4 4-4" />
                </svg>
                <svg v-else class="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 7l4-4 4 4" />
                  <path d="M4 12.5l4-4 4 4" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Groups for this window -->
          <div style="background: var(--bg-primary); border-top: 0.5px solid var(--border);">
            <GroupList
              :groups="w.groups"
              :indicator-style="indicatorStyle"
              :expand-trigger="expandTriggers[w.windowId] || 0"
              :collapse-trigger="collapseTriggers[w.windowId] || 0"
              @close-group="loadAllPreviews"
              @split-group="loadAllPreviews"
              @error="showError"
            />
          </div>
        </template>
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
