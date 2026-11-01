<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue"
import { AIClient } from "../../shared/ai-client"
import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../../shared/constants"
import { formatMarkdown as baseFormatMarkdown, isSafeLinkUrl, escapeAttribute } from "../../shared/utils"
import { buildChatPrompt, estimateChatTokens, exportChatMarkdown, splitForSummary, buildSummaryPrompt, cleanSummary, CHAT_SUGGESTIONS } from "../../shared/chat-helpers"
import {
  loadThreads, loadThread, saveThread, createThread, setActiveThread, renameThread, deleteThread, applyThreadSummary,
  type ChatThreadMeta
} from "../../shared/chat-threads"
import {
  CHAT_TOOL_MODES, DEFAULT_CHAT_TOOL_MODE, buildToolsPrompt, parseActionBlocks, stripActionsBlock, validateToolCalls,
  needsConfirmation, actionMemoryNote, canUndo,
  type ChatToolMode, type ChatActionRecord, type ScopeTab
} from "../../shared/chat-tools"
import type { WindowGroupsInfo, ExtensionSettings, ReasoningEffort } from "../../shared/types"

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  reasoning?: string
  fullRequest?: string
  actions?: ChatActionRecord[]
  timestamp: number
  showDetails?: boolean
}

const props = defineProps<{
  allWindows: WindowGroupsInfo[]
  currentWindowId: number | null
}>()

const emit = defineEmits<{
  (e: "back"): void
  (e: "tabs-changed"): void
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

const threads = ref<ChatThreadMeta[]>([])
const activeThreadId = ref("")
const summary = ref("")
const summarizedCount = ref(0)
const isSummarizing = ref(false)
const renaming = ref(false)
const renameDraft = ref("")
const renameInput = ref<HTMLInputElement | null>(null)
const confirmingDelete = ref(false)
let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null
let summaryAbortController: AbortController | null = null

const activeThread = computed(() => threads.value.find(t => t.id === activeThreadId.value))

const toolMode = ref<ChatToolMode>(DEFAULT_CHAT_TOOL_MODE)
const actionsRunning = ref(0)
const isBusy = computed(() => isLoading.value || actionsRunning.value > 0)
const toolModeHint = computed(() => CHAT_TOOL_MODES.find(m => m.value === toolMode.value)?.hint ?? "")

const rootEl = ref<HTMLElement | null>(null)
const rootWidth = ref(0)
/** With enough room, threads move from the dropdown bar into a left sidebar. */
const SIDEBAR_MIN_WIDTH = 720
const showSidebar = computed(() => rootWidth.value >= SIDEBAR_MIN_WIDTH)
let resizeObserver: ResizeObserver | null = null

const scopeWindows = computed(() => {
  if (selectedScope.value === "all") return props.allWindows
  return [props.allWindows.find(w => w.windowId === selectedScope.value) || props.allWindows[0]].filter(Boolean)
})

const totalScopeTabs = computed(() => {
  if (selectedScope.value === "all") {
    return props.allWindows.reduce((acc, w) => acc + w.groups.reduce((gAcc, g) => gAcc + g.tabs.length, 0), 0)
  }
  const target = props.allWindows.find(w => w.windowId === selectedScope.value)
  return target ? target.groups.reduce((acc, g) => acc + g.tabs.length, 0) : targetTabCount.value
})

const estimatedTokens = computed(() => {
  return estimateChatTokens(totalScopeTabs.value, {
    turns: messages.value,
    summary: summary.value,
    summarizedCount: summarizedCount.value
  })
})

const lastAssistantId = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === "assistant") return messages.value[i].id
  }
  return ""
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
    "chatCurrentPrompt",
    "chatReasoningEffort",
    "chatToolMode",
    STORAGE_KEYS.SETTINGS
  ])
  if (CHAT_TOOL_MODES.some(m => m.value === data.chatToolMode)) {
    toolMode.value = data.chatToolMode as ChatToolMode
  }

  if (Array.isArray(data.savedChatPrompts)) {
    savedPrompts.value = data.savedChatPrompts as string[]
  }
  const loaded = await loadThreads()
  threads.value = loaded.threads
  await openThread(loaded.activeId)
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

