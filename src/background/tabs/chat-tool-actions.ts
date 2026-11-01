'use strict';

import { TAB_GROUP_ID_NONE, groupTitleMap, isTabGroupsSupported, retryTabOperation } from './tab-common'
import { markTabIdsClosedByExtension } from './live-tab-tracker'
import { getClosedTabs, isRestorableUrl, recordTabIdsBeforeClose, removeClosedTab } from '../../shared/closed-tabs-manager'
import { sanitizeToolCall, type ChatToolCall, type ChatToolName, type TabSnapshot } from '../../shared/chat-tools'
import { cacheRemoveTab, invalidatePreviewCache } from '../cache/tab-cache'
import type { ChromeTabGroupColor } from '../../shared/types'

const CLOSE_SOURCE = 'Chat'

export interface ChatToolResult {
  ok: boolean
  /** Tabs actually changed. */
  affected: number
  /** Tabs that no longer existed or were protected. */
  skipped: number
  snapshots: TabSnapshot[]
  error?: string
}

export interface ChatToolUndoResult {
  ok: boolean
  restored: number
  failed: number
  error?: string
}

type GroupArg = [number, ...number[]]

async function snapshotTab(tab: chrome.tabs.Tab): Promise<TabSnapshot> {
  const groupId = tab.groupId ?? TAB_GROUP_ID_NONE
  const snapshot: TabSnapshot = {
    id: tab.id!,
    url: tab.url || tab.pendingUrl || '',
    title: (tab.title || tab.url || '').slice(0, 120),
    windowId: tab.windowId,
    index: tab.index,
    pinned: Boolean(tab.pinned),
    groupId: groupId === TAB_GROUP_ID_NONE ? -1 : groupId,
  }
  if (snapshot.groupId !== -1 && isTabGroupsSupported()) {
    try {
      const group = await chrome.tabGroups.get(snapshot.groupId)
      snapshot.groupTitle = group.title
      snapshot.groupColor = group.color
    } catch {
      // Group vanished; the snapshot keeps just the id.
    }
  }
  return snapshot
}

async function getLiveTabs(tabIds: number[]): Promise<chrome.tabs.Tab[]> {
  const tabs: chrome.tabs.Tab[] = []
  for (const id of tabIds) {
    try {
      const tab = await chrome.tabs.get(id)
      if (tab?.id !== undefined) tabs.push(tab)
    } catch {
      // Tab already closed
    }
  }
  return tabs
}

/** Extension pages (including the chat itself) must never be closed or regrouped by the assistant. */
function isOwnPage(tab: chrome.tabs.Tab): boolean {
  const url = tab.url || tab.pendingUrl || ''
  return url.startsWith(chrome.runtime.getURL(''))
}

async function createGroup(tabIds: number[], windowId: number, title: string, color?: string): Promise<number | undefined> {
  const gid = await retryTabOperation(() =>
    chrome.tabs.group({ tabIds: tabIds as GroupArg, createProperties: { windowId } }),
  )
  if (gid === undefined) return undefined
  if (title) groupTitleMap.set(gid, title)
  await retryTabOperation(() =>
    chrome.tabGroups.update(gid, { title, color: (color || 'grey') as ChromeTabGroupColor }),
  )
  return gid
}

/**
 * Run one validated assistant action and report what it changed, with the snapshots needed to undo it.
 * @param {unknown} rawCall
 * @returns {Promise<ChatToolResult>}
 */
export async function executeChatToolCall(rawCall: unknown): Promise<ChatToolResult> {
  const call = sanitizeToolCall(rawCall)
  if (!call) return { ok: false, affected: 0, skipped: 0, snapshots: [], error: 'Invalid action' }

  try {
    const live = await getLiveTabs(call.tabIds)
    let usable = live.filter(t => !isOwnPage(t))
    if (call.tool === 'close_tabs' || call.tool === 'group_tabs' || call.tool === 'pin_tabs') {
      usable = usable.filter(t => !t.pinned)
    }
    const skipped = call.tabIds.length - usable.length
    if (usable.length === 0) return { ok: false, affected: 0, skipped, snapshots: [], error: 'None of those tabs are available any more' }

    const snapshots = await Promise.all(usable.map(snapshotTab))
    const ids = usable.map(t => t.id!)
    const affected = await applyCall(call, usable, ids)
    invalidatePreviewCache()
    return { ok: true, affected, skipped, snapshots }
  } catch (err: any) {
    return { ok: false, affected: 0, skipped: 0, snapshots: [], error: err?.message || String(err) }
  }
}

