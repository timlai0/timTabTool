# ADR 0012: Search Overlay Live Reasoning Streaming, Progress Deduplication, and Tab Regroup Verification Logging

## Status
Accepted

## Context
1. **Missing Live Reasoning in Search Overlay**:
   While live reasoning streams were available in the extension popup popover, the search overlay (`search-overlay.ts`) did not render the live thought stream container or character count, leaving users without insight into model deliberation during commands initiated from the overlay.
2. **Redundant Progress Detail Strings**:
   The progress toast in the search overlay displayed duplicated status strings (e.g., header `"Executing AI Command..."` and subtitle `"Executing AI Command... • Est. time: ~13s remaining"`).
3. **Content Script Progress Broadcast Disconnect**:
   Content scripts running in web pages listen via `chrome.runtime.onMessage.addListener`, which does not receive `chrome.runtime.sendMessage` calls dispatched from the background service worker. Consequently, background progress updates were not delivered to the active content script overlay unless routed directly via `chrome.tabs.sendMessage(tabId, ...)`.
4. **Tab Group Verification Failures & Missing Logs**:
   The "Check & Regroup Last 20 Tabs" command (`CHECK_LAST_20_TABS`) frequently left ungrouped tabs ungrouped because the review prompt instructed the model to return `"KEEP"` if current group was appropriate, and ungrouped tabs were marked `[Current group: None (ungrouped)]`. Furthermore, models returning wrapped objects (e.g. `{"decisions": [...]}`) or property aliases (`targetGroup`, `category`, `color`) fell back to all-KEEP. Finally, errors thrown during execution left logs unrecorded or orphaned without failure explanations.

## Decision
1. **Search Overlay Live Reasoning Stream**:
   - Added `.atm-progress-thinking`, `.atm-progress-thinking-header`, `.atm-progress-thinking-dot`, `.atm-progress-thinking-chars`, and `.atm-progress-thinking-body` to `search-overlay.css` with dark mode support.
   - Implemented `renderThinkingStreamUI()` in `search-overlay.ts` to stream thoughts with live character counts and automatic scroll-to-bottom.
2. **Progress Text Deduplication & Tool Identification**:
   - Implemented `renderProgressDetailText(etaString)` which omits status text matching generic placeholders (`"Executing AI Command..."`, `"Processing..."`) or matching the active header title.
   - Displays exact command and model in progress status (e.g. `AI Group Tabs (Gemini 2.5 Flash)`).
   - Added `/verify` and `/regroup` commands with full URL flags (`-full`) to command palette.
3. **Tab-Targeted Progress Routing**:
   - Maintained `activeOperationTabIds` in `tab-manager.ts` via `registerOperationTab` and `unregisterOperationTab`.
   - Updated `broadcastOperationProgress` to dispatch `AI_OPERATION_PROGRESS` via `chrome.tabs.sendMessage` to registered tab or active tab.
   - Updated `src/background/index.ts` to automatically register `sender.tab.id` in `handleMessage` and broadcast targets in `broadcastAIStart`.
4. **Robust Tab Regroup Verification & Prompting**:
   - Updated `buildReviewAndRegroupPrompt` to explicitly instruct models not to return `"KEEP"` for ungrouped tabs unless they must remain ungrouped.
   - Enhanced `parseReviewAndRegroupResponse` to unwrap object containers (`decisions`, `tabs`, `results`, `items`, `groups`, `data`).
   - Supported property aliases (`targetGroup`, `category`, `name`, `newName`, `color`) in `resolveParsedDecision`.
   - Added case-insensitive group lookup (`findGroupIdByName`) in `categorizeTabDecision`.
5. **Guaranteed Operation Logging**:
   - Scoped logger outside try blocks in `checkAndRegroupLast20Tabs` to guarantee `logger.markFailed(err)` execution on failure.
   - Passed logger to `finishEmptyRegroup` to record and persist empty runs to both `AILogger` and `LAST_AI_RESULT`.

## Consequences
- **Positive**: Real-time thinking and deliberation visibility in search overlay with deduplicated progress text.
- **Positive**: Reliable tab regroup verification that groups ungrouped tabs and tolerates various LLM response schemas.
- **Positive**: Complete diagnostic audit trail in AI logs for regroup operations regardless of success, abort, or failure state.