onMounted(() => {
  if (rootEl.value && typeof ResizeObserver !== "undefined") {
    rootWidth.value = rootEl.value.clientWidth
    resizeObserver = new ResizeObserver(entries => {
      rootWidth.value = entries[0]?.contentRect.width ?? rootEl.value?.clientWidth ?? 0
    })
    resizeObserver.observe(rootEl.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  stopTimer()
  if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer)
  if (summaryAbortController) summaryAbortController.abort()
  if (currentAbortController) {
    currentAbortController.abort()
  }
})

watch(userPrompt, (val) => {
  chrome.storage.local.set({ chatCurrentPrompt: val })
})

watch(toolMode, (val) => {
  chrome.storage.local.set({ chatToolMode: val })
})

watch(reasoningEffort, (val) => {
  chrome.storage.local.set({ chatReasoningEffort: val })
})

/** Load a thread's messages and memory into the view. */
async function openThread(id: string) {
  const data = await loadThread(id)
  activeThreadId.value = id
  messages.value = data.messages
  clickedUrls.value = data.clickedUrls
  summary.value = data.summary
  summarizedCount.value = data.summarizedCount
  errorMsg.value = ""
  liveReasoning.value = ""
  liveContent.value = ""
  renaming.value = false
  confirmingDelete.value = false
  await setActiveThread(id)
  scrollToBottom()
}

async function saveMessages() {
  if (!activeThreadId.value) return
  const result = await saveThread(activeThreadId.value, {
    messages: messages.value.map(({ showDetails: _ui, ...m }) => m), // UI toggle state is not persisted
    clickedUrls: clickedUrls.value,
    summary: summary.value,
    summarizedCount: summarizedCount.value
  })
  threads.value = result.threads
  if (result.dropped > 0) {
    // The oldest messages were trimmed from storage; mirror that so indices keep matching the summary.
    messages.value = messages.value.slice(result.dropped)
    summarizedCount.value = Math.max(0, summarizedCount.value - result.dropped)
    if (summarizedCount.value === 0) summary.value = ""
  }
}

async function switchThread(id: string) {
  if (isBusy.value || id === activeThreadId.value) return
  await openThread(id)
}

async function newChat() {
  if (isBusy.value) return
  // Reuse the current thread when it is still empty instead of piling up blank ones.
  if (messages.value.length === 0) return
  const created = await createThread()
  threads.value = created.threads
  await openThread(created.id)
}

function startRename() {
  renameDraft.value = activeThread.value?.title ?? ""
  renaming.value = true
  nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

async function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  threads.value = await renameThread(activeThreadId.value, renameDraft.value)
}

/** Two-step delete: the first click arms the button, the second (within 3s) removes the thread. */
async function removeThread() {
  if (isBusy.value) return
  if (messages.value.length > 0 && !confirmingDelete.value) {
    confirmingDelete.value = true
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer)
    confirmDeleteTimer = setTimeout(() => { confirmingDelete.value = false }, 3000)
    return
  }
  if (summaryAbortController) summaryAbortController.abort()
  const result = await deleteThread(activeThreadId.value)
  threads.value = result.threads
  await openThread(result.activeId)
}

/**
 * Fold the oldest unsummarized turns into the thread's rolling summary. Runs after a reply, in the
 * background; on failure the older turns simply fall out of memory until the next attempt.
 */
