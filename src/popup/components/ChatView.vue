<script setup lang="ts">
import { ref } from "vue"
import { AIClient } from "../../shared/ai-client"
import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../../shared/constants"
import type { WindowGroupsInfo, ExtensionSettings } from "../../shared/types"

const props = defineProps<{
  allWindows: WindowGroupsInfo[]
  currentWindowId: number | null
}>()

const emit = defineEmits<{
  (e: "back"): void
}>()

const userPrompt = ref("")
const response = ref("")
const isLoading = ref(false)
const errorMsg = ref("")

async function askQuestion() {
  if (!userPrompt.value.trim()) return

  isLoading.value = true
  errorMsg.value = ""
  response.value = ""

  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
    const settings = (data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings>) || { ...DEFAULT_SETTINGS }
    const aiConfig = settings.ai || DEFAULT_SETTINGS.ai

    if (!aiConfig.enabled || (!aiConfig.apiKey && aiConfig.provider !== "custom")) {
      errorMsg.value = "AI is not configured. Please set it up in settings."
      isLoading.value = false
      return
    }

    const client = new AIClient(aiConfig)
    
    const targetWin = props.allWindows.find(w => w.windowId === props.currentWindowId) || props.allWindows[0]
    let tabsContext = ""
    if (targetWin) {
      let index = 1
      for (const group of targetWin.groups) {
        for (const tab of group.tabs) {
          tabsContext += `${index}. "${tab.title}" (${tab.url})\n`
          index++
        }
      }
    }

    const systemPrompt = `You are a browser tab assistant. The user will ask a question about their current browser tabs.
Here is the list of tabs in the current window:

${tabsContext}

Answer the user's question concisely based on the provided list of tabs.`

    const prompt = `${systemPrompt}\n\nUser Question: ${userPrompt.value}`

    const result = await client.chat(prompt, false)
    response.value = result

  } catch (err: any) {
    errorMsg.value = err.message || "Failed to query AI"
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="flex flex-col h-full bg-white dark:bg-[#1a1a1a] text-black dark:text-white" style="background: var(--bg-primary); color: var(--text-primary);">
    <!-- Header -->
    <header class="flex items-center gap-3 px-4 py-3" style="box-shadow: 0 0.5px 0 var(--border);">
      <button 
        @click="emit('back')" 
        class="w-6 h-6 flex items-center justify-center rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors -ml-1 cursor-pointer"
        title="Go Back"
      >
        <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd" />
        </svg>
      </button>
      <h2 class="text-[13px] font-semibold tracking-tight">Window Chat</h2>
    </header>

    <div class="flex flex-col p-4 gap-4 flex-1 overflow-hidden">
      <div class="flex-1 overflow-y-auto scrollbar-thin rounded border p-3 whitespace-pre-wrap text-[12px]" style="border-color: var(--border); background: var(--bg-elevated);">
        <div v-if="isLoading" class="flex items-center gap-2 opacity-70">
          <span class="animate-spin w-3 h-3 border border-current border-t-transparent rounded-full" />
          Thinking...
        </div>
        <div v-else-if="errorMsg" class="text-red-500">{{ errorMsg }}</div>
        <div v-else-if="response" class="leading-relaxed">{{ response }}</div>
        <div v-else class="opacity-50 italic text-center mt-4">Ask a question about your tabs (e.g. "Which tabs contain urgent things?")</div>
      </div>

      <div class="flex flex-col gap-2 shrink-0">
        <textarea 
          v-model="userPrompt" 
          @keydown.enter.exact.prevent="askQuestion"
          placeholder="Ask a question..."
          class="w-full text-[12px] p-2 rounded border focus:outline-none focus:ring-1 resize-none h-16 scrollbar-thin"
          style="border-color: var(--border); background: var(--bg-primary); color: var(--text-primary); --tw-ring-color: var(--accent);"
        />
        <button 
          @click="askQuestion"
          :disabled="isLoading || !userPrompt.trim()"
          class="w-full py-2 rounded text-[12px] font-medium transition-opacity disabled:opacity-50 cursor-pointer"
          style="background: var(--accent); color: white;"
        >
          {{ isLoading ? "Asking..." : "Ask" }}
        </button>
      </div>
    </div>
  </div>
</template>
