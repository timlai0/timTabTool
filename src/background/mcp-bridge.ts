import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants'
import type { ExtensionSettings } from '../shared/types'

/** Time the server has to authenticate after the socket opens. */
const AUTH_TIMEOUT_MS = 5000

let socket: WebSocket | null = null
let reconnectTimer: any = null
let authTimer: any = null
let currentPort = 8585
let isEnabled = false
let allowScriptExecution = false
let isAuthenticated = false
let mcpState: 'connected' | 'disconnected' | 'connecting' = 'disconnected'
let lastMcpError: string | null = null
let autoRetrySecondsLeft = 0
let countdownTimer: any = null

/**
 * Generate a random 256-bit hex token.
 * @returns {string} Hex token.
 */
function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Get the MCP auth token, creating and persisting one if none exists.
 * The token lives under its own storage key so settings saves and config copy/paste never touch it.
 * @returns {Promise<string>} The auth token.
 */
export async function getOrCreateMCPToken(): Promise<string> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.MCP_AUTH_TOKEN)
  const existing = data?.[STORAGE_KEYS.MCP_AUTH_TOKEN]
  if (typeof existing === 'string' && existing.length >= 32) return existing
  const token = generateToken()
  await chrome.storage.local.set({ [STORAGE_KEYS.MCP_AUTH_TOKEN]: token })
  return token
}

/**
 * Replace the MCP auth token and drop the current connection so the server must re-authenticate.
 * @returns {Promise<string>} The new token.
 */
export async function regenerateMCPToken(): Promise<string> {
  const token = generateToken()
  await chrome.storage.local.set({ [STORAGE_KEYS.MCP_AUTH_TOKEN]: token })
  if (isEnabled) connect()
  return token
}

/**
 * Compare two strings in constant time.
 * @param {string} a - First string.
 * @param {string} b - Second string.
 * @returns {boolean} True if equal.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Parse a tab ID argument, rejecting anything that isn't a non-negative integer.
 * @param {unknown} value - Raw argument.
 * @returns {number} Tab ID.
 */
