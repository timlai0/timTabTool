<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, toRaw } from 'vue'
import { getMessage } from '../../shared/i18n'
import { DEFAULT_SETTINGS, STORAGE_KEYS, DEFAULT_GROUPING_PROMPT, DEFAULT_SPLIT_PROMPT, DEFAULT_CLASSIFY_PROMPT, DEFAULT_MERGE_PROMPT, PREDEFINED_MODELS, DEFAULT_ENDPOINTS, DEFAULT_MODELS } from '../../shared/constants'
import { getAutoBatchSize } from '../../shared/utils'
import type { ExtensionSettings } from '../../shared/types'
import { AIClient } from '../../shared/ai-client'

const emit = defineEmits<{
  back: []
}>()

const vFocus = {
  mounted: (el: HTMLElement) => el.focus()
}

const settings = ref<ExtensionSettings>({ ...DEFAULT_SETTINGS })
const saved = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; error?: string } | null>(null)
const searchShortcut = ref('Ctrl+Shift+F')
const advancedPromptsExpanded = ref(false)
const connectionSettingsExpanded = ref(false)

// MCP Status & Reconnection refs
const mcpStatus = ref({ state: 'disabled', port: 8585, error: null as string | null, autoRetrySecondsLeft: 0 })
const reconnecting = ref(false)
let statusPollInterval: any = null

async function updateMCPStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_MCP_STATUS' })
    if (res && res.state) {
      mcpStatus.value = res
    }
  } catch (err) {
    // Ignore error
  }
}

async function triggerReconnect() {
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
    setTimeout(resize, 0)
  },
  updated: (el: HTMLTextAreaElement) => {
    const resize = () => {
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
    setTimeout(resize, 0)
  }
}





const currentProviderModels = computed(() => {
  return PREDEFINED_MODELS[settings.value.ai.provider] || []
})

const isPredefinedModel = computed(() => {
  const models = currentProviderModels.value
  return (id: string | undefined) => !!id && models.some(m => m.id === id)
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
      const chosen = currentProviderModels.value.find(m => m.id === newValue)
      if (chosen) {
        const mapping: Record<string, number> = { '65K': 65536, '16K': 16384, '8K': 8192, '4K': 4096 }
        settings.value.ai.maxTokens = mapping[chosen.maxTokens] || 16384
      }
    }
  }
})

const modelPlaceholder = computed(() => {
  return DEFAULT_MODELS[settings.value.ai.provider] || 'gpt-4o-mini'
})

const endpointPlaceholder = computed(() =>
  DEFAULT_ENDPOINTS[settings.value.ai.provider] || 'https://api.example.com/v1'
)

