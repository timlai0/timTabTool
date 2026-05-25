<script setup lang="ts">
import { ref, computed, watch, onMounted, toRaw } from 'vue'
import { getMessage } from '../../shared/i18n'
import { DEFAULT_SETTINGS, STORAGE_KEYS, DEFAULT_GROUPING_PROMPT, DEFAULT_SPLIT_PROMPT, DEFAULT_CLASSIFY_PROMPT } from '../../shared/constants'
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

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  custom: '',
}

const PREDEFINED_MODELS: Record<string, { id: string, name: string, complexity: string, costFactor: string, maxTokens: string }[]> = {
  gemini: [
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', complexity: 'High', costFactor: '100%', maxTokens: '65K' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', complexity: 'Medium', costFactor: '75%', maxTokens: '65K' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', complexity: 'Medium', costFactor: '25%', maxTokens: '65K' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', complexity: 'Low', costFactor: '12%', maxTokens: '65K' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', complexity: 'Low', costFactor: '5%', maxTokens: '65K' },
    { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', complexity: 'Low', costFactor: '4%', maxTokens: '65K' },
    { id: 'gemini-flash-lite-latest', name: 'Gemini Flash Lite Latest', complexity: 'Low', costFactor: '4%', maxTokens: '65K' },
    { id: 'gemma-4-31b-it', name: 'Gemma 4 31B', complexity: 'Low', costFactor: 'Free', maxTokens: '8K' },
    { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B', complexity: 'Low', costFactor: 'Free', maxTokens: '8K' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', complexity: 'High', costFactor: '100%', maxTokens: '16K' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', complexity: 'Low', costFactor: '6%', maxTokens: '16K' },
  ],
  claude: [
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', complexity: 'High', costFactor: '100%', maxTokens: '4K' },
    { id: 'claude-3-5-sonnet-20240620', name: 'Claude 3.5 Sonnet', complexity: 'Medium', costFactor: '20%', maxTokens: '8K' },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', complexity: 'Low', costFactor: '2%', maxTokens: '4K' },
  ]
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
  const placeholders: Record<string, string> = {
    openai: 'gpt-4o-mini',
    claude: 'claude-sonnet-4-20250514',
    gemini: 'gemini-3.5-flash',
    custom: 'gpt-4o-mini',
  }
  return placeholders[settings.value.ai.provider] || 'gpt-4o-mini'
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
  if (!settings.value.ai.apiKey) {
    connectionSettingsExpanded.value = true
  }
  const commands = await chrome.commands.getAll()
  const searchCmd = commands.find((c) => c.name === 'open-search')
  if (searchCmd?.shortcut) {
    searchShortcut.value = searchCmd.shortcut
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
  setTimeout(() => { emit('back') }, 600)
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
</script>

<template>
  <div :style="{ width: Math.max(360, settings.windowWidth) + 'px', height: Math.max(240, Math.min(600, settings.windowHeight || 500)) + 'px', background: 'var(--bg-primary)' }" class="flex flex-col">
    <!-- Header -->
    <header class="flex items-center gap-2.5 px-4 py-3" style="box-shadow: 0 0.5px 0 var(--border);">
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
    </header>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto px-2 py-2 space-y-2" style="background: var(--bg-secondary);">

      <!-- AI Configuration -->
      <div>
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5 flex items-center gap-1.5" style="color: var(--text-secondary);">
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
              <div class="flex flex-col">
                <span class="text-xs font-semibold" style="color: var(--text-primary);">AI Provider & Connection Settings</span>
                <span class="text-[10px] mt-0.5" style="color: var(--text-tertiary);">
                  Configure API keys, model provider, endpoints, batch sizes, and max tokens
                </span>
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
              <div class="flex flex-col">
                <span class="text-xs font-semibold" style="color: var(--text-primary);">Advanced Prompt Instructions</span>
                <span class="text-[10px] mt-0.5" style="color: var(--text-tertiary);">
                  Configure tab grouping rules, coherence guidelines, and system prompts
                </span>
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
                  :placeholder="'Default:\n' + DEFAULT_GROUPING_PROMPT"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 min-h-[220px] resize-y"
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
                  placeholder="Instructions on how to reuse existing groups..."
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 min-h-[60px] resize-y"
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
                  :placeholder="'Default:\n' + DEFAULT_SPLIT_PROMPT"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 min-h-[80px] resize-y"
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
                  :placeholder="'Default:\n' + DEFAULT_CLASSIFY_PROMPT"
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 min-h-[80px] resize-y"
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
                  placeholder="E.g., Never use emojis. Always categorize by project."
                  class="w-full text-xs rounded-sm border-0 py-1.5 px-2 min-h-[80px] resize-y"
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

      <!-- Keyboard Shortcut -->
      <div>
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5" style="color: var(--text-secondary);">
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
        <h2 class="text-[10px] font-semibold uppercase tracking-wider px-3 mb-1.5" style="color: var(--text-secondary);">
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
        </div>
      </div>

      <!-- Save button -->
      <div class="pb-1">
        <button
          @click="saveSettings"
          class="w-full py-2.5 text-[13px] font-semibold rounded-sm transition-all"
          style="background: var(--accent); color: #fff;"
        >
          <span v-if="saved" class="inline-flex items-center gap-1.5">
            <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
            </svg>
            {{ getMessage('saved') }}
          </span>
          <span v-else>{{ getMessage('save') }}</span>
        </button>
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
