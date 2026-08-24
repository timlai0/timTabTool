# 8. Action Badge Lifecycle, Multi-Window Synchronization, and Orphaned State Recovery

Date: 2026-08-23

## Status

Accepted

## Context

Under Manifest V3, background service workers are suspended when idle and restarted on demand. When an AI operation (such as `groupAllTabs`, `classifyNewTabs`, `splitGroup`, or `mergeGroup`) updates the browser action badge to `"AI"` and is subsequently interrupted, aborted, or terminated across browser/worker restarts, Chrome persists the `"AI"` badge text in local browser state indefinitely.

Additionally:
- Tab events in one window previously wiped active `"AI"` badges for other concurrently running AI operations in different windows.
- In `splitGroup` and `mergeGroup`, cleanup checks in `finally` blocks incorrectly matched `type === 'group'`, leaving stale in-memory active operation states.
- When closing a window running an AI operation, debounce timeouts were cleared before executing, leaving `"AI"` badges permanently un-cleared.

## Decision

1. **Active AI Operation Tracking & State Resolution**:
   - Introduced `activeAIOperationWindows: Set<number>` to track all windows currently executing an AI task.
   - Introduced `isAnyAIOperationRunning(): boolean` to query active AI execution across all windows and abort controllers.
   - Reconciled orphaned states at extension startup, service worker launch, `chrome.runtime.onStartup`, and `chrome.runtime.onInstalled` by evaluating in-memory process state and resetting stale `"AI"` badges.

2. **Guaranteed Badge Cleanup in All Lifecycle Paths**:
   - Updated `getGroupsPreview`, `groupAllTabs`, `classifyNewTabs`, `splitGroup`, and `mergeGroup` `finally` blocks to explicitly unregister `windowId` and trigger immediate badge synchronization via `updateNewTabsBadge(windowId)`.
   - Fixed operation type matching in `splitGroup` (`'split'`) and `mergeGroup` (`'merge'`).
   - Integrated immediate cleanup and badge refresh into `cancelActiveOperation(windowId)` and `clearWindowCache(windowId)`.
   - Replaced hardcoded empty badge resets in `ungroupAllTabs` with `updateNewTabsBadge(windowId)`.

3. **Multi-Window Synchronization & Focus Event Routing**:
   - In `updateNewTabsBadge(windowId?)`:
     - If `isAnyAIOperationRunning()` is true, enforces the `"AI"` badge text with `#8B5CF6` background.
     - When no AI operations are running, safely computes duplicate counts for the active/focused window with error boundaries and sets the duplicate badge (or clears it if 0).
   - Added listeners for `chrome.windows.onFocusChanged` and `chrome.tabs.onActivated` to update the badge to reflect the currently focused window's duplicate state.

## Consequences

- The extension action badge accurately reflects real-time AI execution and duplicate tab state.
- Orphaned or interrupted states after service worker sleep, crash, window closure, or browser restarts are immediately resolved without getting stuck.
- Zero performance overhead due to efficient in-memory set tracking and debounced window switching listeners.