watch(() => settings.value.ai.provider, (newProvider, oldProvider) => {
  if (!oldProvider) return
  const oldDefault = DEFAULT_ENDPOINTS[oldProvider]
  const current = settings.value.ai.endpoint
  if (!current || current === oldDefault) {
    settings.value.ai.endpoint = DEFAULT_ENDPOINTS[newProvider] || ''
  }
  const oldPredefined = PREDEFINED_MODELS[oldProvider] || []
  if (oldPredefined.some(m => m.id === settings.value.ai.model)) {
    settings.value.ai.model = ''
    isCustomSelected.value = false
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
  const commands = await chrome.commands.getAll()
  const searchCmd = commands.find((c) => c.name === 'open-search')
  if (searchCmd?.shortcut) {
    searchShortcut.value = searchCmd.shortcut
  }

  // Start polling MCP connection status
  updateMCPStatus()
  statusPollInterval = setInterval(updateMCPStatus, 1000)
})

onUnmounted(() => {
  if (statusPollInterval) {
    clearInterval(statusPollInterval)
  }
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

function resetSystemPrompt() {
  settings.value.ai.customPrompt = ''
}

function openShortcutSettings() {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
}

async function saveSettings() {
  if (!settings.value.windowWidth || settings.value.windowWidth < 360) {
    settings.value.windowWidth = 360
  }
  await chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', payload: toRaw(settings.value) })
  saved.value = true
  setTimeout(() => {
    saved.value = false
  }, 1500)
}

async function saveAndGoBack() {
  if (!settings.value.windowWidth || settings.value.windowWidth < 360) {
    settings.value.windowWidth = 360
  }
  await chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', payload: toRaw(settings.value) })
  emit('back')
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const client = new AIClient(settings.value.ai)
    testResult.value = await client.testConnection()
  } catch (err) {
    testResult.value = { ok: false, error: (err as Error).message }
  } finally {
    testing.value = false
  }
}

async function copyConfig() {
  backupError.value = ''
  try {
    const rawConfig = toRaw(settings.value)
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
</script>

<template>
  <div :style="{ width: Math.max(360, settings.windowWidth) + 'px', height: Math.max(240, Math.min(600, settings.windowHeight || 500)) + 'px', background: 'var(--bg-primary)' }" class="flex flex-col">
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
        <h1 class="text-[15px] font-semibold tracking-tight" style="color: var(--text-primary);">{{ getMessage('settings') }}</h1>
      </div>

      <!-- Save settings header button -->
      <button
        @click="saveSettings"
        class="px-2.5 py-1 text-xs font-semibold rounded-sm transition-all flex items-center gap-1.5 focus:outline-none"
        style="background: var(--accent); color: #fff;"
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
    <div class="flex-1 overflow-y-auto px-2 py-2 space-y-2" style="background: var(--bg-secondary);">

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

            <!-- Fallback to sort toggle -->
            <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer setting-row">
              <span class="text-xs flex-1" style="color: var(--text-primary);">{{ getMessage('fallbackToSort') }}</span>
              <div class="relative">
                <input
                  type="checkbox"
                  v-model="settings.ai.fallbackToSort"
                  class="sr-only peer"
                />
                <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
                <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
              </div>
            </label>

            <!-- Model Selector (Always visible when AI enabled) -->
            <div class="px-3.5 py-2.5 setting-row">
              <label class="block text-[10px] font-semibold uppercase tracking-wider mb-1" style="color: var(--text-secondary);">
                {{ getMessage('model') }}
                <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
              </label>
              <select
                v-model="modelSelectValue"
                class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                style="background: var(--bg-secondary); color: var(--text-primary);"
              >
                <option value="">Default ({{ modelPlaceholder }})</option>
                <option 
                  v-for="model in currentProviderModels" 
                  :key="model.id" 
                  :value="model.id"
                >
                  {{ model.name }} ({{ model.complexity }}, {{ model.costFactor }}, Max Output: {{ model.maxTokens }})
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
            </div>

            <!-- AI Provider & Connection Settings Toggle Header -->
            <button
              type="button"
              @click="connectionSettingsExpanded = !connectionSettingsExpanded"
              class="w-full flex items-center justify-between px-3.5 py-3 cursor-pointer text-left setting-row focus:outline-none transition-all duration-200"
              style="background: var(--bg-primary);"
            >
              <div class="flex items-start gap-2.5">
                <svg class="w-4 h-4 mt-0.5" style="color: var(--accent);" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.022 6.022 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V9a1 1 0 001 1h4a1 1 0 001-1v-.01a5.976 5.976 0 011.603 3.652A6.002 6.002 0 014.332 8.027zM9 14.93A5.99 5.99 0 0110 4c.326 0 .647.026.96.076a5.986 5.986 0 01-1.93 5.378A1 1 0 008.5 10v1.5a1.5 1.5 0 01-1.5 1.5H5.828A5.967 5.967 0 019 14.93z" clip-rule="evenodd" />
                </svg>
                <div class="flex flex-col">
                  <span class="text-xs font-semibold" style="color: var(--text-primary);">AI Provider & Connection Settings</span>
                  <span class="text-[10px] mt-0.5" style="color: var(--text-tertiary);">
                    Configure API keys, model provider, endpoints, batch sizes, and max tokens
                  </span>
                </div>
              </div>
              <svg
                class="w-4 h-4 transition-transform duration-200 transform"
                :class="{ 'rotate-180': connectionSettingsExpanded }"
                viewBox="0 0 20 20"
                fill="currentColor"
                style="color: var(--text-secondary);"
              >
                <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
              </svg>
            </button>

            <!-- Collapsible Connection Settings Container -->
            <div v-show="connectionSettingsExpanded">
              <!-- Provider -->
              <div class="px-3 py-2 setting-row">
                <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">{{ getMessage('provider') }}</label>
                <select
                  v-model="settings.ai.provider"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                >
                  <option value="openai">OpenAI</option>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="gemini">Gemini (Google)</option>
                  <option value="custom">Custom (OpenAI-compatible)</option>
                </select>
              </div>

              <!-- API Key -->
              <div class="px-3 py-2 setting-row">
                <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">{{ getMessage('apiKey') }}</label>
                <input
                  type="text"
                  v-model="settings.ai.apiKey"
                  placeholder="sk-... / AIza..."
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                />
              </div>

              <!-- Endpoint -->
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

              <!-- Batch Size -->
              <div class="px-3 py-2 setting-row">
                <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">
                  {{ getMessage('batchSize') || 'Batch Size' }}
                  <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                </label>
                <input
                  type="number"
                  v-model.number="settings.ai.batchSize"
                  :placeholder="getAutoBatchSize(settings.ai.maxTokens).toString() + ' (Auto)'"
                  min="1"
                  max="1000"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                />
              </div>

              <!-- Max Tokens -->
              <div class="px-3 py-2 setting-row">
                <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">
                  Max Output Tokens
                  <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                </label>
                <input
                  type="number"
                  v-model.number="settings.ai.maxTokens"
                  placeholder="16384"
                  min="1"
                  max="65536"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                />
              </div>

              <!-- Max Retries -->
              <div class="px-3 py-2 setting-row">
                <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">
                  Max API Retries
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
              class="w-full flex items-center justify-between px-3.5 py-3 cursor-pointer text-left setting-row focus:outline-none transition-all duration-200"
              style="background: var(--bg-primary);"
            >
              <div class="flex items-start gap-2.5">
                <svg class="w-4 h-4 mt-0.5" style="color: var(--accent);" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
                <div class="flex flex-col">
                  <span class="text-xs font-semibold" style="color: var(--text-primary);">Advanced Prompt Instructions</span>
                  <span class="text-[10px] mt-0.5" style="color: var(--text-tertiary);">
                    Configure tab grouping rules, coherence guidelines, and system prompts
                  </span>
                </div>
              </div>
              <svg
                class="w-4 h-4 transition-transform duration-200 transform"
                :class="{ 'rotate-180': advancedPromptsExpanded }"
                viewBox="0 0 20 20"
                fill="currentColor"
                style="color: var(--text-secondary);"
              >
                <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
              </svg>
            </button>

            <!-- Collapsible Prompts Container -->
            <div v-show="advancedPromptsExpanded">
              <!-- Grouping Prompt -->
              <div class="px-3 py-2 setting-row">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5">
                    <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                      Tab Grouping Prompt
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <div class="relative group/help">
                      <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                      <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[260px] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                        <div class="font-bold mb-1" style="color: var(--accent);">Tab Grouping Prompt</div>
                        Defines tab clustering logic and categories.
                        
                        <strong>When to use</strong>: To modify how tabs are grouped, sizes of groups, or target names.
                        
                        <strong>Examples</strong>:
                        • "Limit maximum groups to 4."
                        • "Create a dedicated group for Dev tools."
                        • "Group only if at least 3 tabs match."
                      </div>
                    </div>
                  </div>
                  <button
                    v-if="settings.ai.groupingPrompt !== DEFAULT_GROUPING_PROMPT"
                    @click="resetGroupingPrompt"
                    class="text-[9px] hover:underline"
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
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 resize-none overflow-hidden"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                ></textarea>
              </div>

              <!-- Coherence Prompt -->
              <div class="px-3 py-2 setting-row">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5">
                    <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                      Batch Coherence Instructions
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <div class="relative group/help">
                      <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                      <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[260px] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                        <div class="font-bold mb-1" style="color: var(--accent);">Batch Coherence</div>
                        Injected into subsequent batches (batch 2+) alongside the list of group names created in previous batches.
                        
                        <strong>Default</strong>:
                        "You should prioritize placing tabs into these existing groups if they fit, rather than creating new, redundant groups."
                      </div>
                    </div>
                  </div>
                  <button
                    v-if="settings.ai.coherencePrompt !== DEFAULT_SETTINGS.ai.coherencePrompt"
                    @click="settings.ai.coherencePrompt = DEFAULT_SETTINGS.ai.coherencePrompt"
                    class="text-[9px] hover:underline"
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
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 resize-none overflow-hidden"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                ></textarea>
              </div>

              <!-- Split Group Prompt -->
              <div class="px-3 py-2 setting-row">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5">
                    <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                      Split Group Prompt
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <div class="relative group/help">
                      <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                      <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[260px] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                        <div class="font-bold mb-1" style="color: var(--accent);">Split Group Prompt</div>
                        Defines how highly related tab groups are divided into finer sub-groups.
                      </div>
                    </div>
                  </div>
                  <button
                    v-if="settings.ai.splitPrompt !== DEFAULT_SPLIT_PROMPT"
                    @click="resetSplitPrompt"
                    class="text-[9px] hover:underline"
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
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 resize-none overflow-hidden"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                ></textarea>
              </div>

              <!-- Add New Tabs Prompt -->
              <div class="px-3 py-2 setting-row">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5">
                    <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                      Add New Tabs Prompt
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <div class="relative group/help">
                      <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                      <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[260px] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                        <div class="font-bold mb-1" style="color: var(--accent);">Add New Tabs Prompt</div>
                        Defines instructions for classifying new incoming tabs into existing groups.
                      </div>
                    </div>
                  </div>
                  <button
                    v-if="settings.ai.classifyPrompt !== DEFAULT_CLASSIFY_PROMPT"
                    @click="resetClassifyPrompt"
                    class="text-[9px] hover:underline"
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
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 resize-none overflow-hidden"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                ></textarea>
              </div>

              <!-- Merge Group Prompt -->
              <div class="px-3 py-2 setting-row">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5">
                    <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                      Merge Group Prompt
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <div class="relative group/help">
                      <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                      <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[260px] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                        <div class="font-bold mb-1" style="color: var(--accent);">Merge Group Prompt</div>
                        Defines instructions for choosing an existing group to merge this tab group into.
                      </div>
                    </div>
                  </div>
                  <button
                    v-if="settings.ai.mergePrompt !== DEFAULT_MERGE_PROMPT"
                    @click="resetMergePrompt"
                    class="text-[9px] hover:underline"
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
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 resize-none overflow-hidden"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                ></textarea>
              </div>

              <!-- Custom Prompt -->
              <div class="px-3 py-2 setting-row">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5">
                    <label class="block text-[10px] font-medium" style="color: var(--text-secondary);">
                      Custom System Prompt Instructions
                      <span style="color: var(--text-tertiary);">({{ getMessage('optional') }})</span>
                    </label>
                    <div class="relative group/help">
                      <span class="w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-[2px] cursor-help transition-all select-none" style="border-color: var(--border); color: var(--text-tertiary); background: var(--hover);">?</span>
                      <div class="absolute left-0 bottom-full mb-1.5 hidden group-hover/help:block w-[260px] p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200" style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border); font-size: 10px; font-weight: normal; text-transform: none;">
                        <div class="font-bold mb-1" style="color: var(--accent);">Custom System Prompt</div>
                        Defines global behavior and style rules.
                        
                        <strong>When to use</strong>: To enforce global formatting, tone, language, or constraints.
                        
                        <strong>Examples</strong>:
                        • "Always respond in German."
                        • "Never use emojis."
                        • "Omit the 'www.' prefix in group names."
                      </div>
                    </div>
                  </div>
                  <button
                    v-if="settings.ai.customPrompt"
                    @click="resetSystemPrompt"
                    class="text-[9px] hover:underline"
                    style="color: var(--accent);"
                    title="Clear custom instructions"
                  >
                    Clear
                  </button>
                </div>
                <textarea
                  v-model="settings.ai.customPrompt"
                  v-autoresize
                  placeholder="E.g., Never use emojis. Always categorize by project."
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 resize-none overflow-hidden"
                  style="background: var(--bg-secondary); color: var(--text-primary);"
                ></textarea>
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
                      'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]': mcpStatus.state === 'connected',
                      'bg-yellow-500 animate-pulse shadow-[0_0_8px_rgba(234,179,8,0.6)]': mcpStatus.state === 'connecting',
                      'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]': mcpStatus.state === 'disconnected' || mcpStatus.state === 'disabled'
                    }"
                    :style="{
                      background: mcpStatus.state === 'connected' ? 'var(--group-green)' : (mcpStatus.state === 'connecting' ? '#eab308' : 'var(--group-red)')
                    }"
                  />
                  <span class="text-xs font-semibold capitalize" :style="{ color: mcpStatus.state === 'connected' ? 'var(--group-green)' : (mcpStatus.state === 'connecting' ? '#eab308' : 'var(--text-primary)') }">
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
                class="text-[10px] leading-relaxed p-1.5 rounded-[3px] border mt-1" 
                style="color: var(--group-red); background: rgba(239,68,68,0.06); border-color: rgba(239,68,68,0.15);"
              >
                <strong>Error:</strong> {{ mcpStatus.error }}
                <br />
                <span v-if="mcpStatus.autoRetrySecondsLeft && mcpStatus.autoRetrySecondsLeft > 0" class="text-[9px] opacity-90">Auto-retry in <span class="font-bold" style="color: #fbbf24;">{{ mcpStatus.autoRetrySecondsLeft }}</span>s...</span>
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
          </template>
        </div>
      </div>

      <!-- Keyboard Shortcut -->
      <div>
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5 flex items-center gap-1.5" style="color: var(--text-secondary);">
          <svg class="w-3.5 h-3.5 opacity-80" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M3 5a2 2 0 00-2 2v6a2 2 0 002 2h14a2 2 0 002-2V7a2 2 0 00-2-2H3zm0 2h14v6H3V7zm2 2a1 1 0 011-1h2a1 1 0 110 2H6a1 1 0 01-1-1zm6-1a1 1 0 100 2h2a1 1 0 100-2h-2zm-6 4a1 1 0 100 2h8a1 1 0 100-2H5z" clip-rule="evenodd" />
          </svg>
          {{ getMessage('shortcutTitle') }}
        </h2>
        <div class="rounded-sm overflow-hidden" style="background: var(--bg-primary); box-shadow: var(--shadow-xs);">
          <div class="flex items-center justify-between px-3 py-2">
            <div>
              <div class="text-xs" style="color: var(--text-primary);">{{ getMessage('searchPlaceholder').replace('...', '') }}</div>
              <kbd class="inline-block mt-1.5 px-2 py-0.5 text-[10px] font-mono rounded-md" style="background: var(--bg-secondary); color: var(--text-secondary);">{{ searchShortcut }}</kbd>
            </div>
            <button
              @click="openShortcutSettings"
              class="px-3 py-1.5 text-[11px] font-medium rounded-sm"
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

          <!-- Window Width -->
          <div class="px-3 py-2 setting-row">
            <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">
              Window Width (px)
            </label>
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
          <div class="px-3 pb-2 setting-row">
            <label class="block text-[10px] font-medium mb-1" style="color: var(--text-secondary);">
              Window Height (px)
            </label>
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

          <!-- Divider -->
          <div class="mx-3.5" style="height: 0.5px; background: var(--border);" />

          <!-- Smart group title toggle -->
          <label class="flex items-start gap-3 px-3 py-2 cursor-pointer">
            <div class="flex-1">
              <span class="text-xs block" style="color: var(--text-primary);">{{ getMessage('smartGroupTitle') }}</span>
              <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                {{ getMessage('smartGroupTitleDesc') }}
              </p>
            </div>
            <div class="relative mt-0.5">
              <input
                type="checkbox"
                v-model="settings.smartGroupTitle"
                class="sr-only peer"
              />
              <div class="toggle-track w-[38px] h-[22px] rounded-full transition-colors duration-200"></div>
              <div class="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 peer-checked:translate-x-4"></div>
            </div>
          </label>

          <!-- Divider -->
          <div class="mx-3.5" style="height: 0.5px; background: var(--border);" />

          <!-- Offline grouping preview toggle -->
          <label class="flex items-start gap-3 px-3 py-2 cursor-pointer">
            <div class="flex-1">
              <span class="text-xs block" style="color: var(--text-primary);">{{ getMessage('showRuleGroupsWhenUngrouped') }}</span>
              <p class="text-[10px] mt-0.5 leading-relaxed" style="color: var(--text-tertiary);">
                {{ getMessage('showRuleGroupsWhenUngroupedDesc') }}
              </p>
            </div>
            <div class="relative mt-0.5">
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
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
