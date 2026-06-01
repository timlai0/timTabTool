import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants'
import type { ExtensionSettings } from '../shared/types'

let socket: WebSocket | null = null
let reconnectTimer: any = null
let currentPort = 8585
let isEnabled = false
let mcpState: 'connected' | 'disconnected' | 'connecting' = 'disconnected'
let lastMcpError: string | null = null
let autoRetrySecondsLeft = 0
let countdownTimer: any = null

function startCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
  }
  autoRetrySecondsLeft = 5
  countdownTimer = setInterval(() => {
    autoRetrySecondsLeft--
    if (autoRetrySecondsLeft <= 0) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
  }, 1000)
}

export function getMCPStatus() {
  return {
    state: isEnabled ? mcpState : 'disabled',
    port: currentPort,
    error: lastMcpError,
    autoRetrySecondsLeft
  }
}

export function reconnectMCP() {
  console.log('[timTabTool MCP] Manual reconnect requested')
  lastMcpError = null
  connect()
}

export function initMCPBridge() {
  chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (data) => {
    const settings = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
    isEnabled = settings.mcpEnabled !== false
    currentPort = settings.mcpPort ?? 8585

    if (isEnabled) {
      connect()
    } else {
      mcpState = 'disconnected'
    }
  })

  // Listen for settings changes to dynamically start/stop/reconnect
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEYS.SETTINGS]) {
      const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue as ExtensionSettings | undefined
      if (newSettings) {
        const nextEnabled = newSettings.mcpEnabled !== false
        const nextPort = newSettings.mcpPort ?? 8585

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

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  autoRetrySecondsLeft = 0
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

function connect() {
  disconnect()
  if (!isEnabled) return
  
  mcpState = 'connecting'
  const url = `ws://127.0.0.1:${currentPort}`
  console.log(`[timTabTool MCP] Connecting to ${url}...`)

  try {
    socket = new WebSocket(url)

    socket.onopen = () => {
      console.log(`[timTabTool MCP] Connected successfully on port ${currentPort}!`)
      mcpState = 'connected'
      lastMcpError = null
      autoRetrySecondsLeft = 0
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (countdownTimer) {
        clearInterval(countdownTimer)
        countdownTimer = null
      }
    }

    socket.onclose = (event) => {
      console.warn(`[timTabTool MCP] Connection closed. Code: ${event.code}. Reconnecting in 5s...`)
      mcpState = 'disconnected'
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
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'ping') {
          sendToSocket({ type: 'pong' })
          return
        }

        const { id, command, args } = message
        if (!command) return

        try {
          const result = await handleCommand(command, args)
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

function sendToSocket(data: any) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(data))
    } catch (err) {
      console.error('[timTabTool MCP] Failed to send to socket:', err)
    }
  }
}

async function handleCommand(command: string, args: any = {}): Promise<any> {
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

    case 'create_tab':
      return new Promise((resolve, reject) => {
        chrome.tabs.create({ url: args.url, active: args.active !== false }, (tab) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve({ id: tab.id, title: tab.title, url: tab.url })
          }
        })
      })

    case 'activate_tab':
      return new Promise((resolve, reject) => {
        const tabId = parseInt(args.tabId, 10)
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

    case 'close_tabs':
      return new Promise((resolve, reject) => {
        const tabIds = Array.isArray(args.tabIds)
          ? args.tabIds.map((id: any) => parseInt(id, 10))
          : [parseInt(args.tabIds, 10)]
        chrome.tabs.remove(tabIds, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve({ closed: tabIds })
          }
        })
      })

    case 'get_tab_content':
      return new Promise((resolve, reject) => {
        const tabId = parseInt(args.tabId, 10)
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

    case 'execute_script':
      return new Promise((resolve, reject) => {
        const tabId = parseInt(args.tabId, 10)
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: (code: string) => {
              try {
                // eslint-disable-next-line no-eval
                const result = eval(code)
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

    default:
      throw new Error(`Unknown command: ${command}`)
  }
}
