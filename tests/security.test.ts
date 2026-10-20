import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const EXT_ID = 'testextensionid'
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`

// In-memory chrome.storage.local shared by every module under test
let store: Record<string, any> = {}
const storageListeners: Array<(changes: any, area: string) => void> = []

function makeChromeStub() {
  return {
    runtime: {
      id: EXT_ID,
      getURL: (p: string) => `${EXT_ORIGIN}${p}`,
      lastError: undefined as any,
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
      sendMessage: vi.fn().mockResolvedValue({}),
    },
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setPopup: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      onCreated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      query: vi.fn((_q: any, cb?: (t: any[]) => void) => {
        const tabs = [{ id: 1, title: 'A', url: 'https://a.test/', active: true, windowId: 1, status: 'complete', groupId: -1 }]
        if (cb) cb(tabs)
        return Promise.resolve(tabs)
      }),
      create: vi.fn((opts: any, cb?: (t: any) => void) => {
        const tab = { id: 99, title: '', url: opts.url }
        if (cb) cb(tab)
        return Promise.resolve(tab)
      }),
      update: vi.fn(),
      remove: vi.fn((_ids: any, cb?: () => void) => {
        if (cb) cb()
        return Promise.resolve()
      }),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      onRemoved: { addListener: vi.fn() },
      getLastFocused: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn(),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: vi.fn((_q: any, cb?: (g: any[]) => void) => {
        if (cb) cb([])
        return Promise.resolve([])
      }),
    },
    scripting: {
      executeScript: vi.fn((_opts: any, cb?: (r: any[]) => void) => {
        const results = [{ result: { success: true, value: 42 } }]
        if (cb) cb(results)
        return Promise.resolve(results)
      }),
    },
    storage: {
      local: {
        get: vi.fn((keys: any, cb?: (d: any) => void) => {
          const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys]
          const out: Record<string, any> = {}
          for (const k of list) if (k in store) out[k] = structuredClone(store[k])
          if (cb) cb(out)
          return Promise.resolve(out)
        }),
        set: vi.fn((items: Record<string, any>) => {
          const changes: Record<string, any> = {}
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store[k], newValue: structuredClone(v) }
            store[k] = structuredClone(v)
          }
          storageListeners.forEach((l) => l(changes, 'local'))
          return Promise.resolve()
        }),
        remove: vi.fn((k: string) => {
          delete store[k]
          return Promise.resolve()
        }),
      },
      onChanged: { addListener: vi.fn((l: any) => storageListeners.push(l)) },
    },
  }
}

vi.stubGlobal('chrome', makeChromeStub())

const extensionPageSender = { id: EXT_ID, url: `${EXT_ORIGIN}src/popup/index.html`, origin: `chrome-extension://${EXT_ID}` } as chrome.runtime.MessageSender
const contentScriptSender = {
  id: EXT_ID,
  url: 'https://evil.test/page',
  origin: 'https://evil.test',
  tab: { id: 5, windowId: 1 } as chrome.tabs.Tab,
} as chrome.runtime.MessageSender

const settingsWithKeys = () => ({
  ai: {
    enabled: true,
    provider: 'gemini',
    apiKey: 'AIza-real-secret',
    model: 'gemini-2.5-flash',
    providerSettings: {
      gemini: { apiKey: 'AIza-real-secret', endpoint: 'https://generativelanguage.googleapis.com' },
      openai: { apiKey: 'sk-openai-secret', endpoint: 'https://api.openai.com/v1' },
      claude: { apiKey: '', endpoint: 'https://api.anthropic.com' },
    },
  },
  mcpEnabled: false,
})

beforeEach(() => {
  store = {}
})

describe('sender policy', () => {
  let policy: typeof import('../src/background/sender-policy')
  beforeAll(async () => {
    policy = await import('../src/background/sender-policy')
  })

  it('trusts extension pages and internal calls, not content scripts or foreign senders', () => {
    expect(policy.isTrustedSender(undefined)).toBe(true)
    expect(policy.isTrustedSender(extensionPageSender)).toBe(true)
    expect(policy.isTrustedSender({ ...extensionPageSender, tab: { id: 3 } as chrome.tabs.Tab })).toBe(true)
    expect(policy.isTrustedSender(contentScriptSender)).toBe(false)
    expect(policy.isTrustedSender({ ...extensionPageSender, id: 'otherext' })).toBe(false)
    expect(policy.isTrustedSender({ id: EXT_ID, url: `${EXT_ORIGIN}x.html`, origin: 'https://evil.test' })).toBe(false)
  })

  it('blocks privileged actions only for untrusted senders', () => {
    expect(policy.isActionAllowed('SAVE_SETTINGS', contentScriptSender)).toBe(false)
    expect(policy.isActionAllowed('REGENERATE_MCP_TOKEN', contentScriptSender)).toBe(false)
    expect(policy.isActionAllowed('EXPORT_KNOWN_TABS', contentScriptSender)).toBe(false)
    expect(policy.isActionAllowed('SAVE_SETTINGS', extensionPageSender)).toBe(true)
    expect(policy.isActionAllowed('SEARCH_TABS', contentScriptSender)).toBe(true)
  })

  it('redacts every API key and restores them on save', () => {
    const original = settingsWithKeys() as any
    const redacted = policy.redactSettingsSecrets(original) as any
    expect(JSON.stringify(redacted)).not.toContain('secret')
    expect(redacted.ai.apiKey).toBe(policy.REDACTED_SECRET)
    expect(redacted.ai.providerSettings.claude.apiKey).toBe('')
    expect(original.ai.apiKey).toBe('AIza-real-secret')

    redacted.ai.model = 'gemini-2.5-pro'
    const restored = policy.restoreRedactedSecrets(redacted, original) as any
    expect(restored.ai.apiKey).toBe('AIza-real-secret')
    expect(restored.ai.providerSettings.openai.apiKey).toBe('sk-openai-secret')
    expect(restored.ai.model).toBe('gemini-2.5-pro')
  })
})