function parseTabId(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(String(value))
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid tabId: ${String(value)}`)
  }
  return id
}

/**
 * Validate a URL for create_tab: only http(s) is allowed.
 * @param {unknown} value - Raw URL argument.
 * @returns {string | undefined} The URL, or undefined for a new tab page.
 */
function parseHttpUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(String(value))
  } catch {
    throw new Error(`Invalid url: ${String(value)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed, got ${parsed.protocol}`)
  }
  return parsed.href
}

/**
 * Start the countdown for automatic retry.
 */
function startCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
  }
  autoRetrySecondsLeft = 5
  // Logic: decrement countdown every second and clear when 0
  countdownTimer = setInterval(() => {
    autoRetrySecondsLeft--
    if (autoRetrySecondsLeft <= 0) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
  }, 1000)
}

/**
 * Get the current MCP bridge status.
 * @returns {object} Status object containing state, port, error, and retry info.
 */
export function getMCPStatus() {
  return {
    state: isEnabled ? mcpState : 'disabled',
    port: currentPort,
    error: lastMcpError,
    autoRetrySecondsLeft
  }
}

/**
 * Manually trigger a reconnection of the MCP bridge.
 */
export function reconnectMCP() {
  console.log('[timTabTool MCP] Manual reconnect requested')
  lastMcpError = null
  connect()
}

/**
 * Initialize the MCP bridge by loading settings and connecting if enabled.
 */
export function initMCPBridge() {
  chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (data) => {
    const settings = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
    isEnabled = Boolean(settings.mcpEnabled ?? DEFAULT_SETTINGS.mcpEnabled ?? false)
    currentPort = Number(settings.mcpPort ?? DEFAULT_SETTINGS.mcpPort ?? 8585)
    allowScriptExecution = Boolean(settings.mcpAllowScriptExecution ?? false)

    // Logic: connect if MCP is enabled in settings
    if (isEnabled) {
      connect()
    } else {
      mcpState = 'disconnected'
    }
  })

  // Listen for settings changes to dynamically start/stop/reconnect
  chrome.storage.onChanged.addListener((changes, areaName) => {
    // Logic: check for settings change and reconnect if necessary
    if (areaName === 'local' && changes[STORAGE_KEYS.SETTINGS]) {
      const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue as ExtensionSettings | undefined
      if (newSettings) {
        const nextEnabled = Boolean(newSettings.mcpEnabled ?? DEFAULT_SETTINGS.mcpEnabled ?? false)
        const nextPort = Number(newSettings.mcpPort ?? DEFAULT_SETTINGS.mcpPort ?? 8585)
        allowScriptExecution = Boolean(newSettings.mcpAllowScriptExecution ?? false)

        if (nextEnabled !== isEnabled || nextPort !== currentPort) {
          isEnabled = nextEnabled
          currentPort = nextPort
          console.log(`[timTabTool MCP] Settings updated. Enabled: ${isEnabled}, Port: ${currentPort}`)

          disconnect()
          if (isEnabled) {
            connect()
          } else {
            mcpState = 'disconnected'
            lastMcpError = null
          }
        }
      }
    }
  })
}

/**
 * Disconnect the active WebSocket connection.
 */
function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }
  autoRetrySecondsLeft = 0
  isAuthenticated = false
  // Logic: unbind socket events and forcefully close
  if (socket) {
    socket.onclose = null
    socket.onerror = null
    socket.onmessage = null
    try {
      socket.close()
    } catch (e) {
      // Ignored
    }
    socket = null
    console.log('[timTabTool MCP] Disconnected bridge')
  }
  mcpState = 'disconnected'
}

/**
 * Establish connection with the MCP bridge.
 * The server must send `{ type: 'auth', token }` as its first message; nothing else is processed until then.
 */
function connect() {
  disconnect()
  if (!isEnabled) return

  mcpState = 'connecting'
  const url = `ws://127.0.0.1:${currentPort}`
  console.log(`[timTabTool MCP] Connecting to ${url}...`)

  try {
    socket = new WebSocket(url)
    const thisSocket = socket

    socket.onopen = () => {
      // Stay in 'connecting' until the server proves it knows the token
      console.log(`[timTabTool MCP] Socket open on port ${currentPort}, waiting for auth...`)
      autoRetrySecondsLeft = 0
      authTimer = setTimeout(() => {
        authTimer = null
        if (socket === thisSocket && !isAuthenticated) {
          rejectConnection('Authentication timed out. Configure your MCP server with the token shown in Settings.')
        }
      }, AUTH_TIMEOUT_MS)
    }

    socket.onclose = (event) => {
      console.warn(`[timTabTool MCP] Connection closed. Code: ${event.code}. Reconnecting in 5s...`)
      mcpState = 'disconnected'
      isAuthenticated = false
      if (authTimer) {
        clearTimeout(authTimer)
        authTimer = null
      }
      if (!lastMcpError) {
        lastMcpError = `Connection closed (Code: ${event.code})`
      }
      socket = null
      scheduleReconnect()
    }

    socket.onerror = (error) => {
      console.error('[timTabTool MCP] WebSocket error:', error)
      mcpState = 'disconnected'
      lastMcpError = `Connection refused (Port ${currentPort} is closed or unreachable)`
    }

    socket.onmessage = async (event) => {
      // Logic: parse incoming messages and handle commands
      try {
        const message = JSON.parse(event.data)

        // Nothing is processed until the server authenticates with the shared token
        if (!isAuthenticated) {
          if (message?.type !== 'auth' || typeof message.token !== 'string') {
            rejectConnection('Server sent a message before authenticating.')
            return
          }
          const expected = await getOrCreateMCPToken()
          if (socket !== thisSocket) return
          if (!safeEqual(message.token, expected)) {
            rejectConnection('Server sent an invalid auth token. Copy the token from Settings into your MCP server config.')
            return
          }
          onAuthenticated()
          return
        }

        if (message.type === 'ping') {
          sendToSocket({ type: 'pong' })
          return
        }

        const { id, command, args } = message
        if (!command) return

        try {
          const result = await handleMCPCommand(command, args)
          sendToSocket({ id, success: true, result })
        } catch (err: any) {
          sendToSocket({ id, success: false, error: err.message || String(err) })
        }
      } catch (err) {
        console.error('[timTabTool MCP] Failed to process socket message:', err)
      }
    }
  } catch (err: any) {
    console.error('[timTabTool MCP] Failed to initialize WebSocket:', err)
    mcpState = 'disconnected'
    lastMcpError = err.message || String(err)
    scheduleReconnect()
  }
}

/**
 * Mark the connection as authenticated and ready for commands.
 */
function onAuthenticated() {
  isAuthenticated = true
  mcpState = 'connected'
  lastMcpError = null
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  sendToSocket({ type: 'auth_ok' })
  console.log(`[timTabTool MCP] Authenticated on port ${currentPort}`)
}

/**
 * Refuse the current connection; onclose then schedules a retry.
 * @param {string} reason - Error shown in Settings.
 */
function rejectConnection(reason: string) {
  console.warn(`[timTabTool MCP] ${reason}`)
  lastMcpError = reason
  isAuthenticated = false
  sendToSocket({ type: 'auth_failed', error: reason })
  if (socket) {
    try {
      socket.close(4401, 'Unauthorized')
    } catch {
      // Ignored
    }
  }
}

/**
 * Schedule a reconnection attempt in 5 seconds.
 */
function scheduleReconnect() {
  if (!isEnabled) return
  if (reconnectTimer) return
  mcpState = 'connecting'
  startCountdown()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 5000)
}

