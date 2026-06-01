<script setup lang="ts">
import type { TabInfo } from '../../shared/types'

defineProps<{
  tab: TabInfo
}>()

function switchToTab(tabId: number) {
  chrome.tabs.update(tabId, { active: true })
}

async function closeTab(tabId: number) {
  try {
    await chrome.tabs.remove(tabId)
  } catch (err) {
    console.error('[timTabTool] Failed to close tab:', err)
  }
}

function getFaviconUrl(tab: TabInfo): string {
  if (tab.favIconUrl) return tab.favIconUrl
  try {
    const url = new URL(tab.url)
    const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')
    if (isFirefox) {
      return `https://www.google.com/s2/favicons?sz=16&domain=${url.hostname}`
    }
    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url.href)}&size=16`
  } catch {
    return ''
  }
}
</script>

<template>
  <button
    class="tab-row w-full flex items-center gap-2.5 px-2 py-[5px] rounded-sm text-left group"
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
    <span class="text-xs truncate" style="color: var(--text-primary);">
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
</style>