describe('message router sender checks', () => {
  let handleExtensionMessage: typeof import('../src/background/message-router').handleExtensionMessage
  beforeAll(async () => {
    ;({ handleExtensionMessage } = await import('../src/background/message-router'))
  })

  it('refuses SAVE_SETTINGS from a content script and leaves settings untouched', async () => {
    store.settings = settingsWithKeys()
    const res = await handleExtensionMessage(
      { action: 'SAVE_SETTINGS', payload: { ...settingsWithKeys(), mcpEnabled: true } } as any,
      contentScriptSender,
    )
    expect(res).toEqual({ error: 'Not allowed from this context' })
    expect(store.settings.mcpEnabled).toBe(false)
  })

  it('refuses MCP token access from a content script', async () => {
    const res = await handleExtensionMessage({ action: 'GET_MCP_TOKEN' } as any, contentScriptSender)
    expect(res).toEqual({ error: 'Not allowed from this context' })
  })

  it('returns redacted settings to content scripts and real ones to extension pages', async () => {
    store.settings = settingsWithKeys()
    const fromPage: any = await handleExtensionMessage({ action: 'GET_SETTINGS' } as any, contentScriptSender)
    expect(JSON.stringify(fromPage)).not.toContain('secret')
    expect(fromPage.ai.apiKey).toBeTruthy()

    const fromPopup: any = await handleExtensionMessage({ action: 'GET_SETTINGS' } as any, extensionPageSender)
    expect(fromPopup.ai.apiKey).toBe('AIza-real-secret')
  })

  it('does not leak API keys through the overlay metrics', async () => {
    store.settings = settingsWithKeys()
    const res: any = await handleExtensionMessage({ action: 'GET_SEARCH_OVERLAY_METRICS', payload: { windowId: 1 } } as any, contentScriptSender)
    expect(JSON.stringify(res.aiSettings)).not.toContain('secret')
    expect(res.aiSettings.apiKey).toBeTruthy()
  })

  it('never overwrites real keys when redacted settings are saved back', async () => {
    store.settings = settingsWithKeys()
    const redacted: any = await handleExtensionMessage({ action: 'GET_SETTINGS' } as any, contentScriptSender)
    await handleExtensionMessage({ action: 'SAVE_SETTINGS', payload: redacted } as any, extensionPageSender)
    expect(store.settings.ai.apiKey).toBe('AIza-real-secret')
    expect(store.settings.ai.providerSettings.openai.apiKey).toBe('sk-openai-secret')
  })

  it('lets the overlay change only the model via SET_AI_MODEL', async () => {
    store.settings = settingsWithKeys()
    const ok = await handleExtensionMessage(
      { action: 'SET_AI_MODEL', payload: { model: 'gpt-4o', provider: 'openai', maxTokens: 16384 } } as any,
      contentScriptSender,
    )
    expect(ok).toEqual({ ok: true })
    expect(store.settings.ai.model).toBe('gpt-4o')
    expect(store.settings.ai.provider).toBe('openai')
    expect(store.settings.ai.apiKey).toBe('AIza-real-secret')

    const bad = await handleExtensionMessage(
      { action: 'SET_AI_MODEL', payload: { model: 'x', provider: 'evil', maxTokens: 1 } } as any,
      contentScriptSender,
    )
    expect(bad).toEqual({ error: 'Invalid provider' })
  })

  it('refuses script and file URLs in OPEN_URL from content scripts', async () => {
    const res = await handleExtensionMessage({ action: 'OPEN_URL', payload: { url: 'file:///etc/passwd' } } as any, contentScriptSender)
    expect(res).toEqual({ error: 'URL scheme not allowed' })
  })
})

