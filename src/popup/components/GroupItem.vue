<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { GROUP_DEFINITIONS, STORAGE_KEYS, DEFAULT_SETTINGS, MODEL_PRICING, PROVIDER_DEFAULTS, DEFAULT_MODELS } from '../../shared/constants'
import { getMessage } from '../../shared/i18n'
import type { GroupedTabs, GroupIndicatorStyle, ExtensionSettings } from '../../shared/types'
import TabItem from './TabItem.vue'
import { SYSTEM_PROMPT } from '../../shared/ai-client'

/**
 * Props for GroupItem component.
 * @property {GroupedTabs} group - The group data to display.
 * @property {GroupIndicatorStyle} mode - The visual mode for the group indicator.
 * @property {number} expandTrigger - Reactive trigger to expand group.
 * @property {number} collapseTrigger - Reactive trigger to collapse group.
 * @property {boolean} [isActiveGroup=false] - Whether this is the currently active group.
 */
const props = withDefaults(defineProps<{
  group: GroupedTabs
  mode: GroupIndicatorStyle
  expandTrigger: number
  collapseTrigger: number
  isActiveGroup?: boolean
}>(), {
  mode: 'header',
  expandTrigger: 0,
  collapseTrigger: 0,
  isActiveGroup: false,
})

/**
 * Emitted events for GroupItem.
 */
const emit = defineEmits<{
  /** Emitted when the group is requested to be closed/ungrouped. */
  'close-group': []
  /** Emitted when the group is successfully split or merged. */
  'split-group': []
  /** Emitted when an error occurs during an operation. */
  'error': [msg: string]
}>()

const collapsed = ref(props.mode === 'header' && !props.isActiveGroup)
const splitting = ref(false)
const showSplitTooltip = ref(false)
const merging = ref(false)
const showMergeTooltip = ref(false)

watch(() => props.expandTrigger, () => { collapsed.value = false })
watch(() => props.collapseTrigger, () => { collapsed.value = true })

const def = GROUP_DEFINITIONS[props.group.category]

const displayColor = computed(() => props.group.groupColor || def.color)
const displayLabel = computed(() => props.group.groupName || getMessage(def.labelKey))

const groupColorVar = computed(() => `var(--group-${displayColor.value}, var(--group-grey))`)

const LIGHT_GROUP_COLORS = new Set(['yellow', 'cyan', 'green', 'orange'])
const badgeTextColor = computed(() => (LIGHT_GROUP_COLORS.has(displayColor.value) ? '#000000' : '#ffffff'))

/**
 * Load AI Settings for estimating tokens/cost and rendering the preview
 * @type {import('vue').Ref<ExtensionSettings['ai']>}
 */
const aiSettings = ref(DEFAULT_SETTINGS.ai)

/**
 * Handles changes in storage to update AI settings dynamically.
 * @param {{ [key: string]: chrome.storage.StorageChange }} changes - The changed storage items.
 * @param {string} namespace - The storage namespace.
 * @returns {void}
 */
function handleStorageChange(changes: { [key: string]: chrome.storage.StorageChange }, namespace: string): void {
  // Logic: Update local reactive state when extension settings change in storage
  if (namespace === 'local' && changes[STORAGE_KEYS.SETTINGS]) {
    const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue as Partial<ExtensionSettings> | undefined
    if (newSettings?.ai) {
      aiSettings.value = { ...DEFAULT_SETTINGS.ai, ...newSettings.ai }
    }
  }
}

onMounted(async () => {
  chrome.storage.onChanged.addListener(handleStorageChange)
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const stored = data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined
  if (stored?.ai) {
    aiSettings.value = { ...DEFAULT_SETTINGS.ai, ...stored.ai }
  }
})

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(handleStorageChange)
})

/**
 * Computes the active AI model to use.
 * @returns {string} The active model identifier.
 */
const activeModel = computed(() => {
  if (aiSettings.value.model) return aiSettings.value.model
  return DEFAULT_MODELS[aiSettings.value.provider] || 'gpt-4o-mini'
})

/**
 * Gets the constructed system prompt including user instructions.
 * @returns {string} The full system prompt.
 */
function getSystemPrompt(): string {
  // Logic: Append custom instructions if present
  if (aiSettings.value.customPrompt?.trim()) {
    return `${SYSTEM_PROMPT}\n\nUser Instructions:\n${aiSettings.value.customPrompt.trim()}`
  }
  return SYSTEM_PROMPT
}

