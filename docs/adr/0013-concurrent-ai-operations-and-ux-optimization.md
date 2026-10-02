# ADR 0013: Concurrent Multi-Window AI Operations and Search Overlay UX Optimization

## Status
Accepted

## Context
1. **Scalar State Collisions in Popup Interface**:
   The popup interface (`App.vue`) tracked active AI operations via single scalar numeric refs (`groupingWindowId`, `classifyingWindowId`, `checkingLast20WindowId`). When an AI operation was initiated in a second window while a previous window operation was in flight, the active window ID reference was overwritten. This reset button states in the first window, severed cancellation routing, and caused the first window's completion event to clear the scalar ref to null—terminating the status polling loop prematurely for all active windows.
2. **Missing Window Context in Broadcast Messages**:
   Background service worker broadcasts (`START_AI_PROGRESS`, `AI_OPERATION_PROGRESS`, `AI_OPERATION_COMPLETE`, `AI_OPERATION_FAILED`) did not consistently identify target window IDs or filter on the client side. Content script overlays in unrelated windows received progress resets, success dismissals, or error alerts intended for a different window.
3. **Search Overlay Trapping During Operations**:
   The search overlay (`search-overlay.ts`) intercepted `hide()` invocations while `isAIOperating` was true by switching into progress-only mode and returning early without closing the overlay. This prevented users from dismissing or minimizing the overlay to continue browsing while long-running operations executed.
4. **Imprecise Window Resolution for Content Scripts**:
   The background `resolveWindowId()` helper inspected only the request payload before falling back to `chrome.windows.getLastFocused()`. For content script messages dispatched from background tabs or non-focused windows without an explicit `windowId`, operations targeted the wrong window.

## Decision
1. **Multi-Window Reactive State in Popup (`App.vue`)**:
   - Replaced scalar single-window locks with a reactive window dictionary (`allActiveOperations`) and helper methods conforming to the Rule of 30: `isWindowGrouping(windowId)`, `isWindowClassifying(windowId)`, `isWindowRegrouping(windowId)`, `isWindowOperating(windowId)`, and `isAnyAIOperating`.
   - Updated polling lifecycle to remain active as long as `isAnyAIOperating.value` is true.
   - Added a clickable header badge with a slide-down active operations tray displaying all concurrent operations, progress percentages, elapsed/ETA times, and independent cancellation triggers.
   - Added in-card mini progress bars and real-time status labels inside each window card when an operation is running in that specific window.
2. **Window-Aware Message Routing and Service Worker Tracking (`background/index.ts`, `tab-manager.ts`)**:
   - Enhanced `resolveWindowId()` to extract and prioritize `sender?.tab?.windowId` before falling back to `chrome.windows.getLastFocused()`.
   - Updated `broadcastAIStart()`, `broadcastAIComplete()`, and `broadcastAIFailed()` to inject `{ windowId, commandAction }` into broadcast payloads and preserve `LAST_AI_RESULT` entries of other active windows.
   - Synchronized `activeAIOperationWindows` and `activeOperationsMap` inside `tab-manager.ts` so `isAnyAIOperationRunning()` and `cancelActiveOperation()` isolate operations strictly by `windowId`.
3. **Non-Blocking Dismissal & Window Filtering in Search Overlay (`search-overlay.ts`, `search-overlay.css`)**:
   - Refactored `hide()` to permit user dismissal or minimization during active AI operations without clearing active progress or aborting background tasks.
   - Enhanced `loadMetrics()` on open to restore active operation progress for all AI command actions (`group`, `classify`, `regroup`, `split`, `merge`, `sort`).
   - Added `currentOverlayWindowId` detection, background operation counter, and `.atm-concurrent-ops-badge` displaying real-time background operation counts from other windows.
   - Partitioned message handlers into discrete functions (`handleStartAIProgressMessage`, `handleAIOperationProgressMessage`, `handleAIOperationCompleteMessage`, `handleAIOperationFailedMessage`) with strict `windowId` filtering.

## Consequences
- **Positive**: Full concurrency support for simultaneous AI operations across multiple windows without state collisions or prematurely terminated polling loops.
- **Positive**: Non-blocking search overlay allows users to minimize progress UI and resume normal browsing while background AI operations complete.
- **Positive**: Complete cross-window visibility via popup tray and overlay background operation badges.
