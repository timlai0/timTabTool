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

    container.appendChild(inputWrap)
    container.appendChild(resultsList)
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
