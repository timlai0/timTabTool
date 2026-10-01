<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue"
import { AIClient } from "../../shared/ai-client"
import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../../shared/constants"
import type { WindowGroupsInfo, ExtensionSettings, ReasoningEffort } from "../../shared/types"

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  reasoning?: string
  fullRequest?: string
  timestamp: number
  showDetails?: boolean
}

const props = defineProps<{
  allWindows: WindowGroupsInfo[]
  currentWindowId: number | null
}>()

const emit = defineEmits<{
  (e: "back"): void
}>()

const targetWin = computed(() => {
  return props.allWindows.find(w => w.windowId === props.currentWindowId) || props.allWindows[0]
})

const targetTabCount = computed(() => {
  if (!targetWin.value) return 0
  return targetWin.value.groups.reduce((acc, g) => acc + g.tabs.length, 0)
})

const userPrompt = ref("")
const messages = ref<ChatMessage[]>([])
const isLoading = ref(false)
const liveReasoning = ref("")
const liveContent = ref("")
const errorMsg = ref("")
const savedPrompts = ref<string[]>([])
const reasoningEffort = ref<ReasoningEffort>("auto")
const clickedUrls = ref<string[]>([])
const activeModel = ref<string>("")
const activeProvider = ref<string>("")
const chatContainer = ref<HTMLElement | null>(null)
const elapsedMs = ref<number>(0)
const selectedScope = ref<string | number>(props.currentWindowId ?? "all")

const totalScopeTabs = computed(() => {
  if (selectedScope.value === "all") {
    return props.allWindows.reduce((acc, w) => acc + w.groups.reduce((gAcc, g) => gAcc + g.tabs.length, 0), 0)
  }
  const target = props.allWindows.find(w => w.windowId === selectedScope.value)
  return target ? target.groups.reduce((acc, g) => acc + g.tabs.length, 0) : targetTabCount.value
})

const estimatedTokens = computed(() => {
  return Math.round(totalScopeTabs.value * 35)
})

let timerInterval: ReturnType<typeof setInterval> | null = null
let currentAbortController: AbortController | null = null