async function maybeSummarize() {
  if (isSummarizing.value) return
  const turns = messages.value.map(memoryTurn)
  const split = splitForSummary(turns, summarizedCount.value)
  if (!split) return

  const threadId = activeThreadId.value
  const settingsData = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const settings = (settingsData[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings>) || { ...DEFAULT_SETTINGS }
  const baseAiConfig = settings.ai || DEFAULT_SETTINGS.ai
  if (!baseAiConfig.enabled || (!baseAiConfig.apiKey && baseAiConfig.provider !== "custom")) return

  isSummarizing.value = true
  summaryAbortController = new AbortController()
  try {
    const client = new AIClient({ ...baseAiConfig, reasoningEffort: "minimal" }, summaryAbortController.signal)
    const raw = await client.chat(buildSummaryPrompt(summary.value, split.toSummarize))
    const next = cleanSummary(raw)
    if (!next) return

    if (threadId === activeThreadId.value) {
      // Ignore the result if the user deleted messages meanwhile and the numbering no longer lines up.
      if (messages.value.length < split.newCount || summarizedCount.value > split.newCount) return
      summary.value = next
      summarizedCount.value = split.newCount
      await saveMessages()
    } else {
      await applyThreadSummary(threadId, next, split.newCount)
    }
  } catch {
    // Summaries are best-effort.
  } finally {
    isSummarizing.value = false
    summaryAbortController = null
  }
}

/** A message as the model should remember it: its text plus what happened to any actions it proposed. */
function memoryTurn(m: ChatMessage) {
  const note = actionMemoryNote(m.actions)
  return { role: m.role, content: note ? `${m.content}\n${note}` : m.content }
}

function formatThreadLabel(t: ChatThreadMeta) {
  return t.messageCount > 0 ? `${t.title} (${Math.ceil(t.messageCount / 2)})` : t.title
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
      content: stripActionsBlock(liveContent.value) + "\n\n*(Generation stopped)*",
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

function askQuestion() {
  return sendQuestion(userPrompt.value, true)
}

async function sendQuestion(text: string, fromInput = false) {
  const promptText = text.trim()
  if (!promptText || isLoading.value) return

  // Add user message to history
  const history = messages.value.map(memoryTurn)
  const userMsgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4)
  messages.value.push({
    id: userMsgId,
    role: "user",
    content: promptText,
    timestamp: Date.now()
  })
  if (fromInput) userPrompt.value = ""
  await saveMessages()
  await runCompletion(promptText, history)
}

/** Drop the last assistant reply and ask the same question again. */
async function regenerate() {
  if (isLoading.value) return
  const lastIdx = messages.value.length - 1
  if (lastIdx < 0 || messages.value[lastIdx].role !== "assistant") return
  const userIdx = lastIdx - 1
  if (userIdx < 0 || messages.value[userIdx].role !== "user") return

  const question = messages.value[userIdx].content
  const history = messages.value.slice(0, userIdx).map(memoryTurn)
  messages.value.splice(lastIdx, 1)
  await saveMessages()
  await runCompletion(question, history)
}

/** Retry after an error: the failed question is already the last (user) message. */
async function retryLast() {
  if (isLoading.value) return
  const lastIdx = messages.value.length - 1
  if (lastIdx < 0 || messages.value[lastIdx].role !== "user") return
  const history = messages.value.slice(0, lastIdx).map(memoryTurn)
  await runCompletion(messages.value[lastIdx].content, history)
}

async function deleteMessage(id: string) {
  if (isLoading.value) return
  const idx = messages.value.findIndex(m => m.id === id)
  if (idx < 0) return
  // Removing a message the summary already covers makes the summary stale, so forget it.
  if (idx < summarizedCount.value) {
    if (summaryAbortController) summaryAbortController.abort()
    summary.value = ""
    summarizedCount.value = 0
  }
  messages.value.splice(idx, 1)
  await saveMessages()
}

function exportChat() {
  if (messages.value.length === 0) return
  const md = exportChatMarkdown(messages.value, { title: activeThread.value?.title, model: activeModel.value })
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `window-chat-${new Date().toISOString().slice(0, 10)}.md`
  a.click()
  URL.revokeObjectURL(url)
}

async function runCompletion(promptText: string, history: { role: "user" | "assistant"; content: string }[]) {
  isLoading.value = true
  errorMsg.value = ""
  liveReasoning.value = ""
  liveContent.value = ""
  startTimer()

  currentAbortController = new AbortController()
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
    
    const targetWindows = scopeWindows.value
    const toolsOn = toolMode.value !== "off"
    const scopeTabs = new Map<number, ScopeTab>()

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
          if (tab.id !== undefined) {
            scopeTabs.set(tab.id, { id: tab.id, title: tab.title, url: tab.url, pinned: Boolean(tab.pinned) })
          }
          const idStr = toolsOn && tab.id !== undefined ? `[id: ${tab.id}] ` : ""
          tabsContext += `- ${idStr}"${tab.title}" [URL: ${tab.url}]${activeStr}${timeStr}\n`
        }
      }
    }

    const fullPrompt = buildChatPrompt(
      tabsContext,
      { turns: history, summary: summary.value, summarizedCount: summarizedCount.value },
      promptText,
      buildToolsPrompt(toolMode.value)
    )

    let capturedReasoning = ""
    let capturedContent = ""
    const result = await client.chat(
      fullPrompt,
      false,
      1,
      undefined,
      (progress) => {
        const thought = progress.liveReasoning || progress.reasoningSnippet
        if (thought) {
          capturedReasoning = thought
          liveReasoning.value = thought
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
    const parsed = parseActionBlocks(result || capturedContent || liveContent.value)
    const proposed = toolsOn
      ? validateToolCalls(parsed.raw, scopeTabs, () => 'act-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
      : []
    let replyText = parsed.text
    if (toolsOn && parsed.parseError) replyText += `\n\n*(${parsed.parseError})*`
    messages.value.push({
      id: assistantMsgId,
      role: "assistant",
      content: replyText,
      reasoning: capturedReasoning || liveReasoning.value || undefined,
      fullRequest: fullPrompt,
      actions: proposed.length > 0 ? proposed : undefined,
      timestamp: Date.now()
    })
    await saveMessages()
    scrollToBottom()

    // Actions the mode allows run right away; the rest wait for the user's click.
    for (const action of proposed) {
      if (!needsConfirmation(toolMode.value, action)) await runAction(action, true)
    }
    void maybeSummarize()

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

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

async function runAction(action: ChatActionRecord, auto = false) {
  if (action.status !== "proposed") return
  action.status = "running"
  actionsRunning.value++
  try {
    const res = await chrome.runtime.sendMessage({ action: "CHAT_TOOL_EXEC", payload: { call: toPlain(action.call) } })
    if (res?.ok) {
      action.status = "done"
      action.snapshots = res.snapshots
      action.executedAt = Date.now()
      action.auto = auto
      action.error = undefined
      const skipped = (action.skipped || 0) + (res.skipped || 0)
      action.skipped = skipped || undefined
    } else {
      action.status = "failed"
      action.error = res?.error || "Action failed"
    }
  } catch (err: any) {
    action.status = "failed"
    action.error = err?.message || "Action failed"
  } finally {
    actionsRunning.value--
  }
  await saveMessages()
  emit("tabs-changed")
}

async function undoAction(action: ChatActionRecord) {
  if (!canUndo(action)) return
  actionsRunning.value++
  try {
    const res = await chrome.runtime.sendMessage({
      action: "CHAT_TOOL_UNDO",
      payload: { tool: action.call.tool, snapshots: toPlain(action.snapshots) }
    })
    if (res?.ok) {
      action.status = "undone"
      action.error = res.failed > 0 ? `${res.failed} tab(s) could not be restored` : undefined
    } else {
      action.error = res?.error || "Undo failed"
    }
  } catch (err: any) {
    action.error = err?.message || "Undo failed"
  } finally {
    actionsRunning.value--
  }
  await saveMessages()
  emit("tabs-changed")
}

function declineAction(action: ChatActionRecord) {
  if (action.status !== "proposed") return
  action.status = "declined"
  saveMessages()
}

async function approveAll(msg: ChatMessage) {
  for (const action of msg.actions ?? []) await runAction(action, false)
}

function declineAll(msg: ChatMessage) {
  for (const action of msg.actions ?? []) declineAction(action)
}

async function undoAll(msg: ChatMessage) {
  for (const action of [...(msg.actions ?? [])].reverse()) await undoAction(action)
}

/** The newest reply's actions, when any of them can still be undone: drives the undo bar by the input. */
const undoBarMessage = computed(() => {
  const last = messages.value[messages.value.length - 1]
  return last && last.role === "assistant" && last.actions?.some(canUndo) ? last : null
})

const undoBarLabel = computed(() => {
  const done = undoBarMessage.value?.actions?.filter(canUndo) ?? []
  if (done.length === 0) return ""
  return done.length === 1 ? done[0].summary : `${done.length} actions done`
})

function actionStatusLabel(a: ChatActionRecord) {
  switch (a.status) {
    case "proposed": return a.destructive ? "Needs approval" : "Waiting"
    case "running": return "Running…"
    case "done": return a.auto ? "Done (auto)" : "Done"
    case "undone": return "Undone"
    case "declined": return "Dismissed"
    case "failed": return "Failed"
  }
}

function formatMarkdown(text: string) {
  if (!text) return ""
  let html = baseFormatMarkdown(text)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, title, url) => {
    // AI output is untrusted: only http(s) links become anchors, and quotes can't break out of the attribute
    const decodedUrl = String(url).trim().replace(/&amp;/g, "&")
    if (!isSafeLinkUrl(decodedUrl)) return match
    const safeUrl = escapeAttribute(decodedUrl)
    const isClicked = clickedUrls.value.includes(decodedUrl)
    const clickedClasses = isClicked ? "line-through opacity-40 text-t-secondary" : "text-accent hover:underline"
    return `<a href="${safeUrl}" class="${clickedClasses} cursor-pointer transition-all duration-150" data-url="${safeUrl}">${title}</a>`
  })
  return html
}

function handleLinkClick(e: MouseEvent) {
  const target = (e.target as HTMLElement).closest("a")
  if (target) {
    e.preventDefault()
    const url = target.getAttribute("href")
    if (url && isSafeLinkUrl(url)) {
      if (!clickedUrls.value.includes(url)) {
        clickedUrls.value.push(url)
        saveMessages()
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
  <div ref="rootEl" class="flex flex-col h-full bg-primary text-t-primary" style="background: var(--bg-primary); color: var(--text-primary);">
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

        <!-- Export Chat as Markdown -->
        <button
          v-if="messages.length > 0"
          @click="exportChat"
          class="w-6 h-6 flex items-center justify-center rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          title="Export chat as Markdown"
          style="color: var(--text-secondary);"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
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

    <div class="flex flex-1 min-h-0 overflow-hidden">
    <!-- Thread sidebar (wide layouts) -->
    <aside v-if="showSidebar" class="w-52 shrink-0 flex flex-col border-r" style="border-color: var(--border); background: var(--bg-elevated);">
      <div class="p-2 shrink-0">
        <button
          @click="newChat"
          :disabled="isBusy || messages.length === 0"
          class="w-full py-1.5 rounded-sm text-[11px] font-medium border cursor-pointer transition-opacity disabled:opacity-40"
          style="border-color: var(--border); background: var(--bg-primary); color: var(--accent);"
          title="Start a new chat thread"
        >+ New chat</button>
      </div>
      <div class="flex-1 overflow-y-auto scrollbar-thin px-1.5 pb-2 flex flex-col gap-0.5">
        <div
          v-for="t in threads"
          :key="t.id"
          @click="switchThread(t.id)"
          class="group flex items-center gap-1 rounded-sm px-2 py-1.5 text-[11px] transition-colors"
          :class="[t.id === activeThreadId ? '' : 'hover:bg-black/5 dark:hover:bg-white/5', isBusy && t.id !== activeThreadId ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer']"
          :style="t.id === activeThreadId ? 'background: var(--hover); border: 1px solid var(--border);' : 'border: 1px solid transparent;'"
          :title="t.title"
        >
          <input
            v-if="renaming && t.id === activeThreadId"
            ref="renameInput"
            v-model="renameDraft"
            @click.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="renaming = false"
            @blur="commitRename"
            maxlength="80"
            placeholder="Chat name (empty = automatic)"
            class="flex-1 min-w-0 text-[11px] px-1 py-0.5 rounded-sm border bg-transparent focus:outline-none"
            style="border-color: var(--accent); color: var(--text-primary);"
          />
          <template v-else>
            <span class="flex-1 min-w-0 truncate" :class="t.id === activeThreadId ? 'font-medium' : ''">{{ t.title }}</span>
            <span v-if="t.messageCount > 0 && t.id !== activeThreadId" class="text-[9px] opacity-50 shrink-0">{{ Math.ceil(t.messageCount / 2) }}</span>
            <template v-if="t.id === activeThreadId">
              <button @click.stop="startRename" :disabled="isBusy" class="opacity-50 hover:opacity-100 cursor-pointer disabled:opacity-30 shrink-0" title="Rename this chat">
                <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" /></svg>
              </button>
              <button
                @click.stop="removeThread"
                :disabled="isBusy"
                class="shrink-0 cursor-pointer disabled:opacity-30"
                :class="confirmingDelete ? 'text-[10px] font-medium px-1 rounded-sm' : 'opacity-50 hover:opacity-100 hover:text-red-500'"
                :style="confirmingDelete ? 'color: var(--group-red); background: rgba(255, 59, 48, 0.12);' : ''"
                :title="confirmingDelete ? 'Click again to delete this chat' : 'Delete this chat'"
              >
                <template v-if="confirmingDelete">Delete?</template>
                <svg v-else class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>
              </button>
            </template>
          </template>
        </div>
      </div>
    </aside>

    <div class="flex flex-col flex-1 min-w-0 min-h-0">
    <!-- Thread bar -->
    <div v-if="!showSidebar" class="flex items-center gap-1.5 px-3 py-1.5 shrink-0 border-b border-border/40">
      <input
        v-if="renaming"
        ref="renameInput"
        v-model="renameDraft"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="renaming = false"
        @blur="commitRename"
        maxlength="80"
        placeholder="Chat name (empty = automatic)"
        class="flex-1 min-w-0 text-[11px] px-1.5 py-0.5 rounded-sm border bg-transparent focus:outline-none"
        style="border-color: var(--accent); color: var(--text-primary);"
      />
      <select
        v-else
        :value="activeThreadId"
        @change="switchThread(($event.target as HTMLSelectElement).value)"
        :disabled="isBusy"
        class="flex-1 min-w-0 text-[11px] px-1.5 py-0.5 rounded-sm border bg-transparent cursor-pointer focus:outline-none truncate disabled:opacity-60"
        style="border-color: var(--border); color: var(--text-primary);"
        title="Switch chat thread"
      >
        <option v-for="t in threads" :key="t.id" :value="t.id" class="bg-primary text-t-primary" style="background: var(--bg-primary); color: var(--text-primary);">
          {{ formatThreadLabel(t) }}
        </option>
      </select>

      <button
        @click="newChat"
        :disabled="isBusy || messages.length === 0"
        class="px-1.5 h-6 flex items-center justify-center rounded-sm text-[11px] font-medium hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
        title="Start a new chat thread"
        style="color: var(--accent);"
      >+ New</button>
      <button
        @click="startRename"
        :disabled="isBusy || renaming"
        class="w-6 h-6 flex items-center justify-center rounded-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
        title="Rename this chat"
        style="color: var(--text-secondary);"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" /></svg>
      </button>
      <button
        @click="removeThread"
        :disabled="isBusy"
        class="h-6 flex items-center justify-center rounded-sm transition-colors cursor-pointer disabled:opacity-40 shrink-0 text-[10.5px]"
        :class="confirmingDelete ? 'px-1.5 font-medium' : 'w-6 hover:bg-red-500/10 hover:text-red-500'"
        :style="confirmingDelete ? 'color: var(--group-red); background: rgba(255, 59, 48, 0.12);' : 'color: var(--text-secondary);'"
        :title="confirmingDelete ? 'Click again to delete this chat' : 'Delete this chat'"
      >
        <template v-if="confirmingDelete">Delete?</template>
        <svg v-else class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
        </svg>
      </button>
    </div>

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
        <div v-if="messages.length === 0 && !isLoading && !errorMsg" class="flex flex-col items-center gap-2 my-auto">
          <span class="opacity-50 italic text-center">Ask a question about your tabs</span>
          <div class="flex flex-wrap justify-center gap-1.5">
            <button
              v-for="s in CHAT_SUGGESTIONS"
              :key="s"
              @click="sendQuestion(s)"
              class="px-2 py-1 rounded-sm text-[10.5px] border cursor-pointer hover:text-[var(--accent)] transition-colors"
              style="border-color: var(--border); background: var(--bg-primary); color: var(--text-secondary);"
            >{{ s }}</button>
          </div>
        </div>

        <!-- Render Conversation Messages -->
        <template v-for="msg in messages" :key="msg.id">
          <!-- User message -->
          <div v-if="msg.role === 'user'" class="flex justify-end">
            <div class="max-w-[85%] rounded-sm px-3 py-1.5 text-[11.5px] leading-relaxed shadow-xs text-white" style="background: var(--accent);">
              {{ msg.content }}
            </div>
            <button
              v-if="!isLoading"
              @click="deleteMessage(msg.id)"
              class="self-end ml-1 opacity-30 hover:opacity-100 hover:text-red-500 transition-opacity cursor-pointer"
              title="Delete message"
            >
              <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
            </button>
          </div>

          <!-- Assistant message -->
          <div v-else class="flex flex-col gap-1.5 max-w-[95%]">
            <div v-if="msg.content" class="rounded-sm p-2.5 border leading-relaxed bg-black/5 dark:bg-white/5" style="border-color: var(--border);" v-html="formatMarkdown(msg.content)" @click="handleLinkClick"></div>

            <!-- Tab actions proposed or run by the assistant -->
            <div v-if="msg.actions?.length" class="flex flex-col gap-1">
              <div
                v-for="a in msg.actions"
                :key="a.id"
                class="flex items-start gap-2 rounded-sm border px-2 py-1.5 text-[10.5px]"
                :style="a.destructive && a.status === 'proposed' ? 'border-color: rgba(255, 59, 48, 0.35); background: rgba(255, 59, 48, 0.06);' : 'border-color: var(--border); background: var(--bg-primary);'"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span class="font-semibold uppercase tracking-wide text-[9px]" :style="a.status === 'failed' ? 'color: var(--group-red);' : a.status === 'done' ? 'color: var(--group-green, #34c759);' : 'color: var(--text-secondary);'">{{ actionStatusLabel(a) }}</span>
                    <span v-if="a.destructive" class="text-[9px] px-1 rounded-sm" style="color: var(--group-red); border: 1px solid rgba(255, 59, 48, 0.3);">closes tabs</span>
                  </div>
                  <div class="break-words" :class="a.status === 'undone' || a.status === 'declined' ? 'line-through opacity-50' : ''">{{ a.summary }}</div>
                  <div v-if="a.call.reason" class="opacity-60 break-words">{{ a.call.reason }}</div>
                  <div v-if="a.skipped" class="opacity-60">{{ a.skipped }} tab(s) skipped (pinned or no longer open)</div>
                  <div v-if="a.error" class="break-words" style="color: var(--group-red);">{{ a.error }}</div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <template v-if="a.status === 'proposed'">
                    <button @click="runAction(a)" :disabled="actionsRunning > 0" class="px-2 py-0.5 rounded-sm text-white cursor-pointer disabled:opacity-50" :style="a.destructive ? 'background: var(--group-red);' : 'background: var(--accent);'">{{ a.destructive ? 'Close tabs' : 'Approve' }}</button>
                    <button @click="declineAction(a)" class="px-1.5 py-0.5 rounded-sm border cursor-pointer" style="border-color: var(--border);">Dismiss</button>
                  </template>
                  <button v-else-if="canUndo(a)" @click="undoAction(a)" :disabled="actionsRunning > 0" class="px-2 py-0.5 rounded-sm border cursor-pointer font-medium disabled:opacity-50" style="border-color: var(--accent); color: var(--accent);">Undo</button>
                </div>
              </div>
              <div v-if="msg.actions.filter(a => a.status === 'proposed').length > 1" class="flex items-center gap-2 text-[10px]">
                <button @click="approveAll(msg)" :disabled="actionsRunning > 0" class="font-medium cursor-pointer hover:underline disabled:opacity-50" style="color: var(--accent);">Approve all</button>
                <button @click="declineAll(msg)" class="opacity-70 cursor-pointer hover:underline">Dismiss all</button>
              </div>
            </div>
            
            <!-- Message actions -->
            <div v-if="!isLoading" class="flex items-center gap-2 text-[10px] opacity-60">
              <button @click="copyToClipboard(msg.content)" class="hover:underline hover:opacity-100 cursor-pointer" title="Copy reply">Copy</button>
              <button v-if="msg.id === lastAssistantId && !msg.actions?.some(a => a.status === 'done' || a.status === 'running')" @click="regenerate" class="hover:underline cursor-pointer" title="Ask again and replace this reply">Regenerate</button>
              <button @click="deleteMessage(msg.id)" class="hover:underline hover:text-red-500 cursor-pointer" title="Delete reply">Delete</button>
            </div>

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
                <div class="p-2 rounded-sm bg-black/10 dark:bg-white/10 text-[9.5px] max-h-36 overflow-y-auto scrollbar-thin opacity-85 leading-relaxed" v-html="formatMarkdown(msg.reasoning)" />
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
            <div class="text-[9.5px] opacity-85 max-h-36 overflow-y-auto scrollbar-thin leading-relaxed" v-html="formatMarkdown(liveReasoning)" />
          </div>

          <!-- Live Streaming Text Content (rendered markdown + typing cursor) -->
          <div v-if="liveContent" class="rounded-sm p-2.5 border leading-relaxed bg-black/5 dark:bg-white/5" style="border-color: var(--border);">
            <span v-html="formatMarkdown(stripActionsBlock(liveContent))" @click="handleLinkClick"></span>
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
            <button
              v-if="messages.length > 0 && messages[messages.length - 1].role === 'user'"
              @click="retryLast"
              class="mt-1 text-[10.5px] font-medium underline cursor-pointer"
            >Retry</button>
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
            <label class="flex items-center gap-1 shrink-0" :title="toolModeHint">
              <span>Actions:</span>
              <select
                v-model="toolMode"
                class="text-[10px] px-1 py-0 rounded-sm border bg-transparent cursor-pointer focus:outline-none"
                :style="toolMode === 'auto' ? 'border-color: var(--group-orange, #ff9500); color: var(--group-orange, #ff9500);' : 'border-color: var(--border); color: var(--text-primary);'"
              >
                <option v-for="m in CHAT_TOOL_MODES" :key="m.value" :value="m.value" class="bg-primary text-t-primary" style="background: var(--bg-primary); color: var(--text-primary);">{{ m.label }}</option>
              </select>
            </label>
            <span v-if="isSummarizing" class="truncate opacity-80" style="color: var(--accent);">· summarizing earlier messages…</span>
            <span v-else-if="summary" class="truncate" title="Older messages are condensed into a summary that is sent with each request">· memory: summary + recent</span>
          </div>
          <span class="shrink-0">Est. Input: ~{{ estimatedTokens }} tokens</span>
        </div>

        <!-- Undo bar for the newest reply's actions -->
        <div v-if="undoBarMessage" class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-sm border text-[11px]" style="border-color: var(--border); background: var(--hover);">
          <span class="truncate min-w-0" :title="undoBarLabel"><span style="color: var(--group-green, #34c759);">✓</span> {{ undoBarLabel }}</span>
          <button @click="undoAll(undoBarMessage)" :disabled="actionsRunning > 0" class="shrink-0 px-2.5 py-0.5 rounded-sm border font-medium cursor-pointer disabled:opacity-50" style="border-color: var(--accent); color: var(--accent);">Undo</button>
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
    </div>
  </div>
</template>