async function applyCall(call: ChatToolCall, tabs: chrome.tabs.Tab[], ids: number[]): Promise<number> {
  switch (call.tool) {
    case 'focus_tab': {
      const tab = tabs[0]
      await chrome.tabs.update(tab.id!, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      return 1
    }
    case 'group_tabs': {
      if (!isTabGroupsSupported()) throw new Error('Tab groups are not supported in this browser')
      // chrome.tabs.group needs one window; make one group per window rather than moving tabs around.
      const byWindow = new Map<number, number[]>()
      for (const t of tabs) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t.id!])
      for (const [windowId, windowTabIds] of byWindow) {
        await createGroup(windowTabIds, windowId, call.title || 'Group', call.color)
      }
      return ids.length
    }
    case 'ungroup_tabs': {
      if (!isTabGroupsSupported()) throw new Error('Tab groups are not supported in this browser')
      const grouped = tabs.filter(t => t.groupId !== undefined && t.groupId !== TAB_GROUP_ID_NONE).map(t => t.id!)
      if (grouped.length > 0) await retryTabOperation(() => chrome.tabs.ungroup(grouped as GroupArg))
      return grouped.length
    }
    case 'pin_tabs':
    case 'unpin_tabs': {
      const pinned = call.tool === 'pin_tabs'
      const targets = tabs.filter(t => Boolean(t.pinned) !== pinned)
      for (const t of targets) await retryTabOperation(() => chrome.tabs.update(t.id!, { pinned }))
      return targets.length
    }
    case 'close_tabs': {
      markTabIdsClosedByExtension(ids)
      await recordTabIdsBeforeClose(ids, CLOSE_SOURCE)
      await chrome.tabs.remove(ids)
      for (const id of ids) cacheRemoveTab(id)
      return ids.length
    }
  }
}

/**
 * Put tabs back into the groups they were in before an action (or out of groups, if they had none).
 */
async function restoreGroupMembership(snapshots: TabSnapshot[]): Promise<{ restored: number; failed: number }> {
  if (!isTabGroupsSupported()) return { restored: 0, failed: snapshots.length }
  let restored = 0
  let failed = 0

  const live = new Map<number, chrome.tabs.Tab>()
  for (const tab of await getLiveTabs(snapshots.map(s => s.id))) live.set(tab.id!, tab)
  failed += snapshots.filter(s => !live.has(s.id)).length
  const present = snapshots.filter(s => live.has(s.id))

  const ungroup = present.filter(s => s.groupId === -1).map(s => s.id)
  if (ungroup.length > 0) {
    try {
      await retryTabOperation(() => chrome.tabs.ungroup(ungroup as GroupArg))
      restored += ungroup.length
    } catch { failed += ungroup.length }
  }

  const byOldGroup = new Map<number, TabSnapshot[]>()
  for (const s of present) {
    if (s.groupId !== -1) byOldGroup.set(s.groupId, [...(byOldGroup.get(s.groupId) ?? []), s])
  }
  for (const [oldGroupId, members] of byOldGroup) {
    const tabIds = members.map(m => m.id)
    try {
      let target: number | undefined
      try {
        const group = await chrome.tabGroups.get(oldGroupId)
        // Only reuse the old group if it is in the tabs' window; otherwise Chrome would move the tabs.
        if (group.windowId === live.get(members[0].id)!.windowId) target = oldGroupId
      } catch { /* group no longer exists */ }

      if (target !== undefined) {
        await retryTabOperation(() => chrome.tabs.group({ tabIds: tabIds as GroupArg, groupId: target }))
      } else {
        await createGroup(tabIds, live.get(members[0].id)!.windowId, members[0].groupTitle ?? '', members[0].groupColor)
      }
      restored += tabIds.length
    } catch { failed += tabIds.length }
  }
  return { restored, failed }
}

