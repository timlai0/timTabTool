<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, toRaw, nextTick } from 'vue'
import { getMessage } from '../../shared/i18n'
import { DEFAULT_SETTINGS, STORAGE_KEYS, DEFAULT_GROUPING_PROMPT, DEFAULT_SPLIT_PROMPT, DEFAULT_CLASSIFY_PROMPT, DEFAULT_MERGE_PROMPT, DEFAULT_WINDOW_NAMING_PROMPT, PREDEFINED_MODELS, DEFAULT_ENDPOINTS, DEFAULT_MODELS, MODEL_PRICING, PROVIDER_DEFAULTS, OPENROUTER_PROVIDERS } from '../../shared/constants'
import { getAutoBatchSize, parseMaxTokensToNumber, formatTimeAgo, formatMarkdown } from '../../shared/utils'
import type { ExtensionSettings, AIOperationLogEntry, AILogRawResponse, AIProvider, OpenRouterProviderItem, ClosedTabEntry } from '../../shared/types'
import { getClosedTabs, restoreClosedTab, restoreAllClosedTabs, removeClosedTab, clearClosedTabs, restoreClosedBatch, removeClosedBatch } from '../../shared/closed-tabs-manager'
import type { TabExportScope, TabExportFormat } from '../../shared/tab-exporter'
import { AIClient, SYSTEM_PROMPT, fetchGoogleModels, fetchOpenRouterModels, fetchOpenRouterProviders, fetchOpenRouterKeyInfo, isFreeModel } from '../../shared/ai-client'
import { APP_VERSION, BUILD_NUMBER, BUILD_HASH, BUILD_TIME } from '../../shared/version'

const props = defineProps<{
  isStandaloneSearch?: boolean
}>()

/**
 * Emitted events for SettingsView.
 */
const emit = defineEmits<{
  /** Triggered to navigate back to the main view. */
  back: []
}>()

const vFocus = {
  mounted: (el: HTMLElement) => el.focus()
}

const settings = ref<ExtensionSettings>({ ...DEFAULT_SETTINGS })
const saved = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; error?: string } | null>(null)
const popupShortcut = ref('Ctrl+Shift+S')
const searchShortcut = ref('Ctrl+Shift+F')
const searchSlashShortcut = ref('Ctrl+Shift+7')
const advancedPromptsExpanded = ref(false)
const connectionSettingsExpanded = ref(false)

const activePromptTab = ref<'grouping' | 'coherence' | 'split' | 'classify' | 'merge' | 'windowNaming' | 'custom' | 'all'>('grouping')

const promptTabs = computed(() => [
  {
    id: 'grouping' as const,
    label: 'Grouping',
    isCustomized: settings.value.ai.groupingPrompt !== DEFAULT_GROUPING_PROMPT
  },
  {
    id: 'coherence' as const,
    label: 'Coherence',
    isCustomized: settings.value.ai.coherencePrompt !== DEFAULT_SETTINGS.ai.coherencePrompt
  },
  {
    id: 'split' as const,
    label: 'Split',
    isCustomized: settings.value.ai.splitPrompt !== DEFAULT_SPLIT_PROMPT
  },
  {
    id: 'classify' as const,
    label: 'Add Tabs',
    isCustomized: settings.value.ai.classifyPrompt !== DEFAULT_CLASSIFY_PROMPT
  },
  {
    id: 'merge' as const,
    label: 'Merge',
    isCustomized: settings.value.ai.mergePrompt !== DEFAULT_MERGE_PROMPT
  },
  {
    id: 'windowNaming' as const,
    label: 'Window Naming',
    isCustomized: settings.value.ai.windowNamingPrompt !== DEFAULT_WINDOW_NAMING_PROMPT
  },
  {
    id: 'custom' as const,
    label: 'Custom',
    isCustomized: Boolean(settings.value.ai.customPrompt && settings.value.ai.customPrompt.trim())
  }
])

watch([advancedPromptsExpanded, activePromptTab], () => {
  nextTick(() => {
    const textareas = document.querySelectorAll<HTMLTextAreaElement>('.advanced-prompts-wrapper textarea')
    textareas.forEach((ta) => {
      ta.style.height = 'auto'
      if (ta.scrollHeight > 0) {
        ta.style.height = Math.max(activePromptTab.value === 'all' ? 64 : 110, ta.scrollHeight) + 'px'
      }
    })
  })
})

// MCP Status & Reconnection refs
const mcpStatus = ref({ state: 'disabled', port: 8585, error: null as string | null, autoRetrySecondsLeft: 0 })
const reconnecting = ref(false)
let statusPollInterval: any = null

/**
 * Fetches the current MCP status from the background script.
 * @returns {Promise<void>}
 */
async function updateMCPStatus(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_MCP_STATUS' })
    if (res && res.state) {
      mcpStatus.value = res
    }
  } catch (err) {
    // Ignore error
  }
}

/**
 * Triggers an MCP reconnection attempt.
 * @returns {Promise<void>}
 */
async function triggerReconnect(): Promise<void> {
  reconnecting.value = true
  try {
    await chrome.runtime.sendMessage({ action: 'RECONNECT_MCP' })
    setTimeout(async () => {
      await updateMCPStatus()
      reconnecting.value = false
    }, 1200)
  } catch (err) {
    reconnecting.value = false
  }
}

// MCP auth token (stored separately from settings, so config copy/paste never includes it)
const mcpToken = ref('')
const mcpTokenVisible = ref(false)
const mcpTokenCopied = ref(false)

/**
 * Loads the MCP auth token from the background script.
 * @returns {Promise<void>}
 */
async function loadMCPToken(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_MCP_TOKEN' })
    if (res?.token) mcpToken.value = res.token
  } catch (err) {
    // Ignore error
  }
}

/**
 * Copies the MCP auth token to the clipboard.
 * @returns {Promise<void>}
 */
async function copyMCPToken(): Promise<void> {
  if (!mcpToken.value) return
  await navigator.clipboard.writeText(mcpToken.value)
  mcpTokenCopied.value = true
  setTimeout(() => {
    mcpTokenCopied.value = false
  }, 1500)
}

/**
 * Replaces the MCP auth token; connected servers must re-authenticate with the new one.
 * @returns {Promise<void>}
 */
async function regenerateMCPToken(): Promise<void> {
  if (!confirm('Generate a new MCP token? Your MCP server will be disconnected until you update its token.')) return
  const res = await chrome.runtime.sendMessage({ action: 'REGENERATE_MCP_TOKEN' })
  if (res?.token) mcpToken.value = res.token
}

const copyText = ref('Copy Config')
const pasteText = ref('Paste Config')
const backupError = ref('')

const vAutoresize = {
  mounted: (el: HTMLTextAreaElement) => {
    const resize = () => {
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
    el.addEventListener('input', resize)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(resize)
      ro.observe(el)
      ;(el as any)._ro = ro
    }
    setTimeout(resize, 0)
  },
  updated: (el: HTMLTextAreaElement) => {
    const resize = () => {
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
    setTimeout(resize, 0)
  },
  unmounted: (el: HTMLTextAreaElement) => {
    if ((el as any)._ro) {
      (el as any)._ro.disconnect()
    }
  }
}

const fetchingGoogleModels = ref(false)
const fetchModelsMessage = ref<string | null>(null)
const fetchModelsError = ref<string | null>(null)

const fetchingOpenRouterModels = ref(false)
const fetchOpenRouterMessage = ref<string | null>(null)
const fetchOpenRouterError = ref<string | null>(null)

const fetchingOpenRouterProviders = ref(false)
const fetchOpenRouterProvidersMessage = ref<string | null>(null)
const fetchOpenRouterProvidersError = ref<string | null>(null)
const isCustomOpenRouterProviderSelected = ref(false)

const fetchingOpenRouterKeyInfo = ref(false)
const fetchOpenRouterKeyInfoMessage = ref<string | null>(null)
const fetchOpenRouterKeyInfoError = ref<string | null>(null)

const openRouterModelSearchQuery = ref('')
const openRouterCategoryFilter = ref<'all' | 'free' | 'thinking' | 'byok'>('all')

function openExternalUrl(url: string): void {
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    chrome.tabs.create({ url })
  } else {
    window.open(url, '_blank')
  }
}

/**
 * Autocompletes token parameters based on the selected AI model.
 * @param {string | undefined} modelId - The model ID.
 * @param {any[]} [customList] - Optional custom list of models.
 */
function autoFillModelParams(modelId: string | undefined, customList?: any[]): void {
  const list = customList || currentProviderModels.value || []
  const targetId = modelId || settings.value.ai.model || (settings.value.ai.provider === 'openrouter' && settings.value.ai.openRouterOnlyFree ? 'stealth/ox-alpha' : (DEFAULT_MODELS[settings.value.ai.provider] || (list[0]?.id ?? '')))
  if (!targetId) return

  const selected = list.find((m: any) => m.id === targetId)
  if (selected) {
    const rawTokens = (selected as any).rawMaxOutputTokens || parseMaxTokensToNumber(selected.maxTokens)
    const tokens = Math.min(rawTokens, 65536)
    settings.value.ai.maxTokens = tokens
    settings.value.ai.batchSize = getAutoBatchSize(tokens)
  } else {
    const provider = settings.value.ai.provider
    let tokens = 16384
    if (provider === 'gemini') tokens = 65536
    else if (provider === 'claude') tokens = 8192
    else if (targetId === 'stealth/ox-alpha') tokens = 32768
    settings.value.ai.maxTokens = tokens
    settings.value.ai.batchSize = getAutoBatchSize(tokens)
  }
}

/**
 * Fetches the available models from the Google API using the configured API key.
 * @returns {Promise<void>}
 */
async function handleFetchGoogleModels(): Promise<void> {
  if (!settings.value.ai.apiKey) {
    fetchModelsError.value = 'Google API Key is required to fetch models.'
    return
  }
  fetchingGoogleModels.value = true
  fetchModelsMessage.value = null
  fetchModelsError.value = null
  try {
    const models = await fetchGoogleModels(settings.value.ai.apiKey, settings.value.ai.endpoint)
    if (!settings.value.ai.customModels) {
      settings.value.ai.customModels = {}
    }
    settings.value.ai.customModels.gemini = models
    fetchModelsMessage.value = `Loaded ${models.length} live models from Google!`
    if (!settings.value.ai.model && models.length > 0) {
      settings.value.ai.model = models[0].id
    }
    autoFillModelParams(settings.value.ai.model, models)
    await saveSettings()
  } catch (err) {
    fetchModelsError.value = (err as Error).message
  } finally {
    fetchingGoogleModels.value = false
  }
}

/**
 * Fetches the available models from the OpenRouter API.
 * @returns {Promise<void>}
 */
/**
 * Fetches the available models from the OpenRouter API.
 * @returns {Promise<void>}
 */
async function handleFetchOpenRouterModels(): Promise<void> {
  fetchingOpenRouterModels.value = true
  fetchOpenRouterMessage.value = null
  fetchOpenRouterError.value = null
  try {
    const models = await fetchOpenRouterModels(settings.value.ai.apiKey, settings.value.ai.endpoint, false)
    if (!settings.value.ai.customModels) {
      settings.value.ai.customModels = {}
    }
    settings.value.ai.customModels.openrouter = models
    const freeCount = models.filter((m: any) => isFreeModel(m.id, m)).length
    fetchOpenRouterMessage.value = `Loaded ${models.length} live models (${freeCount} free) from OpenRouter!`
    if (!settings.value.ai.model && models.length > 0) {
      settings.value.ai.model = settings.value.ai.openRouterOnlyFree ? (models.find((m: any) => isFreeModel(m.id, m))?.id || models[0].id) : models[0].id
    } else if (settings.value.ai.openRouterOnlyFree && !isFreeModel(settings.value.ai.model)) {
      settings.value.ai.model = models.find((m: any) => isFreeModel(m.id, m))?.id || 'stealth/ox-alpha'
    }
    autoFillModelParams(settings.value.ai.model, models)

    if (settings.value.ai.apiKey) {
      fetchOpenRouterKeyInfo(settings.value.ai.apiKey, settings.value.ai.endpoint)
        .then(info => {
          settings.value.ai.openRouterKeyInfo = info
          settings.value.ai.openRouterByokActive = info.isByokActive
          chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', payload: toRaw(settings.value) }).catch(() => {})
        })
        .catch(() => {})
    }

    await saveSettings()
  } catch (err) {
    fetchOpenRouterError.value = (err as Error).message
  } finally {
    fetchingOpenRouterModels.value = false
  }
}

/**
 * Fetches OpenRouter API key information, spending metrics, and BYOK status.
 * @returns {Promise<void>}
 */
async function handleFetchOpenRouterKeyInfo(): Promise<void> {
  if (!settings.value.ai.apiKey) {
    fetchOpenRouterKeyInfoError.value = 'OpenRouter API Key is required.'
    return
  }
  fetchingOpenRouterKeyInfo.value = true
  fetchOpenRouterKeyInfoMessage.value = null
  fetchOpenRouterKeyInfoError.value = null
  try {
    const info = await fetchOpenRouterKeyInfo(settings.value.ai.apiKey, settings.value.ai.endpoint)
    settings.value.ai.openRouterKeyInfo = info
    settings.value.ai.openRouterByokActive = info.isByokActive
    if (info.isByokActive) {
      fetchOpenRouterKeyInfoMessage.value = `BYOK Active (Usage: $${(info.byokUsage || 0).toFixed(2)}${info.byokProviders?.length ? ` · Upstream: ${info.byokProviders.join(', ')}` : ''})`
    } else {
      fetchOpenRouterKeyInfoMessage.value = `Key verified. Standard billing active${typeof info.usage === 'number' ? ` (Usage: $${info.usage.toFixed(2)})` : ''}.`
    }
    await saveSettings()
  } catch (err) {
    fetchOpenRouterKeyInfoError.value = (err as Error).message
  } finally {
    fetchingOpenRouterKeyInfo.value = false
  }
}

const isOpenRouterByokActive = computed(() => {
  if (settings.value.ai.provider !== 'openrouter') return false
  return !!(settings.value.ai.openRouterByokManual || settings.value.ai.openRouterByokActive || settings.value.ai.openRouterKeyInfo?.isByokActive)
})

const KNOWN_BYOK_UPSTREAM_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'google-vertex',
  'amazon-bedrock',
  'azure',
  'mistralai',
  'together',
  'groq',
  'cohere',
]

/**
 * Evaluates whether a specific OpenRouter model runs via BYOK direct billing.
 * @param {string} [modelId] - The model identifier.
 * @returns {boolean} True if the model matches active BYOK credentials or routing.
 */
function isModelByok(modelId?: string): boolean {
  if (!modelId || settings.value.ai.provider !== 'openrouter') return false
  if (isFreeModel(modelId)) return false

  const manual = !!settings.value.ai.openRouterByokManual
  const active = !!settings.value.ai.openRouterByokActive
  const info = settings.value.ai.openRouterKeyInfo
  if (!manual && !active && !info?.isByokActive) return false

  const vendor = modelId.includes('/') ? modelId.split('/')[0].toLowerCase() : ''
  const pinnedProvider = settings.value.ai.openrouterProvider?.toLowerCase().trim()

  // 1. If provider routing is pinned to a vendor
  if (pinnedProvider && pinnedProvider !== 'auto') {
    return !vendor || vendor === pinnedProvider
  }

  // 2. If OpenRouter returned the list of configured BYOK credentials
  if (info?.byokProviders && info.byokProviders.length > 0) {
    return vendor ? info.byokProviders.includes(vendor) : true
  }

  // 3. If manual override or detected byok usage on key without granular provider list
  if (manual || (info?.byokUsage && info.byokUsage > 0) || active) {
    return !vendor || KNOWN_BYOK_UPSTREAM_PROVIDERS.includes(vendor)
  }

  return false
}

/**
 * Fetches the available providers from the OpenRouter API.
 * @returns {Promise<void>}
 */
async function handleFetchOpenRouterProviders(): Promise<void> {
  fetchingOpenRouterProviders.value = true
  fetchOpenRouterProvidersMessage.value = null
  fetchOpenRouterProvidersError.value = null
  try {
    const providers = await fetchOpenRouterProviders(settings.value.ai.apiKey, settings.value.ai.endpoint)
    if (!settings.value.ai.customProviders) {
      settings.value.ai.customProviders = {}
    }
    settings.value.ai.customProviders.openrouter = providers
    fetchOpenRouterProvidersMessage.value = `Loaded ${providers.length} live providers from OpenRouter!`
    await saveSettings()
  } catch (err) {
    fetchOpenRouterProvidersError.value = (err as Error).message
  } finally {
    fetchingOpenRouterProviders.value = false
  }
}

const currentOpenRouterProviders = computed(() => {
  const custom = settings.value.ai.customProviders?.openrouter || []
  const combined = [...OPENROUTER_PROVIDERS]
  for (const p of custom) {
    if (!combined.some(existing => existing.slug.toLowerCase() === p.slug.toLowerCase())) {
      combined.push(p)
    }
  }
  return combined.sort((a, b) => a.name.localeCompare(b.name))
})

const isOpenRouterPredefinedProvider = computed(() => {
  const providers = currentOpenRouterProviders.value
  return (slug: string | undefined) => !!slug && providers.some(p => p.slug === slug)
})

const openRouterProviderSelectValue = computed({
  get() {
    if (isCustomOpenRouterProviderSelected.value) {
      return 'custom'
    }
    const val = settings.value.ai.openrouterProvider
    if (!val || val === 'auto') {
      return ''
    }
    if (isOpenRouterPredefinedProvider.value(val)) {
      return val
    }
    isCustomOpenRouterProviderSelected.value = true
    return 'custom'
  },
  set(newValue) {
    if (newValue === 'custom') {
      isCustomOpenRouterProviderSelected.value = true
      if (!settings.value.ai.openrouterProvider || isOpenRouterPredefinedProvider.value(settings.value.ai.openrouterProvider)) {
        settings.value.ai.openrouterProvider = ''
      }
    } else {
      isCustomOpenRouterProviderSelected.value = false
      settings.value.ai.openrouterProvider = newValue
    }
  }
})

const allProviderModels = computed(() => {
  const provider = settings.value.ai.provider
  if (provider === 'gemini' && settings.value.ai.customModels?.gemini?.length) {
    return settings.value.ai.customModels.gemini
  } else if (provider === 'openrouter' && settings.value.ai.customModels?.openrouter?.length) {
    return settings.value.ai.customModels.openrouter
  }
  return PREDEFINED_MODELS[provider] || []
})

const currentProviderModels = computed(() => {
  const list = allProviderModels.value
  if (settings.value.ai.provider === 'openrouter' && settings.value.ai.openRouterOnlyFree) {
    return list.filter((m: any) => isFreeModel(m.id, m))
  }
  return list
})

