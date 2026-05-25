<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { GROUP_DEFINITIONS, STORAGE_KEYS, DEFAULT_SETTINGS } from '../../shared/constants'
import { getMessage } from '../../shared/i18n'
import type { GroupedTabs, GroupIndicatorStyle, ExtensionSettings } from '../../shared/types'
import TabItem from './TabItem.vue'
import { SYSTEM_PROMPT } from '../../shared/ai-client'

const props = withDefaults(defineProps<{
  group: GroupedTabs
  mode: GroupIndicatorStyle
  expandTrigger: number
  collapseTrigger: number
}>(), {
  mode: 'header',
  expandTrigger: 0,
  collapseTrigger: 0,
})

const emit = defineEmits<{
  'close-group': []
  'split-group': []
  'error': [msg: string]
}>()

const collapsed = ref(props.mode === 'header')
const splitting = ref(false)
const showSplitTooltip = ref(false)

watch(() => props.expandTrigger, () => { collapsed.value = false })
watch(() => props.collapseTrigger, () => { collapsed.value = true })

const def = GROUP_DEFINITIONS[props.group.category]

const displayColor = computed(() => props.group.groupColor || def.color)
const displayLabel = computed(() => props.group.groupName || getMessage(def.labelKey))

const groupColorVar = computed(() => `var(--group-${displayColor.value})`)

// Load AI Settings for estimating tokens/cost and rendering the preview
const aiSettings = ref(DEFAULT_SETTINGS.ai)

onMounted(async () => {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const stored = data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined
  if (stored?.ai) {
    aiSettings.value = { ...DEFAULT_SETTINGS.ai, ...stored.ai }
  }
})

const activeModel = computed(() => {
  if (aiSettings.value.model) return aiSettings.value.model
  const defaults: Record<string, string> = {
    openai: 'gpt-4o-mini',
    claude: 'claude-sonnet-4-20250514',
    gemini: 'gemini-3.5-flash',
    custom: 'gpt-4o-mini',
  }
  return defaults[aiSettings.value.provider] || 'gpt-4o-mini'
})

function getSystemPrompt() {
  if (aiSettings.value.customPrompt?.trim()) {
    return `${SYSTEM_PROMPT}\n\nUser Instructions:\n${aiSettings.value.customPrompt.trim()}`
  }
  return SYSTEM_PROMPT
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
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

const PROVIDER_DEFAULTS: Record<string, { input: number; output: number }> = {
  openai: { input: 0.15, output: 0.60 },
  claude: { input: 3.00, output: 15.00 },
  gemini: { input: 1.50, output: 9.00 },
  custom: { input: 0.15, output: 0.60 },
}

function estimateSplitCost() {
  const tabs = props.group.tabs.length
  if (tabs === 0) {
    return { tokens: 0, costStr: 'Free' }
  }
  const promptLen = getSystemPrompt().length + (aiSettings.value.splitPrompt || '').length
  const promptTokens = Math.ceil(promptLen / 4)
  const inputTokens = promptTokens + tabs * 20
  const outputTokens = 100
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
  
  return { tokens: totalTokens, costStr }
}

async function handleCloseGroup() {
  const tabIds = props.group.tabs.map((t) => t.id)
  await chrome.runtime.sendMessage({ action: 'CLOSE_GROUP', payload: { tabIds } })
  emit('close-group')
}

async function handleSplitGroup() {
  if (!props.group.groupId) return
  splitting.value = true
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'SPLIT_GROUP',
      payload: { groupId: props.group.groupId }
    })
    if (res && typeof res === 'object' && 'error' in res) {
      emit('error', String(res.error))
    } else {
      emit('split-group')
    }
  } catch (err) {
    emit('error', (err as Error).message)
  } finally {
    splitting.value = false
  }
}
const showMergeTooltip = ref(false)
const merging = ref(false)

async function handleMergeGroup() {
  if (!props.group.groupId) return
  merging.value = true
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'MERGE_GROUP',
      payload: { groupId: props.group.groupId }
    })
    if (res && typeof res === 'object' && 'error' in res) {
      emit('error', String(res.error))
    } else {
      emit('split-group') // Reloads the preview cache
    }
  } catch (err) {
    emit('error', (err as Error).message)
  } finally {
    merging.value = false
  }
}

