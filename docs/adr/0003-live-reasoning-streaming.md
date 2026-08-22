# ADR 0003: Live Server-Sent Event (SSE) Reasoning Streaming in Extension UI

## Status
Accepted

## Context
When running complex reasoning and chain-of-thought models (e.g. stealth/ox-alpha, deepseek-r1, o1-mini), operations can take 10 to 60+ seconds. Previously, users only saw an indeterminate progress percentage and elapsed time while the model performed deep chain-of-thought reasoning, without feedback on what the model was currently evaluating.

## Decision
1. **SSE Protocol in AI Client**:
   - chatOpenAI sends stream: true when progress listeners are attached.
   - Consumes Server-Sent Events from esponse.body reader.
   - Extracts streaming reasoning deltas (delta.reasoning, delta.reasoning_content, delta.thought).
   - Automatically falls back to standard JSON parsing if the response is non-SSE or running in headless test environments.
2. **Throttled Broadcast Pipeline**:
   - Throttles progress emissions at ~120ms intervals to prevent IPC/message bus flooding over chrome.runtime.sendMessage.
   - Propagates liveReasoning and easoningSnippet through AI_OPERATION_PROGRESS and ACTIVE_OPERATIONS_UPDATED.
3. **UI Integration**:
   - **Popup Header Active Ops Popover**: An expandable <details> section rendering real-time streaming chain-of-thought terminal text with an active pulsing indicator.
   - **Search Overlay Progress Toast**: Shows real-time thinking status snippet (• Thinking: "...") alongside ETA and discovered group chips.

## Consequences
- **Positive**: Complete real-time transparency into model decisions and grouping logic.
- **Positive**: Zero latency overhead; users immediately see the model analyzing tabs.
- **Negative**: Minor IPC message volume during active reasoning, mitigated by 120ms throttling.