const filteredProviderModels = computed(() => {
  const baseList = allProviderModels.value
  let list: any[] = baseList
  if (settings.value.ai.provider === 'openrouter') {
    if (openRouterCategoryFilter.value === 'free' || settings.value.ai.openRouterOnlyFree) {
      list = list.filter((m: any) => isFreeModel(m.id, m))
    } else if (openRouterCategoryFilter.value === 'thinking') {
      list = list.filter((m: any) => {
        const id = (m.id || '').toLowerCase()
        return id.includes('r1') || id.includes('thinking') || id.includes('o1') || id.includes('o3') || id.includes('ox-alpha') || id.includes('qwq')
      })
    } else if (openRouterCategoryFilter.value === 'byok') {
      list = list.filter((m: any) => isModelByok(m.id))
    }
    if (openRouterModelSearchQuery.value.trim()) {
      const q = openRouterModelSearchQuery.value.toLowerCase().trim()
      list = list.filter((m: any) =>
        (m.id && m.id.toLowerCase().includes(q)) ||
        (m.name && m.name.toLowerCase().includes(q))
      )
    }
  }
  return list
})

function applyOpenRouterPreset(modelId: string): void {
  settings.value.ai.model = modelId
  isCustomSelected.value = false
  autoFillModelParams(modelId)
}

const applyModelPreset = applyOpenRouterPreset

const isPredefinedModel = computed(() => {
  const models = allProviderModels.value
  return (id: string | undefined) => !!id && models.some((m: any) => m.id === id)
})

const isCustomSelected = ref(false)

const modelSelectValue = computed({
  get() {
    if (isCustomSelected.value) {
      return 'custom'
    }
    const val = settings.value.ai.model
    if (!val) {
      return ''
    }
    if (isPredefinedModel.value(val)) {
      return val
    }
    isCustomSelected.value = true
    return 'custom'
  },
  set(newValue) {
    if (newValue === 'custom') {
      isCustomSelected.value = true
      if (!settings.value.ai.model || isPredefinedModel.value(settings.value.ai.model)) {
        settings.value.ai.model = ''
      }
    } else {
      isCustomSelected.value = false
      settings.value.ai.model = newValue
      autoFillModelParams(newValue)
    }
  }
})

const modelPlaceholder = computed(() => {
  if (settings.value.ai.provider === 'openrouter' && settings.value.ai.openRouterOnlyFree) {
    return 'stealth/ox-alpha'
  }
  return DEFAULT_MODELS[settings.value.ai.provider] || 'gpt-4o-mini'
})

const currentModelDefaultMaxTokens = computed(() => {
  const provider = settings.value.ai.provider
  const targetId = settings.value.ai.model || (provider === 'openrouter' && settings.value.ai.openRouterOnlyFree ? 'stealth/ox-alpha' : (DEFAULT_MODELS[provider] || ''))
  const models = currentProviderModels.value || []
  const found = models.find((m: any) => m.id === targetId)
  if (found) {
    const rawTokens = (found as any).rawMaxOutputTokens || parseMaxTokensToNumber(found.maxTokens)
    return Math.min(rawTokens, 65536)
  }
  if (provider === 'gemini') return 65536
  if (provider === 'claude') return 8192
  if (provider === 'openrouter' && (targetId === 'stealth/ox-alpha' || settings.value.ai.openRouterOnlyFree)) return 32768
  return 16384
})

const endpointPlaceholder = computed(() =>
  DEFAULT_ENDPOINTS[settings.value.ai.provider] || 'https://api.example.com/v1'
)

/**
 * Synchronizes active AI fields into the providerSettings snapshot.
 * @param {AIProvider} provider - The provider key to save into.
 */
function syncActiveToProviderSettings(provider: AIProvider): void {
  if (!settings.value.ai.providerSettings) {
    settings.value.ai.providerSettings = {}
  }
  settings.value.ai.providerSettings[provider] = {
    apiKey: settings.value.ai.apiKey,
    endpoint: settings.value.ai.endpoint,
    model: settings.value.ai.model,
    batchSize: settings.value.ai.batchSize,
    maxTokens: settings.value.ai.maxTokens,
    onlyFreeModels: provider === 'openrouter' ? !!settings.value.ai.openRouterOnlyFree : undefined,
    reasoningEffort: settings.value.ai.reasoningEffort,
    openrouterProvider: provider === 'openrouter' ? settings.value.ai.openrouterProvider : undefined,
    openrouterAllowFallbacks: provider === 'openrouter' ? (settings.value.ai.openrouterAllowFallbacks !== false) : undefined,
    openrouterSort: provider === 'openrouter' ? settings.value.ai.openrouterSort : undefined,
    openrouterDataCollection: provider === 'openrouter' ? settings.value.ai.openrouterDataCollection : undefined,
    openrouterRequireParams: provider === 'openrouter' ? !!settings.value.ai.openrouterRequireParams : undefined,
    openrouterIgnoreProviders: provider === 'openrouter' ? settings.value.ai.openrouterIgnoreProviders : undefined,
    openrouterFallbackModels: provider === 'openrouter' ? settings.value.ai.openrouterFallbackModels : undefined,
    openRouterByokManual: provider === 'openrouter' ? !!settings.value.ai.openRouterByokManual : undefined,
    openRouterByokActive: provider === 'openrouter' ? !!settings.value.ai.openRouterByokActive : undefined,
    openRouterKeyInfo: provider === 'openrouter' ? settings.value.ai.openRouterKeyInfo : undefined,
  }
}

/**
 * Loads provider settings from snapshot when switching providers.
 * @param {AIProvider} newProvider - Target provider.
 * @param {AIProvider} [oldProvider] - Previous provider to snapshot.
 */
function loadProviderSettings(newProvider: AIProvider, oldProvider?: AIProvider): void {
  if (!settings.value.ai.providerSettings) {
    settings.value.ai.providerSettings = {}
  }
  if (oldProvider) {
    syncActiveToProviderSettings(oldProvider)
  }

  const saved = settings.value.ai.providerSettings[newProvider]
  if (saved) {
    settings.value.ai.apiKey = saved.apiKey ?? ''
    settings.value.ai.endpoint = saved.endpoint ?? (DEFAULT_ENDPOINTS[newProvider] || '')
    settings.value.ai.model = saved.model ?? (DEFAULT_MODELS[newProvider] || '')
    settings.value.ai.maxTokens = saved.maxTokens ?? (newProvider === 'gemini' ? 65536 : (newProvider === 'claude' ? 8192 : 16384))
    settings.value.ai.batchSize = saved.batchSize ?? getAutoBatchSize(settings.value.ai.maxTokens)
    settings.value.ai.reasoningEffort = saved.reasoningEffort ?? 'auto'
    if (newProvider === 'openrouter') {
      settings.value.ai.openRouterOnlyFree = !!saved.onlyFreeModels
      settings.value.ai.openrouterProvider = saved.openrouterProvider ?? ''
      settings.value.ai.openrouterAllowFallbacks = saved.openrouterAllowFallbacks !== false
      settings.value.ai.openrouterSort = saved.openrouterSort ?? 'auto'
      settings.value.ai.openrouterDataCollection = saved.openrouterDataCollection ?? 'allow'
      settings.value.ai.openrouterRequireParams = !!saved.openrouterRequireParams
      settings.value.ai.openrouterIgnoreProviders = saved.openrouterIgnoreProviders ?? ''
      settings.value.ai.openrouterFallbackModels = saved.openrouterFallbackModels ?? ''
      settings.value.ai.openRouterByokManual = !!saved.openRouterByokManual
      settings.value.ai.openRouterByokActive = !!saved.openRouterByokActive
      settings.value.ai.openRouterKeyInfo = saved.openRouterKeyInfo
    }
  } else {
    const defEndpoint = DEFAULT_ENDPOINTS[newProvider] || ''
    const defModel = (newProvider === 'openrouter' && settings.value.ai.openRouterOnlyFree) ? 'stealth/ox-alpha' : (DEFAULT_MODELS[newProvider] || '')
    const predefined = PREDEFINED_MODELS[newProvider] || []
    const foundModel = predefined.find(m => m.id === defModel)
    const defTokens = foundModel ? parseMaxTokensToNumber(foundModel.maxTokens) : (newProvider === 'gemini' ? 65536 : (newProvider === 'claude' ? 8192 : 16384))
    settings.value.ai.apiKey = ''
    settings.value.ai.endpoint = defEndpoint
    settings.value.ai.model = defModel
    settings.value.ai.maxTokens = defTokens
    settings.value.ai.batchSize = getAutoBatchSize(defTokens)
    settings.value.ai.reasoningEffort = 'auto'
    if (newProvider === 'openrouter') {
      settings.value.ai.openRouterOnlyFree = false
      settings.value.ai.openrouterProvider = ''
      settings.value.ai.openrouterAllowFallbacks = true
      settings.value.ai.openrouterSort = 'auto'
      settings.value.ai.openrouterDataCollection = 'allow'
      settings.value.ai.openrouterRequireParams = false
      settings.value.ai.openrouterIgnoreProviders = ''
      settings.value.ai.openrouterFallbackModels = ''
      settings.value.ai.openRouterByokManual = false
      settings.value.ai.openRouterByokActive = false
      settings.value.ai.openRouterKeyInfo = undefined
    }
    syncActiveToProviderSettings(newProvider)
  }

  const predefined = PREDEFINED_MODELS[newProvider] || []
  const customList = settings.value.ai.customModels?.[newProvider] || []
  const isKnown = predefined.some(m => m.id === settings.value.ai.model) || customList.some((m: any) => m.id === settings.value.ai.model)
  isCustomSelected.value = !isKnown && !!settings.value.ai.model

  if (newProvider === 'openrouter') {
    const isKnownProvider = !settings.value.ai.openrouterProvider || currentOpenRouterProviders.value.some(p => p.slug === settings.value.ai.openrouterProvider)
    isCustomOpenRouterProviderSelected.value = !isKnownProvider && !!settings.value.ai.openrouterProvider
  }
}

watch(() => settings.value.ai.provider, (newProvider, oldProvider) => {
  if (!oldProvider || newProvider === oldProvider) return
  loadProviderSettings(newProvider, oldProvider)
})

watch(() => settings.value.ai.openRouterOnlyFree, (onlyFree) => {
  if (settings.value.ai.provider === 'openrouter' && onlyFree) {
    if (!isFreeModel(settings.value.ai.model)) {
      const freeList = currentProviderModels.value
      settings.value.ai.model = freeList[0]?.id || 'stealth/ox-alpha'
      autoFillModelParams(settings.value.ai.model)
    }
  }
})

watch(() => settings.value.ai.model, (newModel) => {
  if (newModel) {
    autoFillModelParams(newModel)
  }
})

onMounted(async () => {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const stored = data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined
  if (stored) {
    settings.value = { 
      ...DEFAULT_SETTINGS, 
      ...stored,
      ai: { ...DEFAULT_SETTINGS.ai, ...stored.ai }
    }
  }
  if (!settings.value.ai.providerSettings) {
    settings.value.ai.providerSettings = { ...DEFAULT_SETTINGS.ai.providerSettings }
  }
  syncActiveToProviderSettings(settings.value.ai.provider)
  if (!settings.value.ai.endpoint) {
    settings.value.ai.endpoint = DEFAULT_ENDPOINTS[settings.value.ai.provider] || ''
  }
  if (!settings.value.ai.groupingPrompt) {
    settings.value.ai.groupingPrompt = DEFAULT_SETTINGS.ai.groupingPrompt
  }
  if (!settings.value.ai.splitPrompt) {
    settings.value.ai.splitPrompt = DEFAULT_SETTINGS.ai.splitPrompt
  }
  if (!settings.value.ai.classifyPrompt) {
    settings.value.ai.classifyPrompt = DEFAULT_SETTINGS.ai.classifyPrompt
  }
  if (!settings.value.ai.mergePrompt) {
    settings.value.ai.mergePrompt = DEFAULT_SETTINGS.ai.mergePrompt
  }
  if (!settings.value.ai.apiKey) {
    connectionSettingsExpanded.value = true
  }
  try {
    const commands = await (typeof (globalThis as any).browser !== 'undefined' && (globalThis as any).browser.commands
      ? (globalThis as any).browser.commands.getAll()
      : chrome.commands.getAll())
    const popupCmd = commands.find((c: { name?: string; shortcut?: string }) => c.name === '_execute_action')
    if (popupCmd?.shortcut) {
      popupShortcut.value = popupCmd.shortcut
    }
    const searchCmd = commands.find((c: { name?: string; shortcut?: string }) => c.name === 'open-search')
    if (searchCmd?.shortcut) {
      searchShortcut.value = searchCmd.shortcut
    }
    const searchSlashCmd = commands.find((c: { name?: string; shortcut?: string }) => c.name === 'open-search-slash')
    if (searchSlashCmd?.shortcut) {
      searchSlashShortcut.value = searchSlashCmd.shortcut
    }
  } catch (err) {
    console.error('Failed to get commands:', err)
  }

  // Start polling MCP connection status
  updateMCPStatus()
  statusPollInterval = setInterval(updateMCPStatus, 1000)
  loadMCPToken()

  // Load AI operation logs
  loadAILogs()

  // Load restorable closed tabs
  loadClosedTabs()
  refreshExportPreviewCounts()
})

onUnmounted(() => {
  if (statusPollInterval) {
    clearInterval(statusPollInterval)
  }
})

// --- Restorable Closed Tabs state and handlers ---
const closedTabs = ref<ClosedTabEntry[]>([])
const restoringTabId = ref<string | null>(null)
const restoringAll = ref(false)

async function loadClosedTabs(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_CLOSED_TABS' })
    if (res && Array.isArray(res.tabs)) {
      closedTabs.value = res.tabs
    } else {
      closedTabs.value = await getClosedTabs()
    }
  } catch {
    closedTabs.value = await getClosedTabs()
  }
}

async function handleRestoreTab(id: string): Promise<void> {
  restoringTabId.value = id
  try {
    await chrome.runtime.sendMessage({ action: 'RESTORE_CLOSED_TAB', payload: { id } })
  } catch {
    await restoreClosedTab(id)
  } finally {
    restoringTabId.value = null
    await loadClosedTabs()
  }
}

const restoringBatchId = ref<string | null>(null)

async function handleRestoreBatch(batchId: string): Promise<void> {
  restoringBatchId.value = batchId
  try {
    await chrome.runtime.sendMessage({ action: 'RESTORE_CLOSED_BATCH', payload: { batchId } })
  } catch {
    await restoreClosedBatch(batchId)
  } finally {
    restoringBatchId.value = null
    await loadClosedTabs()
  }
}

async function handleRestoreAllTabs(): Promise<void> {
  if (closedTabs.value.length === 0) return
  restoringAll.value = true
  try {
    await chrome.runtime.sendMessage({ action: 'RESTORE_ALL_CLOSED_TABS' })
  } catch {
    await restoreAllClosedTabs()
  } finally {
    restoringAll.value = false
    await loadClosedTabs()
  }
}

async function handleDeleteClosedTab(id: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ action: 'DELETE_CLOSED_TAB', payload: { id } })
  } catch {
    await removeClosedTab(id)
  }
  await loadClosedTabs()
}

async function handleClearClosedTabs(): Promise<void> {
  if (confirm((getMessage('clearClosedTabs') || 'Clear History') + '?')) {
    try {
      await chrome.runtime.sendMessage({ action: 'CLEAR_CLOSED_TABS' })
    } catch {
      await clearClosedTabs()
    }
    await loadClosedTabs()
  }
}

// --- AI Operation Logs state and handlers ---
const aiLogs = ref<AIOperationLogEntry[]>([])
const expandedLogId = ref<string | null>(null)
const logFilterStatus = ref<string>('all')

async function loadAILogs() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_AI_LOGS' })
    if (res && res.logs) {
      aiLogs.value = res.logs
    }
  } catch (err) {
    // Ignore error
  }
}

async function clearAILogs() {
  if (confirm('Clear all saved AI operation logs?')) {
    await chrome.runtime.sendMessage({ action: 'CLEAR_AI_LOGS' })
    await loadAILogs()
  }
}

async function deleteSingleLog(id: string) {
  await chrome.runtime.sendMessage({ action: 'DELETE_AI_LOG', payload: { id } })
  await loadAILogs()
}

async function markLogInterrupted(id: string) {
  const log = aiLogs.value.find(l => l.id === id)
  if (log) {
    log.status = 'CRASHED'
    log.endTime = Date.now()
    log.durationMs = log.endTime - log.timestamp
    log.error = {
      message: 'Operation marked as interrupted (Tab/Service worker crashed).',
      name: 'InterruptedException',
    }
    log.steps.push({
      timestamp: Date.now(),
      step: 'INTERRUPTED',
      detail: 'Operation marked as interrupted.',
    })
    await chrome.storage.local.set({ [STORAGE_KEYS.AI_OPERATION_LOGS]: aiLogs.value })
    await loadAILogs()
  }
}