describe('AI log secret redaction', () => {
  let logger: typeof import('../src/shared/ai-logger')
  beforeAll(async () => {
    logger = await import('../src/shared/ai-logger')
  })

  it('redacts query-string keys and bearer tokens', () => {
    expect(logger.redactSecrets('https://x/v1beta/models/m:generateContent?key=AIzaSECRET&alt=sse'))
      .toBe('https://x/v1beta/models/m:generateContent?key=[REDACTED]&alt=sse')
    expect(logger.redactSecrets('Authorization: Bearer sk-abc.def')).toBe('Authorization: Bearer [REDACTED]')
    expect(logger.redactSecrets('{"x-api-key":"sk-ant-123"}')).toBe('{"x-api-key":"[REDACTED]"}')
    expect(logger.redactSecrets(undefined)).toBeUndefined()
  })

  it('scrubs keys from logs that were stored before redaction existed', async () => {
    store.aiOperationLogs = [{
      id: 'log_1',
      timestamp: Date.now(),
      status: 'COMPLETED',
      steps: [],
      rawRequests: [{ batchIndex: 0, endpoint: 'https://g/v1beta/models/m:generateContent?key=AIzaLEAKED' }],
      rawResponses: [],
    }]
    const logs = await logger.AILogger.getLogs()
    expect(logs[0].rawRequests[0].endpoint).not.toContain('AIzaLEAKED')
    expect(JSON.stringify(store.aiOperationLogs)).not.toContain('AIzaLEAKED')
  })
})

describe('Gemini API key transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('chrome', makeChromeStub())
  })

  it('fetchGoogleModels sends the key as a header, not in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchGoogleModels } = await import('../src/shared/ai-providers')
    await fetchGoogleModels('AIzaSECRET')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).not.toContain('AIzaSECRET')
    expect(url).not.toContain('key=')
    expect(init.headers['x-goog-api-key']).toBe('AIzaSECRET')
  })
})

describe('MCP bridge', () => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = []
    readyState = 0
    sent: any[] = []
    closedWith: number | null = null
    onopen: (() => void) | null = null
    onclose: ((e: any) => void) | null = null
    onerror: ((e: any) => void) | null = null
    onmessage: ((e: any) => Promise<void> | void) | null = null
    constructor(public url: string) {
      FakeWebSocket.instances.push(this)
    }
    send(data: string) {
      this.sent.push(JSON.parse(data))
    }
    close(code?: number) {
      this.closedWith = code ?? 1000
      this.readyState = 3
    }
    open() {
      this.readyState = 1
      this.onopen?.()
    }
    async receive(msg: any) {
      await this.onmessage?.({ data: JSON.stringify(msg) })
    }
  }

  let bridge: typeof import('../src/background/mcp-bridge')

  beforeAll(async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    bridge = await import('../src/background/mcp-bridge')
  })

  beforeEach(() => {
    FakeWebSocket.instances = []
  })

  async function connectBridge(): Promise<FakeWebSocket> {
    store.settings = { mcpEnabled: true, mcpPort: 8585 }
    bridge.initMCPBridge()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    ws.open()
    return ws
  }

  it('ignores commands until the server authenticates and closes on unauthenticated messages', async () => {
    const ws = await connectBridge()
    await ws.receive({ id: 1, command: 'list_tabs' })
    expect(ws.sent.find((m) => m.id === 1)).toBeUndefined()
    expect(ws.closedWith).toBe(4401)
    expect(bridge.getMCPStatus().state).not.toBe('connected')
  })

  it('rejects a wrong token', async () => {
    const ws = await connectBridge()
    await ws.receive({ type: 'auth', token: 'f'.repeat(64) })
    expect(ws.sent).toContainEqual(expect.objectContaining({ type: 'auth_failed' }))
    expect(ws.closedWith).toBe(4401)
  })

  it('accepts the stored token and then runs commands', async () => {
    const token = await bridge.getOrCreateMCPToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const ws = await connectBridge()
    await ws.receive({ type: 'auth', token })
    expect(ws.sent).toContainEqual({ type: 'auth_ok' })
    expect(bridge.getMCPStatus().state).toBe('connected')

    await ws.receive({ id: 7, command: 'list_tabs' })
    expect(ws.sent).toContainEqual(expect.objectContaining({ id: 7, success: true }))
  })

  it('keeps the same token across calls and changes it on regenerate', async () => {
    const first = await bridge.getOrCreateMCPToken()
    expect(await bridge.getOrCreateMCPToken()).toBe(first)
    const next = await bridge.regenerateMCPToken()
    expect(next).not.toBe(first)
    expect(store.mcpAuthToken).toBe(next)
  })

  it('refuses execute_script unless explicitly enabled', async () => {
    store.settings = { mcpEnabled: false, mcpAllowScriptExecution: false }
    bridge.initMCPBridge()
    await expect(bridge.handleMCPCommand('execute_script', { tabId: 1, script: '1+1' })).rejects.toThrow(/disabled/)
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('validates create_tab URLs and tab IDs', async () => {
    await expect(bridge.handleMCPCommand('create_tab', { url: 'javascript:alert(1)' })).rejects.toThrow(/http/)
    await expect(bridge.handleMCPCommand('create_tab', { url: 'file:///C:/secret.txt' })).rejects.toThrow(/http/)
    await expect(bridge.handleMCPCommand('close_tabs', { tabIds: ['1; drop'] })).rejects.toThrow(/Invalid tabId/)
    await expect(bridge.handleMCPCommand('get_tab_content', { tabId: -3 })).rejects.toThrow(/Invalid tabId/)
    await expect(bridge.handleMCPCommand('create_tab', { url: 'https://example.com' })).resolves.toMatchObject({ url: 'https://example.com/' })
  })
})
