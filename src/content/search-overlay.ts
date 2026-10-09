'use strict';

import '../shared/polyfill'

import type { TabInfo } from '../shared/types'
import cssText from './search-overlay.css?inline'
import { AIClient } from '../shared/ai-client'
import { MODEL_PRICING, PROVIDER_DEFAULTS, MODEL_NAMES, DEFAULT_MODELS } from '../shared/constants'
import { getOptimalFaviconUrl, formatMarkdown } from '../shared/utils'

/**
 * Represents a command item in the search overlay.
 */
interface CommandItem {
  key: string
  title: string
  description: string
  action: string
  sendFullUrl?: boolean
}

/**
 * Represents a single search result.
 */
interface SearchResultItem {
  tab: {
    id?: number
    url: string
    title: string
    favIconUrl?: string
    lastAccessed?: number
    active?: boolean
    groupId?: number
  }
  score: number
  isOpen: boolean
  scoreDetails?: string
  isCommand?: boolean
  commandKey?: string
  commandAction?: string
  commandDescription?: string
  sendFullUrl?: boolean
  minTabs?: number
}

// Guard against multiple injections
if (!(window as unknown as Record<string, boolean>).__ATM_SEARCH_LOADED__) {
  ; (window as unknown as Record<string, boolean>).__ATM_SEARCH_LOADED__ = true

  let hostEl: HTMLDivElement | null = null
  let shadow: ShadowRoot | null = null
  let visible = false
  let selectedIndex = 0
  let results: SearchResultItem[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let ignoreMouseHover = false
  // Logik: Filter-Modus fuer Tabs ('open' | 'closed' | 'both')
  // Programming logic: Filter mode for tabs ('open' | 'closed' | 'both')
  let tabFilterMode: 'open' | 'closed' | 'both' = 'open'
  let showUngroupedOnly = false
  let sortMode: 'off' | 'title' | 'url' = 'off'

  let mouseX = 0
  let mouseY = 0
  let lastMouseX = -1
  let lastMouseY = -1
  let justOpened = false
  let overlayMetrics: {
    unpinnedTabsCount: number
    currentGroupTabsCount: number
    newTabsCount: number
    aiSettings: any
  } | null = null

  let domainChipsContainer: HTMLDivElement | null = null
  let progressContainer: HTMLDivElement | null = null
  let progressStatus: HTMLSpanElement | null = null
  let progressPercent: HTMLSpanElement | null = null
  let progressCloseBtn: HTMLButtonElement | null = null
  let progressStopApplyBtn: HTMLButtonElement | null = null
  let progressHideBtn: HTMLButtonElement | null = null
  let concurrentOpsBadge: HTMLSpanElement | null = null
  let progressFill: HTMLDivElement | null = null
  let progressDetail: HTMLDivElement | null = null
  let progressDetailText: HTMLSpanElement | null = null
  let progressThinkingPopover: HTMLDivElement | null = null
  let progressThinkingContainer: HTMLDivElement | null = null
  let progressThinkingChars: HTMLSpanElement | null = null
  let progressThinkingBody: HTMLDivElement | null = null
  let currentOverlayWindowId: number | null = null
  let concurrentBackgroundOpsCount = 0
  let aiActionTitle = ''
  let isAIOperating = false
  let isExternalAI = false
  let aiProgressInterval: ReturnType<typeof setInterval> | null = null
  let aiProgressTimeout: ReturnType<typeof setTimeout> | null = null

  let aiStartTime: number | null = null
  let aiBatchStartTime: number | null = null
  let lastTrackedBatch = 0
  let lastRecordedPercent = 5
  let smoothedRemainingSec: number | null = null
  let aiBatchCurrent = 0
  let aiBatchTotal = 0
  let aiStatusText = 'Processing...'
  let aiModel = ''
  let aiDiscoveredGroups: string[] = []
  let aiLiveReasoning = ''
  let aiReasoningSnippet = ''
  let aiRetryText = ''
  let aiProgressTicker: ReturnType<typeof setInterval> | null = null

  let overlayTimeoutSeconds = 270
  let overlayTimeoutInterval: ReturnType<typeof setInterval> | null = null

  /**
   * Formats remaining seconds into a human-readable ETA string (e.g. "~12s remaining", "~1m 15s remaining").
   * @param {number} totalSec - Total estimated remaining seconds.
   * @returns {string} Formatted ETA text.
   */
  function formatEtaSeconds(totalSec: number): string {
    if (totalSec <= 2) return 'almost done'
    if (totalSec < 60) return `~${totalSec}s remaining`
    const mins = Math.floor(totalSec / 60)
    const secs = totalSec % 60
    if (mins >= 60) {
      const hours = Math.floor(mins / 60)
      const remMins = mins % 60
      return `~${hours}h ${remMins}m remaining`
    }
    return secs > 0 ? `~${mins}m ${secs}s remaining` : `~${mins}m remaining`
  }

  /**
   * Starts tracking AI progress for ETA and percentage remaining estimations.
   * @param {string} [actionTitle] - Title of the action being executed.
   * @param {string} [initialStatus] - Initial status message to display.
   */
  function startAIProgressTracking(actionTitle = '', initialStatus = 'Processing...'): void {
    aiStartTime = Date.now()
    aiBatchStartTime = Date.now()
    lastTrackedBatch = 0
    lastRecordedPercent = 5
    smoothedRemainingSec = null
    aiBatchCurrent = 0
    aiBatchTotal = 0
    aiActionTitle = actionTitle
    aiStatusText = initialStatus
    aiModel = ''
    aiDiscoveredGroups = []
    aiLiveReasoning = ''
    aiReasoningSnippet = ''
    aiRetryText = ''

    if (progressThinkingContainer) {
      progressThinkingContainer.style.display = 'none'
    }

    if (aiProgressTicker) {
      clearInterval(aiProgressTicker)
      aiProgressTicker = null
    }

    updateAIProgressUI()

    aiProgressTicker = setInterval(() => {
      updateAIProgressUI()
    }, 1000)
  }

  /**
   * Stops AI progress tracking and clears internal timers.
   */
  function stopAIProgressTracking(): void {
    if (aiProgressTicker) {
      clearInterval(aiProgressTicker)
      aiProgressTicker = null
    }
    aiStartTime = null
    aiBatchStartTime = null
    lastTrackedBatch = 0
    lastRecordedPercent = 5
    smoothedRemainingSec = null
    aiBatchCurrent = 0
    aiBatchTotal = 0
    aiDiscoveredGroups = []
    aiLiveReasoning = ''
    aiReasoningSnippet = ''
    aiRetryText = ''
    aiModel = ''
    aiActionTitle = ''
    if (progressThinkingContainer) {
      progressThinkingContainer.style.display = 'none'
    }
  }

  function setProgressDetail(text: string, isError = false): void {
    if (progressDetailText) {
      progressDetailText.textContent = text
    } else if (progressDetail) {
      progressDetail.textContent = text
    }
    if (progressDetail) {
      progressDetail.style.color = isError ? 'var(--group-red, #FF3B30)' : ''
      if (isError || !isAIOperating) {
        progressDetail.classList.remove('has-thinking')
        progressDetail.title = ''
        if (progressThinkingPopover) progressThinkingPopover.innerHTML = ''
      }
    }
  }

  function calculateProgressPercent(elapsedSec: number): number {
    if (aiBatchTotal > 1) {
      if (aiBatchCurrent > aiBatchTotal) {
        aiStatusText = 'Applying groups to browser...'
        return 98
      }
      if (aiBatchCurrent > 0) {
        const batchBase = ((aiBatchCurrent - 1) / aiBatchTotal) * 90
        const batchSpan = (1 / aiBatchTotal) * 90
        const batchElapsed = aiBatchStartTime ? (Date.now() - aiBatchStartTime) / 1000 : elapsedSec
        const timeFactor = 1 - Math.exp(-batchElapsed / 30)
        const targetPercent = Math.round(batchBase + (timeFactor * batchSpan * 0.9))
        return Math.max(lastRecordedPercent, Math.min(95, Math.max(5, targetPercent)))
      }
      return 5
    }
    if (aiStatusText.includes('Applying groups')) return 98
    const target = Math.round(5 + (1 - Math.exp(-elapsedSec / 20)) * 85)
    return Math.max(lastRecordedPercent, Math.min(90, Math.max(5, target)))
  }

  function calculateEtaString(percent: number, elapsedSec: number): string {
    if (percent <= 5 || percent >= 100 || elapsedSec <= 1) return 'Calculating ETA...'
    let rawRemaining = 0
    if (aiBatchTotal > 1 && aiBatchCurrent > 1) {
      const completedBatches = aiBatchCurrent - 1
      const avgBatchSec = elapsedSec / completedBatches
      const batchElapsed = aiBatchStartTime ? (Date.now() - aiBatchStartTime) / 1000 : 0
      const remainingBatches = aiBatchTotal - completedBatches
      rawRemaining = Math.max(1, Math.round(remainingBatches * avgBatchSec - batchElapsed))
    } else {
      const estimatedTotalSec = elapsedSec / Math.max(0.05, percent / 100)
      rawRemaining = Math.max(1, Math.round(estimatedTotalSec - elapsedSec))
    }
    smoothedRemainingSec = smoothedRemainingSec === null ? rawRemaining : Math.round(smoothedRemainingSec * 0.85 + rawRemaining * 0.15)
    return formatEtaSeconds(smoothedRemainingSec)
  }

  function renderProgressDetailText(etaString: string): void {
    if (!progressDetail) return
    const parts: string[] = []
    if (aiRetryText) parts.push(aiRetryText)

    const cleanStatus = (aiStatusText || '').trim()
    const headerText = (progressStatus?.textContent || '').trim()
    const isRedundant = !cleanStatus ||
      cleanStatus === 'Executing AI Command...' ||
      cleanStatus === 'Processing...' ||
      cleanStatus === 'AI Command' ||
      cleanStatus === aiActionTitle ||
      cleanStatus === headerText ||
      headerText.startsWith(cleanStatus)

    if (!isRedundant) parts.push(cleanStatus)
    parts.push(`Est. time: ${etaString}`)

    if (aiDiscoveredGroups.length > 0) {
      const sample = aiDiscoveredGroups.slice(0, 3).join(', ')
      const extra = aiDiscoveredGroups.length > 3 ? ` (+${aiDiscoveredGroups.length - 3} more)` : ''
      parts.push(`Discovered: [${sample}${extra}]`)
    }

    const detail = parts.join(' • ')
    if (progressDetailText) {
      progressDetailText.textContent = detail
    } else {
      progressDetail.textContent = detail
    }
  }

  function renderThinkingStreamUI(): void {
    const rawThought = (aiLiveReasoning || aiReasoningSnippet || '').trim()
    if (!progressThinkingContainer || !progressThinkingBody || !progressThinkingChars) return

    if (rawThought) {
      progressThinkingContainer.style.display = 'flex'
      progressThinkingChars.textContent = `(${rawThought.length} chars)`
      progressThinkingBody.innerHTML = formatMarkdown(rawThought)
      progressThinkingBody.scrollTop = progressThinkingBody.scrollHeight
    } else {
      progressThinkingContainer.style.display = 'none'
    }
  }

  /**
   * Recalculates progress percentage, percentage remaining, and estimated time remaining,
   * then updates the overlay DOM elements synchronously.
   */
  function updateAIProgressUI(): void {
    if (!isAIOperating || !progressContainer) return

    if (aiBatchCurrent !== lastTrackedBatch) {
      lastTrackedBatch = aiBatchCurrent
      aiBatchStartTime = Date.now()
    }

    const elapsedSec = aiStartTime ? (Date.now() - aiStartTime) / 1000 : 0
    const percent = calculateProgressPercent(elapsedSec)
    lastRecordedPercent = percent
    const etaString = calculateEtaString(percent, elapsedSec)

    if (progressPercent) {
      progressPercent.textContent = `${percent}% (${Math.max(0, 100 - percent)}% remaining)`
    }
    if (progressFill) {
      progressFill.style.width = `${percent}%`
      progressFill.classList.remove('atm-indeterminate')
    }

    renderProgressDetailText(etaString)
    renderThinkingStreamUI()

    if (progressStopApplyBtn) {
      const canApplyPartial = isAIOperating && (aiBatchCurrent > 1 || aiDiscoveredGroups.length > 0)
      progressStopApplyBtn.style.display = canApplyPartial ? 'inline-flex' : 'none'
    }
  }

  /**
   * Formats a timeout value in seconds to MM:SS string.
   * @param {number} seconds - The timeout in seconds.
   * @returns {string} The formatted timeout.
   */
  function formatTimeout(seconds: number): string {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  /**
   * Extracts the domain from a given URL.
   * @param {string} url - The URL string.
   * @returns {string | null} The extracted domain or null.
   */
  function getDomain(url: string): string | null {
    // Logic: Parse URL and extract hostname without www prefix
    try {
      const obj = new URL(url)
      if (obj.protocol === 'http:' || obj.protocol === 'https:') {
        return obj.hostname.replace(/^www\./, '')
      }
    } catch (e) {
      // ignore
    }
    return null
  }









  const BASE_COMMANDS: CommandItem[] = [
    {
      key: '/group',
      title: 'AI Group Tabs',
      description: 'Organize all tabs in this window into smart groups using AI',
      action: 'GROUP_TABS'
    },
    {
      key: '/group single',
      title: 'AI Group Tabs (Single Request)',
      description: 'Group all tabs using AI in a single request (no batching)',
      action: 'GROUP_TABS_SINGLE'
    },
    {
      key: '/ungroup',
      title: 'Ungroup All Tabs',
      description: 'Ungroup all tabs in this window instantly',
      action: 'UNGROUP_ALL'
    },
    {
      key: '/cleanup-groups',
      title: 'Clean Up Tab Groups',
      description: 'Ungroup tab groups with less than 3 tabs',
      action: 'CLEANUP_GROUPS'
    },
    {
      key: '/split',
      title: 'Split Current Group',
      description: 'Split the current tab group into finer sub-groups using AI',
      action: 'SPLIT_CURRENT_GROUP'
    },
    {
      key: '/merge',
      title: 'Merge Current Group',
      description: 'Merge the current tab group into another group using AI',
      action: 'MERGE_CURRENT_GROUP'
    },
    {
      key: '/classify',
      title: 'Classify New Tabs',
      description: 'Classify ungrouped tabs into existing groups using AI',
      action: 'CLASSIFY_NEW_TABS'
    },
    {
      key: '/verify',
      title: 'Check & Regroup Tabs',
      description: 'Verify if the last 20 tabs are in correct groups and regroup them using AI',
      action: 'CHECK_LAST_20_TABS'
    },
    {
      key: '/regroup',
      title: 'Check & Regroup Tabs',
      description: 'Verify if the last 20 tabs are in correct groups and regroup them using AI',
      action: 'CHECK_LAST_20_TABS'
    },
    {
      key: '/expand',
      title: 'Expand All Groups',
      description: 'Expand all tab groups in this window',
      action: 'EXPAND_ALL_GROUPS'
    },
    {
      key: '/collapse',
      title: 'Collapse All Groups',
      description: 'Collapse all tab groups in this window',
      action: 'COLLAPSE_ALL_GROUPS'
    },
    {
      key: '/titles',
      title: 'Toggle Group Titles',
      description: 'Toggle group title visibility in the tab bar',
      action: 'TOGGLE_GROUP_TITLES'
    },
    {
      key: '/close-duplicates',
      title: 'Close Duplicate Tabs',
      description: 'Close all duplicate tabs in this window (retains first unique URL)',
      action: 'CLOSE_DUPLICATES'
    },
    {
      key: '/close-domain',
      title: 'Close Domain Tabs',
      description: 'Close all tabs in this window belonging to the current tab\'s domain',
      action: 'CLOSE_DOMAIN'
    },
    {
      key: '/isolate-domain',
      title: 'Isolate Domain Tabs',
      description: 'Move all tabs of the current tab\'s domain to a new browser window',
      action: 'ISOLATE_DOMAIN'
    },
    {
      key: '/sort-tabs',
      title: 'Sort Tabs',
      description: 'Sort all unpinned tabs in this window alphabetically by domain & title',
      action: 'SORT_TABS'
    },
    {
      key: '/merge-windows',
      title: 'Merge Windows',
      description: 'Merge all other browser windows into this focused window',
      action: 'MERGE_WINDOWS'
    },
    {
      key: '/mute-all',
      title: 'Mute All Tabs',
      description: 'Mute audio playback on all tabs in this window',
      action: 'MUTE_ALL'
    },
    {
      key: '/unmute-all',
      title: 'Unmute All Tabs',
      description: 'Unmute audio playback on all tabs in this window',
      action: 'UNMUTE_ALL'
    },
    {
      key: '/close-left',
      title: 'Close Tabs to Left',
      description: 'Close all unpinned tabs to the left of the current active tab',
      action: 'CLOSE_LEFT'
    },
    {
      key: '/close-right',
      title: 'Close Tabs to Right',
      description: 'Close all unpinned tabs to the right of the current active tab',
      action: 'CLOSE_RIGHT'
    },
    {
      key: '/model',
      title: 'Set Default Model',
      description: 'Set the default AI model for timTabTool groupings',
      action: 'CHANGE_MODEL'
    },
    {
      key: '/backup-groups',
      title: 'Backup Tab Groups',
      description: 'Save a backup of all current tab groups to a JSON file',
      action: 'BACKUP_GROUPS'
    }
  ]



  const COMMANDS: CommandItem[] = [...BASE_COMMANDS]

  const AI_ACTIONS = [
    { cmd: '/group', action: 'GROUP_TABS', name: 'AI Group Tabs', descPrefix: 'Group all tabs using' },
    { cmd: '/group -full', action: 'GROUP_TABS', name: 'AI Group Tabs (Full URL)', descPrefix: 'Group all tabs with full URLs using', sendFullUrl: true },
    { cmd: '/classify', action: 'CLASSIFY_NEW_TABS', name: 'Classify New Tabs', descPrefix: 'Classify ungrouped tabs using' },
    { cmd: '/classify -full', action: 'CLASSIFY_NEW_TABS', name: 'Classify New Tabs (Full URL)', descPrefix: 'Classify ungrouped tabs with full URLs using', sendFullUrl: true },
    { cmd: '/split', action: 'SPLIT_CURRENT_GROUP', name: 'Split Current Group', descPrefix: 'Split current group using' },
    { cmd: '/split -full', action: 'SPLIT_CURRENT_GROUP', name: 'Split Current Group (Full URL)', descPrefix: 'Split current group with full URLs using', sendFullUrl: true },
    { cmd: '/merge', action: 'MERGE_CURRENT_GROUP', name: 'Merge Current Group', descPrefix: 'Merge current group using' },
    { cmd: '/merge -full', action: 'MERGE_CURRENT_GROUP', name: 'Merge Current Group (Full URL)', descPrefix: 'Merge current group with full URLs using', sendFullUrl: true },
    { cmd: '/verify', action: 'CHECK_LAST_20_TABS', name: 'Check & Regroup Tabs', descPrefix: 'Check and regroup last 20 tabs using' },
    { cmd: '/verify -full', action: 'CHECK_LAST_20_TABS', name: 'Check & Regroup Tabs (Full URL)', descPrefix: 'Check and regroup last 20 tabs with full URLs using', sendFullUrl: true },
    { cmd: '/regroup', action: 'CHECK_LAST_20_TABS', name: 'Check & Regroup Tabs', descPrefix: 'Check and regroup last 20 tabs using' },
    { cmd: '/regroup -full', action: 'CHECK_LAST_20_TABS', name: 'Check & Regroup Tabs (Full URL)', descPrefix: 'Check and regroup last 20 tabs with full URLs using', sendFullUrl: true },
  ]

  for (const { cmd, action, name, descPrefix, sendFullUrl } of AI_ACTIONS) {
    // Add base command without model
    COMMANDS.push({
      key: cmd,
      title: name,
      description: descPrefix + ' default model',
      action: action,
      ...(sendFullUrl ? { sendFullUrl: true } : {})
    })

    for (const modelId of Object.keys(MODEL_PRICING)) {
      const displayName = MODEL_NAMES[modelId] || modelId
      COMMANDS.push({
        key: `${cmd} ${modelId}`,
        title: `${name} (${displayName})`,
        description: `${descPrefix} ${displayName}`,
        action: action,
        ...(sendFullUrl ? { sendFullUrl: true } : {})
      })
    }
  }

  for (const modelId of Object.keys(MODEL_PRICING)) {
    const displayName = MODEL_NAMES[modelId] || modelId
    COMMANDS.push({
      key: `/model ${modelId}`,
      title: `Set Default Model (${displayName})`,
      description: `Change the default model in Settings to ${displayName}`,
      action: 'CHANGE_MODEL'
    })
  }

  for (const x of [2, 3, 4, 5]) {
    COMMANDS.push({
      key: `/cleanup-groups ${x}`,
      title: `Clean Up Tab Groups (< ${x} tabs)`,
      description: `Ungroup tab groups with less than ${x} tabs`,
      action: 'CLEANUP_GROUPS'
    })
  }

  let mouseMoveRaf = 0
  window.addEventListener('mousemove', (e) => {
    if (!visible) return
    mouseX = e.clientX
    mouseY = e.clientY

    if (mouseX === lastMouseX && mouseY === lastMouseY) return
    lastMouseX = mouseX
    lastMouseY = mouseY
    ignoreMouseHover = false

    if (mouseMoveRaf) return
    mouseMoveRaf = requestAnimationFrame(() => {
      mouseMoveRaf = 0
      if (!visible || !shadow) return
      const hoveredEl = shadow.elementFromPoint(mouseX, mouseY)?.closest('.atm-result-item')
      if (hoveredEl) {
        const resultsList = shadow.querySelector('.atm-results') as HTMLDivElement
        if (resultsList) {
          const items = Array.from(resultsList.querySelectorAll('.atm-result-item'))
          const index = items.indexOf(hoveredEl)
          if (index !== -1 && index !== selectedIndex) {
            selectedIndex = index
            updateSelection(resultsList)
          }
        }
      }
    })
  }, { passive: true })

  /**
   * Returns the active model for AI processing.
   * @param {any} aiSettings - AI settings configuration.
   * @returns {string} The active model identifier.
   */
  function getActiveModel(aiSettings: any) {
    if (aiSettings.model) return aiSettings.model
    return DEFAULT_MODELS[aiSettings.provider] || 'gpt-4o-mini'
  }

  /**
   * Estimates AI cost for a given operation.
   * @param {any} aiSettings - AI settings configuration.
   * @param {number} tabs - Number of tabs involved.
   * @param {'group' | 'split' | 'merge' | 'classify'} type - Type of operation.
   * @param {string} [modelOverride] - Optional model identifier override.
   * @param {string} [providerOverride] - Optional provider override.
   * @returns {{ tokens: number, costStr: string, requests: number }} The estimation data.
   */
  function estimateAICost(
    aiSettings: any,
    tabs: number,
    type: 'group' | 'split' | 'merge' | 'classify',
    modelOverride?: string,
    providerOverride?: string
  ) {
    // If not enabled, return empty
    if (!aiSettings || tabs === 0) {
      return { tokens: 0, costStr: 'Free', requests: 0 }
    }

    const est = AIClient.estimateCostAndTokens(
      aiSettings,
      tabs,
      type,
      modelOverride,
      providerOverride
    )

    return {
      tokens: est.tokens,
      costStr: est.costStr,
      requests: est.requests
    }
  }

  function updateConcurrentOpsFromMap(ops?: Record<number, any>): void {
    if (!ops || typeof ops !== 'object') return
    let count = 0
    for (const [widStr, status] of Object.entries(ops)) {
      const wid = Number(widStr)
      if (status && status.type && (currentOverlayWindowId === null || wid !== currentOverlayWindowId)) {
        count++
      }
    }
    concurrentBackgroundOpsCount = count
    if (concurrentOpsBadge) {
      if (count > 0) {
        concurrentOpsBadge.style.display = 'inline-flex'
        concurrentOpsBadge.textContent = `⚡ ${count} bg AI op${count > 1 ? 's' : ''}`
        concurrentOpsBadge.title = `${count} background AI operation${count > 1 ? 's' : ''} running in other windows`
      } else {
        concurrentOpsBadge.style.display = 'none'
      }
    }
  }

  function applyProgressStatusUpdate(status: any): void {
    if (!status) return
    aiBatchCurrent = status.batchCurrent || 0
    aiBatchTotal = status.batchTotal || 0
    if (status.statusText) aiStatusText = status.statusText
    if (status.model) {
      aiModel = status.model
      const currentDisp = MODEL_NAMES[status.model] || status.model
      if (progressStatus && !progressStatus.textContent?.includes(currentDisp)) {
        const baseTitle = aiActionTitle || 'AI Command'
        progressStatus.textContent = baseTitle.includes(currentDisp) ? baseTitle : `${baseTitle} (${currentDisp})`
      }
    }
    if (Array.isArray(status.discoveredGroupNames)) aiDiscoveredGroups = status.discoveredGroupNames
    if (status.liveReasoning) aiLiveReasoning = status.liveReasoning
    if (status.reasoningSnippet) aiReasoningSnippet = status.reasoningSnippet
    aiRetryText = status.retry
      ? `Rate limit / retry in ${(status.retry.delayMs / 1000).toFixed(0)}s (Attempt ${status.retry.attempt}/${status.retry.maxRetries})`
      : ''
    if (status.batchTotal && status.batchTotal > 1) {
      const current = status.batchCurrent || 1
      aiStatusText = current > status.batchTotal
        ? 'Applying groups to browser...'
        : `${status.statusText || 'Processing...'} (Batch ${current} of ${status.batchTotal})`
    }
    updateAIProgressUI()
  }

  async function loadMetrics() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'GET_SEARCH_OVERLAY_METRICS' })
      if (res && typeof res === 'object') {
        overlayMetrics = res
        if (typeof res.windowId === 'number') currentOverlayWindowId = res.windowId
        if (res.activeOperations) updateConcurrentOpsFromMap(res.activeOperations)

        if (res.activeOperation && res.activeOperation.type && !isAIOperating) {
          isExternalAI = true
          const titleMap: Record<string, string> = {
            'group': 'AI Group Tabs',
            'classify': 'Classify New Tabs',
            'regroup': 'Check & Regroup Tabs',
            'split': 'Split Current Group',
            'merge': 'Merge Current Group',
            'sort': 'Sort Tabs'
          }
          const actionMap: Record<string, string> = {
            'group': 'GROUP_TABS',
            'classify': 'CLASSIFY_NEW_TABS',
            'regroup': 'CHECK_LAST_20_TABS',
            'split': 'SPLIT_CURRENT_GROUP',
            'merge': 'MERGE_CURRENT_GROUP',
            'sort': 'SORT_TABS'
          }
          const commandAction = actionMap[res.activeOperation.type] || 'GROUP_TABS'
          runAICommand({
            tab: { title: titleMap[res.activeOperation.type] || 'AI Command', url: 'Executing from Background...' },
            score: 0,
            isOpen: false,
            isCommand: true,
            commandAction
          })
          applyProgressStatusUpdate(res.activeOperation)
        }
      }
    } catch (err) {
      console.error('[timTabTool] Failed to load overlay metrics:', err)
    }
  }

  function renderDetailsPanel(result: SearchResultItem | undefined) {
    if (!shadow) return
    const detailsPanel = shadow.querySelector('.atm-details-panel') as HTMLDivElement
    if (!detailsPanel) return

    if (!result || !result.isCommand || !result.commandAction) {
      detailsPanel.style.display = 'none'
      return
    }

    const action = result.commandAction
    const isLocal = ['UNGROUP_ALL', 'EXPAND_ALL_GROUPS', 'COLLAPSE_ALL_GROUPS', 'TOGGLE_GROUP_TITLES', 'CLEANUP_GROUPS', 'BACKUP_GROUPS'].includes(action)

    if (isLocal) {
      let desc = ''
      if (action === 'UNGROUP_ALL') desc = 'Ungroup all tabs in this window instantly, leaving all tabs active in a single flat list.'
      else if (action === 'EXPAND_ALL_GROUPS') desc = 'Expand all collapsed Chrome tab groups in this window.'
      else if (action === 'COLLAPSE_ALL_GROUPS') desc = 'Collapse all active Chrome tab groups in this window to clear up space.'
      else if (action === 'TOGGLE_GROUP_TITLES') desc = 'Toggle group title visibility. When hidden, groups collapse to tiny color-coded dots, saving maximum tab bar horizontal space.'
      else if (action === 'BACKUP_GROUPS') desc = 'Download a JSON backup containing all of your current tab groups and their tabs.'
      else if (action === 'CLEANUP_GROUPS') {
        const threshold = result.minTabs ?? 3
        desc = `Ungroup any tab group containing less than ${threshold} tabs, leaving larger groups intact.`
      }

      setHTMLContent(detailsPanel, `
        <div class="atm-details-title">${escapeHtml(result.tab.title)}</div>
        <div class="atm-details-meta">
          <span>Mode: <span style="font-weight:600;color:var(--text-secondary,#86868B);">Local Heuristics</span></span>
          <span style="opacity:0.4;">•</span>
          <span>Privacy: <span style="font-weight:600;color:var(--text-secondary,#86868B);">100% Offline</span></span>
        </div>
        <div class="atm-details-section-title">Description</div>
        <div class="atm-details-section-body">${escapeHtml(desc)}</div>
        <div class="atm-details-est">
          <div class="atm-details-est-row">
            <span class="atm-details-est-label">Est. Requests:</span>
            <span style="font-weight:600;">0 (No API calls)</span>
          </div>
          <div class="atm-details-est-row">
            <span class="atm-details-est-label">Cost:</span>
            <span style="font-weight:700;color:var(--group-green, #34C759);">Free</span>
          </div>
        </div>
      `)
      detailsPanel.style.display = 'flex'
      return
    }

    if (!overlayMetrics || !overlayMetrics.aiSettings) {
      setHTMLContent(detailsPanel, `
        <div class="atm-details-title">${escapeHtml(result.tab.title)}</div>
        <div class="atm-details-meta">
          <span>Loading AI Configuration...</span>
        </div>
      `)
      detailsPanel.style.display = 'flex'
      loadMetrics().then(() => {
        if (visible && selectedIndex !== -1 && results[selectedIndex] === result) {
          renderDetailsPanel(result)
        }
      })
      return
    }

    const aiSettings = { ...overlayMetrics.aiSettings }
    if (result.sendFullUrl) {
      aiSettings.sendFullUrl = true
    }

    if (!aiSettings.enabled || !aiSettings.apiKey) {
      setHTMLContent(detailsPanel, `
        <div class="atm-details-title">${escapeHtml(result.tab.title)}</div>
        <div class="atm-details-meta">
          <span style="color:var(--group-red, #FF3B30);font-weight:600;">AI not configured</span>
        </div>
        <div class="atm-details-section-title">Instructions</div>
        <div class="atm-details-section-body">AI is currently disabled or missing an API Key. Please enable AI and configure your connection credentials in timTabTool Settings first.</div>
      `)
      detailsPanel.style.display = 'flex'
      return
    }

    let model = getActiveModel(aiSettings)
    let provider = aiSettings.provider

    if (result.commandKey && result.commandKey.includes(' ')) {
      const parts = result.commandKey.split(' ')
      const possibleModel = parts[1]
      if (possibleModel && (MODEL_PRICING as any)[possibleModel] !== undefined) {
        model = possibleModel
        if (model.includes('/')) {
          provider = 'openrouter'
        } else if (model.startsWith('gemini') || model.startsWith('gemma')) {
          provider = 'gemini'
        } else if (model.startsWith('gpt')) {
          provider = 'openai'
        } else if (model.startsWith('claude')) {
          provider = 'claude'
        }
      }
    } else {
      if (action.includes('GEMINI_FLASH') || action.includes('_GEMINI')) {
        model = 'gemini-3.5-flash'
        provider = 'gemini'
      } else if (action.includes('GEMINI_2_5_FLASH')) {
        model = 'gemini-2.5-flash'
        provider = 'gemini'
      } else if (action.includes('GPT_MINI') || action.includes('_GPT')) {
        model = 'gpt-4o-mini'
        provider = 'openai'
      } else if (action.includes('GPT_4O')) {
        model = 'gpt-4o'
        provider = 'openai'
      } else if (action.includes('CLAUDE_SONNET')) {
        model = 'claude-3-5-sonnet-20240620'
        provider = 'claude'
      }
    }

    const isGroup = action === 'GROUP_TABS' || action.startsWith('GROUP_TABS_')
    const isClassify = action === 'CLASSIFY_NEW_TABS' || action.startsWith('CLASSIFY_NEW_TABS_')

    let systemPrompt = aiSettings.customPrompt?.trim()
      ? `You are a helpful assistant that classifies browser tabs into categories. Be concise.\n\nUser Instructions:\n${aiSettings.customPrompt.trim()}`
      : 'You are a helpful assistant that classifies browser tabs into categories. Be concise.'

    let userPrompt = ''
    let titleStr = ''
    let tabCount = 0

    if (isGroup) {
      titleStr = 'AI Grouping Preview'
      userPrompt = aiSettings.groupingPrompt || 'Organize these browser tabs into semantic, highly-related groups.'
      tabCount = overlayMetrics.unpinnedTabsCount
    } else if (action === 'SPLIT_CURRENT_GROUP') {
      titleStr = 'AI Split Group Preview'
      userPrompt = aiSettings.splitPrompt || 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.'
      tabCount = overlayMetrics.currentGroupTabsCount
    } else if (action === 'MERGE_CURRENT_GROUP') {
      titleStr = 'AI Merge Group Preview'
      userPrompt = aiSettings.mergePrompt || 'Analyze the browser tabs of this group and decide if they should be merged into one of the other existing tab groups. Choose the best fitting existing group from the list. If none of the existing groups are a good fit and this group should remain separate, respond with "KEEP". Be conservative about merging; only merge if the topics are highly related.'
      tabCount = overlayMetrics.currentGroupTabsCount
    } else if (isClassify) {
      titleStr = 'AI Classification Preview'
      userPrompt = aiSettings.classifyPrompt || 'You are classifying new tabs. Decide if each new tab belongs to one of the existing groups or if a new group should be created. Be conservative about creating new groups.'
      tabCount = overlayMetrics.newTabsCount
    }

    const typeStr = isGroup ? 'group' : (action === 'SPLIT_CURRENT_GROUP' ? 'split' : (action === 'MERGE_CURRENT_GROUP' ? 'merge' : 'classify'))
    const est = estimateAICost(aiSettings, tabCount, typeStr, model, provider)

    setHTMLContent(detailsPanel, `
      <div class="atm-details-title">${escapeHtml(titleStr)}</div>
      <div class="atm-details-meta">
        <span>Model: <span class="atm-details-model-name">${escapeHtml(MODEL_NAMES[model] || model)}</span></span>
        <span style="opacity:0.4;">·</span>
        <span>Privacy: AI Analysis</span>
      </div>
      
      <div class="atm-details-section-title">SYSTEM PROMPT</div>
      <div class="atm-details-section-body">${escapeHtml(systemPrompt)}</div>
      
      <div class="atm-details-section-title">USER PROMPT</div>
      <div class="atm-details-section-body">${escapeHtml(userPrompt)}</div>
      
      <div class="atm-details-est">
        <div class="atm-details-est-row">
          <span class="atm-details-est-label">Tabs to Process:</span>
          <span style="font-weight:600;">${tabCount} tabs</span>
        </div>
        <div class="atm-details-est-row">
          <span class="atm-details-est-label">Est. Requests:</span>
          <span style="font-weight:600;">${est.requests} request${est.requests > 1 ? 's' : ''}</span>
        </div>
        <div class="atm-details-est-row">
          <span class="atm-details-est-label">Total Tokens:</span>
          <span style="font-weight:600;">~${est.tokens} tokens</span>
        </div>
        <div class="atm-details-est-row" style="margin-top:12px;">
          <span class="atm-details-est-label">Est. Cost:</span>
          <span style="font-weight:700;color:var(--accent, #007AFF);">${escapeHtml(est.costStr)}</span>
        </div>
      </div>
    `)
    detailsPanel.style.display = 'flex'
  }

  function updateAutocomplete() {
    if (!shadow) return
    const ghost = shadow.querySelector('.atm-autocomplete-ghost') as HTMLDivElement
    if (!ghost) return

    const input = shadow.querySelector('.atm-input') as HTMLInputElement
    if (!input) return

    const query = input.value
    if (!query.startsWith('/') || results.length === 0) {
      ghost.textContent = ''
      return
    }

    const selectedIdx = selectedIndex === -1 ? 0 : selectedIndex
    const selected = results[selectedIdx]
    if (!selected || !selected.isCommand || !selected.commandKey) {
      ghost.textContent = ''
      return
    }

    const key = selected.commandKey
    if (key.toLowerCase().startsWith(query.toLowerCase())) {
      const matchText = query
      const suggestionTail = key.slice(query.length)

      const isDark = hostEl?.getAttribute('data-theme') === 'dark' ||
        (!hostEl?.hasAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)

      const ghostColor = isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)'
      ghost.style.color = ghostColor

      ghost.replaceChildren()
      const matchSpan = document.createElement('span')
      matchSpan.style.color = 'transparent'
      matchSpan.textContent = matchText
      const tailSpan = document.createElement('span')
      tailSpan.style.opacity = '0.95'
      tailSpan.textContent = suggestionTail
      ghost.appendChild(matchSpan)
      ghost.appendChild(tailSpan)
    } else {
      ghost.textContent = ''
    }
  }

  function init() {
    if (hostEl) return

    hostEl = document.createElement('div')
    hostEl.id = 'atm-search-host'
    hostEl.style.display = 'none'
    const isStandalone = Boolean(window.location?.protocol?.includes('-extension:') && window.location?.pathname?.includes('search.html'))
    if (isStandalone) {
      // Logic: Set standalone attribute and styles for styling adjustments
      // Programming logic: Set standalone attribute and styles for layout adjustments
      hostEl.setAttribute('data-standalone', 'true')
      hostEl.style.position = 'absolute'
      hostEl.style.left = '0'
      hostEl.style.top = '0'
      hostEl.style.width = '100%'
      hostEl.style.height = '100%'
    }
    shadow = hostEl.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = cssText
    shadow.appendChild(style)

    const backdrop = document.createElement('div')
    backdrop.className = isStandalone ? 'atm-backdrop standalone' : 'atm-backdrop'
    backdrop.addEventListener('click', hide)

    const container = document.createElement('div')
    container.className = isStandalone ? 'atm-container standalone' : 'atm-container'
    container.addEventListener('click', (e) => e.stopPropagation())

    const inputWrap = document.createElement('div')
    inputWrap.className = 'atm-input-wrap'

    const searchIcon = document.createElement('div')
    searchIcon.className = 'atm-search-icon'
    setSvgContent(searchIcon, '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" /></svg>')

    const inputContainer = document.createElement('div')
    inputContainer.className = 'atm-input-container'
    inputContainer.style.position = 'relative'
    inputContainer.style.flex = '1'
    inputContainer.style.display = 'flex'
    inputContainer.style.alignItems = 'center'

    const ghost = document.createElement('div')
    ghost.className = 'atm-autocomplete-ghost'
    ghost.style.position = 'absolute'
    ghost.style.left = '0'
    ghost.style.top = '0'
    ghost.style.pointerEvents = 'none'
    ghost.style.fontSize = '16px'
    ghost.style.fontFamily = 'inherit'
    ghost.style.lineHeight = 'normal'
    ghost.style.display = 'flex'
    ghost.style.alignItems = 'center'
    ghost.style.height = '100%'
    ghost.style.whiteSpace = 'pre'
    ghost.style.color = 'rgba(0, 0, 0, 0.3)'

    const input = document.createElement('input')
    input.className = 'atm-input'
    input.type = 'text'
    input.placeholder = 'Search tabs...'
    input.autofocus = true
    input.style.background = 'transparent'
    input.style.position = 'relative'
    input.style.zIndex = '1'
    input.style.width = '100%'
    input.addEventListener('input', () => {
      ignoreMouseHover = true
      clearTimeout(debounceTimer)
      const query = input.value
      updateAutocomplete()
      if (!query.trim()) {
        doSearch('', resultsList)
        return
      }
      if (query.trimStart().startsWith('/')) {
        doSearch(query, resultsList)
      } else {
        debounceTimer = setTimeout(() => {
          doSearch(query, resultsList)
        }, 150)
      }
    })
    input.addEventListener('keydown', (e) => {
      ignoreMouseHover = true
      handleKeydown(e, input, resultsList)
    })

    const shortcut = document.createElement('span')
    shortcut.className = 'atm-shortcut'
    shortcut.textContent = 'ESC'

    inputContainer.appendChild(ghost)
    inputContainer.appendChild(input)

    inputWrap.appendChild(searchIcon)
    inputWrap.appendChild(inputContainer)
    inputWrap.appendChild(shortcut)

    // ─── Integrated Progress Bar DOM ───
    progressContainer = document.createElement('div')
    progressContainer.className = 'atm-progress-container'
    progressContainer.style.display = 'none'

    const progressHeader = document.createElement('div')
    progressHeader.className = 'atm-progress-header'

    progressStatus = document.createElement('span')
    progressStatus.className = 'atm-progress-status'
    progressStatus.textContent = 'Preparing AI Command...'

    const progressHeaderRight = document.createElement('div')
    progressHeaderRight.style.display = 'flex'
    progressHeaderRight.style.alignItems = 'center'
    progressHeaderRight.style.gap = '8px'

    progressPercent = document.createElement('span')
    progressPercent.className = 'atm-progress-percent'
    progressPercent.textContent = '0%'

    progressCloseBtn = document.createElement('button')
    progressCloseBtn.className = 'atm-progress-close-btn'
    progressCloseBtn.style.display = 'none'
    progressCloseBtn.textContent = 'Dismiss'
    progressCloseBtn.addEventListener('click', async () => {
      if (isAIOperating) {
        try {
          await chrome.runtime.sendMessage({ action: 'CANCEL_OPERATION' })
        } catch (err) {
          console.error('[timTabTool] Failed to send CANCEL_OPERATION:', err)
        }
      }
      resetAIProgressState()
    })

    progressStopApplyBtn = document.createElement('button')
    progressStopApplyBtn.className = 'atm-progress-stop-apply-btn'
    progressStopApplyBtn.style.display = 'none'
    progressStopApplyBtn.textContent = 'Stop & Apply'
    progressStopApplyBtn.title = 'Stop further AI querying and apply completed batches'
    progressStopApplyBtn.addEventListener('click', async () => {
      if (isAIOperating) {
        try {
          await chrome.runtime.sendMessage({ action: 'CANCEL_OPERATION', payload: { applyCompleted: true } })
        } catch (err) {
          console.error('[timTabTool] Failed to send STOP_AND_APPLY:', err)
        }
      }
      resetAIProgressState()
    })

    progressHideBtn = document.createElement('button')
    progressHideBtn.className = 'atm-progress-hide-btn'
    progressHideBtn.style.display = 'none'
    progressHideBtn.textContent = 'Hide'
    progressHideBtn.addEventListener('click', () => {
      visible = false
      if (hostEl) hostEl.style.display = 'none'
    })

    progressHeaderRight.appendChild(progressHideBtn)
    progressHeaderRight.appendChild(progressPercent)
    progressHeaderRight.appendChild(progressStopApplyBtn)
    progressHeaderRight.appendChild(progressCloseBtn)

    progressHeader.appendChild(progressStatus)
    progressHeader.appendChild(progressHeaderRight)

    const progressBarBg = document.createElement('div')
    progressBarBg.className = 'atm-progress-bar-bg'

    progressFill = document.createElement('div')
    progressFill.className = 'atm-progress-bar-fill'
    progressBarBg.appendChild(progressFill)

    progressDetail = document.createElement('div')
    progressDetail.className = 'atm-progress-detail'

    progressDetailText = document.createElement('span')
    progressDetailText.className = 'atm-progress-detail-text'
    progressDetailText.textContent = 'Ready'
    progressDetail.appendChild(progressDetailText)

    progressThinkingContainer = document.createElement('div')
    progressThinkingContainer.className = 'atm-progress-thinking'

    const thinkingHeader = document.createElement('div')
    thinkingHeader.className = 'atm-progress-thinking-header'

    const thinkingLabel = document.createElement('div')
    thinkingLabel.className = 'atm-progress-thinking-label'

    const thinkingDot = document.createElement('span')
    thinkingDot.className = 'atm-progress-thinking-dot'

    const thinkingTitle = document.createElement('span')
    thinkingTitle.textContent = 'Live Model Thinking'

    thinkingLabel.appendChild(thinkingDot)
    thinkingLabel.appendChild(thinkingTitle)

    progressThinkingChars = document.createElement('span')
    progressThinkingChars.className = 'atm-progress-thinking-chars'
    progressThinkingChars.textContent = '(0 chars)'

    thinkingHeader.appendChild(thinkingLabel)
    thinkingHeader.appendChild(progressThinkingChars)

    progressThinkingBody = document.createElement('div')
    progressThinkingBody.className = 'atm-progress-thinking-body'

    progressThinkingContainer.appendChild(thinkingHeader)
    progressThinkingContainer.appendChild(progressThinkingBody)

    domainChipsContainer = document.createElement('div')
    domainChipsContainer.className = 'atm-domain-chips'

    progressContainer.appendChild(progressHeader)
    progressContainer.appendChild(progressBarBg)
    progressContainer.appendChild(progressDetail)
    progressContainer.appendChild(progressThinkingContainer)

    const resultsList = document.createElement('div')
    resultsList.className = 'atm-results'

    const footer = document.createElement('div')
    footer.className = 'atm-footer'

    const keybindsSpan = document.createElement('span')
    setHTMLContent(keybindsSpan, '<kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close')

    const rightControls = document.createElement('div')
    rightControls.className = 'atm-footer-right'
    rightControls.style.display = 'flex'
    rightControls.style.alignItems = 'center'
    rightControls.style.gap = '12px'

    const groupResultsBtn = document.createElement('button')
    groupResultsBtn.className = 'atm-footer-btn'
    groupResultsBtn.textContent = 'Group results'
    groupResultsBtn.title = 'Group the current search results (Shift+Click to set custom name)'
    groupResultsBtn.addEventListener('click', (e: MouseEvent) => {
      const tabIds = results
        .filter(r => !r.isCommand && r.tab && typeof r.tab.id === 'number')
        .map(r => r.tab.id as number)
      
      if (tabIds.length > 0) {
        let title = input.value.trim() || 'Search Results'
        if (e.shiftKey) {
          const customName = window.prompt('Enter custom group name:', title)
          if (customName === null) return // User cancelled
          title = customName.trim() || 'Search Results'
        }
        chrome.runtime.sendMessage({
          action: 'GROUP_CLUSTER',
          payload: { tabIds, title }
        })
      }
    })

    const sortToggleBtn = document.createElement('button')
    sortToggleBtn.className = 'atm-footer-btn'
    sortToggleBtn.textContent = 'Sort: Off'
    sortToggleBtn.title = 'Change sorting (Off, Title, URL)'
    sortToggleBtn.addEventListener('click', () => {
      if (sortMode === 'off') {
        sortMode = 'title'
        sortToggleBtn.textContent = 'Sort: Title'
      } else if (sortMode === 'title') {
        sortMode = 'url'
        sortToggleBtn.textContent = 'Sort: URL'
      } else {
        sortMode = 'off'
        sortToggleBtn.textContent = 'Sort: Off'
      }
      doSearch(input.value, resultsList)
    })

    const closedTabsToggleBtn = document.createElement('button')
    closedTabsToggleBtn.className = 'atm-footer-btn'
    closedTabsToggleBtn.textContent = 'Show: only open'
    closedTabsToggleBtn.title = 'Filter tabs: only open -> only closed -> both'
    closedTabsToggleBtn.addEventListener('click', () => {
      // Logic: Cycle filter mode through 'open' -> 'closed' -> 'both'
      // Programming logic: Cycle tabFilterMode through open, closed, and both states
      if (tabFilterMode === 'open') {
        tabFilterMode = 'closed'
        closedTabsToggleBtn.textContent = 'Show: only closed'
      } else if (tabFilterMode === 'closed') {
        tabFilterMode = 'both'
        closedTabsToggleBtn.textContent = 'Show: both'
      } else {
        tabFilterMode = 'open'
        closedTabsToggleBtn.textContent = 'Show: only open'
      }
      doSearch(input.value, resultsList)
    })

    const ungroupedToggleLabel = document.createElement('label')
    ungroupedToggleLabel.className = 'atm-closed-tabs-toggle'

    const ungroupedCheckbox = document.createElement('input')
    ungroupedCheckbox.type = 'checkbox'
    ungroupedCheckbox.checked = showUngroupedOnly
    ungroupedCheckbox.className = 'atm-closed-tabs-checkbox'
    ungroupedCheckbox.addEventListener('change', () => {
      showUngroupedOnly = ungroupedCheckbox.checked
      doSearch(input.value, resultsList)
    })

    const ungroupedText = document.createElement('span')
    ungroupedText.textContent = 'Ungrouped only'

    ungroupedToggleLabel.appendChild(ungroupedCheckbox)
    ungroupedToggleLabel.appendChild(ungroupedText)

    const scoreInfoSpan = document.createElement('span')
    scoreInfoSpan.className = 'atm-score-info atm-footer-btn'
    scoreInfoSpan.textContent = 'How scoring works'

    const scoreTooltip = document.createElement('div')
    scoreTooltip.className = 'atm-score-tooltip'
    setHTMLContent(scoreTooltip, `
      <strong>How score is calculated:</strong>
      <ul>
        <li>Title exact word match: <span>+4</span></li>
        <li>Title partial match: <span>+3</span></li>
        <li>Title start match bonus: <span>+1</span></li>
        <li>URL match: <span>+1</span></li>
        <li>Domain match bonus: <span>+1</span></li>
        <li>Same window open tab: <span>+1</span></li>
        <li>Different window open tab: <span>+0.5</span></li>
        <li>History recency boost: <span>Up to +0.2</span></li>
      </ul>
    `)
    scoreInfoSpan.appendChild(scoreTooltip)

    concurrentOpsBadge = document.createElement('span')
    concurrentOpsBadge.className = 'atm-concurrent-ops-badge'
    concurrentOpsBadge.style.display = 'none'

    rightControls.appendChild(groupResultsBtn)
    rightControls.appendChild(sortToggleBtn)
    rightControls.appendChild(closedTabsToggleBtn)
    rightControls.appendChild(ungroupedToggleLabel)
    rightControls.appendChild(concurrentOpsBadge)
    rightControls.appendChild(scoreInfoSpan)

    footer.appendChild(keybindsSpan)
    footer.appendChild(rightControls)

    const detailsPanel = document.createElement('div')
    detailsPanel.className = 'atm-details-panel'
    detailsPanel.style.display = 'none'

    container.appendChild(inputWrap)
    if (domainChipsContainer) container.appendChild(domainChipsContainer)
    container.appendChild(progressContainer)
    container.appendChild(resultsList)
    container.appendChild(detailsPanel)
    container.appendChild(footer)

    backdrop.appendChild(container)
    shadow.appendChild(backdrop)

    if (isStandalone) {
      const searchCol = document.getElementById('search-col')
      if (searchCol) {
        searchCol.appendChild(hostEl)
      } else {
        document.documentElement.appendChild(hostEl)
      }
    } else {
      document.documentElement.appendChild(hostEl)
    }

    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onCreated) {
      let refreshSearchTimer: ReturnType<typeof setTimeout> | null = null
      const refreshSearch = () => {
        if (visible) {
          if (refreshSearchTimer) clearTimeout(refreshSearchTimer)
          refreshSearchTimer = setTimeout(() => {
            refreshSearchTimer = null
            const input = shadow?.querySelector('.atm-input') as HTMLInputElement
            const resList = shadow?.querySelector('.atm-results') as HTMLDivElement
            if (input && resList) {
              const query = input.value
              if (!query || !query.startsWith('/')) {
                doSearch(query, resList)
              }
            }
          }, 150)
        }
      }
      chrome.tabs.onCreated.addListener(refreshSearch)
      chrome.tabs.onRemoved.addListener(refreshSearch)
      chrome.tabs.onUpdated.addListener(refreshSearch)
      if (chrome.tabs.onMoved) chrome.tabs.onMoved.addListener(refreshSearch)
      if (chrome.tabs.onAttached) chrome.tabs.onAttached.addListener(refreshSearch)
      if (chrome.tabs.onDetached) chrome.tabs.onDetached.addListener(refreshSearch)
      if (typeof chrome.tabGroups !== 'undefined') {
        chrome.tabGroups.onCreated.addListener(refreshSearch)
        chrome.tabGroups.onRemoved.addListener(refreshSearch)
        chrome.tabGroups.onUpdated.addListener(refreshSearch)
        if (chrome.tabGroups.onMoved) chrome.tabGroups.onMoved.addListener(refreshSearch)
      }
    }
  }

  function syncThemeAttribute() {
    if (!hostEl) return
    try {
      const raw = localStorage.getItem('atm_theme')
      const mode = raw || 'system'
      if (mode === 'dark') {
        hostEl.setAttribute('data-theme', 'dark')
      } else if (mode === 'light') {
        hostEl.setAttribute('data-theme', 'light')
      } else {
        const isDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        hostEl.setAttribute('data-theme', isDark ? 'dark' : 'light')
      }
    } catch { /* ignore */ }
  }

  function show(initialQuery = '') {
    init()
    if (!hostEl || !shadow) return
    visible = true
    hostEl.style.display = 'block'
    syncThemeAttribute()
    results = []
    selectedIndex = -1
    ignoreMouseHover = true
    justOpened = true
    lastMouseX = mouseX
    lastMouseY = mouseY

    // Reset details panel state and eagerly load metrics & active operations
    const detailsPanel = shadow.querySelector('.atm-details-panel') as HTMLDivElement
    if (detailsPanel) detailsPanel.style.display = 'none'
    overlayMetrics = null
    loadMetrics().then(() => {
      if (visible && selectedIndex !== -1 && shadow) {
        const resultsList = shadow.querySelector('.atm-results') as HTMLDivElement
        if (resultsList) updateSelection(resultsList)
      }
    })

    const input = shadow.querySelector('.atm-input') as HTMLInputElement
    const resultsList = shadow.querySelector('.atm-results') as HTMLDivElement
    if (input && resultsList) {
      input.value = initialQuery
      doSearch(initialQuery, resultsList)

      // Robust auto-focus
      input.focus()
      requestAnimationFrame(() => input.focus())
      setTimeout(() => input.focus(), 50)
      setTimeout(() => input.focus(), 150)
    }
  }

  function resetAIProgressState() {

    isAIOperating = false
    isExternalAI = false
    if (aiProgressInterval) {
      clearInterval(aiProgressInterval)
      aiProgressInterval = null
    }
    if (aiProgressTimeout) {
      clearTimeout(aiProgressTimeout)
      aiProgressTimeout = null
    }

    if (shadow) {
      if (hostEl) {
        hostEl.style.pointerEvents = ''
      }
      const input = shadow.querySelector('.atm-input') as HTMLInputElement
      const container = shadow.querySelector('.atm-container') as HTMLDivElement
      const inputWrap = shadow.querySelector('.atm-input-wrap') as HTMLDivElement
      const backdrop = shadow.querySelector('.atm-backdrop') as HTMLDivElement
      const resultsList = shadow.querySelector('.atm-results') as HTMLDivElement
      const detailsPanel = shadow.querySelector('.atm-details-panel') as HTMLDivElement
      const footer = shadow.querySelector('.atm-footer') as HTMLDivElement

      if (input) {
        input.disabled = false
        setTimeout(() => input.focus(), 0)
      }
      if (container) {
        container.style.opacity = ''
        container.style.pointerEvents = ''
        container.style.background = ''
        container.style.boxShadow = ''
      }
      if (backdrop) {
        backdrop.style.background = ''
        backdrop.style.pointerEvents = ''
        backdrop.style.backdropFilter = ''
        ; (backdrop.style as any).webkitBackdropFilter = ''
      }
      if (progressContainer) {
        progressContainer.style.pointerEvents = ''
        progressContainer.classList.remove('atm-error')
      }
      if (inputWrap) {
        inputWrap.style.display = ''
        inputWrap.style.visibility = ''
      }
      if (resultsList) resultsList.style.visibility = ''
      if (detailsPanel) detailsPanel.style.visibility = ''
      if (footer) footer.style.visibility = ''
    }

    stopAIProgressTracking()
    if (progressContainer) progressContainer.style.display = 'none'
    if (progressStatus) {
      progressStatus.style.color = '' // reset color
      progressStatus.textContent = 'Preparing AI Command...'
    }
    if (progressPercent) progressPercent.textContent = ''
    if (progressFill) {
      progressFill.style.width = '0%'
      progressFill.style.backgroundColor = '' // reset color
      progressFill.classList.remove('atm-indeterminate')
    }
    setProgressDetail('Ready')
    if (progressCloseBtn) progressCloseBtn.style.display = 'none'
    if (progressStopApplyBtn) progressStopApplyBtn.style.display = 'none'
    if (progressHideBtn) progressHideBtn.style.display = 'none'
  }

  function switchToProgressOnlyMode() {
    if (!shadow) return
    const isStandalone = window.location?.protocol?.includes('-extension:') && window.location?.pathname?.includes('search.html')
    if (!isStandalone) {
      if (hostEl) {
        hostEl.style.pointerEvents = 'auto'
      }
      const backdrop = shadow.querySelector('.atm-backdrop') as HTMLDivElement
      if (backdrop) {
        backdrop.style.background = 'transparent'
        backdrop.style.pointerEvents = 'none'
        backdrop.style.backdropFilter = 'none'
        ; (backdrop.style as any).webkitBackdropFilter = 'none'
      }
    }
    if (progressContainer) {
      progressContainer.style.pointerEvents = 'auto'
    }
  }

  function resolveActionDisplayTitle(action: string, explicitTitle?: string): string {
    const titleMap: Record<string, string> = {
      'GROUP_TABS': 'AI Group Tabs',
      'SPLIT_CURRENT_GROUP': 'Split Current Group',
      'MERGE_CURRENT_GROUP': 'Merge Current Group',
      'CLASSIFY_NEW_TABS': 'Classify New Tabs',
      'CHECK_LAST_20_TABS': 'Check & Regroup Tabs',
    }
    return explicitTitle || titleMap[action] || 'AI Command'
  }

  function resolveCommandModel(result: SearchResultItem): { model: string; provider: string; payload?: any } {
    let model = 'gemini-3.5-flash'
    let provider = 'gemini'
    let payload: any = undefined

    if (result.commandKey && result.commandKey.includes(' ')) {
      const parts = result.commandKey.split(' ')
      const possibleModel = parts[parts.length - 1]
      if (possibleModel && (MODEL_PRICING as any)[possibleModel] !== undefined) {
        model = possibleModel
        if (model.startsWith('gemini') || model.startsWith('gemma')) {
          provider = 'gemini'
        } else if (model.startsWith('gpt')) {
          provider = 'openai'
        } else if (model.startsWith('claude')) {
          provider = 'claude'
        }
        payload = { provider, model }
      }
    } else if (overlayMetrics?.aiSettings) {
      model = getActiveModel(overlayMetrics.aiSettings)
      provider = overlayMetrics.aiSettings.provider
    }

    if (result.sendFullUrl) {
      payload = payload || {}
      payload.sendFullUrl = true
    }
    if ((event as MouseEvent | KeyboardEvent)?.shiftKey) {
      payload = payload || {}
      payload.shiftKey = true
    }
    return { model, provider, payload }
  }

  async function runAICommand(result: SearchResultItem) {
    if (!shadow || !result.commandAction) return

    const { model, payload } = resolveCommandModel(result)
    const modelDisplayName = MODEL_NAMES[model] || model
    const baseActionTitle = resolveActionDisplayTitle(result.commandAction, result.tab?.title)
    const headerTitle = baseActionTitle.includes(modelDisplayName)
      ? baseActionTitle
      : `${baseActionTitle} (${modelDisplayName})`

    isAIOperating = true
    startAIProgressTracking(headerTitle, 'Processing...')

    // Keep search input enabled so user can search while progress bar runs
    const input = shadow.querySelector('.atm-input') as HTMLInputElement
    if (input) {
      input.disabled = false
    }
    if (progressContainer) progressContainer.style.display = 'flex'
    switchToProgressOnlyMode()

    if (progressCloseBtn) {
      progressCloseBtn.textContent = 'Cancel'
      progressCloseBtn.style.color = '' // Reverts to CSS-defined red color
      progressCloseBtn.style.display = 'block'
    }
    if (progressHideBtn) {
      progressHideBtn.style.display = 'block'
    }
    if (progressStatus) {
      progressStatus.style.color = '' // reset to default blue
      progressStatus.textContent = headerTitle
    }
    if (progressFill) {
      progressFill.style.width = '100%'
      progressFill.style.backgroundColor = '' // reset to default blue
      progressFill.classList.add('atm-indeterminate')
    }
    if (progressPercent) progressPercent.textContent = ''
    setProgressDetail('Processing...')



    if (isExternalAI) {
      // Triggered externally (e.g. from GUI popup). The background is already executing.
      // We run the local simulated progress, and wait for complete/failed broadcasts!
      return
    }

    try {
      const res = await chrome.runtime.sendMessage({
        action: result.commandAction,
        payload: payload
      })

      if (aiProgressInterval) {
        clearInterval(aiProgressInterval)
        aiProgressInterval = null
      }

      if (res && res.error) {
        throw new Error(res.error)
      }

      if (res && res.backupData) {
        const json = JSON.stringify(res.backupData, null, 2)
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `tabpilot-groups-backup-${new Date().toISOString().split('T')[0]}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }

      // Success!
      stopAIProgressTracking()
      isAIOperating = false
      if (progressPercent) progressPercent.textContent = '100% (0% remaining)'
      if (progressFill) {
        progressFill.style.width = '100%'
        progressFill.classList.remove('atm-indeterminate')
        progressFill.style.backgroundColor = 'var(--group-green, #34C759)'
      }
      if (progressStatus) {
        progressStatus.textContent = 'Success!'
        progressStatus.style.color = 'var(--group-green, #34C759)'
      }
      setProgressDetail('Operation completed successfully.')

      // Reset the progress state after 1.5 seconds instead of hiding the entire overlay
      if (aiProgressTimeout) clearTimeout(aiProgressTimeout)
      aiProgressTimeout = window.setTimeout(() => {
        resetAIProgressState()
        const input = shadow?.querySelector('.atm-input') as HTMLInputElement
        const resultsList = shadow?.querySelector('.atm-results') as HTMLDivElement
        if (input && resultsList) {
          input.focus()
          doSearch(input.value, resultsList)
        }
      }, 1500)

    } catch (err: any) {
      stopAIProgressTracking()
      isAIOperating = false
      if (aiProgressInterval) {
        clearInterval(aiProgressInterval)
        aiProgressInterval = null
      }

      if (progressContainer) {
        progressContainer.classList.add('atm-error')
      }
      if (progressFill) {
        progressFill.style.width = '100%'
        progressFill.classList.remove('atm-indeterminate')
        progressFill.style.backgroundColor = 'var(--group-red, #FF3B30)'
      }
      if (progressStatus) {
        progressStatus.textContent = 'AI Operation Failed'
        progressStatus.style.color = 'var(--group-red, #FF3B30)'
      }
      if (progressDetail) {
        setProgressDetail(err.message || 'An unknown error occurred.', true)

        if (err.message && (err.message.includes('safety safeguard') || err.message.includes('safety limit'))) {
          const btn = document.createElement('button')
          btn.textContent = 'Proceed Anyways'
          btn.style.cssText = 'margin-top:8px;padding:4px 10px;font-size:10.5px;font-weight:600;background:var(--group-red, #FF3B30);color:#ffffff;border:none;border-radius:2px;cursor:pointer;display:inline-block;'
          btn.addEventListener('click', async () => {
            try {
              if (progressStatus) progressStatus.textContent = 'AI Grouping (Bypassing Limits)...'
              if (progressFill) progressFill.style.width = '50%'
              await chrome.runtime.sendMessage({ action: 'GROUP_TABS', payload: { bypassSafeguards: true } })
              if (progressStatus) progressStatus.textContent = 'AI Grouping Completed!'
              if (progressFill) progressFill.style.width = '100%'
            } catch (e: any) {
              if (progressStatus) progressStatus.textContent = 'AI Operation Failed'
              setProgressDetail(e.message || 'Failed to execute command', true)
            }
          })
          progressDetail.appendChild(document.createElement('br'))
          progressDetail.appendChild(btn)
        }
      }
      if (progressCloseBtn) {
        progressCloseBtn.textContent = 'Dismiss'
        progressCloseBtn.style.color = 'var(--group-red, #FF3B30)'
        progressCloseBtn.style.display = 'block'
      }
      if (progressHideBtn) {
        progressHideBtn.style.display = 'none'
      }
    }
  }

  function hide() {
    if (!hostEl) return

    const isStandalone = window.location?.protocol?.includes('-extension:') && window.location?.pathname?.includes('search.html')
    if (isStandalone) {
      if (!isAIOperating) {
        resetAIProgressState()
      }
      const input = shadow?.querySelector('.atm-input') as HTMLInputElement
      const resultsList = shadow?.querySelector('.atm-results') as HTMLDivElement
      if (input && resultsList) {
        doSearch(input.value, resultsList)
      }
      return
    }

    visible = false
    hostEl.style.display = 'none'
    clearTimeout(debounceTimer)
    if (!isAIOperating) {
      resetAIProgressState()
    }
  }

  function toggle(initialQuery = '') {
    if (visible) {
      hide()
    } else {
      show(initialQuery)
    }
  }

  async function doSearch(query: string, resultsList: HTMLDivElement) {
    const trimmed = query.trim()
    if (trimmed.startsWith('/')) {
      const matchText = query.trimStart().toLowerCase()
      const trimmedMatchText = matchText.trimEnd()

      // Count how many base commands start with trimmedMatchText
      const matchingBaseCommands = COMMANDS.filter(c => {
        if (!c.key.startsWith(trimmedMatchText)) return false
        const hasSpace = c.key.includes(' ')
        if (hasSpace) {
          const parts = c.key.split(' ')
          const possibleModel = parts[1]
          if (possibleModel && (MODEL_PRICING as any)[possibleModel] !== undefined) {
            return false // It's a model suggestion, not a base command
          }
        }
        return true
      })

      const onlyOneBaseCommand = matchingBaseCommands.length === 1
      const singleBaseCmd = onlyOneBaseCommand ? matchingBaseCommands[0].key : null

      let matched = COMMANDS.filter(c => {
        if (!c.key.startsWith(trimmedMatchText)) return false

        // Logic: Hide commands with -full if 'Always send full URL' is activated
        // Programming logic: Hide -full commands if 'Always send full URL' is globally enabled
        if (overlayMetrics?.aiSettings?.sendFullUrl && c.sendFullUrl) {
          return false
        }

        // Hide model suggestions if the command is not completely entered yet.
        // A model suggestion has a space, and the second part is a known model.
        const hasSpace = c.key.includes(' ')
        if (hasSpace) {
          const parts = c.key.split(' ')
          const possibleModel = parts[1]
          if (possibleModel && (MODEL_PRICING as any)[possibleModel] !== undefined) {
            const baseCmd = parts[0]

            // 1. Only suggest models for the currently selected provider (only for AI actions, not /model)
            if (baseCmd !== '/model') {
              const activeProvider = overlayMetrics?.aiSettings?.provider || 'gemini'
              let modelProvider = 'gemini'
              if (possibleModel.startsWith('gemini') || possibleModel.startsWith('gemma')) {
                modelProvider = 'gemini'
              } else if (possibleModel.startsWith('gpt')) {
                modelProvider = 'openai'
              } else if (possibleModel.startsWith('claude')) {
                modelProvider = 'claude'
              }

              if (activeProvider !== 'custom' && modelProvider !== activeProvider) {
                return false
              }
            }

            // 2. Only show if the user typed the base command followed by a space
            // OR if there is exactly 1 matching base command starting with matchText (e.g. typing '/split' or '/spl')
            const isFullyEnteredWithSpace = matchText.startsWith(baseCmd + ' ')
            const isSingleMatchingCommand = singleBaseCmd === baseCmd

            if (!isFullyEnteredWithSpace && !isSingleMatchingCommand) {
              return false
            }
          }
        }
        return true
      })

      // Programming logic: If the user typed a custom group threshold, ensure we add a matching suggestion
      const cleanupMatch = trimmedMatchText.match(/^\/cleanup-groups\s+(\d+)$/)
      if (cleanupMatch) {
        const x = parseInt(cleanupMatch[1])
        const hasMatch = matched.some(c => c.key === `/cleanup-groups ${x}`)
        if (!hasMatch) {
          matched.push({
            key: `/cleanup-groups ${x}`,
            title: `Clean Up Tab Groups (< ${x} tabs)`,
            description: `Close tabs in groups with less than ${x} tabs`,
            action: 'CLEANUP_GROUPS'
          })
        }
      }

      const currentDefaultModel = overlayMetrics?.aiSettings ? getActiveModel(overlayMetrics.aiSettings) : 'gemini-3.5-flash'
      matched.sort((a, b) => {
        const aParts = a.key.split(' ')
        const bParts = b.key.split(' ')
        if (aParts[0] === bParts[0]) {
          const aModel = aParts[1]
          const bModel = bParts[1]
          if (aModel && bModel) {
            const aIsDefault = aModel === currentDefaultModel
            const bIsDefault = bModel === currentDefaultModel
            if (aIsDefault && !bIsDefault) return -1
            if (!aIsDefault && bIsDefault) return 1
          }
        }
        return 0
      })

      results = matched.map(c => {
        let minTabs: number | undefined = undefined
        if (c.action === 'CLEANUP_GROUPS') {
          // Programming logic: Parse the number from the command key, e.g. "/cleanup-groups 3" -> 3
          const match = c.key.match(/\/cleanup-groups\s+(\d+)/)
          minTabs = match ? parseInt(match[1]) : 3
        }
        return {
          tab: {
            title: c.key,
            url: `${c.title} — ${c.description}`
          },
          score: 0,
          isOpen: false,
          isCommand: true,
          commandKey: c.key,
          commandAction: c.action,
          commandDescription: c.description,
          sendFullUrl: c.sendFullUrl,
          minTabs
        }
      })
      selectedIndex = results.length > 0 ? 0 : -1
      renderResults(resultsList, query)
      updateSelection(resultsList)
      return
    }

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'SEARCH_TABS',
        payload: { 
          query,
          includeClosedWhenEmpty: tabFilterMode !== 'open'
        },
      })
      if (Array.isArray(res)) {
        results = res
        // Logik: Tabs nach Filter-Modus filtern ('open', 'closed', 'both')
        // Programming logic: Filter tabs by filter mode ('open', 'closed', 'both')
        if (tabFilterMode === 'open') {
          results = results.filter(r => r.isOpen || r.isCommand)
        } else if (tabFilterMode === 'closed') {
          results = results.filter(r => !r.isOpen && !r.isCommand)
        }
        if (showUngroupedOnly) {
          results = results.filter(r => !r.tab || r.tab.groupId === undefined)
        }
        
        if (sortMode === 'title') {
          results.sort((a, b) => (a.tab.title || '').localeCompare(b.tab.title || ''))
        } else if (sortMode === 'url') {
          results.sort((a, b) => (a.tab.url || '').localeCompare(b.tab.url || ''))
        }

        selectedIndex = -1
        renderResults(resultsList, query)
      }
    } catch (err) {
      console.error('[timTabTool] Search failed:', err)
    }
    updateAutocomplete()
  }

  function renderResults(resultsList: HTMLDivElement, query: string) {
    resultsList.textContent = ''

    if (domainChipsContainer) {
      domainChipsContainer.textContent = ''
      
      const domainCounts = new Map<string, number>()
      for (const result of results) {
        if (result.isOpen && !result.isCommand && result.tab && result.tab.url) {
          const domain = getDomain(result.tab.url)
          if (domain) {
            domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1)
          }
        }
      }
      
      if (domainCounts.size > 0) {
        domainChipsContainer.style.display = 'flex'
        
        if (query !== '') {
          const allChip = document.createElement('div')
          allChip.className = 'atm-domain-chip atm-color-blue'
          allChip.textContent = `All Tabs`
          allChip.title = 'Clear search filter'
          allChip.addEventListener('click', () => {
            const input = shadow?.querySelector('.atm-input') as HTMLInputElement
            if (input) {
              input.value = ''
              doSearch('', resultsList)
              input.focus()
            }
          })
          domainChipsContainer.appendChild(allChip)
        }

        const sortedDomains = Array.from(domainCounts.entries())
          .sort((a, b) => b[1] - a[1])
          
        for (const [domain, count] of sortedDomains) {
          const chip = document.createElement('div')
          chip.className = 'atm-domain-chip'
          chip.textContent = `${domain} [${count}]`
          chip.addEventListener('click', () => {
            const input = shadow?.querySelector('.atm-input') as HTMLInputElement
            if (input) {
              input.value = domain
              doSearch(domain, resultsList)
            }
          })
          domainChipsContainer.appendChild(chip)
        }
      } else {
        domainChipsContainer.style.display = 'none'
      }
    }

    if (results.length === 0 && query) {
      const empty = document.createElement('div')
      empty.className = 'atm-empty'
      empty.textContent = query.startsWith('/') ? 'No matching commands' : 'No matching tabs'
      resultsList.appendChild(empty)
      return
    }

    const fragment = document.createDocumentFragment()
    results.forEach((result, index) => {
      const item = document.createElement('div')
      item.className = 'atm-result-item' + (index === selectedIndex ? ' atm-selected' : '')
      item.addEventListener('click', () => activateResult(result))
      item.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button === 1) {
          e.preventDefault()
          e.stopPropagation()
        }
      })
      item.addEventListener('auxclick', (e: MouseEvent) => {
        if (e.button === 1 && result.isOpen && !result.isCommand && result.tab.id !== undefined) {
          e.stopPropagation()
          e.preventDefault()
          chrome.runtime.sendMessage({
            action: 'CLOSE_TAB',
            payload: { tabId: result.tab.id }
          })
          const idx = results.indexOf(result)
          if (idx !== -1) {
            results.splice(idx, 1)
            if (selectedIndex >= results.length) {
              selectedIndex = results.length - 1
            }
            renderResults(resultsList, query)
          }
        }
      })
      item.addEventListener('mouseenter', () => {
        if (ignoreMouseHover) return
        selectedIndex = index
        updateSelection(resultsList)
      })

      if (result.isCommand) {
        const icon = document.createElement('div')
        icon.className = 'atm-favicon atm-command-icon'
        setSvgContent(icon, `<svg viewBox="0 0 20 20" fill="currentColor" style="width:16px;height:16px;"><path fill-rule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm6.707 4.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 12l2.293-2.707zM10 13a1 1 0 011-1h4a1 1 0 110 2h-4a1 1 0 01-1-1z" clip-rule="evenodd" /></svg>`)
        item.appendChild(icon)
      } else if (result.tab.url) {
        const favicon = document.createElement('img')
        favicon.className = 'atm-favicon'
        const optimalFavicon = getOptimalFaviconUrl(result.tab.url, result.tab.favIconUrl)
        if (optimalFavicon) {
          favicon.src = optimalFavicon
        }
        favicon.alt = ''
        favicon.addEventListener('error', () => {
          favicon.replaceWith(createFaviconPlaceholder())
        })
        item.appendChild(favicon)
      } else {
        item.appendChild(createFaviconPlaceholder())
      }

      const content = document.createElement('div')
      content.className = 'atm-result-content'

      const title = document.createElement('div')
      title.className = 'atm-result-title'
      setHighlightedText(title, result.tab.title || 'Untitled', query)
      
      if ('groupTitle' in result.tab && (result.tab as TabInfo).groupTitle) {
        const chip = document.createElement('span')
        chip.className = `atm-group-chip atm-color-${(result.tab as TabInfo).groupColor || 'grey'}`
        chip.textContent = (result.tab as TabInfo).groupTitle || ''
        title.appendChild(chip)
      }

      const url = document.createElement('div')
      url.className = 'atm-result-url'
      if (result.isCommand) {
        url.textContent = result.tab.url
      } else {
        setHighlightedText(url, formatUrl(result.tab.url), query)
      }

      content.appendChild(title)
      content.appendChild(url)
      item.appendChild(content)

      const badge = document.createElement('span')
      badge.className = 'atm-badge'
      if (result.isCommand) {
        badge.classList.add('atm-badge-command')
        badge.textContent = 'COMMAND'
      } else if (result.isOpen) {
        badge.classList.add('atm-badge-open')
        badge.textContent = 'OPEN'
      } else {
        badge.classList.add('atm-badge-history')
        badge.textContent = formatTime(result.tab.lastAccessed)
      }
      item.appendChild(badge)

      const scoreDetails = document.createElement('span')
      scoreDetails.className = 'atm-score-details'
      scoreDetails.textContent = result.scoreDetails || ''
      item.appendChild(scoreDetails)

      if (result.isOpen && !result.isCommand && result.tab.id !== undefined) {
        const closeBtn = document.createElement('button')
        closeBtn.className = 'atm-close-btn'
        closeBtn.title = 'Close tab (or Middle-click row)'
        setSvgContent(closeBtn, '<svg viewBox="0 0 20 20" fill="currentColor" style="width:10px;height:10px;"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>')
        
        const closeAction = (e: Event) => {
          e.stopPropagation()
          e.preventDefault()
          if (result.tab.id !== undefined) {
            chrome.runtime.sendMessage({
              action: 'CLOSE_TAB',
              payload: { tabId: result.tab.id }
            })
            const idx = results.indexOf(result)
            if (idx !== -1) {
              if (selectedIndex >= results.length) {
                selectedIndex = results.length - 1
              }
              renderResults(resultsList, query)
            }
          }
        }

        closeBtn.addEventListener('click', closeAction)
        closeBtn.addEventListener('mousedown', (e: MouseEvent) => {
          if (e.button === 1) {
            e.preventDefault()
            e.stopPropagation()
          }
        })
        closeBtn.addEventListener('auxclick', (e: MouseEvent) => {
          if (e.button === 1) closeAction(e)
        })
        item.appendChild(closeBtn)
      }

      fragment.appendChild(item)
    })
    resultsList.appendChild(fragment)

    if (justOpened && shadow) {
      justOpened = false
      const hoveredEl = shadow.elementFromPoint(mouseX, mouseY)?.closest('.atm-result-item')
      if (hoveredEl) {
        const items = Array.from(resultsList.querySelectorAll('.atm-result-item'))
        const index = items.indexOf(hoveredEl)
        if (index !== -1) {
          selectedIndex = index
        }
      } else {
        if (!query && results.length > 1 && results[0]?.tab.active) {
          selectedIndex = 1
        } else {
          selectedIndex = 0
        }
      }
      updateSelection(resultsList)
    }
  }

  function createFaviconPlaceholder(): HTMLSpanElement {
    const span = document.createElement('span')
    span.className = 'atm-favicon-placeholder'
    return span
  }

  function updateSelection(resultsList: HTMLDivElement) {
    const items = resultsList.querySelectorAll('.atm-result-item')
    items.forEach((item, i) => {
      item.classList.toggle('atm-selected', i === selectedIndex)
    })
    if (selectedIndex !== -1 && items[selectedIndex]) {
      items[selectedIndex].scrollIntoView({ block: 'nearest' })
    }
    renderDetailsPanel(results[selectedIndex])
    updateAutocomplete()
  }

  function handleKeydown(e: KeyboardEvent, _input: HTMLInputElement, resultsList: HTMLDivElement) {
    e.stopPropagation()

    if (e.key === 'Escape') {
      e.preventDefault()
      if (_input.value) {
        _input.value = ''
        doSearch('', resultsList)
      } else {
        hide()
      }
      return
    }

    if (e.key === 'ArrowRight') {
      const selectedIdx = selectedIndex === -1 ? 0 : selectedIndex
      const selected = results[selectedIdx]
      if (selected && selected.isCommand && selected.commandKey) {
        const query = _input.value
        if (selected.commandKey.toLowerCase().startsWith(query.toLowerCase()) && query.toLowerCase() !== selected.commandKey.toLowerCase()) {
          e.preventDefault()
          _input.value = selected.commandKey + ' '
          doSearch(_input.value, resultsList)
          return
        }
      }
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (results.length > 0) {
        if (selectedIndex === -1) {
          selectedIndex = 0
        } else {
          selectedIndex = (selectedIndex + 1) % results.length
        }
        updateSelection(resultsList)
      }
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length > 0) {
        if (selectedIndex === -1) {
          selectedIndex = results.length - 1
        } else {
          selectedIndex = (selectedIndex - 1 + results.length) % results.length
        }
        updateSelection(resultsList)
      }
      return
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      if (results.length > 0) {
        if (e.shiftKey) {
          // Move up
          if (selectedIndex === -1) {
            selectedIndex = results.length - 1
          } else {
            selectedIndex = (selectedIndex - 1 + results.length) % results.length
          }
        } else {
          // Move down
          if (selectedIndex === -1) {
            selectedIndex = 0
          } else {
            selectedIndex = (selectedIndex + 1) % results.length
          }
        }
        updateSelection(resultsList)
      }
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      const targetIndex = selectedIndex === -1 ? 0 : selectedIndex
      if (results[targetIndex]) {
        activateResult(results[targetIndex])
      }
      return
    }
  }

  async function runChangeModelCommand(result: SearchResultItem) {
    if (!shadow || !result.commandKey) return
    const parts = result.commandKey.split(' ')
    const modelId = parts[1]
    if (!modelId) return

    isAIOperating = true

    // Keep search input enabled, show progress
    const input = shadow.querySelector('.atm-input') as HTMLInputElement
    if (input) {
      input.disabled = false
    }
    if (progressContainer) progressContainer.style.display = 'flex'
    switchToProgressOnlyMode()
    if (progressPercent) progressPercent.textContent = '0%'
    if (progressFill) progressFill.style.width = '0%'
    if (progressStatus) {
      progressStatus.textContent = 'Updating default model...'
      progressStatus.style.color = ''
    }

    const displayName = MODEL_NAMES[modelId] || modelId
    setProgressDetail(`Setting default model to ${displayName}...`)

    try {
      // Step 1: Get settings
      const settings = await chrome.runtime.sendMessage({ action: 'GET_SETTINGS' })
      if (!settings || typeof settings !== 'object') {
        throw new Error('Failed to load extension settings.')
      }

      // Step 2: Update model and provider
      let provider = settings.ai.provider || 'gemini'
      let maxTokens = 16384
      if (modelId.includes('/')) {
        provider = 'openrouter'
        maxTokens = modelId === 'stealth/ox-alpha' ? 32768 : 16384
      } else if (modelId.startsWith('gemini') || modelId.startsWith('gemma')) {
        provider = 'gemini'
        maxTokens = 65536
      } else if (modelId.startsWith('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
        provider = 'openai'
        maxTokens = 16384
      } else if (modelId.startsWith('claude')) {
        provider = 'claude'
        maxTokens = modelId.includes('opus') || modelId.includes('haiku') ? 4096 : 8192
      }

      settings.ai.model = modelId
      settings.ai.provider = provider
      settings.ai.maxTokens = maxTokens

      // Step 3: Save settings
      await chrome.runtime.sendMessage({
        action: 'SAVE_SETTINGS',
        payload: settings
      })

      // Update local overlay metrics so autocomplete filtering refreshes immediately!
      if (overlayMetrics && overlayMetrics.aiSettings) {
        overlayMetrics.aiSettings.model = modelId
        overlayMetrics.aiSettings.provider = provider
      }

      // Success!
      stopAIProgressTracking()
      isAIOperating = false
      if (progressPercent) progressPercent.textContent = '100% (0% remaining)'
      if (progressFill) {
        progressFill.style.width = '100%'
        progressFill.style.backgroundColor = 'var(--group-green, #34C759)'
      }
      if (progressStatus) {
        progressStatus.textContent = 'Success!'
        progressStatus.style.color = 'var(--group-green, #34C759)'
      }
      setProgressDetail(`Default model is now set to ${displayName}.`)

      // Reset the progress state after 1.5 seconds instead of hiding the entire overlay
      if (aiProgressTimeout) clearTimeout(aiProgressTimeout)
      aiProgressTimeout = window.setTimeout(() => {
        resetAIProgressState()
        const input = shadow?.querySelector('.atm-input') as HTMLInputElement
        const resultsList = shadow?.querySelector('.atm-results') as HTMLDivElement
        if (input && resultsList) {
          input.focus()
          doSearch(input.value, resultsList)
        }
      }, 1500)

    } catch (err: any) {
      isAIOperating = false
      if (progressFill) {
        progressFill.style.backgroundColor = 'var(--group-red, #FF3B30)'
      }
      if (progressStatus) {
        progressStatus.textContent = 'Failed to update model'
        progressStatus.style.color = 'var(--group-red, #FF3B30)'
      }
      setProgressDetail(err.message || 'An unknown error occurred.', true)
      if (progressCloseBtn) {
        progressCloseBtn.textContent = 'Dismiss'
        progressCloseBtn.style.color = 'var(--group-red, #FF3B30)'
        progressCloseBtn.style.display = 'block'
      }
      if (progressHideBtn) {
        progressHideBtn.style.display = 'none'
      }
    }
  }

  function activateResult(result: SearchResultItem) {
    if (result.isCommand && result.commandAction) {
      if (result.commandAction === 'CHANGE_MODEL') {
        runChangeModelCommand(result)
        return
      }

      const aiActions = ['GROUP_TABS', 'SPLIT_CURRENT_GROUP', 'MERGE_CURRENT_GROUP', 'CLASSIFY_NEW_TABS', 'CHECK_LAST_20_TABS']
      if (aiActions.includes(result.commandAction)) {
        runAICommand(result)
        return
      }

      if (result.commandAction === 'UNGROUP_ALL') {
        const confirmed = window.confirm(chrome.i18n.getMessage('confirmUngroupAll') || 'Are you sure you want to ungroup all tabs in this window?')
        if (!confirmed) return
      }

      chrome.runtime.sendMessage({
        action: result.commandAction,
        payload: result.commandAction === 'CLEANUP_GROUPS' ? { minTabs: result.minTabs } : undefined
      })
    } else if (result.isOpen && result.tab.id) {
      chrome.runtime.sendMessage({
        action: 'SWITCH_TAB',
        payload: { tabId: result.tab.id, windowId: (result.tab as TabInfo).windowId }
      })
    } else {
      chrome.runtime.sendMessage({
        action: 'OPEN_URL',
        payload: { url: result.tab.url }
      })
    }
    const isStandalone = Boolean(window.location?.protocol?.includes('-extension:') && window.location?.pathname?.includes('search.html'))
    const isNavigation = !(result.isCommand && result.commandAction)
    if (!isStandalone || !isNavigation) {
      hide()
    }
  }

  function setHTMLContent(element: HTMLElement, htmlString: string): void {
    element.replaceChildren()
    const doc = new DOMParser().parseFromString(htmlString, 'text/html')
    if (doc?.body?.childNodes) {
      element.append(...Array.from(doc.body.childNodes))
    }
  }

  function setSvgContent(element: HTMLElement, svgString: string): void {
    element.replaceChildren()
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml')
    if (doc.documentElement) {
      element.appendChild(doc.documentElement)
    }
  }

  function setHighlightedText(element: HTMLElement, text: string, query: string): void {
    element.replaceChildren()
    if (!query || !text) {
      element.textContent = text
      return
    }
    const terms = Array.from(new Set(query.split(/\s+/).filter(Boolean))).sort((a, b) => b.length - a.length)
    if (terms.length === 0) {
      element.textContent = text
      return
    }

    const escapedTerms = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi')

    const parts = text.split(regex)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!part) continue
      if (i % 2 === 1) {
        const span = document.createElement('span')
        span.className = 'atm-highlight'
        span.textContent = part
        element.appendChild(span)
      } else {
        element.appendChild(document.createTextNode(part))
      }
    }
  }

  function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function formatUrl(url: string): string {
    try {
      const parsed = new URL(url)
      return parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '')
    } catch {
      return url
    }
  }

  function formatTime(ts: number | undefined): string {
    if (!ts) return ''
    const diff = Date.now() - ts
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  // Expose toggle function globally so background can call it via executeScript
  ; (window as unknown as Record<string, (q?: string) => void>).__ATM_TOGGLE_SEARCH__ = toggle

  function updateConcurrentOpsBadge(): void {
    if (!concurrentOpsBadge) return
    if (concurrentBackgroundOpsCount > 0) {
      concurrentOpsBadge.style.display = 'inline-flex'
      concurrentOpsBadge.textContent = `⚡ ${concurrentBackgroundOpsCount} bg AI op${concurrentBackgroundOpsCount > 1 ? 's' : ''}`
      concurrentOpsBadge.title = `${concurrentBackgroundOpsCount} background AI operation${concurrentBackgroundOpsCount > 1 ? 's' : ''} running in other windows`
    } else {
      concurrentOpsBadge.style.display = 'none'
    }
  }

  function handleStartAIProgressMessage(payload: any): void {
    const winId = payload?.windowId
    if (winId !== undefined && currentOverlayWindowId !== null && winId !== currentOverlayWindowId) {
      concurrentBackgroundOpsCount++
      updateConcurrentOpsBadge()
      return
    }
    if (isAIOperating || !visible) return
    const commandAction = payload?.commandAction
    if (!commandAction) return
    const titleMap: Record<string, string> = {
      'GROUP_TABS': 'AI Group Tabs',
      'SPLIT_CURRENT_GROUP': 'Split Current Group',
      'MERGE_CURRENT_GROUP': 'Merge Current Group',
      'CLASSIFY_NEW_TABS': 'Classify New Tabs',
      'CHECK_LAST_20_TABS': 'Check & Regroup Tabs',
      'SORT_TABS': 'Sort Tabs'
    }
    const actionTitle = titleMap[commandAction] || 'AI Command'
    if (hostEl && shadow) {
      switchToProgressOnlyMode()
      isExternalAI = true
      startAIProgressTracking(actionTitle)
      runAICommand({
        tab: { title: actionTitle, url: 'Executing from Background...' },
        score: 0,
        isOpen: false,
        isCommand: true,
        commandAction
      })
    }
  }

  function handleAIOperationProgressMessage(payload: any): void {
    const winId = payload?.windowId
    if (winId !== undefined && currentOverlayWindowId !== null && winId !== currentOverlayWindowId) {
      return
    }
    if (!isAIOperating || !visible) return
    applyProgressStatusUpdate(payload?.status)
  }

  function handleAIOperationCompleteMessage(payload: any): void {
    const winId = payload?.windowId
    if (winId !== undefined && currentOverlayWindowId !== null && winId !== currentOverlayWindowId) {
      if (concurrentBackgroundOpsCount > 0) concurrentBackgroundOpsCount--
      updateConcurrentOpsBadge()
      return
    }
    if (!isAIOperating) return
    stopAIProgressTracking()
    if (aiProgressInterval) {
      clearInterval(aiProgressInterval)
      aiProgressInterval = null
    }
    isAIOperating = false
    isExternalAI = false
    if (progressPercent) progressPercent.textContent = '100% (0% remaining)'
    if (progressFill) {
      progressFill.style.width = '100%'
      progressFill.classList.remove('atm-indeterminate')
      progressFill.style.backgroundColor = 'var(--group-green, #34C759)'
    }
    if (progressStatus) {
      progressStatus.textContent = 'Success!'
      progressStatus.style.color = 'var(--group-green, #34C759)'
    }
    setProgressDetail('Operation completed successfully.')
    if (progressCloseBtn) progressCloseBtn.style.display = 'none'
    if (progressStopApplyBtn) progressStopApplyBtn.style.display = 'none'

    if (visible) {
      if (aiProgressTimeout) clearTimeout(aiProgressTimeout)
      aiProgressTimeout = setTimeout(() => { hide() }, 1500)
    } else {
      resetAIProgressState()
    }
  }

  function handleAIOperationFailedMessage(payload: any): void {
    const winId = payload?.windowId
    if (winId !== undefined && currentOverlayWindowId !== null && winId !== currentOverlayWindowId) {
      if (concurrentBackgroundOpsCount > 0) concurrentBackgroundOpsCount--
      updateConcurrentOpsBadge()
      return
    }
    if (visible) {
      init()
      if (hostEl && shadow) {
        syncThemeAttribute()
        switchToProgressOnlyMode()
        stopAIProgressTracking()
        if (aiProgressInterval) {
          clearInterval(aiProgressInterval)
          aiProgressInterval = null
        }
        isAIOperating = false
        isExternalAI = false
        if (progressContainer) progressContainer.classList.add('atm-error')
        if (progressFill) {
          progressFill.style.width = '100%'
          progressFill.classList.remove('atm-indeterminate')
          progressFill.style.backgroundColor = 'var(--group-red, #FF3B30)'
        }
        if (progressStatus) {
          progressStatus.textContent = 'AI Operation Failed'
          progressStatus.style.color = 'var(--group-red, #FF3B30)'
        }
        setProgressDetail(payload?.error || 'An unknown error occurred.', true)
        if (progressCloseBtn) {
          progressCloseBtn.textContent = 'Dismiss'
          progressCloseBtn.style.color = 'var(--group-red, #FF3B30)'
          progressCloseBtn.style.display = 'block'
        }
        if (progressStopApplyBtn) progressStopApplyBtn.style.display = 'none'
        if (progressHideBtn) progressHideBtn.style.display = 'none'
      }
    } else {
      resetAIProgressState()
    }
  }

  // Also listen for messages (for tabs.sendMessage from background)
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === 'TOGGLE_SEARCH_OVERLAY') {
      toggle(message.payload?.initialQuery || '')
    } else if (message?.action === 'ACTIVE_OPERATIONS_UPDATED') {
      if (message.payload && typeof message.payload === 'object') {
        updateConcurrentOpsFromMap(message.payload)
      }
    } else if (message?.action === 'START_AI_PROGRESS') {
      handleStartAIProgressMessage(message.payload)
    } else if (message?.action === 'AI_OPERATION_PROGRESS') {
      handleAIOperationProgressMessage(message.payload)
    } else if (message?.action === 'AI_OPERATION_COMPLETE') {
      handleAIOperationCompleteMessage(message.payload)
    } else if (message?.action === 'AI_OPERATION_FAILED') {
      handleAIOperationFailedMessage(message.payload)
    }
  })



  // Auto-initialize and show if loaded directly inside the standalone search.html page
  if (window.location?.protocol?.includes('-extension:') && window.location?.pathname?.includes('search.html')) {
    // Logik: Sofortiges Anzeigen des Overlays in der search.html-Seite
    // Programming logic: Immediately display the search overlay in search.html page
    show()
  }
}