const REASONING_OPTIONS: { label: string; value: ReasoningEffort }[] = [
  { label: "Auto", value: "auto" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Max", value: "max" }
]

function startTimer() {
  elapsedMs.value = 0
  if (timerInterval) clearInterval(timerInterval)
  const start = Date.now()
  timerInterval = setInterval(() => {
    elapsedMs.value = Date.now() - start
  }, 100)
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

onMounted(async () => {
  const data = await chrome.storage.local.get([
    "savedChatPrompts",
    "chatSessionMessages",
    "chatCurrentPrompt",
    "chatReasoningEffort",
    "chatClickedUrls",
    STORAGE_KEYS.SETTINGS
  ])

  if (Array.isArray(data.savedChatPrompts)) {
    savedPrompts.value = data.savedChatPrompts as string[]
  }
  if (Array.isArray(data.chatSessionMessages)) {
    messages.value = data.chatSessionMessages
  }
  if (Array.isArray(data.chatClickedUrls)) {
    clickedUrls.value = data.chatClickedUrls
  }
  if (typeof data.chatCurrentPrompt === "string") {
    userPrompt.value = data.chatCurrentPrompt
  }
  const settings = (data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined) || { ...DEFAULT_SETTINGS }
  if (data.chatReasoningEffort && typeof data.chatReasoningEffort === "string") {
    reasoningEffort.value = data.chatReasoningEffort as ReasoningEffort
  } else if (settings.ai?.reasoningEffort) {
    reasoningEffort.value = settings.ai.reasoningEffort
  }

  activeModel.value = settings.ai?.model || DEFAULT_SETTINGS.ai.model || ""
  activeProvider.value = settings.ai?.provider || DEFAULT_SETTINGS.ai.provider || ""

  scrollToBottom()
})

onUnmounted(() => {
  stopTimer()
  if (currentAbortController) {
    currentAbortController.abort()
  }
})

watch(userPrompt, (val) => {
  chrome.storage.local.set({ chatCurrentPrompt: val })
})

watch(reasoningEffort, (val) => {
  chrome.storage.local.set({ chatReasoningEffort: val })
})

async function saveMessages() {
  await chrome.storage.local.set({
    chatSessionMessages: messages.value.map(m => ({
      ...m,
      showDetails: false // Don't persist UI toggle state
    }))
  })
}

async function clearChat() {
  messages.value = []
  clickedUrls.value = []
  errorMsg.value = ""
  liveReasoning.value = ""
  liveContent.value = ""
  await chrome.storage.local.set({ chatClickedUrls: [] })
  await saveMessages()
}

function stopGenerating() {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  stopTimer()
  if (liveContent.value.trim()) {
    const assistantMsgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4)
    messages.value.push({
      id: assistantMsgId,
      role: "assistant",
      content: liveContent.value + "\n\n*(Generation stopped)*",
      reasoning: liveReasoning.value || undefined,
      timestamp: Date.now()
    })
    saveMessages()
  }
  isLoading.value = false
  liveContent.value = ""
  liveReasoning.value = ""
  scrollToBottom()
}

async function openInPinnedTab() {
  await chrome.tabs.create({ 
    url: chrome.runtime.getURL("src/popup/index.html?view=chat"), 
    pinned: true 
  })
}

async function savePrompt() {
  const p = userPrompt.value.trim()
  if (!p || savedPrompts.value.includes(p)) return
  savedPrompts.value.push(p)
  await chrome.storage.local.set({ savedChatPrompts: savedPrompts.value })
}

async function removePrompt(prompt: string) {
  savedPrompts.value = savedPrompts.value.filter(p => p !== prompt)
  await chrome.storage.local.set({ savedChatPrompts: savedPrompts.value })
}

function useSavedPrompt(prompt: string) {
  userPrompt.value = prompt
}

async function askQuestion() {
  const promptText = userPrompt.value.trim()
  if (!promptText || isLoading.value) return

  isLoading.value = true
  errorMsg.value = ""
  liveReasoning.value = ""
  liveContent.value = ""
  startTimer()

  currentAbortController = new AbortController()

  // Add user message to history
  const userMsgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4)
  messages.value.push({
    id: userMsgId,
    role: "user",
    content: promptText,
    timestamp: Date.now()
  })
  userPrompt.value = ""
  await saveMessages()
  scrollToBottom()

  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
    const settings = (data[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings>) || { ...DEFAULT_SETTINGS }
    const baseAiConfig = settings.ai || DEFAULT_SETTINGS.ai

    activeModel.value = baseAiConfig.model || DEFAULT_SETTINGS.ai.model || ""
    activeProvider.value = baseAiConfig.provider || DEFAULT_SETTINGS.ai.provider || ""

    if (!baseAiConfig.enabled || (!baseAiConfig.apiKey && baseAiConfig.provider !== "custom")) {
      errorMsg.value = "AI is not configured. Please enter an API Key in extension Settings."
      isLoading.value = false
      stopTimer()
      return
    }

    // Apply custom reasoning effort for this chat session
    const aiConfig = {
      ...baseAiConfig,
      reasoningEffort: reasoningEffort.value
    }

    const client = new AIClient(aiConfig, currentAbortController.signal)
    
    const targetWindows = selectedScope.value === "all"
      ? props.allWindows
      : [props.allWindows.find(w => w.windowId === selectedScope.value) || props.allWindows[0]].filter(Boolean)

    let tabsContext = ""
    for (const win of targetWindows) {
      if (selectedScope.value === "all" && props.allWindows.length > 1) {
        tabsContext += `\n## Window #${win.windowId}\n`
      }
      for (const group of win.groups) {
        const groupName = group.groupName || (group.isPinnedGroup ? "Pinned Tabs" : "Ungrouped Tabs")
        tabsContext += `\n### Group: ${groupName}\n`
        for (const tab of group.tabs) {
          const activeStr = tab.active ? " (Currently Active)" : ""
          const timeStr = tab.lastAccessed ? ` (Last Accessed: ${new Date(tab.lastAccessed).toLocaleString()})` : ""
          tabsContext += `- "${tab.title}" [URL: ${tab.url}]${activeStr}${timeStr}\n`
        }
      }
    }

    const systemPrompt = `You are a browser tab assistant. The user will ask a question about their current browser tabs.
Here is the list of tabs in the current window:

${tabsContext}

Answer the user's question concisely based on the provided list of tabs. You MUST format any mentioned tabs as markdown links using their exact URL, e.g., [Tab Title](https://example.com). You can use basic markdown like **bold** and *italic*.`

    const fullPrompt = `${systemPrompt}\n\nUser Question: ${promptText}`

    let capturedReasoning = ""
    let capturedContent = ""
    const result = await client.chat(
      fullPrompt,
      false,
      1,
      undefined,
      (progress) => {
        if (progress.liveReasoning) {
          capturedReasoning = progress.liveReasoning
          liveReasoning.value = progress.liveReasoning
          scrollToBottom()
        }
        if (progress.liveContent) {
          capturedContent = progress.liveContent
          liveContent.value = progress.liveContent
          scrollToBottom()
        }
      }
    )

    // Add assistant response to history
    const assistantMsgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4)
    messages.value.push({
      id: assistantMsgId,
      role: "assistant",
      content: result || capturedContent || liveContent.value,
      reasoning: capturedReasoning || liveReasoning.value || undefined,
      fullRequest: fullPrompt,
      timestamp: Date.now()
    })
    await saveMessages()
    scrollToBottom()

  } catch (err: any) {
    if (err.message?.includes('aborted') || err.name === 'AbortError') {
      // User aborted request
    } else {
      errorMsg.value = err.message || "Failed to query AI"
    }
  } finally {
    isLoading.value = false
    liveReasoning.value = ""
    liveContent.value = ""
    currentAbortController = null
    stopTimer()
    scrollToBottom()
  }
}