function exportLogsAsJson() {
  const jsonStr = JSON.stringify(aiLogs.value, null, 2)
  const blob = new Blob([jsonStr], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ai_operation_logs_${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function toggleLogExpand(id: string) {
  expandedLogId.value = expandedLogId.value === id ? null : id
}

function formatDurationMs(ms?: number): string {
  if (!ms || isNaN(ms)) return '0s'
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  const tenths = Math.floor((ms % 1000) / 100)
  if (mins === 0) {
    return `${secs}.${tenths}s (${ms}ms)`
  }
  const formattedMinSec = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${formattedMinSec} (${(ms / 1000).toFixed(1)}s)`
}

const copyReqState = ref<Record<string, boolean>>({})
const copyRespState = ref<Record<string, boolean>>({})

async function copyToClipboardWithFeedback(text: string, key: string, type: 'req' | 'resp' | 'thought') {
  try {
    await navigator.clipboard.writeText(text)
    if (type === 'req') {
      copyReqState.value = { ...copyReqState.value, [key]: true }
      setTimeout(() => { copyReqState.value = { ...copyReqState.value, [key]: false } }, 1500)
    } else {
      copyRespState.value = { ...copyRespState.value, [key]: true }
      setTimeout(() => { copyRespState.value = { ...copyRespState.value, [key]: false } }, 1500)
    }
  } catch (err) {
    console.error('Failed to copy', err)
  }
}

function getRequestForBatch(log: AIOperationLogEntry, batchIndex: number) {
  return log.rawRequests.find(r => r.batchIndex === batchIndex)
}

function getCompleteApiRequest(log: AIOperationLogEntry, batchIndex: number): string {
  const req = getRequestForBatch(log, batchIndex)
  if (!req) return 'No request data recorded'
  return JSON.stringify({
    batchIndex: req.batchIndex,
    endpoint: req.endpoint,
    requestTimestamp: new Date(req.requestTimestamp).toISOString(),
    config: log.configSnapshot,
    systemPrompt: req.systemMessage || log.prompts?.systemPrompt || '',
    userMessage: req.userMessage || log.prompts?.userPrompt || '',
    payloadSummary: req.payloadSummary,
  }, null, 2)
}

function getCompleteAiResponse(resp: AILogRawResponse): string {
  if (resp.parsedJson) {
    return JSON.stringify(resp.parsedJson, null, 2)
  }
  return resp.responseBody || resp.error || 'No response body recorded'
}

function extractReasoningFromRawResponse(resp: AILogRawResponse): string | null {
  if (!resp.parsedJson) return null
  const json = resp.parsedJson as any
  if (typeof json === 'object' && json !== null) {
    if (typeof json.accumulatedReasoning === 'string' && json.accumulatedReasoning.trim()) {
      return json.accumulatedReasoning.trim()
    }
    const choice = json.choices?.[0]
    const reasoning = choice?.message?.reasoning || choice?.message?.reasoning_content || choice?.message?.thought
    if (typeof reasoning === 'string' && reasoning.trim()) {
      return reasoning.trim()
    }
    const candidate = json.candidates?.[0]
    if (candidate) {
      if (typeof candidate.reasoning_content === 'string' && candidate.reasoning_content.trim()) {
        return candidate.reasoning_content.trim()
      }
      if (Array.isArray(candidate.content?.parts)) {
        const thoughts = candidate.content.parts
          .filter((p: any) => p && (p.thought === true || typeof p.thought === 'string'))
          .map((p: any) => typeof p.thought === 'string' ? p.thought : (p.text || ''))
          .join('\n')
          .trim()
        if (thoughts) return thoughts
      }
    }
  }
  return null
}

function calculateVariancePercent(est?: number, act?: number): string {
  if (est === undefined || act === undefined || est === 0) return '—'
  const diff = ((act - est) / est) * 100
  const sign = diff > 0 ? '+' : ''
  return `${sign}${diff.toFixed(1)}%`
}

function calculateCostVariancePercent(estStr?: string, actStr?: string): string {
  if (!estStr || !actStr || estStr === '—' || actStr === '—') return '—'
  const est = parseFloat(estStr.replace(/[^0-9.]/g, ''))
  const act = parseFloat(actStr.replace(/[^0-9.]/g, ''))
  if (isNaN(est) || isNaN(act) || est === 0) return '—'
  const diff = ((act - est) / est) * 100
  const sign = diff > 0 ? '+' : ''
  return `${sign}${diff.toFixed(1)}%`
}

function getActualUsage(log: AIOperationLogEntry) {
  if (log.tokenUsage?.actualInputTokens !== undefined) {
    return {
      input: log.tokenUsage.actualInputTokens,
      output: log.tokenUsage.actualOutputTokens || 0,
      costStr: log.tokenUsage.actualCostStr || '—'
    };
  }

  // Calculate dynamically from rawResponses
  let totalInput = 0;
  let totalOutput = 0;

  for (const resp of log.rawResponses || []) {
    const json = resp.parsedJson as any;
    if (!json) continue;

    if (json.usage) {
      totalInput += json.usage.prompt_tokens || json.usage.input_tokens || 0;
      totalOutput += json.usage.completion_tokens || json.usage.output_tokens || 0;
    } else if (json.usageMetadata) {
      totalInput += json.usageMetadata.promptTokenCount || 0;
      totalOutput += json.usageMetadata.candidatesTokenCount || 0;
    }
  }

  if (totalInput === 0 && totalOutput === 0) {
    return { input: undefined, output: undefined, costStr: undefined };
  }

  // Calculate cost
  const provider = log.configSnapshot?.provider || 'openai';
  const model = log.configSnapshot?.model || DEFAULT_MODELS[provider] || 'gpt-4o-mini';
  let rates = MODEL_PRICING[model];
  if (!rates) {
    rates = (PROVIDER_DEFAULTS as any)[provider] || PROVIDER_DEFAULTS.openai;
  }
  const cost = (totalInput * rates.input + totalOutput * rates.output) / 1000000;
  let costStr = '';
  if (cost === 0) costStr = 'Free';
  else if (cost < 0.0001) costStr = '< $0.0001';
  else costStr = `~$${cost.toFixed(4)}`;

  return { input: totalInput, output: totalOutput, costStr };
}

async function reuseLogAndGroup(log: AIOperationLogEntry) {
  if (log.configSnapshot) {
    settings.value.ai.provider = log.configSnapshot.provider as any
    if (log.configSnapshot.model) settings.value.ai.model = log.configSnapshot.model
    if (log.configSnapshot.endpoint) settings.value.ai.endpoint = log.configSnapshot.endpoint
    if (log.configSnapshot.sendFullUrl !== undefined) settings.value.ai.sendFullUrl = log.configSnapshot.sendFullUrl
    if (log.configSnapshot.batchSize) settings.value.ai.batchSize = log.configSnapshot.batchSize
    if (log.configSnapshot.maxTokens) settings.value.ai.maxTokens = log.configSnapshot.maxTokens
    if (log.configSnapshot.maxRetries !== undefined) settings.value.ai.maxRetries = log.configSnapshot.maxRetries
    if (log.configSnapshot.bypassSafeguards !== undefined) settings.value.ai.bypassSafeguards = log.configSnapshot.bypassSafeguards
    if (log.configSnapshot.openrouterProvider !== undefined) settings.value.ai.openrouterProvider = log.configSnapshot.openrouterProvider
    if (log.configSnapshot.openrouterAllowFallbacks !== undefined) settings.value.ai.openrouterAllowFallbacks = log.configSnapshot.openrouterAllowFallbacks
  }
  
  if (log.prompts) {
    if (log.prompts.systemPrompt !== undefined) settings.value.ai.customPrompt = log.prompts.systemPrompt
    if (log.prompts.userPrompt !== undefined) {
      if (log.actionType === 'GROUP_TABS' || log.actionType.startsWith('GROUP_TABS_')) {
        settings.value.ai.groupingPrompt = log.prompts.userPrompt
      } else if (log.actionType === 'SPLIT_GROUP') {
        settings.value.ai.splitPrompt = log.prompts.userPrompt
      } else if (log.actionType === 'MERGE_GROUP') {
        settings.value.ai.mergePrompt = log.prompts.userPrompt
      } else if (log.actionType === 'CLASSIFY_NEW_TABS') {
        settings.value.ai.classifyPrompt = log.prompts.userPrompt
      }
    }
    if (log.prompts.coherencePrompt !== undefined) settings.value.ai.coherencePrompt = log.prompts.coherencePrompt
  }
  
  await saveSettings()
  let actionToRun = log.actionType
  if (actionToRun === 'GROUP_TABS' || actionToRun.startsWith('GROUP_TABS_')) {
    actionToRun = 'CLASSIFY_NEW_TABS'
  }
  await chrome.runtime.sendMessage({ action: actionToRun })
  alert(`Configuration restored from log and ${actionToRun} initiated!`)
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(console.error)
}

const filteredLogs = computed(() => {
  if (logFilterStatus.value === 'all') return aiLogs.value
  return aiLogs.value.filter(l => l.status === logFilterStatus.value)
})

function resetGroupingPrompt() {
  settings.value.ai.groupingPrompt = DEFAULT_SETTINGS.ai.groupingPrompt
}

function resetSplitPrompt() {
  settings.value.ai.splitPrompt = DEFAULT_SPLIT_PROMPT
}

function resetClassifyPrompt() {
  settings.value.ai.classifyPrompt = DEFAULT_CLASSIFY_PROMPT
}

function resetMergePrompt() {
  settings.value.ai.mergePrompt = DEFAULT_MERGE_PROMPT
}

function resetWindowNamingPrompt() {
  settings.value.ai.windowNamingPrompt = DEFAULT_WINDOW_NAMING_PROMPT
}

function resetSystemPrompt() {
  settings.value.ai.customPrompt = ''
}

function openShortcutSettings() {
  const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')
  if (isFirefox) {
    alert('In Firefox, please manage shortcuts via the Add-ons Manager:\n\n1. Open a new tab and go to about:addons\n2. Click the gear icon\n3. Select "Manage Extension Shortcuts"')
  } else {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  }
}

async function saveSettings() {
  if (!settings.value.windowWidth || settings.value.windowWidth < 380) {
    settings.value.windowWidth = 420
  }
  syncActiveToProviderSettings(settings.value.ai.provider)
  await chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', payload: toRaw(settings.value) })
  saved.value = true
  setTimeout(() => {
    saved.value = false
  }, 1500)
}

async function saveAndGoBack() {
  if (!settings.value.windowWidth || settings.value.windowWidth < 380) {
    settings.value.windowWidth = 420
  }
  syncActiveToProviderSettings(settings.value.ai.provider)
  await chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', payload: toRaw(settings.value) })
  emit('back')
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    syncActiveToProviderSettings(settings.value.ai.provider)
    const client = new AIClient(settings.value.ai)
    testResult.value = await client.testConnection()
    if (testResult.value.ok && settings.value.ai.provider === 'openrouter' && settings.value.ai.apiKey) {
      fetchOpenRouterKeyInfo(settings.value.ai.apiKey, settings.value.ai.endpoint)
        .then(info => {
          settings.value.ai.openRouterKeyInfo = info
          settings.value.ai.openRouterByokActive = info.isByokActive
          chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', payload: toRaw(settings.value) }).catch(() => {})
        })
        .catch(() => {})
    }
  } catch (err) {
    testResult.value = { ok: false, error: (err as Error).message }
  } finally {
    testing.value = false
  }
}

async function copyConfig() {
  backupError.value = ''
  try {
    const rawConfig = JSON.parse(JSON.stringify(toRaw(settings.value)))
    if (rawConfig.ai) {
      delete rawConfig.ai.customModels
    }
    delete rawConfig.customModels
    const jsonStr = JSON.stringify(rawConfig, null, 2)
    await navigator.clipboard.writeText(jsonStr)
    copyText.value = 'Config Copied!'
    setTimeout(() => {
      copyText.value = 'Copy Config'
    }, 1500)
  } catch (err: any) {
    backupError.value = 'Failed to copy: ' + err.message
  }
}

async function pasteConfig() {
  backupError.value = ''
  try {
    const text = await navigator.clipboard.readText()
    if (!text) {
      throw new Error('Clipboard is empty')
    }
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid configuration JSON')
    }
    
    settings.value = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        ...(parsed.ai || {})
      }
    }
    
    pasteText.value = 'Config Pasted!'
    setTimeout(() => {
      pasteText.value = 'Paste Config'
    }, 1500)
  } catch (err: any) {
    backupError.value = 'Failed to paste: ' + err.message
  }
}

// --- Known Unclosed Tabs Export state and handlers ---
const exportScope = ref<TabExportScope>('all_unclosed')
const exportFormat = ref<TabExportFormat>('markdown')
const exportCounts = ref<{ total: number; open: number; unrestored: number }>({ total: 0, open: 0, unrestored: 0 })
const exportCopyFeedback = ref<string | null>(null)
const exportDownloadFeedback = ref<string | null>(null)
const exportError = ref<string>('')

async function refreshExportPreviewCounts(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'EXPORT_KNOWN_TABS',
      payload: { scope: exportScope.value, format: exportFormat.value },
    })
    if (res && res.counts) {
      exportCounts.value = res.counts
    }
  } catch {
    // Ignore preview count error
  }
}

watch(exportScope, () => {
  refreshExportPreviewCounts()
})

async function handleCopyExportTabs(): Promise<void> {
  exportError.value = ''
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'EXPORT_KNOWN_TABS',
      payload: { scope: exportScope.value, format: exportFormat.value },
    })
    if (!res || !res.ok) {
      throw new Error(res?.error || 'Failed to generate tab export')
    }
    if (res.counts) exportCounts.value = res.counts
    await navigator.clipboard.writeText(res.content || '')
    exportCopyFeedback.value = `Copied (${res.counts?.total ?? 0} tabs)!`
    setTimeout(() => {
      exportCopyFeedback.value = null
    }, 1800)
  } catch (err: any) {
    exportError.value = 'Failed to copy export: ' + (err?.message || String(err))
  }
}

async function handleDownloadExportTabs(): Promise<void> {
  exportError.value = ''
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'EXPORT_KNOWN_TABS',
      payload: { scope: exportScope.value, format: exportFormat.value },
    })
    if (!res || !res.ok) {
      throw new Error(res?.error || 'Failed to generate tab export')
    }
    if (res.counts) exportCounts.value = res.counts
    const mimeByFormat: Record<TabExportFormat, string> = {
      markdown: 'text/markdown;charset=utf-8',
      json: 'application/json;charset=utf-8',
      txt: 'text/plain;charset=utf-8',
      html: 'text/html;charset=utf-8',
    }
    const extByFormat: Record<TabExportFormat, string> = {
      markdown: 'md',
      json: 'json',
      txt: 'txt',
      html: 'html',
    }
    const blob = new Blob([res.content || ''], { type: mimeByFormat[exportFormat.value] })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const dateStamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    a.download = `tabpilot_tabs_${exportScope.value}_${dateStamp}.${extByFormat[exportFormat.value]}`
    a.click()
    URL.revokeObjectURL(url)
    exportDownloadFeedback.value = `Downloaded .${extByFormat[exportFormat.value]}!`
    setTimeout(() => {
      exportDownloadFeedback.value = null
    }, 1800)
  } catch (err: any) {
    exportError.value = 'Failed to download export: ' + (err?.message || String(err))
  }
}
</script>

<template>
  <div :style="props.isStandaloneSearch ? { width: '100%', height: '100%', background: 'var(--bg-primary)' } : { width: Math.max(380, settings.windowWidth || 420) + 'px', height: Math.max(450, Math.min(600, settings.windowHeight || 600)) + 'px', background: 'var(--bg-primary)' }" class="flex flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between px-4 py-2.5" style="box-shadow: 0 0.5px 0 var(--border);">
      <div class="flex items-center gap-2.5">
        <button
          @click="saveAndGoBack"
          class="w-7 h-7 -ml-1 flex items-center justify-center rounded-sm"
          style="color: var(--accent);"
        >
          <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clip-rule="evenodd" />
          </svg>
        </button>
        <h1 class="text-[15px] font-semibold tracking-tight flex items-center gap-2" style="color: var(--text-primary);">
          <span>{{ getMessage('settings') }}</span>
          <span class="text-[10px] font-medium opacity-70" style="color: var(--text-secondary);">v{{ APP_VERSION }} (b{{ BUILD_NUMBER }})</span>
        </h1>
      </div>

      <!-- Save settings header button -->
      <button
        @click="saveSettings"
        class="px-2.5 py-1 text-xs font-semibold rounded-sm transition-all flex items-center gap-1.5 focus:outline-none text-white"
        style="background: var(--accent);"
      >
        <span v-if="saved" class="inline-flex items-center gap-1">
          <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
          </svg>
          {{ getMessage('saved') }}
        </span>
        <span v-else>{{ getMessage('save') }}</span>
      </button>
    </header>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto px-2 py-2" style="background: var(--bg-secondary);">
      <div class="settings-layout-container w-full max-w-[1400px] mx-auto">
        <!-- Left Column: AI & Automation -->
        <div class="settings-column">
          <!-- AI Configuration -->
          <div>
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5 flex items-center gap-1.5" style="color: var(--text-secondary);">
          <svg class="w-3.5 h-3.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M5 2a1 1 0 011-1h1a1 1 0 011 1v1h1a1 1 0 110 2H8v1a1 1 0 11-2 0V6H5a1 1 0 01-1-1V3a1 1 0 011-1zm12 7a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1h-1a1 1 0 110-2h1v-1a1 1 0 011-1zM11 5a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0V9H9a1 1 0 110-2h1V6a1 1 0 011-1zM4 11a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1z" clip-rule="evenodd" />
          </svg>
          {{ getMessage('aiConfig') }}
          <span class="text-[9px] font-normal normal-case tracking-normal px-1.5 py-0.5 rounded-sm" style="background: var(--hover); color: var(--text-tertiary);">{{ getMessage('optional') }}</span>
        </h2>
        <div class="rounded-sm overflow-hidden" style="background: var(--bg-primary); box-shadow: var(--shadow-xs);">
          <!-- Enable toggle -->
          <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
            <span class="text-xs flex-1" style="color: var(--text-primary);">{{ getMessage('enableAI') }}</span>
            <div class="relative">
              <input
                type="checkbox"
                v-model="settings.ai.enabled"
                class="sr-only peer"
              />
              <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
              <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
            </div>
          </label>

          <template v-if="settings.ai.enabled">
            <!-- Always Log AI Operations toggle -->
            <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
              <div class="flex-1">
                <span class="text-xs block font-medium" style="color: var(--text-primary);">Always Log AI Operations</span>
                <span class="text-[10px] block" style="color: var(--text-tertiary);">Automatically record detailed verbose logs in Settings (when off: only with Shift+Click)</span>
              </div>
              <div class="relative shrink-0">
                <input
                  type="checkbox"
                  v-model="settings.ai.alwaysLogAIOperations"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>

            <!-- Send Full URL toggle -->
            <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
              <span class="text-xs flex-1" style="color: var(--text-primary);">Send Full URL (Higher Tokens)</span>
              <div class="relative">
                <input
                  type="checkbox"
                  v-model="settings.ai.sendFullUrl"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>

            <!-- Fallback to sort & Send random order toggles (2 Columns) -->
            <div class="grid grid-cols-2 setting-row">
              <!-- Fallback to sort toggle -->
              <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer border-r" style="border-color: var(--border);">
                <span class="text-xs flex-1" style="color: var(--text-primary);">{{ getMessage('fallbackToSort') }}</span>
                <div class="relative shrink-0">
                  <input
                    type="checkbox"
                    v-model="settings.ai.fallbackToSort"
                    class="sr-only peer"
                  />
                  <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                  <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
                </div>
              </label>

              <!-- Send random order toggle -->
              <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer">
                <span class="text-xs flex-1" style="color: var(--text-primary);">{{ getMessage('sendRandomOrder') }}</span>
                <div class="relative shrink-0">
                  <input
                    type="checkbox"
                    v-model="settings.ai.sendRandomOrder"
                    class="sr-only peer"
                  />
                  <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                  <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
                </div>
              </label>
            </div>

            <!-- Only Allow Free Models toggle (OpenRouter only) -->
            <label v-if="settings.ai.provider === 'openrouter'" class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
              <div class="flex-1">
                <span class="text-xs block font-medium" style="color: var(--text-primary);">Only Allow Free Models</span>
                <span class="text-[10.5px] block" style="color: var(--text-secondary);">Filter model list and API usage to free OpenRouter models (e.g. stealth/ox-alpha, :free)</span>
              </div>
              <div class="relative shrink-0">
                <input
                  type="checkbox"
                  v-model="settings.ai.openRouterOnlyFree"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>

            <!-- Model & Reasoning Effort Selector (Always visible when AI enabled) -->
            <div class="px-3.5 py-2.5 setting-row">
              <div :class="{ 'grid grid-cols-2 gap-3': settings.ai.provider === 'openrouter' || settings.ai.provider === 'openai' || settings.ai.provider === 'gemini' }">
                <!-- Model Column -->
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="block text-[10px] font-semibold uppercase tracking-wider" style="color: var(--text-secondary);">
                      {{ getMessage('model') }}
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <span v-if="settings.ai.provider === 'openrouter'" class="text-[9px] opacity-70" style="color: var(--text-tertiary);">
                      {{ filteredProviderModels.length }} / {{ currentProviderModels.length }} models
                    </span>
                  </div>

                  <!-- OpenRouter Model Category Filter & Live Search -->
                  <div v-if="settings.ai.provider === 'openrouter'" class="mb-1.5 flex flex-col gap-1.5">
                    <!-- Category Pills -->
                    <div class="flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-none text-[9px]">
                      <button
                        type="button"
                        @click="openRouterCategoryFilter = 'all'"
                        class="px-1.5 py-0.5 rounded-xs font-medium cursor-pointer transition-colors"
                        :style="openRouterCategoryFilter === 'all' ? 'background: var(--accent); color: #fff;' : 'background: var(--bg-secondary); color: var(--text-secondary);'"
                      >
                        All
                      </button>
                      <button
                        type="button"
                        @click="openRouterCategoryFilter = 'free'"
                        class="px-1.5 py-0.5 rounded-xs font-medium cursor-pointer transition-colors"
                        :style="openRouterCategoryFilter === 'free' ? 'background: var(--group-green); color: #fff;' : 'background: var(--bg-secondary); color: var(--text-secondary);'"
                      >
                        Free Only
                      </button>
                      <button
                        type="button"
                        @click="openRouterCategoryFilter = 'thinking'"
                        class="px-1.5 py-0.5 rounded-xs font-medium cursor-pointer transition-colors"
                        :style="openRouterCategoryFilter === 'thinking' ? 'background: var(--accent); color: #fff;' : 'background: var(--bg-secondary); color: var(--text-secondary);'"
                      >
                        Reasoning
                      </button>
                      <button
                        v-if="isOpenRouterByokActive || settings.ai.openRouterKeyInfo?.byokProviders?.length"
                        type="button"
                        @click="openRouterCategoryFilter = 'byok'"
                        class="px-1.5 py-0.5 rounded-xs font-medium cursor-pointer transition-colors"
                        :style="openRouterCategoryFilter === 'byok' ? 'background: var(--group-green); color: #fff;' : 'background: var(--bg-secondary); color: var(--text-secondary);'"
                      >
                        BYOK Direct
                      </button>
                    </div>

                    <!-- Search Input -->
                    <div class="relative">
                      <input
                        type="text"
                        v-model="openRouterModelSearchQuery"
                        placeholder="Search models (e.g. claude, deepseek, 70b)..."
                        class="w-full text-[10px] rounded-xs border-0 py-1 pl-6 pr-5"
                        style="background: var(--bg-secondary); color: var(--text-primary);"
                      />
                      <svg class="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 opacity-50" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
                      </svg>
                      <button
                        v-if="openRouterModelSearchQuery"
                        type="button"
                        @click="openRouterModelSearchQuery = ''"
                        class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] opacity-60 hover:opacity-100 cursor-pointer"
                      >
                        &times;
                      </button>
                    </div>
                  </div>

                  <select
                    v-model="modelSelectValue"
                    class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                    style="background: var(--bg-secondary); color: var(--text-primary);"
                  >
                    <option value="">Default ({{ modelPlaceholder }})</option>
                    <option 
                      v-for="model in filteredProviderModels" 
                      :key="model.id" 
                      :value="model.id"
                    >
                      {{ model.name }} ({{ isModelByok(model.id) ? 'BYOK Direct · ' : '' }}{{ model.complexity }}, {{ (model as any).costDetails || model.costFactor }}, Max Output: {{ model.maxTokens }})
                    </option>
                    <option value="custom">Custom model name...</option>
                  </select>
                  <input
                    v-if="modelSelectValue === 'custom'"
                    v-focus
                    type="text"
                    v-model="settings.ai.model"
                    placeholder="Enter custom model name"
                    class="w-full text-xs rounded-sm border-0 py-1.5 px-2 mt-2"
                    style="background: var(--bg-secondary); color: var(--text-primary);"
                  />

                  <!-- OpenRouter Quick Model Presets -->
                  <div v-if="settings.ai.provider === 'openrouter'" class="mt-1.5 flex flex-wrap gap-1">
                    <button
                      type="button"
                      @click="applyOpenRouterPreset('stealth/ox-alpha')"
                      class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity"
                      :style="settings.ai.model === 'stealth/ox-alpha' ? 'background: var(--accent-soft); border-color: var(--accent); color: var(--accent);' : 'background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);'"
                      title="Free fast reasoning model"
                    >
                      ⚡ ox-alpha (Free)
                    </button>
                    <button
                      type="button"
                      @click="applyOpenRouterPreset('deepseek/deepseek-r1:free')"
                      class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity"
                      :style="settings.ai.model === 'deepseek/deepseek-r1:free' ? 'background: var(--accent-soft); border-color: var(--accent); color: var(--accent);' : 'background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);'"
                      title="Free DeepSeek R1 reasoning model"
                    >
                      🧠 DeepSeek R1 (Free)
                    </button>
                    <button
                      type="button"
                      @click="applyOpenRouterPreset('anthropic/claude-3.5-sonnet')"
                      class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity"
                      :style="settings.ai.model === 'anthropic/claude-3.5-sonnet' ? 'background: var(--accent-soft); border-color: var(--accent); color: var(--accent);' : 'background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);'"
                      title="Claude 3.5 Sonnet"
                    >
                      ⭐ Claude 3.5 Sonnet
                    </button>
                    <button
                      type="button"
                      @click="applyOpenRouterPreset('openai/gpt-4o-mini')"
                      class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity"
                      :style="settings.ai.model === 'openai/gpt-4o-mini' ? 'background: var(--accent-soft); border-color: var(--accent); color: var(--accent);' : 'background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);'"
                      title="GPT-4o Mini"
                    >
                      🚀 GPT-4o Mini
                    </button>
                    <button
                      type="button"
                      @click="applyOpenRouterPreset('google/gemini-2.5-flash')"
                      class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity"
                      :style="settings.ai.model === 'google/gemini-2.5-flash' ? 'background: var(--accent-soft); border-color: var(--accent); color: var(--accent);' : 'background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);'"
                      title="Gemini 2.5 Flash"
                    >
                      🔥 Gemini 2.5 Flash
                    </button>
                  </div>

                  <!-- Google Gemini Quick Model Presets -->
                  <div v-if="settings.ai.provider === 'gemini'" class="mt-1.5 flex flex-wrap gap-1">
                    <button
                      type="button"
                      @click="applyModelPreset('gemini-2.5-flash')"
                      class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity"
                      :style="settings.ai.model === 'gemini-2.5-flash' ? 'background: var(--accent-soft); border-color: var(--accent); color: var(--accent);' : 'background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);'"
                      title="Default thinking model with low latency"
                    >
                      Gemini 2.5 Flash (Thinking)
                    </button>
                    <button
                      type="button"
                      @click="applyModelPreset('gemini-2.5-pro')"
                      class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity"
                      :style="settings.ai.model === 'gemini-2.5-pro' ? 'background: var(--accent-soft); border-color: var(--accent); color: var(--accent);' : 'background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);'"
                      title="High capability deep reasoning model"
                    >
                      Gemini 2.5 Pro (Deep CoT)
                    </button>
                    <button
                      type="button"
                      @click="applyModelPreset('gemini-3.5-flash')"
                      class="text-[8.5px] px-1.5 py-0.5 rounded-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity"
                      :style="settings.ai.model === 'gemini-3.5-flash' ? 'background: var(--accent-soft); border-color: var(--accent); color: var(--accent);' : 'background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);'"
                      title="Next-gen Gemini 3.5 Flash"
                    >
                      Gemini 3.5 Flash
                    </button>
                  </div>
                </div>

                <!-- Reasoning Effort Column (Thinking & CoT Models) -->
                <div v-if="settings.ai.provider === 'openrouter' || settings.ai.provider === 'openai' || settings.ai.provider === 'gemini'">
                  <div class="flex items-center justify-between mb-1">
                    <label class="block text-[10px] font-semibold uppercase tracking-wider" style="color: var(--text-secondary);">
                      Reasoning Effort
                      <span class="normal-case font-normal" style="color: var(--text-tertiary);">(Thinking Models)</span>
                    </label>
                    <span class="text-[9px] opacity-70" style="color: var(--text-tertiary);">Deliberation depth</span>
                  </div>
                  <select
                    v-model="settings.ai.reasoningEffort"
                    class="w-full text-xs rounded-sm border-0 py-1.5 px-2 cursor-pointer"
                    style="background: var(--bg-secondary); color: var(--text-primary);"
                  >
                    <option value="auto">Auto (Model Default)</option>
                    <option value="minimal">Minimal (Fastest)</option>
                    <option value="low">Low (Fast)</option>
                    <option value="medium">Medium (Balanced)</option>
                    <option value="high">High (Deep)</option>
                    <option value="max">Max (Maximum)</option>
                  </select>
                </div>
              </div>

              <!-- Fetch Google Models Button -->
              <div v-if="settings.ai.provider === 'gemini'" class="mt-2">
                <button
                  type="button"
                  @click="handleFetchGoogleModels"
                  :disabled="fetchingGoogleModels || !settings.ai.apiKey"
                  class="text-[10px] px-2.5 py-1 rounded-sm flex items-center gap-1.5 font-medium transition-all cursor-pointer"
                  style="background: var(--accent-soft); color: var(--accent); border: 0.5px solid var(--border);"
                  title="Fetch live model list from Google Gemini API"
                >
                  <span v-if="fetchingGoogleModels" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
                  <svg v-else class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd" />
                  </svg>
                  <span>{{ fetchingGoogleModels ? 'Fetching models...' : 'Fetch Live Models from Google' }}</span>
                </button>
                <div v-if="fetchModelsMessage" class="mt-1.5 text-[10px] font-medium" style="color: var(--group-green);">
                  {{ fetchModelsMessage }}
                </div>
                <div v-if="fetchModelsError" class="mt-1.5 text-[10px] font-medium" style="color: var(--group-red);">
                  {{ fetchModelsError }}
                </div>
              </div>

              <!-- Fetch OpenRouter Models & Check BYOK Status Buttons -->
              <div v-if="settings.ai.provider === 'openrouter'" class="mt-2 flex flex-col gap-2">
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    @click="handleFetchOpenRouterModels"
                    :disabled="fetchingOpenRouterModels"
                    class="text-[10px] px-2.5 py-1 rounded-sm flex items-center gap-1.5 font-medium transition-all cursor-pointer"
                    style="background: var(--accent-soft); color: var(--accent); border: 0.5px solid var(--border);"
                    title="Fetch live model list from OpenRouter API"
                  >
                    <span v-if="fetchingOpenRouterModels" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
                    <svg v-else class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd" />
                    </svg>
                    <span>{{ fetchingOpenRouterModels ? 'Fetching models...' : 'Fetch Live Models' }}</span>
                  </button>

                  <button
                    type="button"
                    @click="handleFetchOpenRouterKeyInfo"
                    :disabled="fetchingOpenRouterKeyInfo || !settings.ai.apiKey"
                    class="text-[10px] px-2.5 py-1 rounded-sm flex items-center gap-1.5 font-medium transition-all cursor-pointer"
                    style="background: var(--bg-secondary); color: var(--text-primary); border: 0.5px solid var(--border);"
                    title="Query OpenRouter key metadata and check BYOK status"
                  >
                    <span v-if="fetchingOpenRouterKeyInfo" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
                    <svg v-else class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd" />
                    </svg>
                    <span>{{ fetchingOpenRouterKeyInfo ? 'Checking Key...' : 'Check Key / BYOK' }}</span>
                  </button>
                </div>

                <div v-if="fetchOpenRouterMessage" class="text-[10px] font-medium" style="color: var(--group-green);">
                  {{ fetchOpenRouterMessage }}
                </div>
                <div v-if="fetchOpenRouterError" class="text-[10px] font-medium" style="color: var(--group-red);">
                  {{ fetchOpenRouterError }}
                </div>
                <div v-if="fetchOpenRouterKeyInfoMessage" class="text-[10px] font-medium" style="color: var(--group-green);">
                  {{ fetchOpenRouterKeyInfoMessage }}
                </div>
                <div v-if="fetchOpenRouterKeyInfoError" class="text-[10px] font-medium" style="color: var(--group-red);">
                  {{ fetchOpenRouterKeyInfoError }}
                </div>

                <!-- BYOK Status Card -->
                <div v-if="settings.ai.openRouterKeyInfo || isOpenRouterByokActive" class="p-2.5 rounded-sm border flex flex-col gap-1.5" style="background: var(--bg-secondary); border-color: var(--border);">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5 text-[11px] font-semibold" :style="{ color: isOpenRouterByokActive ? 'var(--group-green)' : 'var(--accent)' }">
                      <span class="w-2 h-2 rounded-full" :style="{ background: isOpenRouterByokActive ? 'var(--group-green)' : 'var(--accent)' }"></span>
                      {{ isOpenRouterByokActive ? 'BYOK Direct Billing Active' : 'Standard OpenRouter Billing' }}
                    </div>
                    <span v-if="settings.ai.openRouterKeyInfo?.label" class="text-[9px] px-1.5 py-0.5 rounded-xs font-mono" style="background: var(--hover); color: var(--text-secondary);">
                      {{ settings.ai.openRouterKeyInfo.label }}
                    </span>
                  </div>

                  <div class="text-[10px]" style="color: var(--text-secondary);">
                    <template v-if="isOpenRouterByokActive">
                      Requests for matching models route directly to upstream provider credentials with 0% platform token markup.
                    </template>
                    <template v-else>
                      Standard OpenRouter token charges and rate limits apply.
                    </template>
                  </div>

                  <!-- Selected model routing indicator -->
                  <div v-if="settings.ai.model && isOpenRouterByokActive" class="text-[9.5px] font-medium flex items-center gap-1.5">
                    <span class="w-1.5 h-1.5 rounded-full" :style="{ background: isModelByok(settings.ai.model) ? 'var(--group-green)' : 'var(--text-tertiary)' }"></span>
                    <span :style="{ color: isModelByok(settings.ai.model) ? 'var(--group-green)' : 'var(--text-secondary)' }">
                      Selected: <strong>{{ settings.ai.model }}</strong> &rarr; {{ isModelByok(settings.ai.model) ? 'BYOK Direct Billing' : 'Standard Credits (No BYOK Key Detected)' }}
                    </span>
                  </div>

                  <div v-if="settings.ai.openRouterKeyInfo" class="text-[9.5px] mt-0.5 pt-1 border-t flex flex-wrap gap-x-3 gap-y-1" style="border-color: var(--border); color: var(--text-tertiary);">
                    <span v-if="typeof settings.ai.openRouterKeyInfo.byokUsage === 'number' && settings.ai.openRouterKeyInfo.byokUsage > 0">
                      BYOK Usage: <strong style="color: var(--text-primary);">${{ settings.ai.openRouterKeyInfo.byokUsage.toFixed(4) }}</strong>
                    </span>
                    <span v-if="typeof settings.ai.openRouterKeyInfo.usage === 'number'">
                      OpenRouter Credits: <strong style="color: var(--text-primary);">${{ settings.ai.openRouterKeyInfo.usage.toFixed(4) }}</strong>
                    </span>
                    <span v-if="settings.ai.openRouterKeyInfo.byokProviders?.length">
                      Upstream: <strong style="color: var(--text-primary);">{{ settings.ai.openRouterKeyInfo.byokProviders.join(', ') }}</strong>
                    </span>
                  </div>

                  <!-- Quick Action Links -->
                  <div class="mt-1 pt-1.5 border-t flex flex-wrap gap-1.5" style="border-color: var(--border);">
                    <button
                      type="button"
                      @click="openExternalUrl('https://openrouter.ai/settings/keys')"
                      class="text-[9px] px-2 py-0.5 rounded-xs font-medium flex items-center gap-1 cursor-pointer transition-colors"
                      style="background: var(--hover); color: var(--text-primary); border: 0.5px solid var(--border);"
                      title="Manage OpenRouter API Keys in browser"
                    >
                      <span>Keys Dashboard</span>
                      <svg class="w-2.5 h-2.5 opacity-60" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h4a.75.75 0 010 1.5h-4zm6.75-2a.75.75 0 01.75-.75h5.5c.414 0 .75.336.75.75v5.5a.75.75 0 01-1.5 0V4.56l-5.72 5.72a.75.75 0 11-1.06-1.06l5.72-5.72h-4.44a.75.75 0 01-.75-.75z" clip-rule="evenodd" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      @click="openExternalUrl('https://openrouter.ai/settings/integrations')"
                      class="text-[9px] px-2 py-0.5 rounded-xs font-medium flex items-center gap-1 cursor-pointer transition-colors"
                      style="background: var(--hover); color: var(--text-primary); border: 0.5px solid var(--border);"
                      title="Configure BYOK provider accounts on OpenRouter"
                    >
                      <span>BYOK Integrations</span>
                      <svg class="w-2.5 h-2.5 opacity-60" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 014.25 4h4a.75.75 0 010 1.5h-4zm6.75-2a.75.75 0 01.75-.75h5.5c.414 0 .75.336.75.75v5.5a.75.75 0 01-1.5 0V4.56l-5.72 5.72a.75.75 0 11-1.06-1.06l5.72-5.72h-4.44a.75.75 0 01-.75-.75z" clip-rule="evenodd" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      @click="openExternalUrl('https://openrouter.ai/activity')"
                      class="text-[9px] px-2 py-0.5 rounded-xs font-medium flex items-center gap-1 cursor-pointer transition-colors"
                      style="background: var(--hover); color: var(--text-primary); border: 0.5px solid var(--border);"
                      title="View live OpenRouter generation logs and costs"
                    >
                      <span>Activity & Logs</span>
                      <svg class="w-2.5 h-2.5 opacity-60" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 014.25 4h4a.75.75 0 010 1.5h-4zm6.75-2a.75.75 0 01.75-.75h5.5c.414 0 .75.336.75.75v5.5a.75.75 0 01-1.5 0V4.56l-5.72 5.72a.75.75 0 11-1.06-1.06l5.72-5.72h-4.44a.75.75 0 01-.75-.75z" clip-rule="evenodd" />
                      </svg>
                    </button>
                  </div>

                  <div v-if="!isOpenRouterByokActive && !settings.ai.openRouterByokManual" class="text-[9px] mt-0.5 pt-1 border-t" style="border-color: var(--border); color: var(--text-tertiary);">
                    Note: OpenRouter records BYOK usage metrics after your first API call. You can also enable "Assume BYOK Active" below.
                  </div>
                </div>
              </div>
            </div>

            <!-- AI Provider & Connection Settings Toggle Header -->
            <button
              type="button"
              @click="connectionSettingsExpanded = !connectionSettingsExpanded"
              class="w-full flex items-center justify-between px-3.5 py-3 cursor-pointer text-left focus:outline-none transition-all duration-200 border-t border-b hover:bg-black/5 dark:hover:bg-white/5"
              style="background: var(--bg-elevated); border-color: var(--border);"
            >
              <div class="flex items-start gap-2.5">
                <svg class="w-4 h-4 mt-0.5 shrink-0" style="color: var(--accent);" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.022 6.022 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V9a1 1 0 001 1h4a1 1 0 001-1v-.01a5.976 5.976 0 011.603 3.652A6.002 6.002 0 014.332 8.027zM9 14.93A5.99 5.99 0 0110 4c.326 0 .647.026.96.076a5.986 5.986 0 01-1.93 5.378A1 1 0 008.5 10v1.5a1.5 1.5 0 01-1.5 1.5H5.828A5.967 5.967 0 019 14.93z" clip-rule="evenodd" />
                </svg>
                <div class="flex flex-col">
                  <span class="text-xs font-bold tracking-wide" style="color: var(--text-primary);">AI Provider & Connection Settings</span>
                  <span class="text-[10.5px] mt-0.5 font-medium" style="color: var(--text-secondary);">
                    Configure API keys, model provider, endpoints, batch sizes, and max tokens
                  </span>
                </div>
              </div>
              <svg
                class="w-4 h-4 transition-transform duration-200 transform shrink-0"
                :class="{ 'rotate-180': connectionSettingsExpanded }"
                viewBox="0 0 20 20"
                fill="currentColor"
                style="color: var(--accent);"
              >
                <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
              </svg>
            </button>

            <!-- Collapsible Connection Settings Container -->
            <div v-show="connectionSettingsExpanded">
              <!-- Provider & API Key (2 Columns) -->
              <div class="px-3 py-2 setting-row">
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">{{ getMessage('provider') }}</label>
                    <select
                      v-model="settings.ai.provider"
                      class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                      style="background: var(--bg-secondary); color: var(--text-primary);"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="claude">Claude (Anthropic)</option>
                      <option value="gemini">Gemini (Google)</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="custom">Custom (OpenAI-compatible)</option>
                    </select>
                  </div>

                  <div>
                    <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">{{ getMessage('apiKey') }}</label>
                    <input
                      type="text"
                      v-model="settings.ai.apiKey"
                      placeholder="sk-... / AIza... / sk-or-..."
                      class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                      style="background: var(--bg-secondary); color: var(--text-primary);"
                    />
                  </div>
                </div>
              </div>

              <!-- Endpoint (Full Width) -->
              <div class="px-3 py-2 setting-row">
                <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">{{ getMessage('endpoint') }}</label>
                <input
                  type="url"
                  v-model="settings.ai.endpoint"
                  :placeholder="endpointPlaceholder"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                />
              </div>

              <!-- Batch Size, Max Tokens & Max Retries (3 Columns) -->
              <div class="px-3 py-2 setting-row">
                <div class="grid grid-cols-3 gap-2.5">
                  <!-- Batch Size -->
                  <div>
                    <label class="block text-[10px] font-medium mb-1 truncate" style="color: var(--text-secondary);">
                      {{ getMessage('batchSize') || 'Batch Size' }}
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <input
                      type="number"
                      v-model.number="settings.ai.batchSize"
                      :placeholder="getAutoBatchSize(settings.ai.maxTokens || currentModelDefaultMaxTokens).toString() + ' (Auto)'"
                      max="1000"
                      class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                      style="background: var(--bg-secondary); color: var(--text-primary);"
                    />
                  </div>

                  <!-- Max Tokens -->
                  <div>
                    <label class="block text-[10px] font-medium mb-1 truncate" style="color: var(--text-secondary);">
                      Max Output Tokens
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <input
                      type="number"
                      v-model.number="settings.ai.maxTokens"
                      :placeholder="currentModelDefaultMaxTokens.toString()"
                      min="1"
                      max="1048576"
                      class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                      style="background: var(--bg-secondary); color: var(--text-primary);"
                    />
                  </div>

                  <!-- Max Retries -->
                  <div>
                    <label class="block text-[10px] font-medium mb-1 truncate" style="color: var(--text-secondary);">
                      Max Retries
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <input
                      type="number"
                      v-model.number="settings.ai.maxRetries"
                      placeholder="2"
                      min="0"
                      max="10"
                      class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                      style="background: var(--bg-secondary); color: var(--text-primary);"
                    />
                  </div>
                </div>
              </div>

              <!-- OpenRouter Provider Routing (e.g. Google, NVIDIA, Groq) -->
              <div v-if="settings.ai.provider === 'openrouter'" class="px-3 py-2 setting-row">
                <div class="flex items-center justify-between mb-1">
                  <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                    OpenRouter Provider Routing
                    <span style="color: var(--text-tertiary);">(BYOK / Backend)</span>
                  </label>
                  <span class="text-[9px] opacity-70" style="color: var(--text-tertiary);">e.g. Google, NVIDIA, Groq</span>
                </div>
                <select
                  v-model="openRouterProviderSelectValue"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 cursor-pointer"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                >
                  <option value="">Auto (All Providers / Default)</option>
                  <option 
                    v-for="provider in currentOpenRouterProviders" 
                    :key="provider.slug" 
                    :value="provider.slug"
                  >
                    {{ provider.name }} ({{ provider.slug }})
                  </option>
                  <option value="custom">Custom provider slug...</option>
                </select>
                <input
                  v-if="openRouterProviderSelectValue === 'custom'"
                  v-focus
                  type="text"
                  v-model="settings.ai.openrouterProvider"
                  placeholder="Enter provider slug (e.g. google, nvidia, groq)"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 mt-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                />

                <!-- Fetch OpenRouter Providers Button -->
                <div class="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    @click="handleFetchOpenRouterProviders"
                    :disabled="fetchingOpenRouterProviders"
                    class="text-[10px] px-2.5 py-1 rounded-sm flex items-center gap-1.5 font-medium transition-all cursor-pointer"
                    style="background: var(--accent-soft); color: var(--accent); border: 0.5px solid var(--border);"
                    title="Fetch live provider list from OpenRouter API"
                  >
                    <span v-if="fetchingOpenRouterProviders" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
                    <svg v-else class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd" />
                    </svg>
                    <span>{{ fetchingOpenRouterProviders ? 'Fetching providers...' : 'Fetch Live Providers from OpenRouter' }}</span>
                  </button>
                </div>
                <div v-if="fetchOpenRouterProvidersMessage" class="mt-1.5 text-[10px] font-medium" style="color: var(--group-green);">
                  {{ fetchOpenRouterProvidersMessage }}
                </div>
                <div v-if="fetchOpenRouterProvidersError" class="mt-1.5 text-[10px] font-medium" style="color: var(--group-red);">
                  {{ fetchOpenRouterProvidersError }}
                </div>
                <!-- Provider Strategy & Privacy Controls (2 Columns) -->
                <div class="mt-3 grid grid-cols-2 gap-2.5 pt-2.5 border-t" style="border-color: var(--border);">
                  <!-- Routing Strategy (Sort) -->
                  <div>
                    <label class="block text-[10px] font-medium mb-1 truncate" style="color: var(--text-secondary);">
                      Routing Strategy
                    </label>
                    <select
                      v-model="settings.ai.openrouterSort"
                      class="w-full text-xs rounded-sm border-0 py-1.5 px-2 cursor-pointer"
                      style="background: var(--bg-secondary); color: var(--text-primary);"
                    >
                      <option value="auto">Auto (Balanced)</option>
                      <option value="price">Lowest Price (price)</option>
                      <option value="throughput">Highest Speed (throughput)</option>
                      <option value="latency">Lowest Latency (latency)</option>
                    </select>
                  </div>

                  <!-- Data Collection Policy -->
                  <div>
                    <label class="block text-[10px] font-medium mb-1 truncate" style="color: var(--text-secondary);">
                      Privacy Policy
                    </label>
                    <select
                      v-model="settings.ai.openrouterDataCollection"
                      class="w-full text-xs rounded-sm border-0 py-1.5 px-2 cursor-pointer"
                      style="background: var(--bg-secondary); color: var(--text-primary);"
                    >
                      <option value="allow">Standard (Allow All)</option>
                      <option value="deny">Zero Data Retention (deny)</option>
                    </select>
                  </div>
                </div>

                <!-- Fallback Models Input -->
                <div class="mt-2.5">
                  <div class="flex items-center justify-between mb-1">
                    <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                      Model Fallbacks
                      <span style="color: var(--text-tertiary);">(Optional Redundancy)</span>
                    </label>
                    <span class="text-[9px] opacity-70" style="color: var(--text-tertiary);">Comma-separated model IDs</span>
                  </div>
                  <input
                    type="text"
                    v-model="settings.ai.openrouterFallbackModels"
                    placeholder="e.g. openai/gpt-4o-mini, google/gemini-2.5-flash"
                    class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                    style="background: var(--bg-secondary); color: var(--text-primary);"
                  />
                </div>

                <!-- Excluded Providers Input -->
                <div class="mt-2.5">
                  <div class="flex items-center justify-between mb-1">
                    <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                      Exclude Providers
                      <span style="color: var(--text-tertiary);">(Optional Blacklist)</span>
                    </label>
                    <span class="text-[9px] opacity-70" style="color: var(--text-tertiary);">Comma-separated provider slugs</span>
                  </div>
                  <input
                    type="text"
                    v-model="settings.ai.openrouterIgnoreProviders"
                    placeholder="e.g. cloudflare, novita"
                    class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                    style="background: var(--bg-secondary); color: var(--text-primary);"
                  />
                </div>
              </div>

              <!-- Require All Parameters Supported Toggle (OpenRouter only) -->
              <label v-if="settings.ai.provider === 'openrouter'" class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
                <div class="flex-1">
                  <span class="text-xs block font-medium" style="color: var(--text-primary);">Enforce Parameter Support</span>
                  <span class="text-[10.5px] block" style="color: var(--text-secondary);">Only route to providers supporting all requested JSON schema parameters</span>
                </div>
                <div class="relative shrink-0">
                  <input
                    type="checkbox"
                    v-model="settings.ai.openrouterRequireParams"
                    class="sr-only peer"
                  />
                  <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                  <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
                </div>
              </label>

              <!-- Allow Fallbacks Toggle (OpenRouter only) -->
              <label v-if="settings.ai.provider === 'openrouter' && settings.ai.openrouterProvider" class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
                <div class="flex-1">
                  <span class="text-xs block font-medium" style="color: var(--text-primary);">Allow Provider Fallbacks</span>
                  <span class="text-[10.5px] block" style="color: var(--text-secondary);">Allow fallback to other providers if {{ settings.ai.openrouterProvider }} fails (uncheck to hard-lock to BYOK)</span>
                </div>
                <div class="relative shrink-0">
                  <input
                    type="checkbox"
                    v-model="settings.ai.openrouterAllowFallbacks"
                    class="sr-only peer"
                  />
                  <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                  <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
                </div>
              </label>

              <!-- Assume BYOK Active Manual Override Toggle (OpenRouter only) -->
              <label v-if="settings.ai.provider === 'openrouter'" class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
                <div class="flex-1">
                  <span class="text-xs block font-medium" style="color: var(--text-primary);">Assume BYOK Active (Direct Billing)</span>
                  <span class="text-[10.5px] block" style="color: var(--text-secondary);">Force BYOK badges and direct upstream billing labels for newly provisioned keys</span>
                </div>
                <div class="relative shrink-0">
                  <input
                    type="checkbox"
                    v-model="settings.ai.openRouterByokManual"
                    class="sr-only peer"
                  />
                  <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                  <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
                </div>
              </label>

              <!-- Test connection -->
              <div class="flex items-center gap-2.5 px-3.5 py-2.5 setting-row">
                <button
                  @click="testConnection"
                  :disabled="testing || !settings.ai.apiKey"
                  class="px-3.5 py-1.5 text-[11px] font-medium rounded-sm disabled:opacity-40"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                >
                  {{ testing ? getMessage('testing') : getMessage('testConnection') }}
                </button>
                <span v-if="testResult?.ok" class="text-[11px] font-medium" style="color: var(--group-green);">{{ getMessage('connected') }}</span>
                <span v-else-if="testResult" class="text-[11px]" style="color: var(--group-red);">{{ testResult.error || getMessage('failed') }}</span>
              </div>
            </div>

            <!-- Advanced Prompt Instructions Toggle Header -->
            <button
              type="button"
              @click="advancedPromptsExpanded = !advancedPromptsExpanded"
              class="w-full flex items-center justify-between px-3.5 py-3 cursor-pointer text-left focus:outline-none transition-all duration-200 border-t border-b hover:bg-black/5 dark:hover:bg-white/5"
              style="background: var(--bg-elevated); border-color: var(--border);"
            >
              <div class="flex items-start gap-2.5">
                <svg class="w-4 h-4 mt-0.5 shrink-0" style="color: var(--accent);" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
                <div class="flex flex-col">
                  <span class="text-xs font-bold tracking-wide" style="color: var(--text-primary);">Advanced Prompt Instructions</span>
                  <span class="text-[10.5px] mt-0.5 font-medium" style="color: var(--text-secondary);">
                    Configure tab grouping rules, coherence guidelines, and system prompts
                  </span>
                </div>
              </div>
              <svg
                class="w-4 h-4 transition-transform duration-200 transform shrink-0"
                :class="{ 'rotate-180': advancedPromptsExpanded }"
                viewBox="0 0 20 20"
                fill="currentColor"
                style="color: var(--accent);"
              >
                <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
              </svg>
            </button>

            <!-- Collapsible Prompts Container -->
            <div v-show="advancedPromptsExpanded" class="advanced-prompts-wrapper border-b" style="border-color: var(--border);">
              <!-- Segmented Tabs Navigation Bar -->
              <div class="flex items-center justify-between gap-1 px-3 py-1.5 border-b flex-wrap" style="border-color: var(--border); background: var(--bg-primary);">
                <div class="flex items-center gap-1 flex-wrap">
                  <button
                    v-for="tab in promptTabs"
                    :key="tab.id"
                    type="button"
                    @click="activePromptTab = tab.id"
                    class="px-2 py-0.75 text-[10px] font-medium rounded-sm transition-all flex items-center gap-1 cursor-pointer select-none border"
                    :style="activePromptTab === tab.id
                      ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }
                      : { background: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }"
                  >
                    <span>{{ tab.label }}</span>
                    <span
                      v-if="tab.isCustomized"
                      class="w-1.5 h-1.5 rounded-full shrink-0"
                      :style="{ background: activePromptTab === tab.id ? '#fff' : 'var(--accent)' }"
                      title="Customized"
                    />
                  </button>
                </div>
                <button
                  type="button"
                  @click="activePromptTab = (activePromptTab === 'all' ? 'grouping' : 'all')"
                  class="px-2 py-0.75 text-[9.5px] font-medium rounded-sm transition-all flex items-center gap-1 shrink-0 ml-auto cursor-pointer border"
                  :style="activePromptTab === 'all'
                    ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'var(--accent)' }
                    : { background: 'var(--bg-secondary)', color: 'var(--text-tertiary)', borderColor: 'var(--border)' }"
                  title="Toggle between single prompt view and all prompts grid"
                >
                  <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM11 13a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                  </svg>
                  <span>{{ activePromptTab === 'all' ? 'Single View' : 'All Prompts' }}</span>
                </button>
              </div>

              <!-- Prompts Grid / Active Card Container -->
              <div class="p-2" :class="{ 'advanced-prompts-grid': activePromptTab === 'all' }">
                <!-- Grouping Prompt -->
                <div v-show="activePromptTab === 'grouping' || activePromptTab === 'all'" class="prompt-card">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <label class="block text-[10px] font-medium truncate" style="color: var(--text-secondary);">
                        Tab Grouping Prompt
                        <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                      </label>
                      <div class="relative group/help shrink-0">
                        <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                        <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[270px] max-w-[calc(100vw-32px)] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                          <div class="font-bold mb-1" style="color: var(--accent);">Tab Grouping Prompt</div>
                          Defines tab clustering logic and categories.
                          
                          <strong style="color: var(--accent);">Data sent to AI</strong>:
                          • List of browser tabs: [Index, Title, Domain or Full URL, Opened timestamp]
                        </div>
                      </div>
                    </div>
                    <button
                      v-if="settings.ai.groupingPrompt !== DEFAULT_GROUPING_PROMPT"
                      @click="resetGroupingPrompt"
                      class="text-[9px] hover:underline shrink-0 ml-1.5"
                      style="color: var(--accent);"
                      title="Restore default instructions"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <textarea
                    v-model="settings.ai.groupingPrompt"
                    v-autoresize
                    :placeholder="'Default:\n' + DEFAULT_GROUPING_PROMPT"
                    class="w-full text-xs rounded-sm py-1.5 px-2 resize-y overflow-y-auto flex-1 scrollbar-thin transition-all"
                    :class="activePromptTab === 'all' ? 'min-h-[64px] max-h-[110px]' : 'min-h-[105px] max-h-[220px]'"
                    style="background: var(--bg-primary); color: var(--text-primary); border: 0.5px solid var(--border);"
                  ></textarea>
                </div>

                <!-- Coherence Prompt -->
                <div v-show="activePromptTab === 'coherence' || activePromptTab === 'all'" class="prompt-card">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <label class="block text-[10px] font-medium truncate" style="color: var(--text-secondary);">
                        Batch Coherence Instructions
                        <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                      </label>
                      <div class="relative group/help shrink-0">
                        <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                        <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[270px] max-w-[calc(100vw-32px)] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                          <div class="font-bold mb-1" style="color: var(--accent);">Batch Coherence</div>
                          Injected into subsequent batches (batch 2+).
                          
                          <strong style="color: var(--accent);">Data sent to AI</strong>:
                          • Current batch tab list [Index, Title, Domain/URL, Opened timestamp]
                          • List of existing group names created in previous batches (e.g., ["Dev", "Shopping"])
                        </div>
                      </div>
                    </div>
                    <button
                      v-if="settings.ai.coherencePrompt !== DEFAULT_SETTINGS.ai.coherencePrompt"
                      @click="settings.ai.coherencePrompt = DEFAULT_SETTINGS.ai.coherencePrompt"
                      class="text-[9px] hover:underline shrink-0 ml-1.5"
                      style="color: var(--accent);"
                      title="Restore default instructions"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <textarea
                    v-model="settings.ai.coherencePrompt"
                    v-autoresize
                    placeholder="Instructions on how to reuse existing groups..."
                    class="w-full text-xs rounded-sm py-1.5 px-2 resize-y overflow-y-auto flex-1 scrollbar-thin transition-all"
                    :class="activePromptTab === 'all' ? 'min-h-[64px] max-h-[110px]' : 'min-h-[105px] max-h-[220px]'"
                    style="background: var(--bg-primary); color: var(--text-primary); border: 0.5px solid var(--border);"
                  ></textarea>
                </div>

                <!-- Split Group Prompt -->
                <div v-show="activePromptTab === 'split' || activePromptTab === 'all'" class="prompt-card">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <label class="block text-[10px] font-medium truncate" style="color: var(--text-secondary);">
                        Split Group Prompt
                        <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                      </label>
                      <div class="relative group/help shrink-0">
                        <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                        <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[270px] max-w-[calc(100vw-32px)] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                          <div class="font-bold mb-1" style="color: var(--accent);">Split Group Prompt</div>
                          Defines how highly related tab groups are divided into finer sub-groups.
                          
                          <strong style="color: var(--accent);">Data sent to AI</strong>:
                          • Target group's tab list: [Index, Title, Domain or Full URL, Opened timestamp]
                        </div>
                      </div>
                    </div>
                    <button
                      v-if="settings.ai.splitPrompt !== DEFAULT_SPLIT_PROMPT"
                      @click="resetSplitPrompt"
                      class="text-[9px] hover:underline shrink-0 ml-1.5"
                      style="color: var(--accent);"
                      title="Restore default instructions"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <textarea
                    v-model="settings.ai.splitPrompt"
                    v-autoresize
                    :placeholder="'Default:\n' + DEFAULT_SPLIT_PROMPT"
                    class="w-full text-xs rounded-sm py-1.5 px-2 resize-y overflow-y-auto flex-1 scrollbar-thin transition-all"
                    :class="activePromptTab === 'all' ? 'min-h-[64px] max-h-[110px]' : 'min-h-[105px] max-h-[220px]'"
                    style="background: var(--bg-primary); color: var(--text-primary); border: 0.5px solid var(--border);"
                  ></textarea>
                </div>

                <!-- Add New Tabs Prompt -->
                <div v-show="activePromptTab === 'classify' || activePromptTab === 'all'" class="prompt-card">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <label class="block text-[10px] font-medium truncate" style="color: var(--text-secondary);">
                        Add New Tabs Prompt
                        <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                      </label>
                      <div class="relative group/help shrink-0">
                        <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                        <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[270px] max-w-[calc(100vw-32px)] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                          <div class="font-bold mb-1" style="color: var(--accent);">Add New Tabs Prompt</div>
                          Defines instructions for classifying new incoming tabs into existing groups.
                          
                          <strong style="color: var(--accent);">Data sent to AI</strong>:
                          • New tab list [Index, Title, Domain/URL, Opened timestamp]
                          • List of existing group names in the current window
                        </div>
                      </div>
                    </div>
                    <button
                      v-if="settings.ai.classifyPrompt !== DEFAULT_CLASSIFY_PROMPT"
                      @click="resetClassifyPrompt"
                      class="text-[9px] hover:underline shrink-0 ml-1.5"
                      style="color: var(--accent);"
                      title="Restore default instructions"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <textarea
                    v-model="settings.ai.classifyPrompt"
                    v-autoresize
                    :placeholder="'Default:\n' + DEFAULT_CLASSIFY_PROMPT"
                    class="w-full text-xs rounded-sm py-1.5 px-2 resize-y overflow-y-auto flex-1 scrollbar-thin transition-all"
                    :class="activePromptTab === 'all' ? 'min-h-[64px] max-h-[110px]' : 'min-h-[105px] max-h-[220px]'"
                    style="background: var(--bg-primary); color: var(--text-primary); border: 0.5px solid var(--border);"
                  ></textarea>
                </div>

                <!-- Merge Group Prompt -->
                <div v-show="activePromptTab === 'merge' || activePromptTab === 'all'" class="prompt-card">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <label class="block text-[10px] font-medium truncate" style="color: var(--text-secondary);">
                        Merge Group Prompt
                        <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                      </label>
                      <div class="relative group/help shrink-0">
                        <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                        <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[270px] max-w-[calc(100vw-32px)] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                          <div class="font-bold mb-1" style="color: var(--accent);">Merge Group Prompt</div>
                          Defines instructions for choosing an existing group to merge this tab group into.
                          
                          <strong style="color: var(--accent);">Data sent to AI</strong>:
                          • Target group's tab list: [Index, Title, Domain or Full URL, Opened timestamp]
                          • List of all other existing group names in the window
                        </div>
                      </div>
                    </div>
                    <button
                      v-if="settings.ai.mergePrompt !== DEFAULT_MERGE_PROMPT"
                      @click="resetMergePrompt"
                      class="text-[9px] hover:underline shrink-0 ml-1.5"
                      style="color: var(--accent);"
                      title="Restore default instructions"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <textarea
                    v-model="settings.ai.mergePrompt"
                    v-autoresize
                    :placeholder="'Default:\n' + DEFAULT_MERGE_PROMPT"
                    class="w-full text-xs rounded-sm py-1.5 px-2 resize-y overflow-y-auto flex-1 scrollbar-thin transition-all"
                    :class="activePromptTab === 'all' ? 'min-h-[64px] max-h-[110px]' : 'min-h-[105px] max-h-[220px]'"
                    style="background: var(--bg-primary); color: var(--text-primary); border: 0.5px solid var(--border);"
                  ></textarea>
                </div>

                <!-- Window Naming Prompt -->
                <div v-show="activePromptTab === 'windowNaming' || activePromptTab === 'all'" class="prompt-card">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <label class="block text-[10px] font-medium truncate" style="color: var(--text-secondary);">
                        Window Naming Prompt
                        <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                      </label>
                      <div class="relative group/help shrink-0">
                        <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                        <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[270px] max-w-[calc(100vw-32px)] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                          <div class="font-bold mb-1" style="color: var(--accent);">Window Naming Prompt</div>
                          Defines instructions for generating concise, descriptive browser window titles based on open tabs.
                          
                          <strong style="color: var(--accent);">Data sent to AI</strong>:
                          • Window tabs: [Index, Title, Domain or Full URL, Opened timestamp]
                          • List of other open window names to contrast with
                        </div>
                      </div>
                    </div>
                    <button
                      v-if="settings.ai.windowNamingPrompt !== DEFAULT_WINDOW_NAMING_PROMPT"
                      @click="resetWindowNamingPrompt"
                      class="text-[9px] hover:underline shrink-0 ml-1.5"
                      style="color: var(--accent);"
                      title="Restore default instructions"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <textarea
                    v-model="settings.ai.windowNamingPrompt"
                    v-autoresize
                    :placeholder="'Default:\n' + DEFAULT_WINDOW_NAMING_PROMPT"
                    class="w-full text-xs rounded-sm py-1.5 px-2 resize-y overflow-y-auto flex-1 scrollbar-thin transition-all"
                    :class="activePromptTab === 'all' ? 'min-h-[64px] max-h-[110px]' : 'min-h-[105px] max-h-[220px]'"
                    style="background: var(--bg-primary); color: var(--text-primary); border: 0.5px solid var(--border);"
                  ></textarea>
                </div>

                <!-- Custom Prompt -->
                <div v-show="activePromptTab === 'custom' || activePromptTab === 'all'" class="prompt-card">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <label class="block text-[10px] font-medium truncate" style="color: var(--text-secondary);">
                        Custom System Prompt Instructions
                        <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                      </label>
                      <div class="relative group/help shrink-0">
                        <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                        <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[270px] max-w-[calc(100vw-32px)] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                          <div class="font-bold mb-1" style="color: var(--accent);">Custom System Prompt</div>
                          Defines global behavior, persona, and output style rules.
                          
                          <strong style="color: var(--accent);">Data sent to AI</strong>:
                          • System instructions prepended to every AI prompt
                        </div>
                      </div>
                    </div>
                    <button
                      v-if="settings.ai.customPrompt"
                      @click="resetSystemPrompt"
                      class="text-[9px] hover:underline shrink-0 ml-1.5"
                      style="color: var(--accent);"
                      title="Restore default instructions"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <textarea
                    v-model="settings.ai.customPrompt"
                    v-autoresize
                    :placeholder="'Default:\n' + SYSTEM_PROMPT"
                    class="w-full text-xs rounded-sm py-1.5 px-2 resize-y overflow-y-auto flex-1 scrollbar-thin transition-all"
                    :class="activePromptTab === 'all' ? 'min-h-[64px] max-h-[110px]' : 'min-h-[105px] max-h-[220px]'"
                    style="background: var(--bg-primary); color: var(--text-primary); border: 0.5px solid var(--border);"
                  ></textarea>
                </div>
              </div>
            </div>
          </template>

          <div class="px-3.5 py-2.5">
            <p class="text-[10px] leading-relaxed" style="color: var(--text-tertiary);">
              {{ getMessage('apiKeyNote') }}
            </p>
          </div>
        </div>
      </div>

      <!-- Model Context Protocol (MCP) Bridge -->
      <div>
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5 flex items-center gap-1.5" style="color: var(--text-secondary);">
          <svg class="w-3.5 h-3.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 3a1 1 0 01.707.293l3 3a1 1 0 01-1.414 1.414L11 6.414V14a1 1 0 11-2 0V6.414L7.707 7.707a1 1 0 01-1.414-1.414l3-3A1 1 0 0110 3zm-3.707 9.293a1 1 0 011.414 0L10 14.586l2.293-2.293a1 1 0 011.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
          </svg>
          Model Context Protocol (MCP) Bridge
        </h2>
        <div class="rounded-sm overflow-hidden" style="background: var(--bg-primary); box-shadow: var(--shadow-xs);">
          <!-- Enable toggle -->
          <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
            <div class="flex-1">
              <span class="text-xs block" style="color: var(--text-primary);">Enable MCP WebSocket Server</span>
              <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                Bridges browser tab operations directly to your AI agents locally.
              </p>
            </div>
            <div class="relative mt-0.5">
              <input
                type="checkbox"
                v-model="settings.mcpEnabled"
                class="sr-only peer"
              />
              <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
              <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
            </div>
          </label>

          <template v-if="settings.mcpEnabled">
            <!-- Connection Status -->
            <div class="px-3.5 py-2.5 setting-row flex flex-col gap-1.5">
              <label class="block text-[10px] font-semibold uppercase tracking-wider" style="color: var(--text-secondary);">
                MCP Bridge Connection Status
              </label>
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span 
                    class="w-2.5 h-2.5 rounded-full inline-block"
                    :class="{
                      'bg-green-500 shadow-[0_0_8px_rgba(52,199,89,0.6)]': mcpStatus.state === 'connected',
                      'bg-yellow-500 animate-pulse shadow-[0_0_8px_rgba(255,159,10,0.6)]': mcpStatus.state === 'connecting',
                      'bg-red-500 shadow-[0_0_8px_rgba(255,59,48,0.6)]': mcpStatus.state === 'disconnected' || mcpStatus.state === 'disabled'
                    }"
                    :style="{
                      background: mcpStatus.state === 'connected' ? 'var(--group-green)' : (mcpStatus.state === 'connecting' ? 'var(--group-yellow)' : 'var(--group-red)')
                    }"
                  />
                  <span class="text-xs font-semibold capitalize" :style="{ color: mcpStatus.state === 'connected' ? 'var(--group-green)' : (mcpStatus.state === 'connecting' ? 'var(--group-yellow)' : 'var(--text-primary)') }">
                    {{ mcpStatus.state }}
                  </span>
                </div>
                <button
                  v-if="mcpStatus.state !== 'connected'"
                  @click="triggerReconnect"
                  :disabled="reconnecting"
                  class="px-2.5 py-1 text-[10px] font-medium rounded-sm border transition-all duration-200"
                  style="background: var(--bg-secondary); color: var(--text-primary); border-color: var(--border);"
                >
                  {{ reconnecting ? 'Connecting...' : 'Retry Now' }}
                </button>
              </div>
              
              <!-- Connection Error Display -->
              <p 
                v-if="mcpStatus.state === 'disconnected' && mcpStatus.error" 
                class="text-[10px] leading-relaxed p-1.5 rounded-sm border mt-1" 
                style="color: var(--group-red); background: rgba(255,59,48,0.06); border-color: rgba(255,59,48,0.15);"
              >
                <strong>Error:</strong> {{ mcpStatus.error }}
                <br />
                <span v-if="mcpStatus.autoRetrySecondsLeft && mcpStatus.autoRetrySecondsLeft > 0" class="text-[9px] opacity-90">Auto-retry in <span class="font-bold" style="color: var(--group-yellow);">{{ mcpStatus.autoRetrySecondsLeft }}</span>s...</span>
                <span v-else class="text-[9px] opacity-75">Auto-retrying every 5 seconds...</span>
              </p>
            </div>

            <!-- Port Selection -->
            <div class="px-3.5 py-2.5 setting-row">
              <label class="block text-[10px] font-semibold uppercase tracking-wider mb-1" style="color: var(--text-secondary);">
                WebSocket Server Port
              </label>
              <input
                type="number"
                v-model.number="settings.mcpPort"
                placeholder="8585"
                min="1024"
                max="65535"
                class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                style="background: var(--bg-secondary); color: var(--text-primary);"
              />
              <p class="text-[10px] mt-1.5 leading-relaxed" style="color: var(--text-tertiary);">
                Server listens on 127.0.0.1. Ensure your MCP client points to the same port.
              </p>
            </div>

            <!-- Auth Token -->
            <div class="px-3.5 py-2.5 setting-row">
              <label class="block text-[10px] font-semibold uppercase tracking-wider mb-1" style="color: var(--text-secondary);">
                Auth Token
              </label>
              <div class="flex items-center gap-1.5">
                <input
                  :type="mcpTokenVisible ? 'text' : 'password'"
                  :value="mcpToken"
                  readonly
                  class="flex-1 min-w-0 text-xs font-mono rounded-sm border-0 py-1.5 px-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                />
                <button
                  @click="mcpTokenVisible = !mcpTokenVisible"
                  class="px-2 py-1 text-[10px] font-medium rounded-sm border"
                  style="background: var(--bg-secondary); color: var(--text-primary); border-color: var(--border);"
                >
                  {{ mcpTokenVisible ? 'Hide' : 'Show' }}
                </button>
                <button
                  @click="copyMCPToken"
                  class="px-2 py-1 text-[10px] font-medium rounded-sm border"
                  style="background: var(--bg-secondary); color: var(--text-primary); border-color: var(--border);"
                >
                  {{ mcpTokenCopied ? 'Copied!' : 'Copy' }}
                </button>
                <button
                  @click="regenerateMCPToken"
                  class="px-2 py-1 text-[10px] font-medium rounded-sm border"
                  style="background: var(--bg-secondary); color: var(--text-primary); border-color: var(--border);"
                >
                  New
                </button>
              </div>
              <p class="text-[10px] mt-1.5 leading-relaxed" style="color: var(--text-tertiary);">
                Your MCP server must send <code>{"type":"auth","token":"&lt;token&gt;"}</code> as its first message. Commands from unauthenticated servers are ignored.
              </p>
            </div>

            <!-- Script execution opt-in -->
            <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
              <div class="flex-1">
                <span class="text-xs block" style="color: var(--text-primary);">Allow script execution</span>
                <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--group-red);">
                  Lets the MCP server run any JavaScript in any tab (execute_script). Only enable if you trust every tool connected to it.
                </p>
              </div>
              <div class="relative mt-0.5">
                <input
                  type="checkbox"
                  v-model="settings.mcpAllowScriptExecution"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>
          </template>
        </div>
      </div>
    </div>

    <!-- Right Column: App Preferences & Tools -->
    <div class="settings-column">
      <!-- Keyboard Shortcut -->
      <div>
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5 flex items-center gap-1.5" style="color: var(--text-secondary);">
          <svg class="w-3.5 h-3.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M3 5a2 2 0 00-2 2v6a2 2 0 002 2h14a2 2 0 002-2V7a2 2 0 00-2-2H3zm0 2h14v6H3V7zm2 2a1 1 0 011-1h2a1 1 0 110 2H6a1 1 0 01-1-1zm6-1a1 1 0 100 2h2a1 1 0 100-2h-2zm-6 4a1 1 0 100 2h8a1 1 0 100-2H5z" clip-rule="evenodd" />
          </svg>
          {{ getMessage('shortcutTitle') }}
        </h2>
        <div class="rounded-sm overflow-hidden flex flex-col" style="background: var(--bg-primary); box-shadow: var(--shadow-xs);">
          <div class="flex items-center justify-between px-3 py-3 border-b border-white/5 relative group">
            <div>
              <div class="text-xs font-medium" style="color: var(--text-primary);">{{ getMessage('cmdOpenPopup') }}</div>
              <div class="mt-2 flex gap-1 items-center">
                <template v-for="(key, i) in popupShortcut.split('+')" :key="'p-'+i">
                  <span v-if="i > 0" class="text-[10px] opacity-40" style="color: var(--text-secondary);">+</span>
                  <kbd class="px-2 py-1 text-[10px] font-mono rounded-[4px] border" style="background: var(--bg-secondary); color: var(--text-primary); border-color: var(--border-color); box-shadow: 0 1px 1px rgba(0,0,0,0.1);">{{ key }}</kbd>
                </template>
              </div>
            </div>
            <button
              @click="openShortcutSettings"
              class="px-3 py-1.5 text-[11px] font-medium rounded-sm hover:opacity-80 transition-opacity"
              style="color: var(--accent);"
            >
              {{ getMessage('changeShortcut') }}
            </button>
          </div>
          <div class="flex items-center justify-between px-3 py-3 border-b border-white/5 relative group">
            <div>
              <div class="text-xs font-medium" style="color: var(--text-primary);">{{ getMessage('cmdOpenSearch') }}</div>
              <div class="mt-2 flex gap-1 items-center">
                <template v-for="(key, i) in searchShortcut.split('+')" :key="'f-'+i">
                  <span v-if="i > 0" class="text-[10px] opacity-40" style="color: var(--text-secondary);">+</span>
                  <kbd class="px-2 py-1 text-[10px] font-mono rounded-[4px] border" style="background: var(--bg-secondary); color: var(--text-primary); border-color: var(--border-color); box-shadow: 0 1px 1px rgba(0,0,0,0.1);">{{ key }}</kbd>
                </template>
              </div>
            </div>
            <button
              @click="openShortcutSettings"
              class="px-3 py-1.5 text-[11px] font-medium rounded-sm opacity-0 group-hover:opacity-100 transition-opacity"
              style="color: var(--accent);"
            >
              {{ getMessage('changeShortcut') }}
            </button>
          </div>
          <div class="flex items-center justify-between px-3 py-3 relative group">
            <div>
              <div class="text-xs font-medium" style="color: var(--text-primary);">{{ getMessage('cmdOpenSearchSlash') }}</div>
              <div class="mt-2 flex gap-1 items-center">
                <template v-for="(key, i) in searchSlashShortcut.split('+')" :key="'s-'+i">
                  <span v-if="i > 0" class="text-[10px] opacity-40" style="color: var(--text-secondary);">+</span>
                  <kbd class="px-2 py-1 text-[10px] font-mono rounded-[4px] border" style="background: var(--bg-secondary); color: var(--text-primary); border-color: var(--border-color); box-shadow: 0 1px 1px rgba(0,0,0,0.1);">{{ key }}</kbd>
                </template>
              </div>
            </div>
            <button
              @click="openShortcutSettings"
              class="px-3 py-1.5 text-[11px] font-medium rounded-sm opacity-0 group-hover:opacity-100 transition-opacity"
              style="color: var(--accent);"
            >
              {{ getMessage('changeShortcut') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Display Settings -->
      <div>
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5 flex items-center gap-1.5" style="color: var(--text-secondary);">
          <svg class="w-3.5 h-3.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4 2a2 2 0 00-2 2v11a3 3 0 106 0V4a2 2 0 00-2-2H4zm1 14a1 1 0 100-2 1 1 0 000 2zm5-1.757l4.9-4.9a2 2 0 000-2.828L13.485 5.1a2 2 0 00-2.828 0L9.757 8.1 10 14.243z" clip-rule="evenodd" />
          </svg>
          {{ getMessage('displaySettings') }}
        </h2>
        <div class="rounded-sm overflow-hidden" style="background: var(--bg-primary); box-shadow: var(--shadow-xs);">
          <!-- Group indicator style -->
          <div class="px-3.5 py-3">
            <label class="block text-[10px] font-medium mb-2.5" style="color: var(--text-secondary);">
              {{ getMessage('groupIndicatorStyle') }}
            </label>
            <div class="grid grid-cols-2 gap-2.5">
              <!-- Classic mode card -->
              <label
                class="relative flex flex-col items-center gap-2 p-3 rounded-sm border-2 cursor-pointer transition-all"
                :style="settings.groupIndicatorStyle === 'header'
                  ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' }
                  : { borderColor: 'var(--border)', background: 'transparent' }"
              >
                <input type="radio" v-model="settings.groupIndicatorStyle" value="header" class="sr-only" />
                <div class="w-full space-y-1.5">
                  <div class="flex items-center gap-1.5">
                    <span class="w-1.5 h-1.5 rounded-full" style="background: var(--accent);" />
                    <span class="h-1 flex-1 rounded-full" style="background: var(--text-tertiary); opacity: 0.4;" />
                  </div>
                  <div class="pl-3 space-y-1">
                    <div class="h-1 w-3/4 rounded-full" style="background: var(--text-tertiary); opacity: 0.25;" />
                    <div class="h-1 w-1/2 rounded-full" style="background: var(--text-tertiary); opacity: 0.25;" />
                  </div>
                </div>
                <span class="text-[10px] font-medium" style="color: var(--text-primary);">
                  {{ getMessage('styleHeader') }}
                </span>
              </label>
              <!-- Minimal mode card -->
              <label
                class="relative flex flex-col items-center gap-2 p-3 rounded-sm border-2 cursor-pointer transition-all"
                :style="settings.groupIndicatorStyle === 'bar'
                  ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' }
                  : { borderColor: 'var(--border)', background: 'transparent' }"
              >
                <input type="radio" v-model="settings.groupIndicatorStyle" value="bar" class="sr-only" />
                <div class="w-full space-y-1">
                  <div class="flex items-center gap-1.5">
                    <span class="w-[2px] h-3 rounded-full" style="background: var(--accent);" />
                    <span class="h-1 flex-1 rounded-full" style="background: var(--text-tertiary); opacity: 0.25;" />
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="w-[2px] h-3 rounded-full" style="background: var(--accent);" />
                    <span class="h-1 w-3/4 rounded-full" style="background: var(--text-tertiary); opacity: 0.25;" />
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="w-[2px] h-3 rounded-full" style="background: var(--group-green);" />
                    <span class="h-1 w-2/3 rounded-full" style="background: var(--text-tertiary); opacity: 0.25;" />
                  </div>
                </div>
                <span class="text-[10px] font-medium" style="color: var(--text-primary);">
                  {{ getMessage('styleBar') }}
                </span>
              </label>
            </div>
          </div>

          <!-- Divider -->
          <div class="mx-3.5" style="height: 0.5px; background: var(--border);" />

          <!-- Window Dimensions (2 Columns) -->
          <div class="px-3 py-2 setting-row">
            <div class="grid grid-cols-2 gap-3">
              <!-- Window Width -->
              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                    Window Width (px)
                  </label>
                  <button
                    v-if="settings.windowWidth !== 800"
                    @click="settings.windowWidth = 800"
                    class="text-[9px] hover:underline focus:outline-none transition-opacity"
                    style="color: var(--accent);"
                  >
                    Max
                  </button>
                </div>
                <input
                  type="number"
                  v-model.number="settings.windowWidth"
                  placeholder="360"
                  min="360"
                  max="800"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                />
              </div>

              <!-- Window Height -->
              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                    Window Height (px)
                  </label>
                  <button
                    v-if="settings.windowHeight !== 600"
                    @click="settings.windowHeight = 600"
                    class="text-[9px] hover:underline focus:outline-none transition-opacity"
                    style="color: var(--accent);"
                  >
                    Max
                  </button>
                </div>
                <input
                  type="number"
                  v-model.number="settings.windowHeight"
                  placeholder="500"
                  min="240"
                  max="600"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                />
              </div>
            </div>
          </div>

          <!-- Divider -->
          <div class="mx-3.5" style="height: 0.5px; background: var(--border);" />

          <!-- Smart Group Title & 2-Column Search Layout (2 Columns) -->
          <div class="grid grid-cols-2 border-b" style="border-color: var(--border);">
            <!-- Smart group title toggle -->
            <label class="flex items-start gap-3 px-3 py-2 cursor-pointer border-r" style="border-color: var(--border);">
              <div class="flex-1">
                <span class="text-xs block" style="color: var(--text-primary);">{{ getMessage('smartGroupTitle') }}</span>
                <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                  {{ getMessage('smartGroupTitleDesc') }}
                </p>
              </div>
              <div class="relative mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  v-model="settings.smartGroupTitle"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>

            <!-- Search popup layout toggle -->
            <label class="flex items-start gap-3 px-3 py-2 cursor-pointer">
              <div class="flex-1">
                <span class="text-xs block" style="color: var(--text-primary);">Use 2-Column Search Layout</span>
                <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                  Switches popup to wide search overlay design.
                </p>
              </div>
              <div class="relative mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  v-model="settings.useSearchPopup"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>
          </div>

          <!-- Sort new tabs & Offline grouping preview (2 Columns) -->
          <div class="grid grid-cols-2 border-b" style="border-color: var(--border);">
            <!-- Sort new tabs toggle -->
            <label class="flex items-start gap-3 px-3 py-2 cursor-pointer border-r" style="border-color: var(--border);">
              <div class="flex-1">
                <span class="text-xs block" style="color: var(--text-primary);">Sort New Tabs</span>
                <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                  Auto-sort newly created tabs by domain & title.
                </p>
              </div>
              <div class="relative mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  v-model="settings.sortNewTabs"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>

            <!-- Offline grouping preview toggle -->
            <label class="flex items-start gap-3 px-3 py-2 cursor-pointer">
              <div class="flex-1">
                <span class="text-xs block" style="color: var(--text-primary);">{{ getMessage('showRuleGroupsWhenUngrouped') }}</span>
                <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                  {{ getMessage('showRuleGroupsWhenUngroupedDesc') }}
                </p>
              </div>
              <div class="relative mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  v-model="settings.showRuleGroupsWhenUngrouped"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>
          </div>

          <!-- Eco Mode & Fast Overlay Mode (2 Columns) -->
          <div class="grid grid-cols-2">
            <!-- Eco Mode toggle -->
            <label class="flex items-start gap-3 px-3 py-2 cursor-pointer border-r" style="border-color: var(--border);">
              <div class="flex-1">
                <span class="text-xs block font-medium" style="color: var(--text-primary);">{{ getMessage('ecoMode') }}</span>
                <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                  {{ getMessage('ecoModeDesc') }}
                </p>
              </div>
              <div class="relative mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  v-model="settings.ecoMode"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>

            <!-- Fast Overlay Mode toggle -->
            <label class="flex items-start gap-3 px-3 py-2 cursor-pointer">
              <div class="flex-1">
                <span class="text-xs block font-medium" style="color: var(--text-primary);">{{ getMessage('fastOverlayMode') }}</span>
                <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                  {{ getMessage('fastOverlayModeDesc') }}
                </p>
              </div>
              <div class="relative mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  v-model="settings.fastOverlayMode"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>
          </div>
        </div>
      </div>

      <!-- Restorable Closed Tabs Section -->
      <div>
        <div class="flex items-center justify-between px-3 mb-1.5">
          <h2 class="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5" style="color: var(--text-secondary);">
            <svg class="w-3.5 h-3.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3 3a.75.75 0 001.06-1.06l-2.78-2.78V5z" clip-rule="evenodd" />
            </svg>
            {{ getMessage('restorableClosedTabs') }} ({{ closedTabs.length }})
          </h2>
          <div class="flex items-center gap-1.5">
            <button
              v-if="closedTabs.length > 0"
              @click="handleRestoreAllTabs"
              :disabled="restoringAll"
              class="px-2 py-0.5 text-[9px] font-medium rounded-sm transition-all cursor-pointer flex items-center gap-1"
              style="background: var(--bg-primary); color: var(--accent); border: 0.5px solid var(--border);"
              :title="getMessage('restoreAll')"
            >
              <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.451a.75.75 0 000-1.5H4.5a.75.75 0 00-.75.75v3.75a.75.75 0 001.5 0v-2.19l.37.37a7 7 0 101.99-9.19.75.75 0 00-.91 1.192 5.5 5.5 0 018.612 4.723z" clip-rule="evenodd" />
              </svg>
              {{ getMessage('restoreAll') }}
            </button>
            <button
              v-if="closedTabs.length > 0"
              @click="handleClearClosedTabs"
              class="px-2 py-0.5 text-[9px] font-medium rounded-sm transition-all cursor-pointer"
              style="background: var(--bg-primary); color: var(--group-red); border: 0.5px solid var(--border);"
              :title="getMessage('clearClosedTabs')"
            >
              {{ getMessage('clearClosedTabs') }}
            </button>
          </div>
        </div>

        <div class="rounded-sm overflow-hidden p-2 space-y-2" style="background: var(--bg-primary); box-shadow: var(--shadow-xs);">
          <p class="text-[10px] px-1" style="color: var(--text-tertiary);">
            {{ getMessage('restorableClosedTabsDesc') }}
          </p>

          <div v-if="closedTabs.length === 0" class="text-center py-6 text-[11px]" style="color: var(--text-tertiary);">
            {{ getMessage('noClosedTabs') }}
          </div>

          <div v-else class="space-y-1 max-h-[260px] overflow-y-auto pr-0.5">
            <div
              v-for="entry in closedTabs"
              :key="entry.id"
              class="p-2 rounded-sm border flex items-center justify-between gap-2 text-xs transition-all hover:bg-black/5 dark:hover:bg-white/5"
              style="background: var(--bg-secondary); border-color: var(--border);"
            >
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <!-- Favicon -->
                <img
                  v-if="entry.favIconUrl"
                  :src="entry.favIconUrl"
                  alt=""
                  class="w-3.5 h-3.5 shrink-0 rounded-xs object-contain"
                  @error="(e) => (e.target as HTMLElement).style.display = 'none'"
                />
                <svg v-else class="w-3.5 h-3.5 shrink-0 opacity-40" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 7.747a6.5 6.5 0 0110.336-2.08.75.75 0 001.06-1.06A8 8 0 102.5 10c0 .91.152 1.785.432 2.6a.75.75 0 001.4-.526 6.467 6.467 0 01-.004-.327z" clip-rule="evenodd" />
                </svg>

                <div class="min-w-0 flex-1">
                  <div class="font-medium text-[11px] truncate" style="color: var(--text-primary);" :title="entry.title">
                    {{ entry.title }}
                  </div>
                  <div class="flex items-center gap-1.5 text-[9.5px]" style="color: var(--text-tertiary);">
                    <span class="truncate max-w-[180px]" :title="entry.url">{{ entry.url }}</span>
                    <span>&bull;</span>
                    <span>{{ formatTimeAgo(entry.closedAt) }}</span>
                    <span
                      class="px-1.5 py-0.2 rounded-xs text-[8.5px] font-medium shrink-0"
                      :style="entry.batchId ? 'background: rgba(239, 68, 68, 0.12); color: var(--group-red); border: 0.5px solid rgba(239, 68, 68, 0.25);' : 'background: var(--hover); color: var(--accent);'"
                    >
                      {{ entry.source }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Action buttons -->
              <div class="flex items-center gap-1 shrink-0">
                <button
                  v-if="entry.batchId"
                  @click="handleRestoreBatch(entry.batchId)"
                  :disabled="restoringBatchId === entry.batchId"
                  class="px-2 py-1 text-[9.5px] font-semibold rounded-xs transition-colors cursor-pointer flex items-center gap-1 border"
                  style="background: var(--bg-primary); color: var(--accent); border-color: var(--border);"
                  :title="getMessage('restoreBatch')"
                >
                  <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.451a.75.75 0 000-1.5H4.5a.75.75 0 00-.75.75v3.75a.75.75 0 001.5 0v-2.19l.37.37a7 7 0 101.99-9.19.75.75 0 00-.91 1.192 5.5 5.5 0 018.612 4.723z" clip-rule="evenodd" />
                  </svg>
                  <span>{{ getMessage('restoreBatch') }}</span>
                </button>
                <button
                  @click="handleRestoreTab(entry.id)"
                  :disabled="restoringTabId === entry.id"
                  class="px-2 py-1 text-[9.5px] font-semibold rounded-xs transition-colors cursor-pointer flex items-center gap-1"
                  style="background: var(--accent); color: #fff;"
                  :title="getMessage('restoreTab')"
                >
                  <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v2.5h-2.5a.75.75 0 000 1.5h2.5v2.5a.75.75 0 001.5 0v-2.5h2.5a.75.75 0 000-1.5h-2.5v-2.5z" clip-rule="evenodd" />
                  </svg>
                  <span>{{ getMessage('restoreTab') }}</span>
                </button>
                <button
                  @click="handleDeleteClosedTab(entry.id)"
                  class="p-1 rounded-xs hover:bg-black/10 dark:hover:bg-white/10 transition-colors opacity-60 hover:opacity-100 cursor-pointer"
                  style="color: var(--group-red);"
                  title="Remove from history"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.21-2.35.398a.75.75 0 00-.56.885l.135.539a.75.75 0 00.885.56 25.1 25.1 0 011.89-.37v10.55A2.75 2.75 0 008.75 19h2.5a2.75 2.75 0 002.75-2.75V5.727c.642.096 1.272.22 1.89.37a.75.75 0 00.885-.56l.135-.539a.75.75 0 00-.56-.885 26.6 26.6 0 00-2.35-.398V3.75A2.75 2.75 0 0011.25 1h-2.5zm1.25 1.5c.69 0 1.25.56 1.25 1.25v.266c-.83-.04-1.67-.04-2.5 0V3.75c0-.69.56-1.25 1.25-1.25z" clip-rule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- AI Operation Logs Section -->
      <div>
        <div class="flex items-center justify-between px-3 mb-1.5">
          <h2 class="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5" style="color: var(--text-secondary);">
            <svg class="w-3.5 h-3.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h8a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" />
            </svg>
            AI Detailed Operation Logs ({{ aiLogs.length }})
          </h2>
          <div class="flex items-center gap-1.5">
            <button
              v-if="aiLogs.length > 0"
              @click="exportLogsAsJson"
              class="px-2 py-0.5 text-[9px] font-medium rounded-sm transition-all cursor-pointer"
              style="background: var(--bg-primary); color: var(--accent); border: 0.5px solid var(--border);"
              title="Export all logs as JSON"
            >
              Export JSON
            </button>
            <button
              v-if="aiLogs.length > 0"
              @click="clearAILogs"
              class="px-2 py-0.5 text-[9px] font-medium rounded-sm transition-all cursor-pointer"
              style="background: var(--bg-primary); color: var(--group-red); border: 0.5px solid var(--border);"
              title="Clear all logs"
            >
              Clear Logs
            </button>
          </div>
        </div>

        <div class="rounded-sm overflow-hidden p-2 space-y-2" style="background: var(--bg-primary); box-shadow: var(--shadow-xs);">
          <p class="text-[10px] px-1" style="color: var(--text-tertiary);">
            Logs recorded when Shift-clicking AI operations or when AI operations crash/fail. Retained across restarts.
          </p>

          <div v-if="aiLogs.length === 0" class="text-center py-6 text-[11px]" style="color: var(--text-tertiary);">
            No recorded AI logs yet. Hold Shift and click an AI operation (e.g. Group Tabs) to generate a detailed verbose log.
          </div>

          <div v-else class="space-y-1.5">
            <div
              v-for="log in aiLogs"
              :key="log.id"
              class="rounded-sm border overflow-hidden transition-all text-xs"
              style="background: var(--bg-secondary); border-color: var(--border);"
            >
              <!-- Log Summary Header -->
              <div
                class="p-2 flex items-center justify-between cursor-pointer select-none gap-2 hover:bg-black/5 dark:hover:bg-white/5"
                @click="toggleLogExpand(log.id)"
              >
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <!-- Status Badge -->
                  <span
                    class="px-2 py-0.5 text-[9px] font-semibold rounded-sm shrink-0 uppercase"
                    :style="log.status === 'COMPLETED'
                      ? 'background: rgba(52, 199, 89, 0.15); color: var(--group-green);'
                      : log.status === 'RUNNING'
                      ? 'background: rgba(255, 159, 10, 0.15); color: var(--group-yellow);'
                      : 'background: rgba(255, 59, 48, 0.15); color: var(--group-red);'"
                  >
                    {{ log.status }}
                  </span>

                  <!-- Mark Interrupted button if stuck in RUNNING -->
                  <button
                    v-if="log.status === 'RUNNING'"
                    @click.stop="markLogInterrupted(log.id)"
                    class="px-2 py-1 text-[9px] font-semibold rounded-sm bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-colors shrink-0 cursor-pointer shadow-sm border border-red-500/20"
                    title="Mark this interrupted/crashed operation as finished"
                  >
                    Mark Interrupted
                  </button>

                  <button
                    @click.stop="reuseLogAndGroup(log)"
                    class="px-2 py-1 text-[9px] font-semibold rounded-sm bg-accent/15 text-accent hover:bg-accent/25 transition-colors shrink-0 cursor-pointer shadow-sm border border-accent/20"
                    title="Reuse configuration from this log and process tabs (preserves current groups)"
                  >
                    Reuse Info & Classify
                  </button>

                  <!-- Action Name -->
                  <span class="font-semibold text-[11px] truncate" style="color: var(--text-primary);">
                    {{ log.actionType }}
                  </span>

                  <!-- Shift Badge -->
                  <span v-if="log.triggeredWithShift" class="px-1.5 py-0.5 text-[8.5px] font-semibold rounded-sm shrink-0 border border-accent/20 shadow-sm" style="background: var(--accent-soft); color: var(--accent);">
                    Shift
                  </span>

                  <span class="text-[10px] tabular-nums shrink-0" style="color: var(--text-tertiary);">
                    ({{ log.tabsCount }} tabs)
                  </span>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                  <span class="text-[9.5px] tabular-nums" style="color: var(--text-tertiary);">
                    {{ formatTimeAgo(log.timestamp) }}
                  </span>
                  <button
                    @click.stop="deleteSingleLog(log.id)"
                    class="p-1 rounded-sm hover:bg-red-500/10 text-red-500 transition-colors cursor-pointer"
                    title="Delete log"
                  >
                    <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                    </svg>
                  </button>
                  <svg
                    class="w-3.5 h-3.5 transition-transform duration-200"
                    :class="expandedLogId === log.id ? 'rotate-180' : ''"
                    style="color: var(--text-tertiary);"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clip-rule="evenodd" />
                  </svg>
                </div>
              </div>

              <!-- Expanded Log Details -->
              <div v-if="expandedLogId === log.id" class="p-2.5 border-t space-y-2 text-[10.5px] font-mono leading-relaxed select-text" style="border-color: var(--border); background: var(--bg-primary);">
                <!-- Error Details if failed -->
                <div v-if="log.error" class="p-2 rounded-sm bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 space-y-1">
                  <div class="font-bold flex items-center gap-1">
                    <span>CRASH / ERROR DETAILS:</span>
                  </div>
                  <div>Message: {{ log.error.message }}</div>
                  <div v-if="log.error.stack" class="whitespace-pre-wrap text-[9.5px] opacity-90 overflow-x-auto p-1 bg-black/5 dark:bg-black/30 rounded-sm">
                    {{ log.error.stack }}
                  </div>
                </div>

                <!-- Config & Metadata -->
                <div class="grid grid-cols-2 gap-2 p-2 rounded-sm bg-black/5 dark:bg-white/5 text-[10px]">
                  <div><span class="opacity-60">Provider:</span> {{ log.configSnapshot?.provider }}</div>
                  <div><span class="opacity-60">Model:</span> {{ log.configSnapshot?.model || 'default' }}</div>
                  <div><span class="opacity-60">Duration:</span> {{ log.durationMs ? formatDurationMs(log.durationMs) : 'In progress' }}</div>
                  <div v-if="log.tokenUsage?.estimatedCostStr"><span class="opacity-60">Cost Est:</span> {{ log.tokenUsage.estimatedCostStr }}</div>
                  <div v-if="log.results?.summary" class="col-span-2"><span class="opacity-60">Result:</span> {{ log.results.summary }}</div>
                </div>

                <!-- Token Usage & Cost Comparison Card (Estimated vs Actual) -->
                <div v-if="log.tokenUsage" class="p-2.5 rounded-sm bg-black/5 dark:bg-white/5 space-y-1.5 text-[9.5px]">
                  <div class="font-bold flex items-center justify-between opacity-90 border-b border-black/10 dark:border-white/10 pb-1">
                    <span>TOKEN USAGE & COST COMPARISON:</span>
                    <span class="text-[8.5px] font-normal opacity-70 font-sans">Estimated vs Actual Response</span>
                  </div>
                  <div class="grid grid-cols-4 gap-1 text-[9px] font-mono text-center pt-0.5">
                    <div class="font-bold text-left opacity-70">Metric</div>
                    <div class="font-semibold opacity-80">Estimated</div>
                    <div class="font-semibold text-accent">Actual</div>
                    <div class="font-semibold opacity-80">Variance</div>

                    <!-- Input Tokens -->
                    <div class="text-left font-sans opacity-80">Input Tokens</div>
                    <div>{{ log.tokenUsage.estimatedInputTokens?.toLocaleString() ?? '—' }}</div>
                    <div class="text-accent font-bold">{{ getActualUsage(log).input?.toLocaleString() ?? '—' }}</div>
                    <div>{{ calculateVariancePercent(log.tokenUsage.estimatedInputTokens, getActualUsage(log).input) }}</div>

                    <!-- Output Tokens -->
                    <div class="text-left font-sans opacity-80">Output Tokens</div>
                    <div>{{ log.tokenUsage.estimatedOutputTokens?.toLocaleString() ?? '—' }}</div>
                    <div class="text-accent font-bold">{{ getActualUsage(log).output?.toLocaleString() ?? '—' }}</div>
                    <div>{{ calculateVariancePercent(log.tokenUsage.estimatedOutputTokens, getActualUsage(log).output) }}</div>

                    <!-- Total Cost -->
                    <div class="text-left font-sans opacity-80">Total Cost</div>
                    <div>{{ log.tokenUsage.estimatedCostStr ?? '—' }}</div>
                    <div class="text-green-600 dark:text-green-400 font-bold">{{ getActualUsage(log).costStr ?? '—' }}</div>
                    <div>{{ calculateCostVariancePercent(log.tokenUsage.estimatedCostStr, getActualUsage(log).costStr) }}</div>
                  </div>
                </div>

                <!-- Execution Steps -->
                <div>
                  <div class="font-semibold text-[10px] mb-1 opacity-80">Execution Steps ({{ log.steps.length }}):</div>
                  <div class="space-y-1 max-h-36 overflow-y-auto p-1.5 rounded-sm bg-black/5 dark:bg-white/5 text-[9.5px]">
                    <div v-for="(step, idx) in log.steps" :key="idx" class="flex items-start gap-1.5">
                      <span class="opacity-50 shrink-0">{{ new Date(step.timestamp).toLocaleTimeString() }}</span>
                      <span class="font-bold text-accent shrink-0">[{{ step.step }}]</span>
                      <span class="break-all">{{ step.detail }}</span>
                    </div>
                  </div>
                </div>

                <!-- Prompts Used -->
                <div v-if="log.prompts.userPrompt || log.prompts.systemPrompt">
                  <div class="font-semibold text-[10px] mb-1 opacity-80">Prompts Used:</div>
                  <div class="space-y-1 max-h-32 overflow-y-auto p-1.5 rounded-sm bg-black/5 dark:bg-white/5 text-[9.5px] whitespace-pre-wrap">
                    <div v-if="log.prompts.systemPrompt"><span class="font-bold">System:</span> {{ log.prompts.systemPrompt }}</div>
                    <div v-if="log.prompts.userPrompt"><span class="font-bold">User:</span> {{ log.prompts.userPrompt }}</div>
                  </div>
                </div>

                <!-- Raw Network Requests & Responses -->
                <div v-if="log.rawResponses && log.rawResponses.length > 0">
                  <div class="font-semibold text-[10px] mb-1 opacity-80 flex items-center justify-between">
                    <span>Raw API Requests & Responses ({{ log.rawResponses.length }}):</span>
                  </div>
                  <div class="space-y-2">
                    <div v-for="(resp, idx) in log.rawResponses" :key="idx" class="p-2 rounded-sm bg-black/5 dark:bg-white/5 space-y-2 text-[9.5px]">
                      <div class="flex items-center justify-between font-bold">
                        <span class="text-accent">Batch #{{ resp.batchIndex }} (Status {{ resp.statusCode ?? 'ERR' }}) - {{ formatDurationMs(resp.responseTimeMs) }}</span>
                      </div>

                      <!-- Action Buttons: Copy API Request & Copy AI Response -->
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <button
                          @click="copyToClipboardWithFeedback(getCompleteApiRequest(log, resp.batchIndex), `req_${log.id}_${resp.batchIndex}`, 'req')"
                          class="px-2 py-1 text-[9px] font-semibold rounded-sm bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors flex items-center gap-1 cursor-pointer border border-black/10 dark:border-white/10 shadow-sm"
                        >
                          <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M7 9a2 2 0 012-2h6a2 2 0 012 2v6a2 2 0 01-2 2H9a2 2 0 01-2-2V9z" />
                            <path d="M5 3a2 2 0 00-2 2v6a2 2 0 002 2V5h8a2 2 0 00-2-2H5z" />
                          </svg>
                          <span>{{ copyReqState[`req_${log.id}_${resp.batchIndex}`] ? 'Copied Request!' : 'Copy Complete API Request' }}</span>
                        </button>

                        <button
                          v-if="resp.responseBody || resp.parsedJson"
                          @click="copyToClipboardWithFeedback(getCompleteAiResponse(resp), `resp_${log.id}_${resp.batchIndex}`, 'resp')"
                          class="px-2 py-1 text-[9px] font-semibold rounded-sm bg-accent/15 text-accent hover:bg-accent/25 transition-colors flex items-center gap-1 cursor-pointer border border-accent/20 shadow-sm"
                        >
                          <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M7 9a2 2 0 012-2h6a2 2 0 012 2v6a2 2 0 01-2 2H9a2 2 0 01-2-2V9z" />
                            <path d="M5 3a2 2 0 00-2 2v6a2 2 0 002 2V5h8a2 2 0 00-2-2H5z" />
                          </svg>
                          <span>{{ copyRespState[`resp_${log.id}_${resp.batchIndex}`] ? 'Copied Response!' : 'Copy Complete AI Response' }}</span>
                        </button>

                        <button
                          v-if="extractReasoningFromRawResponse(resp)"
                          @click="copyToClipboardWithFeedback(extractReasoningFromRawResponse(resp)!, `thought_${log.id}_${resp.batchIndex}`, 'thought')"
                          class="px-2 py-1 text-[9px] font-semibold rounded-sm bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 transition-colors flex items-center gap-1 cursor-pointer border border-amber-500/20 shadow-sm"
                        >
                          <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14H8v-1h4v1zM6 8a4 4 0 118 0c0 1.098-.5 2.1-1.3 2.7-.4.3-.7.8-.7 1.3H8c0-.5-.3-1-.7-1.3C6.5 10.1 6 9.1 6 8z" />
                          </svg>
                          <span>{{ copyRespState[`thought_${log.id}_${resp.batchIndex}`] ? 'Copied Reasoning!' : 'Copy Model Reasoning' }}</span>
                        </button>
                      </div>

                      <!-- Extracted Model Reasoning Trace -->
                      <div v-if="extractReasoningFromRawResponse(resp)" class="flex flex-col gap-1 mt-1">
                        <details class="group/logReasoning text-[9px]" open>
                          <summary class="cursor-pointer font-medium flex items-center justify-between hover:underline select-none" style="color: var(--group-yellow);" title="Click to collapse/expand reasoning trace">
                            <span class="flex items-center gap-1">
                              <svg class="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                                <path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14H8v-1h4v1zM6 8a4 4 0 118 0c0 1.098-.5 2.1-1.3 2.7-.4.3-.7.8-.7 1.3H8c0-.5-.3-1-.7-1.3C6.5 10.1 6 9.1 6 8z" />
                              </svg>
                              <span class="font-semibold">Model Reasoning Trace</span>
                              <span class="text-[8px] opacity-60 font-normal">({{ extractReasoningFromRawResponse(resp)!.length }} chars)</span>
                            </span>
                            <span class="text-[8px] opacity-70 group-open/logReasoning:hidden" style="color: var(--text-tertiary);">Expand</span>
                          </summary>
                          <div 
                            class="mt-1 max-h-40 overflow-y-auto p-2 bg-amber-500/5 dark:bg-amber-500/10 border border-amber-500/20 rounded-sm text-[9px] leading-relaxed scrollbar-thin select-text"
                            v-html="formatMarkdown(extractReasoningFromRawResponse(resp)!)"
                          />
                        </details>
                      </div>

                      <!-- Raw Response Body -->
                      <div v-if="resp.responseBody" class="max-h-44 overflow-y-auto whitespace-pre-wrap p-1.5 bg-black/5 dark:bg-black/40 rounded-sm opacity-90 font-mono text-[9px]">
                        {{ resp.responseBody }}
                      </div>
                      <div v-if="resp.error" class="text-red-500 font-bold">
                        Error: {{ resp.error }}
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Input Tabs -->
                <div v-if="log.tabsInput && log.tabsInput.length > 0">
                  <div class="font-semibold text-[10px] mb-1 opacity-80">Input Tabs ({{ log.tabsInput.length }}):</div>
                  <div class="max-h-32 overflow-y-auto space-y-1 p-1.5 rounded-sm bg-black/5 dark:bg-white/5 text-[9.5px]">
                    <div v-for="tab in log.tabsInput" :key="tab.index" class="truncate">
                      <span class="opacity-50">#{{ tab.index }}</span> <span class="font-medium">{{ tab.title }}</span> <span class="opacity-60 text-[8.5px]">({{ tab.url }})</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Backup & Import -->
      <div>
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5 flex items-center gap-1.5" style="color: var(--text-secondary);">
          <svg class="w-3.5 h-3.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M3 5a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5zm2 1h10v2H5V6zm0 4h10v4H5v-4z" clip-rule="evenodd" />
          </svg>
          Backup & Import
        </h2>
        <div class="rounded-sm overflow-hidden p-3 space-y-2" style="background: var(--bg-primary); box-shadow: var(--shadow-xs);">
          <div class="flex gap-2">
            <button
              @click="copyConfig"
              class="flex-1 py-1.5 text-xs font-medium rounded-sm transition-all text-center flex items-center justify-center gap-1.5 focus:outline-none"
              style="background: var(--bg-secondary); color: var(--text-primary); border: 0.5px solid var(--border);"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M7 9a2 2 0 012-2h6a2 2 0 012 2v6a2 2 0 01-2 2H9a2 2 0 01-2-2V9z" />
                <path d="M5 3a2 2 0 00-2 2v6a2 2 0 002 2V5h8a2 2 0 00-2-2H5z" />
              </svg>
              {{ copyText }}
            </button>
            <button
              @click="pasteConfig"
              class="flex-1 py-1.5 text-xs font-medium rounded-sm transition-all text-center flex items-center justify-center gap-1.5 focus:outline-none"
              style="background: var(--bg-secondary); color: var(--text-primary); border: 0.5px solid var(--border);"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clip-rule="evenodd" />
              </svg>
              {{ pasteText }}
            </button>
          </div>
          <p v-if="backupError" class="text-[10px] text-center" style="color: var(--group-red);">
            {{ backupError }}
          </p>

          <!-- Divider -->
          <div style="height: 0.5px; background: var(--border);" />

          <!-- Export Known Unclosed Tabs -->
          <div class="space-y-2 pt-0.5">
            <div class="flex items-center justify-between gap-2">
              <div class="text-xs font-medium flex items-center gap-1.5" style="color: var(--text-primary);">
                <span>{{ getMessage('exportKnownTabsTitle') || 'Export Known Unclosed Tabs' }}</span>
                <span class="text-[9.5px] px-1.5 py-0.2 rounded-xs tabular-nums" style="background: var(--bg-secondary); color: var(--accent); border: 0.5px solid var(--border);">
                  {{ exportCounts.total }} {{ getMessage('tabs') || 'tabs' }}
                </span>
              </div>
              <div class="text-[9px] tabular-nums" style="color: var(--text-tertiary);">
                {{ exportCounts.open }} open &bull; {{ exportCounts.unrestored }} unrestored
              </div>
            </div>
            <p class="text-[10px] leading-relaxed" style="color: var(--text-tertiary);">
              {{ getMessage('exportKnownTabsDesc') || 'Export open and previously known tabs that were not explicitly closed (e.g., to recover missing tabs after browser crash or sync failure).' }}
            </p>

            <!-- Scope & Format Selectors -->
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-[9.5px] font-medium mb-1" style="color: var(--text-secondary);">Scope</label>
                <select
                  v-model="exportScope"
                  class="w-full text-[11px] rounded-sm py-1 px-2 border-0 cursor-pointer"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                >
                  <option value="all_unclosed">{{ getMessage('exportScopeAllUnclosed') || 'Open + Unrestored' }}</option>
                  <option value="open_only">{{ getMessage('exportScopeOpenOnly') || 'Open Tabs Only' }}</option>
                  <option value="missing_only">{{ getMessage('exportScopeMissingOnly') || 'Unrestored Only' }}</option>
                </select>
              </div>
              <div>
                <label class="block text-[9.5px] font-medium mb-1" style="color: var(--text-secondary);">Format</label>
                <select
                  v-model="exportFormat"
                  class="w-full text-[11px] rounded-sm py-1 px-2 border-0 cursor-pointer"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                >
                  <option value="markdown">Markdown (.md)</option>
                  <option value="json">JSON (.json)</option>
                  <option value="txt">Plain Text URLs (.txt)</option>
                  <option value="html">HTML Bookmarks (.html)</option>
                </select>
              </div>
            </div>

            <!-- Action Buttons: Copy & Download -->
            <div class="flex gap-2">
              <button
                @click="handleCopyExportTabs"
                class="flex-1 py-1.5 text-xs font-medium rounded-sm transition-all text-center flex items-center justify-center gap-1.5 cursor-pointer focus:outline-none"
                style="background: var(--bg-secondary); color: var(--text-primary); border: 0.5px solid var(--border);"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M7 9a2 2 0 012-2h6a2 2 0 012 2v6a2 2 0 01-2 2H9a2 2 0 01-2-2V9z" />
                  <path d="M5 3a2 2 0 00-2 2v6a2 2 0 002 2V5h8a2 2 0 00-2-2H5z" />
                </svg>
                <span>{{ exportCopyFeedback || 'Copy List' }}</span>
              </button>
              <button
                @click="handleDownloadExportTabs"
                class="flex-1 py-1.5 text-xs font-medium rounded-sm transition-all text-center flex items-center justify-center gap-1.5 cursor-pointer focus:outline-none"
                style="background: var(--accent); color: #ffffff;"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
                <span>{{ exportDownloadFeedback || 'Export File' }}</span>
              </button>
            </div>
            <p v-if="exportError" class="text-[10px] text-center" style="color: var(--group-red);">
              {{ exportError }}
            </p>
          </div>
        </div>

        <!-- About & Build Info -->
        <div class="p-3 rounded-sm" style="background: var(--bg-primary); border: 0.5px solid var(--border);">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <img src="/icons/icon-32.png" alt="" class="w-4 h-4 shrink-0" />
              <div>
                <div class="text-xs font-semibold" style="color: var(--text-primary);">TabPilot</div>
                <div class="text-[10px]" style="color: var(--text-secondary);">
                  Version {{ APP_VERSION }} <span style="color: var(--text-tertiary);">(Build #{{ BUILD_NUMBER }})</span>
                </div>
              </div>
            </div>
            <div class="text-[9.5px] text-right font-mono" style="color: var(--text-tertiary);">
              <div>Commit: {{ BUILD_HASH }}</div>
              <div v-if="BUILD_TIME">{{ new Date(BUILD_TIME).toLocaleDateString() }}</div>
            </div>
          </div>
        </div>
      </div>
      <!-- End of Right Column -->
    </div>
    <!-- End of settings-layout-container -->
  </div>
</div>
</div>
</template>

<style scoped>
/* Responsive 2-column layout for settings */
.settings-layout-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

@media (min-width: 880px) {
  .settings-layout-container {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    align-items: start;
  }
}

/* Advanced Prompts Container & Grid */
.advanced-prompts-wrapper {
  container-type: inline-size;
}

.advanced-prompts-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

@container (min-width: 520px) {
  .advanced-prompts-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
}

@container (min-width: 860px) {
  .advanced-prompts-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
}

.prompt-card {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  border-radius: 2px;
  background: var(--bg-secondary);
  border: 0.5px solid var(--border);
  min-width: 0;
}

.prompt-card textarea::-webkit-scrollbar {
  width: 4px;
}
.prompt-card textarea::-webkit-scrollbar-track {
  background: transparent;
}
.prompt-card textarea::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 2px;
}
.prompt-card textarea::-webkit-scrollbar-thumb:hover {
  background: var(--text-tertiary);
}

.setting-row {
  border-bottom: 0.5px solid var(--border);
}
.setting-row:last-child {
  border-bottom: none;
}
button:hover {
  opacity: 0.85;
}
button:active {
  transform: scale(0.98);
}
button:disabled {
  opacity: 0.4;
  pointer-events: none;
}
select, input[type="text"], input[type="password"], input[type="url"] {
  outline: none;
}
select:focus, input:focus {
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* iOS-style toggle switch */
.toggle-track {
  background: var(--text-tertiary);
}
.peer:checked ~ .toggle-track {
  background: var(--accent);
}
</style>
