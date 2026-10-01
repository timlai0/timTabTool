<script setup lang="ts">
import type { TabInfo } from '../../shared/types'
import { getOptimalFaviconUrl } from '../../shared/utils'

/**
 * Props for the TabItem component.
 * @property {TabInfo} tab - The tab information to display.
 */
const props = defineProps<{
  tab: TabInfo
}>()

/**
 * Switches the active state to the selected tab and brings its window to focus.
 * @param {number} tabId - The ID of the tab to switch to.
 * @returns {Promise<void>}
 */
async function switchToTab(tabId: number): Promise<void> {
  // Logic: Focus target tab and containing window
  try {
    await chrome.tabs.update(tabId, { active: true })
    if (props.tab && props.tab.windowId !== undefined) {
      await chrome.windows.update(props.tab.windowId, { focused: true })
    }
  } catch (err) {
    console.error('[timTabTool] Failed to switch tab or focus window:', err)
  }
}

/**
 * Closes a specified tab by its ID.
 * @param {number} tabId - The ID of the tab to close.
 * @returns {Promise<void>}
 */
async function closeTab(tabId: number): Promise<void> {
  await chrome.runtime.sendMessage({ action: 'CLOSE_TAB', payload: { tabId } })
}

/**
 * Gets the best favicon URL for a tab.
 * @param {TabInfo} tab - The tab to get the favicon for.
 * @returns {string} The optimized favicon URL.
 */
function getFaviconUrl(tab: TabInfo): string {
  return getOptimalFaviconUrl(tab.url, tab.favIconUrl)
}
</script>

<template>
  <button
    :data-tab-id="tab.id"
    class="tab-row w-full flex items-center gap-2.5 px-2 py-[5px] rounded-sm text-left group transition-all duration-300"
    :class="{ 'active-tab-highlight': tab.active }"
    @click="switchToTab(tab.id)"
    @mousedown.middle.prevent.stop=""
    @click.middle.prevent.stop="closeTab(tab.id)"
    @auxclick.prevent.stop="($event) => { if ($event.button === 1) closeTab(tab.id); }"
    :title="tab.url"
  >
    <div class="w-4 h-4 shrink-0 rounded-sm flex items-center justify-center overflow-hidden" style="background: var(--bg-secondary);">
      <img
        v-if="getFaviconUrl(tab)"
        :src="getFaviconUrl(tab)"
        alt=""
        loading="lazy"
        decoding="async"
        class="w-3.5 h-3.5"
        @error="($event.target as HTMLImageElement).style.display = 'none'"
      />
    </div>
    <span class="text-xs truncate flex-1 min-w-0" :style="{ color: tab.active ? 'var(--accent)' : 'var(--text-primary)' }">
      {{ tab.title || 'Untitled' }}
    </span>
    <span
      @click.stop="closeTab(tab.id)"
      @auxclick.prevent.stop="($event) => { if ($event.button === 1) closeTab(tab.id); }"
      class="opacity-0 group-hover:opacity-100 p-0.5 rounded-sm hover:bg-red-500/20 hover:text-red-500 transition-all shrink-0 cursor-pointer"
      style="color: var(--text-tertiary);"
      title="Close tab (or Middle-click)"
    >
      <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
      </svg>
    </span>
  </button>
</template>

<style scoped>
.tab-row:hover {
  background: var(--hover);
}
.tab-row:active {
  transform: scale(0.99);
}

.active-tab-highlight {
  /* Logik: Hebt den aktuell aktiven Tab durch einen dezenten Hintergrund hervor */
  /* Highlight the active tab with a soft accent background */
  background: var(--accent-soft) !important;
}
</style>
