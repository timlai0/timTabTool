# ADR 0010: Live Server-Sent Event (SSE) Reasoning Streaming for Google Gemini API

## Status
Accepted

## Context
ADR 0003 introduced real-time Server-Sent Event (SSE) reasoning streaming for OpenRouter and OpenAI-compatible providers, giving users live visibility into deliberation tokens via active operation popovers, search overlay progress toasts, and chat inspector traces.

Previously, the Google Gemini API integration (`chatGemini`) executed purely via blocking non-streaming requests to `:generateContent`. Users operating Gemini thinking models (such as `gemini-2.5-flash`, `gemini-2.5-pro`, and `gemini-3.5-flash`) observed indeterminate wait times without real-time reasoning feedback. Furthermore, thought segments were only parsed after full request completion, and if only thought tokens were returned in an initial payload, fallback logic could inadvertently mistake thoughts for completion output.

## Decision
1. **Gemini SSE Protocol Implementation**:
   - When progress listeners are attached (`onProgress`), `chatGemini` requests `:streamGenerateContent?alt=sse` instead of `:generateContent`.
   - Reads streaming chunks over `ReadableStream<Uint8Array>` with Server-Sent Events decoding.
   - Extracts reasoning deltas from candidate parts where `part.thought` is true or contains reasoning text.
   - Accumulates reasoning deltas and content deltas separately, throttling progress emissions at ~40ms to avoid bus flooding.
   - Emits standardized progress updates containing `liveContent`, `liveReasoning`, and `reasoningSnippet`.
2. **Resilient Non-Streaming Fallback**:
   - If SSE response headers or stream readers are unavailable (such as headless test runners or non-SSE proxies), gracefully falls back to JSON candidate parsing.
   - Correctly segregates `thoughtParts` and `textParts`, ensuring thought parts are not treated as completion text when text parts are absent.
   - Updates `liveReasoning` and `reasoningSnippet` on progress listeners in non-streaming mode.
3. **Automated Schema Recovery**:
   - If a configured `thinkingConfig` payload produces an HTTP 400 Bad Request on models lacking thinking support (e.g. `gemini-1.5-flash`), automatically strips `thinkingConfig` and retries the request seamlessly.
4. **UI Integration & Presets**:
   - Google Gemini thinking traces automatically stream into the existing UI components:
     - Popup Header Active Ops Popover (`Live Model Thinking` terminal view).
     - Search Overlay progress toast (`• Thinking: "..."`).
     - Chat view streaming reasoning trace and inspection history (`Model Reasoning Trace`).
   - Added 1-click model presets for Google Gemini in Settings (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.5-flash`).

## Consequences
- **Positive**: Full parity between OpenRouter and Google Gemini API reasoning streaming in the extension UI.
- **Positive**: Real-time transparency into Gemini model categorization and clustering decisions with zero added latency.
- **Positive**: Graceful fallback when streaming is unavailable or when models reject thinking configuration.