/**
 * Estimates the cost and token usage for splitting a group.
 * @returns {{ tokens: number, costStr: string }} The estimation details.
 */
function estimateSplitCost(): { tokens: number; costStr: string } {
  // Logic: Calculate prompt length and tab info to estimate token count
  const tabs = props.group.tabs.length
  if (tabs === 0) {
    return { tokens: 0, costStr: 'Free' }
  }
  const promptLen = getSystemPrompt().length + (aiSettings.value.splitPrompt || '').length + 100
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

/**
 * Estimates the cost and token usage for merging a group.
 * @returns {{ tokens: number, costStr: string }} The estimation details.
 */
function estimateMergeCost(): { tokens: number; costStr: string } {
  // Logic: Calculate token cost based on merged tab properties
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

/**
 * Handles ungrouping all tabs in this group.
 * @returns {Promise<void>}
 */
async function handleCloseGroup(): Promise<void> {
  const tabIds = props.group.tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
  if (tabIds.length > 0) {
    if (confirm(getMessage('confirmUngroupGroup') || 'Are you sure you want to ungroup these tabs?')) {
      await chrome.runtime.sendMessage({ action: 'UNGROUP_GROUP', payload: { tabIds } })
    }
  }
  emit('close-group')
}

/**
 * Triggers AI to split the current group into smaller sub-groups.
 * @param {MouseEvent} [event] - Optional mouse event to check for modifiers.
 * @returns {Promise<void>}
 */
async function handleSplitGroup(event?: MouseEvent): Promise<void> {
  if (!props.group.groupId) return
  splitting.value = true
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'SPLIT_GROUP',
      payload: { groupId: props.group.groupId, shiftKey: event?.shiftKey }
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

/**
 * Triggers AI to merge the current group into existing ones.
 * @param {MouseEvent} [event] - Optional mouse event to check for modifiers.
 * @returns {Promise<void>}
 */
async function handleMergeGroup(event?: MouseEvent): Promise<void> {
  if (!props.group.groupId) return
  merging.value = true
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'MERGE_GROUP',
      payload: { groupId: props.group.groupId, shiftKey: event?.shiftKey }
    })
    if (res && typeof res === 'object' && 'error' in res) {
      emit('error', String(res.error))
    } else {
      emit('split-group')
    }
  } catch (err) {
    emit('error', (err as Error).message)
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <div class="group/item" :data-active-group="isActiveGroup ? 'true' : 'false'">
    <!-- Collapsed chip -->
    <template v-if="collapsed">
      <button
        class="w-full flex items-center gap-2.5 px-3.5 py-2 text-left group/row relative"
        :class="{ 'active-group-highlight': isActiveGroup, 'z-30': showSplitTooltip || showMergeTooltip }"
        :data-active-group-header="isActiveGroup ? 'true' : 'false'"
        @click="collapsed = false"
      >
        <span
          class="w-[22px] h-[22px] shrink-0 rounded-full flex items-center justify-center font-bold tabular-nums leading-none border border-border select-none"
          :class="group.tabs.length >= 100 ? 'text-[9px] tracking-tight' : 'text-[10px]'"
          :style="{
            background: groupColorVar,
            color: badgeTextColor,
            borderColor: 'var(--border)'
          }"
        >
          {{ group.tabs.length }}
        </span>
        <span class="text-xs font-medium flex-1 truncate" style="color: var(--text-primary);">
          <span v-if="displayLabel === '_ungrouped_'" class="italic font-normal">ungrouped</span>
          <template v-else>{{ displayLabel }}</template>
        </span>
        <!-- Split Group with AI -->
        <button
          v-if="group.groupId"
          class="w-[22px] h-[22px] border rounded-sm opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0"
          style="border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);"
          title="Split this group with AI (Sends existing tab groups as context)"
          @click.stop="handleSplitGroup"
          :disabled="splitting"
          @mouseenter="showSplitTooltip = true"
          @mouseleave="showSplitTooltip = false"
        >
          <svg v-if="splitting" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 21v-6a4 4 0 0 0-1.17-2.83L5.5 6.8" />
            <path d="M12 15a4 4 0 0 1 1.17-2.83L18.5 6.8" />
            <path d="M5.5 10.5V6.8h3.7" />
            <path d="M14.8 6.8h3.7v3.7" />
          </svg>
        </button>
        <!-- Merge Group with AI -->
        <button
          v-if="group.groupId"
          class="w-[22px] h-[22px] border rounded-sm opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0 ml-1"
          style="border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);"
          title="Merge this group with AI"
          @click.stop="handleMergeGroup"
          :disabled="merging"
          @mouseenter="showMergeTooltip = true"
          @mouseleave="showMergeTooltip = false"
        >
          <svg v-if="merging" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5.5 6.8l5.33 5.34A4 4 0 0 1 12 15v6" />
            <path d="M18.5 6.8l-5.33 5.34A4 4 0 0 0 12 15" />
            <path d="M9 18l3 3 3-3" />
          </svg>
        </button>
        <button
          class="w-[22px] h-[22px] border rounded-sm opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0 ml-1 group/ungroup"
          style="border: 1px solid var(--border); background: var(--hover); color: var(--text-tertiary);"
          :title="getMessage('ungroupGroup')"
          @click.stop="handleCloseGroup"
        >
          <svg class="w-3 h-3 transition-colors group-hover/ungroup:text-red-500" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
        <svg class="w-3 h-3" style="color: var(--text-tertiary);" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
        </svg>

        <!-- Split Tooltip -->
        <div
          v-if="showSplitTooltip && aiSettings.enabled && aiSettings.apiKey"
          class="absolute right-3.5 top-full mt-1 block w-[285px] p-3 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200"
          style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);"
        >
          <div class="font-semibold mb-1 flex items-center justify-between" style="color: var(--accent);">
            <span>AI Split Group Preview</span>
            <span class="text-[9px] font-normal px-1.5 py-0.5 rounded-full bg-accent/10" style="color: var(--accent);">Sub-Grouping</span>
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
          <div class="text-[10px] mb-1.5 leading-normal" style="color: var(--text-secondary);">
            {{ aiSettings.splitPrompt || 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.' }}
          </div>

          <div class="text-[9.5px] italic mb-2 px-2 py-1 rounded bg-black/5 dark:bg-white/5" style="color: var(--accent);">
            Includes names of all other existing window tab groups for contextual sub-grouping.
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
          class="absolute right-3.5 top-full mt-1 block w-[285px] p-3 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200"
          style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);"
        >
          <div class="font-semibold mb-1 flex items-center justify-between" style="color: var(--accent);">
            <span>AI Merge Group Preview</span>
            <span class="text-[9px] font-normal px-1.5 py-0.5 rounded-full bg-accent/10" style="color: var(--accent);">Target Merge</span>
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
          <div class="text-[10px] mb-2 leading-normal" style="color: var(--text-secondary);">
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
        class="w-full flex items-center gap-2.5 px-3.5 py-2 text-left group/row relative sticky-group-header"
        :class="{ 'active-group-highlight': isActiveGroup, '!z-30': showSplitTooltip || showMergeTooltip }"
        :data-active-group-header="isActiveGroup ? 'true' : 'false'"
        @click="collapsed = true"
      >
        <span class="w-[3px] h-4 rounded-sm shrink-0" :style="{ background: groupColorVar }" />
        <span class="text-xs font-medium flex-1 truncate" style="color: var(--text-primary);">
          <span v-if="displayLabel === '_ungrouped_'" class="italic font-normal">ungrouped</span>
          <template v-else>{{ displayLabel }}</template>
        </span>
        <span class="text-[10px] tabular-nums" style="color: var(--text-tertiary);">{{ group.tabs.length }}</span>
        <!-- Split Group with AI -->
        <button
          v-if="group.groupId"
          class="w-[22px] h-[22px] border rounded-sm opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0"
          style="border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);"
          title="Split this group with AI (Sends existing tab groups as context)"
          @click.stop="handleSplitGroup"
          :disabled="splitting"
          @mouseenter="showSplitTooltip = true"
          @mouseleave="showSplitTooltip = false"
        >
          <svg v-if="splitting" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 21v-6a4 4 0 0 0-1.17-2.83L5.5 6.8" />
            <path d="M12 15a4 4 0 0 1 1.17-2.83L18.5 6.8" />
            <path d="M5.5 10.5V6.8h3.7" />
            <path d="M14.8 6.8h3.7v3.7" />
          </svg>
        </button>
        <!-- Merge Group with AI -->
        <button
          v-if="group.groupId"
          class="w-[22px] h-[22px] border rounded-sm opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0 ml-1"
          style="border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);"
          title="Merge this group with AI"
          @click.stop="handleMergeGroup"
          :disabled="merging"
          @mouseenter="showMergeTooltip = true"
          @mouseleave="showMergeTooltip = false"
        >
          <svg v-if="merging" class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5.5 6.8l5.33 5.34A4 4 0 0 1 12 15v6" />
            <path d="M18.5 6.8l-5.33 5.34A4 4 0 0 0 12 15" />
            <path d="M9 18l3 3 3-3" />
          </svg>
        </button>
        <button
          class="w-[22px] h-[22px] border rounded-sm opacity-0 group-hover/row:opacity-100 focus:outline-none flex items-center justify-center transition-all duration-150 shrink-0 ml-1 group/ungroup"
          style="border: 1px solid var(--border); background: var(--hover); color: var(--text-tertiary);"
          :title="getMessage('ungroupGroup')"
          @click.stop="handleCloseGroup"
        >
          <svg class="w-3 h-3 transition-colors group-hover/ungroup:text-red-500" viewBox="0 0 20 20" fill="currentColor">
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
          class="absolute right-3.5 top-full mt-1 block w-[285px] p-3 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200"
          style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);"
        >
          <div class="font-semibold mb-1 flex items-center justify-between" style="color: var(--accent);">
            <span>AI Split Group Preview</span>
            <span class="text-[9px] font-normal px-1.5 py-0.5 rounded-full bg-accent/10" style="color: var(--accent);">Sub-Grouping</span>
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
          <div class="text-[10px] mb-1.5 leading-normal" style="color: var(--text-secondary);">
            {{ aiSettings.splitPrompt || 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.' }}
          </div>

          <div class="text-[9.5px] italic mb-2 px-2 py-1 rounded bg-black/5 dark:bg-white/5" style="color: var(--accent);">
            Includes names of all other existing window tab groups for contextual sub-grouping.
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
          class="absolute right-3.5 top-full mt-1 block w-[285px] p-3 rounded-sm shadow-card z-50 pointer-events-none text-left whitespace-pre-wrap leading-relaxed transition-all duration-200"
          style="background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border);"
        >
          <div class="font-semibold mb-1 flex items-center justify-between" style="color: var(--accent);">
            <span>AI Merge Group Preview</span>
            <span class="text-[9px] font-normal px-1.5 py-0.5 rounded-full bg-accent/10" style="color: var(--accent);">Target Merge</span>
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
          <div class="text-[10px] mb-2 leading-normal" style="color: var(--text-secondary);">
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
      <div class="relative group/bar" :class="{ 'active-group-bar-highlight': isActiveGroup }" :data-active-group-header="isActiveGroup ? 'true' : 'false'">
        <div
          class="absolute left-0 top-0 bottom-0 w-4 cursor-pointer z-10 flex items-start"
          :title="(displayLabel === '_ungrouped_' ? 'ungrouped' : displayLabel) + ' (' + group.tabs.length + ')'"
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
          :title="getMessage('ungroupGroup')"
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
.sticky-group-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg-primary);
  /* Logik: Kopfzeile der Gruppe klebrig machen, damit sie beim Scrollen der Tabs sichtbar bleibt */
}

button.group\/row:hover,
.group\/row:hover {
  background: linear-gradient(var(--hover), var(--hover)), var(--bg-primary);
}
button:active {
  transform: scale(0.99);
}

.active-group-highlight {
  /* Logik: Markiert die aktive Gruppe durch einen dezenten Hintergrund und einen linken Rahmen in Akzentfarbe */
  /* Highlight active group with soft accent background and left border */
  background: linear-gradient(var(--accent-soft), var(--accent-soft)), var(--bg-primary) !important;
  border-left: 3.5px solid var(--accent) !important;
  padding-left: calc(14px - 3.5px) !important;
}

.active-group-bar-highlight {
  /* Logik: Hebt den Container der aktiven Gruppe im Balkenmodus dezent hervor */
  /* Highlight active group container in bar mode */
  background: var(--accent-soft);
  border-left: 3.5px solid var(--accent);
}
</style>