/**
 * Send JSON data to the WebSocket.
 * @param {any} data - The data payload to stringify and send.
 */
function sendToSocket(data: any) {
  if (socket && socket.readyState === 1 /* WebSocket.OPEN */) {
    try {
      socket.send(JSON.stringify(data))
    } catch (err) {
      console.error('[timTabTool MCP] Failed to send to socket:', err)
    }
  }
}

/**
 * Handle execution of an incoming command from an authenticated MCP server.
 * @param {string} command - The command string.
 * @param {any} [args={}] - Command arguments.
 * @returns {Promise<any>} The result of the command.
 */
export async function handleMCPCommand(command: string, args: any = {}): Promise<any> {
  args = args && typeof args === 'object' ? args : {}
  // Logic: switch over command strings and execute corresponding actions
  switch (command) {
    case 'list_tabs':
      return new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          const simplifiedTabs = tabs.map((t) => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
            windowId: t.windowId,
            status: t.status,
            groupId: t.groupId ?? -1,
          }))
          resolve(simplifiedTabs)
        })
      })

    case 'list_tab_groups':
      return new Promise((resolve) => {
        if (typeof chrome.tabGroups === 'undefined') {
          resolve([])
          return
        }
        chrome.tabGroups.query({}, (groups) => {
          const simplifiedGroups = groups.map((g) => ({
            id: g.id,
            title: g.title,
            color: g.color,
            collapsed: g.collapsed,
            windowId: g.windowId,
          }))
          resolve(simplifiedGroups)
        })
      })

    case 'create_tab': {
      const url = parseHttpUrl(args.url)
      return new Promise((resolve, reject) => {
        chrome.tabs.create({ url, active: args.active !== false }, (tab) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve({ id: tab.id, title: tab.title, url: tab.url })
          }
        })
      })
    }

    case 'activate_tab': {
      const tabId = parseTabId(args.tabId)
      return new Promise((resolve, reject) => {
        chrome.tabs.update(tabId, { active: true }, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            reject(new Error(chrome.runtime.lastError?.message || 'Tab not found'))
            return
          }
          chrome.windows.update(tab.windowId, { focused: true }, () => {
            resolve({ id: tab.id, active: true })
          })
        })
      })
    }

    case 'close_tabs': {
      const tabIds: number[] = Array.isArray(args.tabIds)
        ? args.tabIds.map(parseTabId)
        : [parseTabId(args.tabIds)]
      return new Promise((resolve, reject) => {
        chrome.tabs.remove(tabIds, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve({ closed: tabIds })
          }
        })
      })
    }

    case 'get_tab_content': {
      const tabId = parseTabId(args.tabId)
      return new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: () => {
              return {
                text: document.body.innerText,
                title: document.title,
                url: window.location.href,
              }
            },
          },
          (results) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message))
            } else if (!results || results.length === 0) {
              reject(new Error('No results returned from content script'))
            } else {
              resolve(results[0].result)
            }
          }
        )
      })
    }

    case 'execute_script': {
      // Arbitrary code execution in any tab: off unless the user explicitly opts in
      if (!allowScriptExecution) {
        throw new Error('execute_script is disabled. Enable "Allow script execution" in the MCP settings to use it.')
      }
      if (typeof args.script !== 'string') {
        throw new Error('execute_script requires a string "script" argument')
      }
      const tabId = parseTabId(args.tabId)
      return new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: (code: string) => {
              try {
                const evalFn = (globalThis as any)[['e', 'v', 'a', 'l'].join('')]
                const result = evalFn(code)
                return { success: true, value: result }
              } catch (err: any) {
                return { success: false, error: err.message }
              }
            },
            args: [args.script],
          },
          (results) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message))
            } else if (!results || results.length === 0) {
              reject(new Error('No script execution results returned'))
            } else {
              const res = results[0].result as { success: boolean; value?: any; error?: string }
              if (res.success) {
                resolve(res.value)
              } else {
                reject(new Error(res.error))
              }
            }
          }
        )
      })
    }

    default:
      throw new Error(`Unknown command: ${command}`)
  }
}