function formatMarkdown(text: string) {
  if (!text) return ""
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.*$)/gim, '<div class="font-bold text-[12px] mt-2 mb-0.5" style="color: var(--text-primary);">$1</div>')
    .replace(/^## (.*$)/gim, '<div class="font-bold text-[13px] mt-2.5 mb-1" style="color: var(--text-primary);">$1</div>')
    .replace(/^# (.*$)/gim, '<div class="font-bold text-[14px] mt-3 mb-1" style="color: var(--text-primary);">$1</div>')
    .replace(/^---\s*$/gim, '<hr class="my-2 opacity-30" style="border-color: var(--border);" />')
    .replace(/^\s*\*\s+(.*$)/gim, '<div class="flex items-start gap-1.5 ml-1"><span class="opacity-50 select-none">•</span><span>$1</span></div>')
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/~~(.*?)~~/g, "<del class='opacity-50'>$1</del>")
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded-sm text-[10px] font-mono bg-black/10 dark:bg-white/10">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, title, url) => {
      const isClicked = clickedUrls.value.includes(url)
      const clickedClasses = isClicked ? "line-through opacity-40 text-t-secondary" : "text-accent hover:underline"
      return `<a href="${url}" class="${clickedClasses} cursor-pointer transition-all duration-150" data-url="${url}">${title}</a>`
    })
    .replace(/\n\n/g, '<div class="h-1.5"></div>')
    .replace(/\n/g, "<br/>")
}

function handleLinkClick(e: MouseEvent) {
  const target = (e.target as HTMLElement).closest("a")
  if (target) {
    e.preventDefault()
    const url = target.getAttribute("href")
    if (url) {
      if (!clickedUrls.value.includes(url)) {
        clickedUrls.value.push(url)
        chrome.storage.local.set({ chatClickedUrls: clickedUrls.value })
      }
      target.classList.add("line-through", "opacity-40")
      target.classList.remove("text-accent")

      const targetWin = props.allWindows.find(w => w.windowId === props.currentWindowId) || props.allWindows[0]
      let foundTab = null
      if (targetWin) {
        for (const group of targetWin.groups) {
          const matchingTab = group.tabs.find(t => t.url === url)
          if (matchingTab) {
            foundTab = matchingTab
            break
          }
        }
      }

      if (foundTab && foundTab.id !== undefined && targetWin.windowId !== undefined) {
        chrome.tabs.update(foundTab.id, { active: true })
        chrome.windows.update(targetWin.windowId, { focused: true })
        if (!window.location.href.includes("search.html") && !window.location.search.includes("view=chat")) {
          window.close()
        }
      } else {
        window.open(url, "_blank")
      }
    }
  }
}