async function reopenClosed(snapshots: TabSnapshot[]): Promise<{ restored: number; failed: number }> {
  let restored = 0
  let failed = 0
  const windows = new Set((await chrome.windows.getAll()).map(w => w.id))
  const recreated: { snapshot: TabSnapshot; tab: chrome.tabs.Tab }[] = []

  for (const s of [...snapshots].sort((a, b) => a.index - b.index)) {
    if (!isRestorableUrl(s.url)) { failed++; continue }
    try {
      const props: chrome.tabs.CreateProperties = { url: s.url, active: false, pinned: s.pinned }
      if (windows.has(s.windowId)) {
        props.windowId = s.windowId
        props.index = s.index
      }
      const tab = await chrome.tabs.create(props)
      recreated.push({ snapshot: s, tab })
      restored++
    } catch { failed++ }
  }

  // Regroup the reopened tabs the way they were.
  if (isTabGroupsSupported()) {
    const byGroup = new Map<number, { snapshot: TabSnapshot; tab: chrome.tabs.Tab }[]>()
    for (const r of recreated) {
      if (r.snapshot.groupId !== -1) byGroup.set(r.snapshot.groupId, [...(byGroup.get(r.snapshot.groupId) ?? []), r])
    }
    for (const [oldGroupId, members] of byGroup) {
      const tabIds = members.map(m => m.tab.id!)
      const windowId = members[0].tab.windowId
      try {
        let target: number | undefined
        try {
          const group = await chrome.tabGroups.get(oldGroupId)
          if (group.windowId === windowId) target = oldGroupId
        } catch { /* group was removed when its last tab closed */ }
        if (target !== undefined) {
          await retryTabOperation(() => chrome.tabs.group({ tabIds: tabIds as GroupArg, groupId: target }))
        } else {
          await createGroup(tabIds, windowId, members[0].snapshot.groupTitle ?? '', members[0].snapshot.groupColor)
        }
      } catch {
        // Tabs are back; losing the group is a cosmetic failure.
      }
    }
  }

  // The tabs are open again, so drop them from the "recently closed" list.
  try {
    const urls = new Set(recreated.map(r => r.snapshot.url))
    for (const entry of await getClosedTabs()) {
      if (entry.source === CLOSE_SOURCE && urls.has(entry.url)) await removeClosedTab(entry.id)
    }
  } catch {
    // Housekeeping only
  }
  return { restored, failed }
}

/**
 * Reverse a previously executed action from its snapshots.
 * @param {unknown} tool
 * @param {unknown} rawSnapshots
 * @returns {Promise<ChatToolUndoResult>}
 */
export async function undoChatToolCall(tool: unknown, rawSnapshots: unknown): Promise<ChatToolUndoResult> {
  const snapshots = sanitizeSnapshots(rawSnapshots)
  if (!snapshots || snapshots.length === 0) return { ok: false, restored: 0, failed: 0, error: 'Nothing to undo' }

  try {
    const name = tool as ChatToolName
    let result: { restored: number; failed: number }
    switch (name) {
      case 'close_tabs':
        result = await reopenClosed(snapshots)
        break
      case 'group_tabs':
      case 'ungroup_tabs':
        result = await restoreGroupMembership(snapshots)
        break
      case 'pin_tabs':
      case 'unpin_tabs': {
        result = { restored: 0, failed: 0 }
        for (const s of snapshots) {
          try {
            await retryTabOperation(() => chrome.tabs.update(s.id, { pinned: s.pinned }))
            result.restored++
          } catch { result.failed++ }
        }
        break
      }
      default:
        return { ok: false, restored: 0, failed: 0, error: 'This action cannot be undone' }
    }
    invalidatePreviewCache()
    return { ok: result.restored > 0, ...result, error: result.restored === 0 ? 'Could not restore any tabs' : undefined }
  } catch (err: any) {
    return { ok: false, restored: 0, failed: snapshots.length, error: err?.message || String(err) }
  }
}

function sanitizeSnapshots(raw: unknown): TabSnapshot[] | null {
  if (!Array.isArray(raw)) return null
  const out: TabSnapshot[] = []
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    if (!Number.isInteger(s.id) || !Number.isInteger(s.windowId) || typeof s.url !== 'string') continue
    out.push({
      id: s.id as number,
      url: s.url,
      title: typeof s.title === 'string' ? s.title : '',
      windowId: s.windowId as number,
      index: Number.isInteger(s.index) ? (s.index as number) : 0,
      pinned: Boolean(s.pinned),
      groupId: Number.isInteger(s.groupId) ? (s.groupId as number) : -1,
      groupTitle: typeof s.groupTitle === 'string' ? s.groupTitle : undefined,
      groupColor: typeof s.groupColor === 'string' ? s.groupColor : undefined,
    })
  }
  return out
}
