<script setup lang="ts">
import type { TabInfo } from '../../shared/types'
import { getOptimalFaviconUrl } from '../../shared/utils'

defineProps<{
  tab: TabInfo
}>()

async function switchToTab(tabId: number) {
  try {
    await chrome.tabs.update(tabId, { active: true })
    if (props.tab && props.tab.windowId !== undefined) {
      await chrome.windows.update(props.tab.windowId, { focused: true })
    }
  } catch (err) {
    console.error('[timTabTool] Failed to switch tab or focus window:', err)
  }
}

async function closeTab(tabId: number) {
  try {
    await chrome.tabs.remove(tabId)
  } catch (err) {
    console.error('[timTabTool] Failed to close tab:', err)
  }
}

function getFaviconUrl(tab: TabInfo): string {
  return getOptimalFaviconUrl(tab.url, tab.favIconUrl)
}
</script>

<template>
  <button
    class="tab-row w-full flex items-center gap-2.5 px-2 py-[5px] rounded-sm text-left group"
    :class="{ 'active-tab-highlight': tab.active }"
    @click="switchToTab(tab.id)"
    @mousedown.middle.prevent.stop=""
    @click.middle.prevent.stop="closeTab(tab.id)"
    @auxclick.prevent.stop="($event) => { if ($event.button === 1) closeTab(tab.id); }"
    @contextmenu.prevent.stop="closeTab(tab.id)"
    :title="tab.url"
  >
    <div class="w-4 h-4 shrink-0 rounded-sm flex items-center justify-center overflow-hidden" style="background: var(--bg-secondary);">
      <img
        v-if="getFaviconUrl(tab)"
        :src="getFaviconUrl(tab)"
        alt=""
        class="w-3.5 h-3.5"
        @error="($event.target as HTMLImageElement).style.display = 'none'"
      />
    </div>
    <span class="text-xs truncate" :style="{ color: tab.active ? 'var(--accent)' : 'var(--text-primary)' }">
      {{ tab.title || 'Untitled' }}
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