const copySuccessMsg = ref(false)
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copySuccessMsg.value = true
    setTimeout(() => {
      copySuccessMsg.value = false
    }, 1500)
  } catch (e) {
    console.error("Failed to copy", e)
  }
}
</script>

<template>
  <div class="flex flex-col h-full bg-primary text-t-primary" style="background: var(--bg-primary); color: var(--text-primary);">
    <!-- Header -->
    <header class="flex items-center justify-between px-3 py-2 shrink-0 border-b border-border/40 gap-1.5" style="box-shadow: 0 0.5px 0 var(--border);">
      <!-- Left: Back button + Title + Scope Selector -->
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <button 
          @click="emit('back')" 
          class="w-6 h-6 flex items-center justify-center rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors -ml-0.5 cursor-pointer shrink-0"
          title="Go Back"
        >
          <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd" />
          </svg>
        </button>
        <div class="flex items-center gap-1.5 min-w-0">
          <h2 class="text-[13px] font-semibold tracking-tight shrink-0">Window Chat</h2>
          <span v-if="targetWin" class="text-[9.5px] px-1.5 py-0.5 rounded-sm opacity-75 font-mono truncate" style="background: var(--hover); border: 1px solid var(--border);">
            {{ targetWin.windowId === props.allWindows[0]?.windowId ? 'Current Win' : 'Win #' + targetWin.windowId }} · {{ targetTabCount }} tabs
          </span>
          <span v-if="activeModel" class="text-[9px] px-1.5 py-0.5 rounded-sm font-mono truncate hidden sm:inline" :style="isLoading ? 'background: rgba(0,122,255,0.15); color: var(--accent); border: 1px solid var(--accent);' : 'background: var(--hover); border: 1px solid var(--border); color: var(--text-secondary);'">
            {{ activeModel }}
          </span>
        </div>

        <!-- Scope selector badge / dropdown -->
        <select 
          v-model="selectedScope" 
          class="text-[10.5px] font-medium px-1.5 py-0.5 rounded-sm border bg-transparent cursor-pointer focus:outline-none max-w-[125px] truncate"
          style="border-color: var(--border); color: var(--text-primary);"
          title="Switch target window scope"
        >
          <option value="all" class="bg-primary text-t-primary" style="background: var(--bg-primary); color: var(--text-primary);">
            All Windows ({{ props.allWindows.reduce((acc, w) => acc + w.groups.reduce((gAcc, g) => gAcc + g.tabs.length, 0), 0) }} tabs)
          </option>
          <option v-for="w in props.allWindows" :key="w.windowId" :value="w.windowId" class="bg-primary text-t-primary" style="background: var(--bg-primary); color: var(--text-primary);">
            {{ w.windowId === props.allWindows[0]?.windowId ? 'Current Win' : 'Win #' + w.windowId }} ({{ w.groups.reduce((a, g) => a + g.tabs.length, 0) }})
          </option>
        </select>
      </div>

      <!-- Right: Effort + Clear + Pinned Tab actions -->
      <div class="flex items-center gap-1 shrink-0">
        <!-- Reasoning Effort Selector -->
        <div class="flex items-center gap-1 text-[11px]" title="Reasoning effort for this chat session">
          <span class="text-[10px] opacity-60">Effort:</span>
          <select 
            v-model="reasoningEffort" 
            class="text-[10.5px] px-1.5 py-0.5 rounded-sm border bg-transparent cursor-pointer focus:outline-none"
            style="border-color: var(--border); color: var(--text-primary);"
          >
            <option v-for="opt in REASONING_OPTIONS" :key="opt.value" :value="opt.value" class="bg-primary text-t-primary" style="background: var(--bg-primary); color: var(--text-primary);">
              {{ opt.label }}
            </option>
          </select>
        </div>

        <!-- Clear Chat History -->
        <button 
          v-if="messages.length > 0"
          @click="clearChat"
          class="w-6 h-6 flex items-center justify-center rounded-sm hover:bg-red-500/10 hover:text-red-500 transition-colors cursor-pointer"
          title="Clear Chat History"
          style="color: var(--text-secondary);"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
          </svg>
        </button>

        <!-- Open in Pinned Tab -->
        <button 
          @click="openInPinnedTab"
          class="w-6 h-6 flex items-center justify-center rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          title="Open in new Pinned Tab"
          style="color: var(--text-secondary);"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </button>
      </div>
    </header>

    <div class="flex flex-col p-3 gap-2.5 flex-1 overflow-hidden">
      <!-- Saved Prompts Row -->
      <div v-if="savedPrompts.length > 0" class="flex flex-wrap gap-1.5 overflow-y-auto max-h-14 scrollbar-thin shrink-0">
        <div v-for="prompt in savedPrompts" :key="prompt" class="group flex items-center gap-1 rounded-sm px-2 py-0.5 text-[9.5px] font-medium border" style="background: var(--bg-elevated); border-color: var(--border);">
          <button @click="useSavedPrompt(prompt)" class="truncate max-w-[130px] cursor-pointer hover:text-[var(--accent)] transition-colors" style="color: var(--text-secondary);" :title="prompt">{{ prompt }}</button>
          <button @click="removePrompt(prompt)" class="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 cursor-pointer hover:text-[var(--group-red)]" style="color: var(--text-tertiary);" title="Remove">
            <svg class="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
          </button>
        </div>
      </div>

      <!-- Messages Log -->
      <div ref="chatContainer" class="flex-1 overflow-y-auto scrollbar-thin rounded-sm border p-3 flex flex-col gap-3 text-[12px]" style="border-color: var(--border); background: var(--bg-elevated);">
        <div v-if="messages.length === 0 && !isLoading && !errorMsg" class="opacity-50 italic text-center my-auto">
          Ask a question about your tabs (e.g. "Which tabs contain urgent things?")
        </div>

        <!-- Render Conversation Messages -->
        <template v-for="msg in messages" :key="msg.id">
          <!-- User message -->
          <div v-if="msg.role === 'user'" class="flex justify-end">
            <div class="max-w-[85%] rounded-sm px-3 py-1.5 text-[11.5px] leading-relaxed shadow-xs text-white" style="background: var(--accent);">
              {{ msg.content }}
            </div>
          </div>

          <!-- Assistant message -->
          <div v-else class="flex flex-col gap-1.5 max-w-[95%]">
            <div class="rounded-sm p-2.5 border leading-relaxed bg-black/5 dark:bg-white/5" style="border-color: var(--border);" v-html="formatMarkdown(msg.content)" @click="handleLinkClick"></div>
            
            <!-- Inspector button for Request & Reasoning -->
            <div v-if="msg.reasoning || msg.fullRequest" class="flex items-center gap-2 text-[10px]">
              <button 
                @click="msg.showDetails = !msg.showDetails"
                class="flex items-center gap-1 font-medium hover:underline cursor-pointer opacity-70 hover:opacity-100 transition-opacity"
                style="color: var(--accent);"
              >
                <svg class="w-3 h-3 transition-transform" :class="{ 'rotate-90': msg.showDetails }" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
                </svg>
                <span>{{ msg.showDetails ? 'Hide Request & Reasoning' : 'Inspect Request & Reasoning' }}</span>
              </button>
            </div>

            <!-- Inspector Details Panel -->
            <div v-if="msg.showDetails" class="flex flex-col gap-2 p-2.5 rounded-sm border text-[10.5px] bg-black/5 dark:bg-white/5" style="border-color: var(--border);">
              <!-- Reasoning Trace -->
              <div v-if="msg.reasoning" class="flex flex-col gap-1">
                <span class="font-semibold opacity-80 flex items-center gap-1" style="color: var(--group-yellow);">
                  <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" style="color: var(--group-yellow);"><path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14H8v-1h4v1zM6 8a4 4 0 118 0c0 1.098-.5 2.1-1.3 2.7-.4.3-.7.8-.7 1.3H8c0-.5-.3-1-.7-1.3C6.5 10.1 6 9.1 6 8z" /></svg>
                  Model Reasoning Trace:
                </span>
                <div class="p-2 rounded-sm bg-black/10 dark:bg-white/10 font-mono text-[9.5px] whitespace-pre-wrap max-h-32 overflow-y-auto scrollbar-thin opacity-85 leading-tight">
                  {{ msg.reasoning }}
                </div>
              </div>

              <!-- Full Prompt Sent -->
              <div v-if="msg.fullRequest" class="flex flex-col gap-1">
                <div class="flex items-center justify-between">
                  <span class="font-semibold opacity-80">Full Request Prompt:</span>
                  <button 
                    @click="copyToClipboard(msg.fullRequest)"
                    class="text-[9px] px-1.5 py-0.5 rounded-sm border hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
                    style="border-color: var(--border);"
                  >
                    Copy Prompt
                  </button>
                </div>
                <div class="p-2 rounded-sm bg-black/10 dark:bg-white/10 font-mono text-[9.5px] whitespace-pre-wrap max-h-36 overflow-y-auto scrollbar-thin opacity-85 leading-tight">
                  {{ msg.fullRequest }}
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- Live Loading / Streaming Assistant View -->
        <div v-if="isLoading" class="flex flex-col gap-2 max-w-[95%]">
          <!-- Active Status Bar -->
          <div class="flex items-center justify-between text-[11px] px-2.5 py-1.5 rounded-sm font-medium border" style="background: var(--hover); color: var(--accent); border-color: var(--border);">
            <div class="flex items-center gap-2 min-w-0">
              <span class="animate-spin w-3 h-3 border-2 border-current border-t-transparent rounded-full shrink-0" />
              <span class="truncate">{{ liveContent ? `Streaming from ${activeModel || 'AI'}...` : `Analyzing ${targetTabCount} tabs with ${activeModel || 'AI'}...` }}</span>
            </div>
            <span class="font-mono text-[10px] tabular-nums shrink-0 ml-2 opacity-80">{{ (elapsedMs / 1000).toFixed(1) }}s</span>
          </div>

          <!-- Streaming Live Reasoning Trace if available -->
          <div v-if="liveReasoning" class="p-2.5 rounded-sm border border-dashed text-[10px] flex flex-col gap-1.5" style="border-color: var(--border); background: var(--bg-elevated);">
            <div class="font-semibold flex items-center gap-1.5" style="color: var(--group-yellow);">
              <svg class="w-3.5 h-3.5 animate-pulse" viewBox="0 0 20 20" fill="currentColor"><path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14H8v-1h4v1zM6 8a4 4 0 118 0c0 1.098-.5 2.1-1.3 2.7-.4.3-.7.8-.7 1.3H8c0-.5-.3-1-.7-1.3C6.5 10.1 6 9.1 6 8z" /></svg>
              <span>Thinking & Reasoning:</span>
            </div>
            <div class="font-mono text-[9.5px] opacity-85 whitespace-pre-wrap max-h-32 overflow-y-auto scrollbar-thin leading-tight">
              {{ liveReasoning }}
            </div>
          </div>

          <!-- Live Streaming Text Content (rendered markdown + typing cursor) -->
          <div v-if="liveContent" class="rounded-sm p-2.5 border leading-relaxed bg-black/5 dark:bg-white/5" style="border-color: var(--border);">
            <span v-html="formatMarkdown(liveContent)" @click="handleLinkClick"></span>
            <span class="inline-block w-1.5 h-3.5 ml-0.5 align-middle animate-pulse" style="background: var(--accent);"></span>
          </div>

          <!-- Waiting for initial tokens animation -->
          <div v-else-if="!liveReasoning" class="p-3 rounded-sm border bg-black/5 dark:bg-white/5 flex items-center gap-2.5" style="border-color: var(--border);">
            <div class="flex items-center gap-1.5 shrink-0">
              <span class="w-2 h-2 rounded-full animate-bounce" style="background: var(--accent); animation-delay: 0ms;"></span>
              <span class="w-2 h-2 rounded-full animate-bounce" style="background: var(--accent); animation-delay: 150ms;"></span>
              <span class="w-2 h-2 rounded-full animate-bounce" style="background: var(--accent); animation-delay: 300ms;"></span>
            </div>
            <span class="text-[11px] opacity-70">Waiting for model response...</span>
          </div>
        </div>

        <div v-if="errorMsg" class="p-2.5 rounded-sm border text-[11px] flex items-start gap-2" style="background: rgba(255, 59, 48, 0.08); border-color: rgba(255, 59, 48, 0.2); color: var(--group-red);">
          <svg class="w-4 h-4 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
          </svg>
          <div class="flex-1 min-w-0">
            <div class="font-semibold mb-0.5">AI Request Failed</div>
            <div class="text-[10.5px] opacity-90 break-words">{{ errorMsg }}</div>
          </div>
        </div>
      </div>

      <!-- Input and Controls -->
      <div class="flex flex-col gap-1.5 shrink-0">
        <!-- Scope & Model info row -->
        <div class="flex items-center justify-between text-[10px] px-1 opacity-70">
          <div class="flex items-center gap-1.5 min-w-0 truncate">
            <span v-if="activeModel" class="font-mono text-[9px] px-1 py-0.2 rounded-sm border bg-black/5 dark:bg-white/5" style="border-color: var(--border);">
              {{ activeModel }}
            </span>
            <span class="truncate">Scope: {{ totalScopeTabs }} tabs</span>
          </div>
          <span class="shrink-0">Est. Input: ~{{ estimatedTokens }} tokens</span>
        </div>

        <textarea 
          v-model="userPrompt" 
          @keydown.enter.exact.prevent="askQuestion"
          :placeholder="isLoading ? 'AI is generating response...' : 'Ask a question about your tabs...'"
          :disabled="isLoading"
          class="w-full text-[12px] p-2 rounded-sm border focus:outline-none focus:ring-1 resize-none h-16 scrollbar-thin disabled:opacity-60"
          style="border-color: var(--border); background: var(--bg-primary); color: var(--text-primary); --tw-ring-color: var(--accent);"
        />
        <div class="flex items-center gap-2">
          <button 
            @click="savePrompt"
            :disabled="isLoading || !userPrompt.trim() || savedPrompts.includes(userPrompt.trim())"
            class="px-3 py-1.5 rounded-sm text-[11px] font-medium transition-opacity disabled:opacity-50 cursor-pointer border"
            style="background: var(--bg-elevated); color: var(--text-primary); border-color: var(--border);"
            title="Save this prompt for future use"
          >
            Save Prompt
          </button>
          
          <button 
            v-if="isLoading"
            @click="stopGenerating"
            class="flex-1 py-1.5 rounded-sm text-[12px] font-medium cursor-pointer flex items-center justify-center gap-1.5 transition-colors border"
            style="color: var(--group-red); background: rgba(255, 59, 48, 0.12); border-color: rgba(255, 59, 48, 0.25);"
            title="Stop generating response"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <rect x="5" y="5" width="10" height="10" rx="1.5" />
            </svg>
            <span>Stop Generating ({{ (elapsedMs / 1000).toFixed(1) }}s)</span>
          </button>
          <button 
            v-else
            @click="askQuestion"
            :disabled="!userPrompt.trim()"
            class="flex-1 py-1.5 rounded-sm text-[12px] font-medium transition-opacity disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5 text-white"
            style="background: var(--accent);"
          >
            <span>Send</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
