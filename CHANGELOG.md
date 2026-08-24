# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Action Badge Lifecycle & Stuck "AI" Icon**: Resolved an issue where the extension badge remained permanently stuck on `"AI"` after service worker suspension, browser restart, unhandled abort, or window closure.
- **Orphaned Badge & Background State Reconciliation**: Added startup and wake-up validation across `chrome.runtime.onStartup`, `chrome.runtime.onInstalled`, and service worker initialization to reconcile in-memory tasks and reset stale `"AI"` badges.
- **Multi-Window Badge Synchronization**: Added active AI task set tracking (`activeAIOperationWindows`) and window focus/activation listeners (`chrome.windows.onFocusChanged`, `chrome.tabs.onActivated`) to ensure background tasks in other windows do not prematurely wipe or desynchronize duplicate tab badge indicators.
- **Operation Type Cleanup in `splitGroup` and `mergeGroup`**: Fixed incorrect operation type comparison checks in `finally` cleanup blocks that previously prevented active operation state clearing.

### Added
- OpenRouter advanced routing strategies (`openrouterSort`): support for `price` (lowest price), `throughput` (highest completion speed), and `latency` (lowest time to first token) routing preferences.
- OpenRouter data collection privacy policy (`openrouterDataCollection`): support for `deny` to strictly enforce zero data retention upstream routing.
- OpenRouter automated model fallback chain (`openrouterFallbackModels`) with `models: [...]` array injection for high availability and automated failover.
- OpenRouter parameter enforcement toggle (`openrouterRequireParams`) to strictly ensure upstream provider compatibility with requested structured JSON schemas.
- OpenRouter provider blacklist / exclusions (`openrouterIgnoreProviders`) to filter out undesirable upstream hosts.
- OpenRouter model discovery UX: interactive model search input, category filter pills (`All`, `Free Only`, `Reasoning`, `BYOK Direct`), model count metrics, and 1-click popular presets (`stealth/ox-alpha`, `deepseek/deepseek-r1:free`, `anthropic/claude-3.5-sonnet`, `openai/gpt-4o-mini`, `google/gemini-2.5-flash`).
- OpenRouter direct dashboard links in the BYOK & Key status card to OpenRouter Keys, Integrations, and Activity Logs.
- Active OpenRouter routing strategy and zero data retention privacy badges in the main popup AI popover.
- OpenRouter Bring Your Own Key (BYOK) auto-detection and key metadata retrieval via `fetchOpenRouterKeyInfo`, querying `/api/v1/key` and `/api/v1/byok`.
- OpenRouter BYOK status card in Settings displaying live BYOK status, key label, BYOK usage in USD, OpenRouter credit usage, and detected upstream providers.
- OpenRouter "Assume BYOK Active (Direct Billing)" manual override toggle (`openRouterByokManual`) for newly provisioned keys.
- OpenRouter `[BYOK Direct]` model dropdown annotations and `BYOK Direct Billing Active` status pill in the main popup AI popover.
- OpenRouter as a first-class AI provider option with default endpoint `https://openrouter.ai/api/v1` and default model `openai/gpt-4o-mini`.
- OpenRouter Provider Routing dropdown with support for BYOK keys (e.g. Google Vertex / Google AI Studio BYOK, NVIDIA, Groq, Together, DeepInfra, Fireworks, etc.), custom provider slugs, and a "Fetch Live Providers from OpenRouter" action button.
- OpenRouter "Allow Provider Fallbacks" toggle setting (`openrouterAllowFallbacks`) allowing users to hard-lock requests to their chosen BYOK provider or allow fallback to shared OpenRouter capacity.
- OpenRouter "Only Allow Free Models" toggle setting (`openRouterOnlyFree`) to restrict model selection, live discovery, and API requests to free models (e.g. `stealth/ox-alpha`, `:free` models).
- Predefined model catalog for OpenRouter including free models (`stealth/ox-alpha`, `meta-llama/llama-3.3-70b-instruct:free`, `deepseek/deepseek-r1:free`, `deepseek/deepseek-chat:free`, `google/gemini-2.0-flash-exp:free`, `google/gemini-2.0-flash-thinking-exp:free`, `qwen/qwen-2.5-coder-32b-instruct:free`, `mistralai/mistral-small-24b-instruct-2501:free`).
- Live model discovery function `fetchOpenRouterModels` with `onlyFree` filtering and "Fetch Live Models from OpenRouter" button in Settings.
- Per-provider settings memory: switching providers preserves each provider's API keys, endpoints, models, token limits, and batch sizes in `providerSettings`.
- Reasoning Effort dropdown setting (`auto`, `minimal`, `low`, `medium`, `high`, `max`) to control deliberation depth and reduce latency for thinking / chain-of-thought models across OpenRouter, OpenAI, and Google Gemini (e.g. `gemini-3.7-flash`, `stealth/ox-alpha`, `o3-mini`, `o1`).
- Google Gemini `generationConfig.thinkingConfig.thinkingBudget` token budget injection and thought part extraction for Gemini reasoning models.
- Live Server-Sent Events (SSE) streaming of reasoning/thinking tokens (`delta.reasoning`, `delta.reasoning_content`) with real-time terminal display in the Popup Header popover and live thought ticker in Search Overlay progress toast.
- `AIProgressUpdate` and `OperationStatusInfo` updated with `liveReasoning` and `reasoningSnippet` fields.
- Background worker `getAIOverrides` and `GET_SETTINGS` updated to handle OpenRouter and merge `providerSettings`.
- **Eco Mode** (`ecoMode` setting): In-memory tab history caching and debounced batch write flushes in `storage.ts`, scalable tab event debouncing, and lightweight offline grouping handling to eliminate memory thrashing and storage serialization locks when managing hundreds or thousands of open tabs.
- **Quick Overlay Fast Mode** (`fastOverlayMode` setting): Deferred AI token/metric computations on overlay open, `requestAnimationFrame`-throttled pointer event listeners, and batched `DocumentFragment` DOM rendering.
- On-demand dynamic content script execution in Firefox via `chrome.scripting.executeScript`, omitting static `<all_urls>` injection in `dist-firefox/manifest.json` to prevent multi-gigabyte memory consumption in the Firefox Extensions process.