function estimateMergeCost() {
  const tabs = props.group.tabs.length
  if (tabs === 0) {
    return { tokens: 0, costStr: 'Free' }
  }
  const promptLen = getSystemPrompt().length + (aiSettings.value.mergePrompt || '').length
  const promptTokens = Math.ceil(promptLen / 4)
  const inputTokens = promptTokens + tabs * 20
  const outputTokens = 50
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
  
  return { tokens: totalTokens, costStr }
}
</script>

<template>
  <div class="group/item">
    <!-- Collapsed chip -->
    <template v-if="collapsed">
      <button
        class="w-full flex items-center gap-2.5 px-3.5 py-2 text-left group/row relative"
        @click="collapsed = false"
      >
        <span
          class="min-w-[22px] h-[22px] rounded-sm flex items-center justify-center text-white text-[10px] font-bold px-1 tabular-nums"
          :style="{ background: groupColorVar }"
        >
          {{ group.tabs.length }}
        </span>
        <span class="text-xs font-medium flex-1 truncate" style="color: var(--text-primary);">{{ displayLabel }}</span>
        <!-- Split Group with AI -->
        <button
          v-if="group.groupId"
          class="w-[22px] h-[22px] border rounded-[4px] opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0"
          style="border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);"
          title="Split this group with AI"
          @click.stop="handleSplitGroup"
          :disabled="splitting"
          @mouseenter="showSplitTooltip = true"
          @mouseleave="showSplitTooltip = false"
        >
          <svg v-if="splitting" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10.893 2.577a.75.75 0 00-1.786 0L8.23 8.169a.75.75 0 01-.46.46L2.169 9.107a.75.75 0 000 1.786l5.601.411a.75.75 0 01.46.46l.411 5.601a.75.75 0 001.786 0l.411-5.601a.75.75 0 01.46-.46l5.601-.411a.75.75 0 000-1.786l-5.601-.411a.75.75 0 01-.46-.46l-.411-5.601z" clip-rule="evenodd" />
          </svg>
        </button>
        <!-- Merge Group with AI -->
        <button
          v-if="group.groupId"
          class="w-[22px] h-[22px] border rounded-[4px] opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0 ml-1"
          style="border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);"
          title="Merge this group with AI"
          @click.stop="handleMergeGroup"
          :disabled="merging"
          @mouseenter="showMergeTooltip = true"
          @mouseleave="showMergeTooltip = false"
        >
          <svg v-if="merging" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M12.232 4.232a2.5 2.5 0 013.536 3.536l-1.225 1.224a.75.75 0 001.061 1.06l1.224-1.224a4 4 0 00-5.656-5.656l-3 3a4 4 0 00.225 5.865.75.75 0 00.977-1.138 2.5 2.5 0 01-.142-3.667l3-3z" />
            <path d="M11.603 7.963a.75.75 0 00-.977 1.138 2.5 2.5 0 01.142 3.667l-3 3a2.5 2.5 0 01-3.536-3.536l1.225-1.224a.75.75 0 00-1.061-1.06l-1.224 1.224a4 4 0 105.656 5.656l3-3a4 4 0 00-.225-5.865z" />
          </svg>
        </button>
        <button
          class="p-1 rounded-md opacity-0 group-hover/row:opacity-100"
          style="color: var(--text-tertiary);"
          :title="getMessage('closeGroup')"
          @click.stop="handleCloseGroup"
        >
          <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
        <svg class="w-3 h-3" style="color: var(--text-tertiary);" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
        </svg>

        <!-- Split Tooltip -->
        <div
          v-if="showSplitTooltip && aiSettings.enabled && aiSettings.apiKey"
          class="absolute left-3.5 right-[94px] top-0 mt-1 block p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200"
          style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);"
        >
          <div class="font-semibold mb-1" style="color: var(--accent);">
            AI Split Group Preview
          </div>
          <div class="flex items-center gap-1.5 text-[9px] mb-2" style="color: var(--text-tertiary);">
            <span>Model: <span class="font-semibold" style="color: var(--text-secondary);">{{ activeModel }}</span></span>
            <span class="opacity-40">•</span>
            <span>Privacy: <span class="font-semibold" style="color: var(--text-secondary);">AI Analysis</span></span>
          </div>
          
          <div class="mb-1 text-[9px] uppercase font-bold tracking-wider mt-2" style="color: var(--text-tertiary);">System Prompt</div>
          <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
            {{ getSystemPrompt() }}
          </div>
          
          <div class="mb-1 text-[9px] uppercase font-bold tracking-wider" style="color: var(--text-tertiary);">Split Prompt</div>
          <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
            {{ aiSettings.splitPrompt || 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.' }}
          </div>
          
          <div class="mt-2 pt-2 border-t flex flex-col gap-1.5" style="border-color: var(--border);">
            <div class="flex items-center justify-between text-[10px]">
              <span style="color: var(--text-secondary);">
                Est. Requests: <span class="font-bold tabular-nums" style="color: var(--text-primary);">1</span>
              </span>
              <span class="font-bold tabular-nums" style="color: var(--text-primary);">{{ estimateSplitCost().costStr }}</span>
            </div>
            <div class="flex items-center justify-between text-[9px]" style="color: var(--text-tertiary);">
              <span>Total: <span class="font-semibold tabular-nums" style="color: var(--text-secondary);">~{{ estimateSplitCost().tokens }}</span> tokens</span>
            </div>
          </div>
        </div>

        <!-- Merge Tooltip -->
        <div
          v-if="showMergeTooltip && aiSettings.enabled && aiSettings.apiKey"
          class="absolute left-3.5 right-[94px] top-0 mt-1 block p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200"
          style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);"
        >
          <div class="font-semibold mb-1" style="color: var(--accent);">
            AI Merge Group Preview
          </div>
          <div class="flex items-center gap-1.5 text-[9px] mb-2" style="color: var(--text-tertiary);">
            <span>Model: <span class="font-semibold" style="color: var(--text-secondary);">{{ activeModel }}</span></span>
            <span class="opacity-40">•</span>
            <span>Privacy: <span class="font-semibold" style="color: var(--text-secondary);">AI Analysis</span></span>
          </div>
          
          <div class="mb-1 text-[9px] uppercase font-bold tracking-wider mt-2" style="color: var(--text-tertiary);">System Prompt</div>
          <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
            {{ getSystemPrompt() }}
          </div>
          
          <div class="mb-1 text-[9px] uppercase font-bold tracking-wider" style="color: var(--text-tertiary);">Merge Prompt</div>
          <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
            {{ aiSettings.mergePrompt || 'Analyze the browser tabs of this group and decide if they should be merged into one of the other existing tab groups. Choose the best fitting existing group from the list. If none of the existing groups are a good fit and this group should remain separate, respond with "KEEP". Be conservative about merging; only merge if the topics are highly related.' }}
          </div>
          
          <div class="mt-2 pt-2 border-t flex flex-col gap-1.5" style="border-color: var(--border);">
            <div class="flex items-center justify-between text-[10px]">
              <span style="color: var(--text-secondary);">
                Est. Requests: <span class="font-bold tabular-nums" style="color: var(--text-primary);">1</span>
              </span>
              <span class="font-bold tabular-nums" style="color: var(--text-primary);">{{ estimateMergeCost().costStr }}</span>
            </div>
            <div class="flex items-center justify-between text-[9px]" style="color: var(--text-tertiary);">
              <span>Total: <span class="font-semibold tabular-nums" style="color: var(--text-secondary);">~{{ estimateMergeCost().tokens }}</span> tokens</span>
            </div>
          </div>
        </div>
      </button>
    </template>

    <!-- Header mode: expanded -->
    <template v-else-if="mode === 'header'">
      <button
        class="w-full flex items-center gap-2.5 px-3.5 py-2 text-left group/row relative"
        @click="collapsed = true"
      >
        <span class="w-[3px] h-4 rounded-sm shrink-0" :style="{ background: groupColorVar }" />
        <span class="text-xs font-medium flex-1 truncate" style="color: var(--text-primary);">
          {{ displayLabel }}
        </span>
        <span class="text-[10px] tabular-nums" style="color: var(--text-tertiary);">{{ group.tabs.length }}</span>
        <!-- Split Group with AI -->
        <button
          v-if="group.groupId"
          class="w-[22px] h-[22px] border rounded-[4px] opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0"
          style="border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);"
          title="Split this group with AI"
          @click.stop="handleSplitGroup"
          :disabled="splitting"
          @mouseenter="showSplitTooltip = true"
          @mouseleave="showSplitTooltip = false"
        >
          <svg v-if="splitting" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10.893 2.577a.75.75 0 00-1.786 0L8.23 8.169a.75.75 0 01-.46.46L2.169 9.107a.75.75 0 000 1.786l5.601.411a.75.75 0 01.46.46l.411 5.601a.75.75 0 001.786 0l.411-5.601a.75.75 0 01.46-.46l5.601-.411a.75.75 0 000-1.786l-5.601-.411a.75.75 0 01-.46-.46l-.411-5.601z" clip-rule="evenodd" />
          </svg>
        </button>
        <!-- Merge Group with AI -->
        <button
          v-if="group.groupId"
          class="w-[22px] h-[22px] border rounded-[4px] opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0 ml-1"
          style="border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);"
          title="Merge this group with AI"
          @click.stop="handleMergeGroup"
          :disabled="merging"
          @mouseenter="showMergeTooltip = true"
          @mouseleave="showMergeTooltip = false"
        >
          <svg v-if="merging" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M12.232 4.232a2.5 2.5 0 013.536 3.536l-1.225 1.224a.75.75 0 001.061 1.06l1.224-1.224a4 4 0 00-5.656-5.656l-3 3a4 4 0 00.225 5.865.75.75 0 00.977-1.138 2.5 2.5 0 01-.142-3.667l3-3z" />
            <path d="M11.603 7.963a.75.75 0 00-.977 1.138 2.5 2.5 0 01.142 3.667l-3 3a2.5 2.5 0 01-3.536-3.536l1.225-1.224a.75.75 0 00-1.061-1.06l-1.224 1.224a4 4 0 105.656 5.656l3-3a4 4 0 00-.225-5.865z" />
          </svg>
        </button>
        <button
          class="p-1 rounded-md opacity-0 group-hover/row:opacity-100"
          style="color: var(--text-tertiary);"
          :title="getMessage('closeGroup')"
          @click.stop="handleCloseGroup"
        >
          <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
        <svg
          class="w-3 h-3 rotate-90"
          style="color: var(--text-tertiary);"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
        </svg>

        <!-- Split Tooltip -->
        <div
          v-if="showSplitTooltip && aiSettings.enabled && aiSettings.apiKey"
          class="absolute left-3.5 right-[94px] top-0 mt-1 block p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200"
          style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);"
        >
          <div class="font-semibold mb-1" style="color: var(--accent);">
            AI Split Group Preview
          </div>
          <div class="flex items-center gap-1.5 text-[9px] mb-2" style="color: var(--text-tertiary);">
            <span>Model: <span class="font-semibold" style="color: var(--text-secondary);">{{ activeModel }}</span></span>
            <span class="opacity-40">•</span>
            <span>Privacy: <span class="font-semibold" style="color: var(--text-secondary);">AI Analysis</span></span>
          </div>
          
          <div class="mb-1 text-[9px] uppercase font-bold tracking-wider mt-2" style="color: var(--text-tertiary);">System Prompt</div>
          <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
            {{ getSystemPrompt() }}
          </div>
          
          <div class="mb-1 text-[9px] uppercase font-bold tracking-wider" style="color: var(--text-tertiary);">Split Prompt</div>
          <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
            {{ aiSettings.splitPrompt || 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.' }}
          </div>
          
          <div class="mt-2 pt-2 border-t flex flex-col gap-1.5" style="border-color: var(--border);">
            <div class="flex items-center justify-between text-[10px]">
              <span style="color: var(--text-secondary);">
                Est. Requests: <span class="font-bold tabular-nums" style="color: var(--text-primary);">1</span>
              </span>
              <span class="font-bold tabular-nums" style="color: var(--text-primary);">{{ estimateSplitCost().costStr }}</span>
            </div>
            <div class="flex items-center justify-between text-[9px]" style="color: var(--text-tertiary);">
              <span>Total: <span class="font-semibold tabular-nums" style="color: var(--text-secondary);">~{{ estimateSplitCost().tokens }}</span> tokens</span>
            </div>
          </div>
        </div>

        <!-- Merge Tooltip -->
        <div
          v-if="showMergeTooltip && aiSettings.enabled && aiSettings.apiKey"
          class="absolute left-3.5 right-[94px] top-0 mt-1 block p-2.5 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200"
          style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);"
        >
          <div class="font-semibold mb-1" style="color: var(--accent);">
            AI Merge Group Preview
          </div>
          <div class="flex items-center gap-1.5 text-[9px] mb-2" style="color: var(--text-tertiary);">
            <span>Model: <span class="font-semibold" style="color: var(--text-secondary);">{{ activeModel }}</span></span>
            <span class="opacity-40">•</span>
            <span>Privacy: <span class="font-semibold" style="color: var(--text-secondary);">AI Analysis</span></span>
          </div>
          
          <div class="mb-1 text-[9px] uppercase font-bold tracking-wider mt-2" style="color: var(--text-tertiary);">System Prompt</div>
          <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
            {{ getSystemPrompt() }}
          </div>
          
          <div class="mb-1 text-[9px] uppercase font-bold tracking-wider" style="color: var(--text-tertiary);">Merge Prompt</div>
          <div class="text-[10px] mb-2" style="color: var(--text-secondary);">
            {{ aiSettings.mergePrompt || 'Analyze the browser tabs of this group and decide if they should be merged into one of the other existing tab groups. Choose the best fitting existing group from the list. If none of the existing groups are a good fit and this group should remain separate, respond with "KEEP". Be conservative about merging; only merge if the topics are highly related.' }}
          </div>
          
          <div class="mt-2 pt-2 border-t flex flex-col gap-1.5" style="border-color: var(--border);">
            <div class="flex items-center justify-between text-[10px]">
              <span style="color: var(--text-secondary);">
                Est. Requests: <span class="font-bold tabular-nums" style="color: var(--text-primary);">1</span>
              </span>
              <span class="font-bold tabular-nums" style="color: var(--text-primary);">{{ estimateMergeCost().costStr }}</span>
            </div>
            <div class="flex items-center justify-between text-[9px]" style="color: var(--text-tertiary);">
              <span>Total: <span class="font-semibold tabular-nums" style="color: var(--text-secondary);">~{{ estimateMergeCost().tokens }}</span> tokens</span>
            </div>
          </div>
        </div>
      </button>
      <div class="pl-6 pr-2 pb-1">
        <TabItem v-for="tab in group.tabs" :key="tab.id" :tab="tab" />
      </div>
    </template>

    <!-- Bar mode: expanded with colored vertical bar -->
    <template v-else>
      <div class="relative group/bar">
        <div
          class="absolute left-0 top-0 bottom-0 w-4 cursor-pointer z-10 flex items-start"
          :title="displayLabel + ' (' + group.tabs.length + ')'"
          @click="collapsed = true"
        >
          <div
            class="absolute left-1.5 top-1 bottom-1 w-[3px] rounded-sm transition-all duration-200"
            :style="{ background: groupColorVar }"
          />
        </div>
        <button
          class="absolute left-0 top-0 w-4 h-4 flex items-center justify-center transition-all opacity-0 group-hover/bar:opacity-100 z-20"
          style="color: var(--text-tertiary);"
          :title="getMessage('closeGroup')"
          @click.stop="handleCloseGroup"
        >
          <svg class="w-2 h-2" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
        <div class="pl-5 pr-2 py-0.5">
          <TabItem v-for="tab in group.tabs" :key="tab.id" :tab="tab" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
button.group\/row:hover,
.group\/row:hover {
  background: var(--hover);
}
button:active {
  transform: scale(0.99);
}
</style>
