import cssText from './search-overlay.css?inline'

interface SearchResultItem {
  tab: {
    id?: number
    url: string
    title: string
    favIconUrl?: string
    lastAccessed?: number
    active?: boolean
  }
  score: number
  isOpen: boolean
  scoreDetails?: string
  isCommand?: boolean
  commandAction?: string
  commandDescription?: string
}

// Guard against multiple injections
if (!(window as unknown as Record<string, boolean>).__ATM_SEARCH_LOADED__) {
  ;(window as unknown as Record<string, boolean>).__ATM_SEARCH_LOADED__ = true

  let hostEl: HTMLDivElement | null = null
  let shadow: ShadowRoot | null = null
  let visible = false
  let selectedIndex = 0
  let results: SearchResultItem[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let ignoreMouseHover = false

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

  const COMMANDS = [
    {
      key: '/group',
      title: 'Group Tabs',
      description: 'Organize all tabs in this window into smart groups',
      action: 'GROUP_TABS'
    },
    {
      key: '/ungroup',
      title: 'Ungroup All',
      description: 'Ungroup all tabs in this window',
      action: 'UNGROUP_ALL'
    },
    {
      key: '/split',
      title: 'Split Current Group',
      description: 'Split the current tab group using AI',
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
    }
  ]

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX
    mouseY = e.clientY

    if (visible && (mouseX !== lastMouseX || mouseY !== lastMouseY)) {
      lastMouseX = mouseX
      lastMouseY = mouseY
      ignoreMouseHover = false

      if (shadow) {
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
      }
    }
  }, { passive: true })

  const MODEL_PRICING = {
    'gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
    'gemini-3.5-flash': { input: 1.50, output: 9.00 },
    'gemini-2.5-flash': { input: 0.50, output: 3.00 },
    'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
    'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
    'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
    'gemini-flash-lite-latest': { input: 0.075, output: 0.30 },
    'gemma-4-31b-it': { input: 0, output: 0 },
    'gemma-4-26b-a4b-it': { input: 0, output: 0 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
    'claude-3-5-sonnet-20240620': { input: 3.00, output: 15.00 },
    'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  }

  const PROVIDER_DEFAULTS = {
    openai: { input: 0.15, output: 0.60 },
    claude: { input: 3.00, output: 15.00 },
    gemini: { input: 1.50, output: 9.00 },
    custom: { input: 0.15, output: 0.60 },
  }

  function getActiveModel(aiSettings: any) {
    if (aiSettings.model) return aiSettings.model
    const defaults: Record<string, string> = {
      openai: 'gpt-4o-mini',
      claude: 'claude-sonnet-4-20250514',
      gemini: 'gemini-3.5-flash',
      custom: 'gpt-4o-mini',
    }
    return defaults[aiSettings.provider] || 'gpt-4o-mini'
  }

  function estimateAICost(aiSettings: any, tabs: number, type: 'group' | 'split' | 'merge' | 'classify') {
    if (tabs === 0) {
      return { tokens: 0, costStr: 'Free' }
    }
    
    let promptLen = 1000
    if (aiSettings.customPrompt) promptLen += aiSettings.customPrompt.length
    
    if (type === 'group') {
      if (aiSettings.groupingPrompt) promptLen += aiSettings.groupingPrompt.length
    } else if (type === 'split') {
      if (aiSettings.splitPrompt) promptLen += aiSettings.splitPrompt.length
    } else if (type === 'merge') {
      if (aiSettings.mergePrompt) promptLen += aiSettings.mergePrompt.length
    } else if (type === 'classify') {
      if (aiSettings.classifyPrompt) promptLen += aiSettings.classifyPrompt.length
    }

    const promptTokens = Math.ceil(promptLen / 4)
    const inputTokens = promptTokens + tabs * 20
    const outputTokens = type === 'group' ? Math.max(100, tabs * 20) : type === 'split' ? 100 : 50
    const totalTokens = inputTokens + outputTokens
    
    const provider = aiSettings.provider
    const model = getActiveModel(aiSettings)
    
    let rates = (MODEL_PRICING as any)[model]
    if (!rates) {
      rates = (PROVIDER_DEFAULTS as any)[provider] || PROVIDER_DEFAULTS.openai
    }
    
    const cost = (inputTokens * rates.input + outputTokens * rates.output) / 1000000
    let costStr = ''
    if (cost === 0) costStr = 'Free'
    else if (cost < 0.0001) costStr = '< $0.0001'
    else costStr = `~$${cost.toFixed(4)}`
    
    return { tokens: totalTokens, costStr }
  }

  async function loadMetrics() {
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'GET_SEARCH_OVERLAY_METRICS'
      })
      if (res && typeof res === 'object') {
        overlayMetrics = res
      }
    } catch (err) {
      console.error('[TabPilot] Failed to load overlay metrics:', err)
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
    const isLocal = ['UNGROUP_ALL', 'EXPAND_ALL_GROUPS', 'COLLAPSE_ALL_GROUPS', 'TOGGLE_GROUP_TITLES'].includes(action)
    
    if (isLocal) {
      let desc = ''
      if (action === 'UNGROUP_ALL') desc = 'Ungroup all tabs in this window instantly, leaving all tabs active in a single flat list.'
      else if (action === 'EXPAND_ALL_GROUPS') desc = 'Expand all collapsed Chrome tab groups in this window.'
      else if (action === 'COLLAPSE_ALL_GROUPS') desc = 'Collapse all active Chrome tab groups in this window to clear up space.'
      else if (action === 'TOGGLE_GROUP_TITLES') desc = 'Toggle group title visibility. When hidden, groups collapse to tiny color-coded dots, saving maximum tab bar horizontal space.'

      detailsPanel.innerHTML = `
        <div class="atm-details-title">${result.tab.title}</div>
        <div class="atm-details-meta">
          <span>Mode: <span style="font-weight:600;color:var(--text-secondary,#86868B);">Local Heuristics</span></span>
          <span style="opacity:0.4;">•</span>
          <span>Privacy: <span style="font-weight:600;color:var(--text-secondary,#86868B);">100% Offline</span></span>
        </div>
        <div class="atm-details-section-title">Description</div>
        <div class="atm-details-section-body">${desc}</div>
        <div class="atm-details-est">
          <div class="atm-details-est-row">
            <span class="atm-details-est-label">Est. Requests:</span>
            <span style="font-weight:600;">0 (No API calls)</span>
          </div>
          <div class="atm-details-est-row">
            <span class="atm-details-est-label">Cost:</span>
            <span style="font-weight:700;color:#34C759;">Free</span>
          </div>
        </div>
      `
      detailsPanel.style.display = 'flex'
      return
    }

    if (!overlayMetrics || !overlayMetrics.aiSettings) {
      detailsPanel.innerHTML = `
        <div class="atm-details-title">${result.tab.title}</div>
        <div class="atm-details-meta">
          <span>Loading AI Configuration...</span>
        </div>
      `
      detailsPanel.style.display = 'flex'
      return
    }

    const aiSettings = overlayMetrics.aiSettings
    
    if (!aiSettings.enabled || !aiSettings.apiKey) {
      detailsPanel.innerHTML = `
        <div class="atm-details-title">${result.tab.title}</div>
        <div class="atm-details-meta">
          <span style="color:#FF3B30;font-weight:600;">AI not configured</span>
        </div>
        <div class="atm-details-section-title">Instructions</div>
        <div class="atm-details-section-body">AI is currently disabled or missing an API Key. Please enable AI and configure your connection credentials in TabPilot Settings first.</div>
      `
      detailsPanel.style.display = 'flex'
      return
    }

    const model = getActiveModel(aiSettings)
    let systemPrompt = aiSettings.customPrompt?.trim() 
      ? `You are a helpful assistant that classifies browser tabs into categories. Be concise.\n\nUser Instructions:\n${aiSettings.customPrompt.trim()}`
      : 'You are a helpful assistant that classifies browser tabs into categories. Be concise.'
      
    let userPrompt = ''
    let titleStr = ''
    let tabCount = 0
    let estRequests = 1

    if (action === 'GROUP_TABS') {
      titleStr = 'AI Grouping Preview'
      userPrompt = aiSettings.groupingPrompt || 'Organize these browser tabs into semantic, highly-related groups.'
      tabCount = overlayMetrics.unpinnedTabsCount
      const batchSize = aiSettings.batchSize || 30
      estRequests = Math.max(1, Math.ceil(tabCount / batchSize))
    } else if (action === 'SPLIT_CURRENT_GROUP') {
      titleStr = 'AI Split Group Preview'
      userPrompt = aiSettings.splitPrompt || 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.'
      tabCount = overlayMetrics.currentGroupTabsCount
      estRequests = 1
    } else if (action === 'MERGE_CURRENT_GROUP') {
      titleStr = 'AI Merge Group Preview'
      userPrompt = aiSettings.mergePrompt || 'Analyze the browser tabs of this group and decide if they should be merged into one of the other existing tab groups. Choose the best fitting existing group from the list. If none of the existing groups are a good fit and this group should remain separate, respond with "KEEP". Be conservative about merging; only merge if the topics are highly related.'
      tabCount = overlayMetrics.currentGroupTabsCount
      estRequests = 1
    } else if (action === 'CLASSIFY_NEW_TABS') {
      titleStr = 'AI Classification Preview'
      userPrompt = aiSettings.classifyPrompt || 'You are classifying new tabs. Decide if each new tab belongs to one of the existing groups or if a new group should be created. Be conservative about creating new groups.'
      tabCount = overlayMetrics.newTabsCount
      const batchSize = aiSettings.batchSize || 30
      estRequests = Math.max(1, Math.ceil(tabCount / batchSize))
    }

    const est = estimateAICost(aiSettings, tabCount, action === 'GROUP_TABS' ? 'group' : action === 'SPLIT_CURRENT_GROUP' ? 'split' : action === 'MERGE_CURRENT_GROUP' ? 'merge' : 'classify')

    detailsPanel.innerHTML = `
      <div class="atm-details-title">${titleStr}</div>
      <div class="atm-details-meta">
        <span>Model: <span style="font-weight:600;color:var(--text-secondary,#86868B);">${model}</span></span>
        <span style="opacity:0.4;">•</span>
        <span>Privacy: <span style="font-weight:600;color:var(--text-secondary,#86868B);">AI Analysis</span></span>
      </div>
      
      <div class="atm-details-section-title">System Prompt</div>
      <div class="atm-details-section-body">${escapeHtml(systemPrompt)}</div>
      
      <div class="atm-details-section-title">User Prompt</div>
      <div class="atm-details-section-body">${escapeHtml(userPrompt)}</div>
      
      <div class="atm-details-est">
        <div class="atm-details-est-row">
          <span class="atm-details-est-label">Tabs to Process:</span>
          <span style="font-weight:600;">${tabCount} tabs</span>
        </div>
        <div class="atm-details-est-row">
          <span class="atm-details-est-label">Est. Requests:</span>
          <span style="font-weight:600;">${estRequests} request${estRequests > 1 ? 's' : ''}</span>
        </div>
        <div class="atm-details-est-row">
          <span class="atm-details-est-label">Total Tokens:</span>
          <span style="font-weight:600;">~${est.tokens} tokens</span>
        </div>
        <div class="atm-details-est-row" style="margin-top:2px;border-top:0.5px dashed rgba(0,0,0,0.06);padding-top:2px;">
          <span class="atm-details-est-label" style="font-weight:600;">Est. Cost:</span>
          <span style="font-weight:700;color:#007AFF;">${est.costStr}</span>
        </div>
      </div>
    `
    detailsPanel.style.display = 'flex'
  }

  function init() {
    if (hostEl) return

    hostEl = document.createElement('div')
    hostEl.id = 'atm-search-host'
    hostEl.style.display = 'none'
    shadow = hostEl.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = cssText
    shadow.appendChild(style)

    const backdrop = document.createElement('div')
    backdrop.className = 'atm-backdrop'
    backdrop.addEventListener('click', hide)

    const container = document.createElement('div')
    container.className = 'atm-container'
    container.addEventListener('click', (e) => e.stopPropagation())

    const inputWrap = document.createElement('div')
    inputWrap.className = 'atm-input-wrap'

    const searchIcon = document.createElement('div')
    searchIcon.className = 'atm-search-icon'
    searchIcon.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" /></svg>'

    const input = document.createElement('input')
    input.className = 'atm-input'
    input.type = 'text'
    input.placeholder = 'Search tabs...'
    input.addEventListener('input', () => {
      ignoreMouseHover = true
      clearTimeout(debounceTimer)
      const query = input.value.trim()
      if (!query) {
        doSearch('', resultsList)
        return
      }
      debounceTimer = setTimeout(() => {
        doSearch(query, resultsList)
      }, 150)
    })
    input.addEventListener('keydown', (e) => {
      ignoreMouseHover = true
      handleKeydown(e, input, resultsList)
    })

    const shortcut = document.createElement('span')
    shortcut.className = 'atm-shortcut'
    shortcut.textContent = 'ESC'

    inputWrap.appendChild(searchIcon)
    inputWrap.appendChild(input)
    inputWrap.appendChild(shortcut)

    const resultsList = document.createElement('div')
    resultsList.className = 'atm-results'

    const footer = document.createElement('div')
    footer.className = 'atm-footer'

    const keybindsSpan = document.createElement('span')
    keybindsSpan.innerHTML = '<kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close'

    const scoreInfoSpan = document.createElement('span')
    scoreInfoSpan.className = 'atm-score-info'
    scoreInfoSpan.textContent = 'How scoring works'

    const scoreTooltip = document.createElement('div')
    scoreTooltip.className = 'atm-score-tooltip'
    scoreTooltip.innerHTML = `
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
    `
    scoreInfoSpan.appendChild(scoreTooltip)

    footer.appendChild(keybindsSpan)
    footer.appendChild(scoreInfoSpan)

    const detailsPanel = document.createElement('div')
    detailsPanel.className = 'atm-details-panel'
    detailsPanel.style.display = 'none'

    container.appendChild(inputWrap)
    container.appendChild(resultsList)
    container.appendChild(detailsPanel)
    container.appendChild(footer)

    backdrop.appendChild(container)
    shadow.appendChild(backdrop)

    document.documentElement.appendChild(hostEl)
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
        hostEl.removeAttribute('data-theme')
      }
    } catch { /* ignore */ }
  }

  function show() {
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

    // Reset details panel state and load fresh metrics
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
      input.value = ''
      doSearch('', resultsList)
      setTimeout(() => input.focus(), 0)
    }
  }

  function hide() {
    if (!hostEl) return
    visible = false
    hostEl.style.display = 'none'
    clearTimeout(debounceTimer)
  }

  function toggle() {
    if (visible) {
      hide()
    } else {
      show()
    }
  }

  async function doSearch(query: string, resultsList: HTMLDivElement) {
    const trimmed = query.trim()
    if (trimmed.startsWith('/')) {
      const matchText = trimmed.toLowerCase()
      const matched = COMMANDS.filter(c => c.key.startsWith(matchText))
      results = matched.map(c => ({
        tab: {
          title: c.title,
          url: c.description
        },
        score: 0,
        isOpen: false,
        isCommand: true,
        commandAction: c.action,
        commandDescription: c.description
      }))
      selectedIndex = -1
      renderResults(resultsList, query)
      return
    }

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'SEARCH_TABS',
        payload: { query },
      })
      if (Array.isArray(res)) {
        results = res
        selectedIndex = -1
        renderResults(resultsList, query)
      }
    } catch (err) {
      console.error('[TabPilot] Search failed:', err)
    }
  }

  function renderResults(resultsList: HTMLDivElement, query: string) {
    resultsList.innerHTML = ''

    if (results.length === 0 && query) {
      const empty = document.createElement('div')
      empty.className = 'atm-empty'
      empty.textContent = query.startsWith('/') ? 'No matching commands' : 'No matching tabs'
      resultsList.appendChild(empty)
      return
    }

    results.forEach((result, index) => {
      const item = document.createElement('div')
      item.className = 'atm-result-item' + (index === selectedIndex ? ' atm-selected' : '')
      item.addEventListener('click', () => activateResult(result))
      item.addEventListener('mouseenter', () => {
        if (ignoreMouseHover) return
        selectedIndex = index
        updateSelection(resultsList)
      })

      if (result.isCommand) {
        const icon = document.createElement('div')
        icon.className = 'atm-favicon atm-command-icon'
        icon.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" style="width:16px;height:16px;"><path fill-rule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm6.707 4.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 12l2.293-2.707zM10 13a1 1 0 011-1h4a1 1 0 110 2h-4a1 1 0 01-1-1z" clip-rule="evenodd" /></svg>`
        item.appendChild(icon)
      } else if (result.tab.url) {
        const favicon = document.createElement('img')
        favicon.className = 'atm-favicon'
        const isHttps = window.location.protocol === 'https:'
        const isHttpFavicon = result.tab.favIconUrl?.startsWith('http://')
        if (result.tab.favIconUrl && !(isHttps && isHttpFavicon)) {
          favicon.src = result.tab.favIconUrl
        } else {
          const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')
          if (isFirefox) {
            favicon.src = `https://www.google.com/s2/favicons?sz=16&domain=${new URL(result.tab.url).hostname}`
          } else {
            favicon.src = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(result.tab.url)}&size=16`
          }
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
      title.innerHTML = highlightText(result.tab.title || 'Untitled', query)

      const url = document.createElement('div')
      url.className = 'atm-result-url'
      url.innerHTML = result.isCommand ? escapeHtml(result.tab.url) : highlightText(formatUrl(result.tab.url), query)

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
        closeBtn.title = 'Close tab'
        closeBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:10px;height:10px;"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>'
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation()
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
        })
        item.appendChild(closeBtn)
      }

      resultsList.appendChild(item)
    })

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
  }

  function handleKeydown(e: KeyboardEvent, _input: HTMLInputElement, resultsList: HTMLDivElement) {
    e.stopPropagation()

    if (e.key === 'Escape') {
      e.preventDefault()
      hide()
      return
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

  function activateResult(result: SearchResultItem) {
    if (result.isCommand && result.commandAction) {
      chrome.runtime.sendMessage({
        action: result.commandAction
      })
    } else if (result.isOpen && result.tab.id) {
      chrome.runtime.sendMessage({
        action: 'SWITCH_TAB',
        payload: { tabId: result.tab.id },
      })
    } else {
      chrome.runtime.sendMessage({
        action: 'OPEN_URL',
        payload: { url: result.tab.url },
      })
    }
    hide()
  }

  function highlightText(text: string, query: string): string {
    if (!query || !text) return escapeHtml(text)
    const terms = query.split(/\s+/).filter(Boolean)
    let result = escapeHtml(text)
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(${escaped})`, 'gi')
      result = result.replace(regex, '<span class="atm-highlight">$1</span>')
    }
    return result
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
  ;(window as unknown as Record<string, () => void>).__ATM_TOGGLE_SEARCH__ = toggle

  // Also listen for messages (for tabs.sendMessage from background)
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === 'TOGGLE_SEARCH_OVERLAY') {
      toggle()
    }
  })
}
