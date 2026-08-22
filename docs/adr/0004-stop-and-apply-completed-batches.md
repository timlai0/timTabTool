# ADR 0004: Stop and Apply Completed Batches in Multi-Batch Operations

## Status
Accepted

## Context
When processing large browser windows (e.g. hundreds of tabs across multiple batches), users may decide after 1 or more batches have completed that they want to abort further LLM querying without losing the organization and grouping work already performed on the completed batches. Previously, cancelling an operation discarded all accumulated batch results.

## Decision
1. **AI Client Partial Batch Return**:
   - In `AIClient.groupTabsFreely` and `AIClient.classifyNewTabsIntoGroups`, wrapped the batch loop in try/catch blocks.
   - When an `AbortError` occurs and `allResults.length > 0`, the client returns the accumulated groups/assignments from completed batches rather than rethrowing.
2. **Selective Ungrouping & Application**:
   - In `src/background/tab-manager.ts`, added `applyCompletedOnCancelFlags: Map<number, boolean>` and updated `cancelActiveOperation(windowId, applyCompleted)`.
   - When `applyCompleted` is set, `groupTabsFreelyWithAI` selectively ungroups only the classified tabs (`chrome.tabs.ungroup(orderedTabIds)`), groups them into Chrome Tab Groups, and preserves unclassified tabs in their original window locations.
3. **UI Integration**:
   - Added `Stop & Apply` / `Apply Done` button in the Search Overlay progress toast and Popup Header active operations popover whenever `batchCurrent > 1` or completed groups exist.
   - Handled `STOP_AND_APPLY_OPERATION` message routing in background worker.

## Consequences
- **Positive**: Eliminates wasted token usage and time on large windows when user halts early.
- **Positive**: Preserves window tab state and order for unorganized tabs while applying completed batches.
- **Negative**: Window may contain a mix of grouped tabs (from completed batches) and ungrouped tabs (from pending batches).
