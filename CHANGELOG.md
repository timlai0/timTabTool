# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Export Known Unclosed Tabs**: Export currently open tabs and unrestored history tabs that were not explicitly closed (e.g. to recover lost tabs after a browser crash or sync failure). Supports scoping to open tabs only, unrestored tabs only, or both, formatted as Markdown (.md), JSON (.json), plain text URL list (.txt), or Netscape Bookmark HTML (.html) with copy-to-clipboard and file download options in Settings.

### Security
- **MCP Bridge Authentication (breaking for MCP servers)**: The bridge now requires the server to send `{"type":"auth","token":"<token>"}` as its first message; the token is shown in Settings → MCP and stored separately from settings. Unauthenticated or wrong-token connections are closed with code `4401`. `execute_script` is disabled unless "Allow script execution" is turned on, `create_tab` only accepts http(s) URLs, and tab IDs are validated.
- **Gemini API Key Leak into Logs**: Gemini requests and model listing now send the key via the `x-goog-api-key` header instead of the `?key=` query string. AI logs redact keys and bearer tokens, and keys already stored in old logs are scrubbed on load.
- **Message Sender Checks**: Settings writes, MCP token/status, AI logs, closed-tab management and tab export are now restricted to extension pages. Content scripts receive settings with API keys redacted, change the model through the narrow `SET_AI_MODEL` action, and cannot open `javascript:`/`data:`/`file:`/`blob:` URLs via `OPEN_URL`.
- **Dependencies**: Applied non-breaking `npm audit fix` updates (including vite and undici).

### Fixed
- **Gemini API Deprecated Generation Parameters**: Removed deprecated custom sampling parameters (`temperature`, `top_p`, `top_k`) from Gemini requests and migrated reasoning effort configuration from token-based `thinking_budget` to `thinking_level` (`minimal`, `low`, `medium`, `high`), preventing HTTP 400 `INVALID_ARGUMENT` errors.
- **Concurrent Multi-Window State Collisions in Popup**: Replaced scalar numeric locks (`groupingWindowId`, `classifyingWindowId`, `checkingLast20WindowId`) in `App.vue` with a reactive multi-window status map (`allActiveOperations`) and window-level helpers (`isWindowGrouping`, `isWindowClassifying`, `isWindowRegrouping`, `isWindowOperating`), preventing UI button resets, lost cancellation targets, and premature polling stops when executing operations in parallel.
- **Search Overlay Modal Trapping During In-Flight AI Tasks**: Fixed `hide()` in `search-overlay.ts` to allow users to close or minimize the overlay during active operations without resetting progress state, terminating execution, or keeping users trapped on screen.
- **Cross-Window Broadcast Collisions**: Fixed service worker progress, completion, and failure broadcasts to include `{ windowId, commandAction }` and added strict window filtering in content scripts, preventing operations in one window from erasing or overwriting progress UI in other windows.
- **Content Script Window ID Resolution**: Resolved caller window ID from `sender?.tab?.windowId` in `resolveWindowId`, ensuring operations initiated from search overlays target the caller's window instead of defaulting to the last focused normal window.
- **Tab Group Verification Ungrouped Tabs & Schema Parsing**: Resolved an issue where "Check & Regroup Last 20 Tabs" left ungrouped tabs untouched due to conservative prompt interpretation; added explicit prompt rules for ungrouped tabs, object unwrap parsing (`decisions`, `tabs`, `results`, `items`), and property aliases (`targetGroup`, `category`, `color`, `newName`).
- **Tab Group Verification Operation Logging**: Fixed missing and orphaned logs during tab regroup verification by scoping loggers outside try blocks, capturing error stack traces via `logger.markFailed`, and logging zero-tab runs with `finishEmptyRegroup`.
- **Search Overlay Progress Text Deduplication**: Eliminated duplicate and redundant status strings between the search overlay header and subtitle.
- **Content Script Progress Broadcast Delivery**: Routed background `AI_OPERATION_PROGRESS` broadcasts directly to the active tab content script via `activeOperationTabIds` and `chrome.tabs.sendMessage`, allowing live reasoning deltas to stream into web page overlays.
- **SPA Routing False-Positive Collisions**: Introduced `isSpaHashRoute` guard to strictly preserve client-side hash routes (`#/dashboard` vs `#/settings`) during URL normalization, preventing accidental clustering and closure of distinct web application views.
- **Metric Inflation & Double-Counting in Duplicate Clusters**: Resolved an issue where exact duplicate copies inside mixed clusters were counted towards both exact and possible duplicate counts, standardizing cluster accounting.
- **Action Badge Lifecycle & Stuck "AI" Icon**: Resolved an issue where the extension badge remained permanently stuck on `"AI"` after service worker suspension, browser restart, unhandled abort, or window closure.
- **Orphaned Badge & Background State Reconciliation**: Added startup and wake-up validation across `chrome.runtime.onStartup`, `chrome.runtime.onInstalled`, and service worker initialization to reconcile in-memory tasks and reset stale `"AI"` badges.
- **Multi-Window Badge Synchronization**: Added active AI task set tracking (`activeAIOperationWindows`) and window focus/activation listeners (`chrome.windows.onFocusChanged`, `chrome.tabs.onActivated`) to ensure background tasks in other windows do not prematurely wipe or desynchronize duplicate tab badge indicators.
- **Operation Type Cleanup in `splitGroup` and `mergeGroup`**: Fixed incorrect operation type comparison checks in `finally` cleanup blocks that previously prevented active operation state clearing.
- **Gemini Reasoning Separation & Fallback**: Corrected candidate part segregation in `chatGemini` to ensure thought parts are not inadvertently treated as completion text when text parts are absent.

### Added
- **AI-Powered Browser Window Naming**: Added automated semantic naming of browser windows via configured AI models based on open tab titles and domains. Supported both single-window generation (`generateWindowName`) and global all-window contrasting generation (`generateAllWindowsNames`), with persistence in `chrome.storage.local.customWindowNames` and dual-channel runtime broadcasting.
- **Window Naming UI & Command Integrations**: Integrated inline AI name buttons into window headers, global "AI Name All Windows" button in the popup header, window popover actions, extension context menu action, `/name-window` and `/name-all-windows` slash commands in the search overlay, and a customizable "Window Naming Prompt" card in Settings.
- **Window Chat Launchers & Full-View Mode**: Added context menu actions (`open-chat-window`, `open-chat-tab`) and responsive full-view styling to open AI tab chat in a dedicated popup window or pinned tab.
- **AI-Driven Duplicate Group Renaming**: Added `RENAME_DUPLICATE_GROUPS` background handler and `AIClient.generateDistinctGroupNames` to intelligently differentiate and disambiguate identically named tab groups across windows.
- **Background & Shared Utilities Architecture Modularization**: Decomposed monolithic `tab-manager.ts` and `utils.ts` into isolated leaf modules (`url-utils.ts`, `duplicate-detector.ts`, `ai-providers.ts`, `message-router.ts`, `ipc-broadcast.ts`, `tab-window-actions.ts`, `ai-tab-operations.ts`) maintaining strict bundler DAG invariants.
- **Tabbed Prompt Card Layout & Auto-Resize in Settings**: Segmented prompt configurations into focused tab cards (Grouping, Coherence, Split, Add Tabs, Merge, Custom, All) within popup viewport budgeting constraints.
- **Middle-Click Tab Close**: Enabled middle-click (`auxclick` button 1) tab closing across popup tab items and search overlay results.
- **Concurrent Multi-Window Header Tray in Popup**: Added a click-toggle slide-down tray to the header AI badge displaying all concurrent window operations in real time with progress percentages, elapsed/ETA times, and direct cancel buttons per window.
- **Per-Window In-Card Real-Time Progress Indicators**: Added real-time operation status lines and animated mini progress bars inside individual window cards in `App.vue`.
- **Search Overlay Cross-Window Concurrent Tasks Indicator**: Added `.atm-concurrent-ops-badge` to the search overlay displaying the count of background AI tasks currently running in other windows.
- **Multi-Window Concurrency Unit Test Suite**: Added comprehensive unit test coverage in `tests/background.test.ts` and `tests/search-overlay.test.ts` verifying concurrent multi-window state tracking, independent cancellation, and window-filtered runtime message handling.
- **Search Overlay Live Reasoning Stream**: Built dedicated live thinking container with character counter, real-time thought delta streaming, auto-scroll, and light/dark theme styling in the search overlay.
- **Explicit Tool & Model Header in Overlay**: Displayed actual tool and model in the search overlay header (e.g. `AI Group Tabs (Gemini 2.5 Flash)`).
- **Command Palette Regroup Shortcuts**: Added `/verify` and `/regroup` commands with `-full` URL flags to the search overlay command palette.
- **Case-Insensitive Group Name Resolution**: Added case-insensitive matching in `findGroupIdByName` for tab regrouping.
- **Comprehensive Possible Duplication Detection**: Multi-stage URL canonicalization supporting modern tracking parameter stripping (`srsltid`, `rdt_cid`, `igsh`, `mibextid`), protocol normalization (`http:` to `https:`), `www.` host canonicalization, default index document normalization (`/index.html`, `/index.php`, `/default.aspx`), and section anchor matching.
- **Intelligent Keeper Tab Scoring (`calculateKeeperTabScore`)**: Priority ranking that automatically evaluates candidate tabs in a cluster based on active focus (+10,000), pinned state (+5,000), audio playback (+3,000), group membership (+1,000), and clean canonical URL form (+200), ensuring user-focused tabs are safely retained.
- **Visual Variant Differences & Badges**: Precalculated diff badges (`+N params`, `#anchor`, `http`, `www`, default doc) and match reason summaries in the popup duplicates popover, with dedicated indicators for exact duplicate copies in mixed clusters.
- **High-Throughput Batch Performance Benchmark**: Added dedicated 5,000-tab benchmark achieving sub-100ms execution times.
- **Google Gemini Live Reasoning Streaming**: Integrated `:streamGenerateContent?alt=sse` into `chatGemini` with Server-Sent Events decoding, live thought/reasoning token delta extraction (`part.thought`), and throttled real-time progress updates matching the OpenRouter experience across the active ops popover, search overlay toast, and chat views.
- **Google Gemini Schema Recovery & Model Presets**: Added automated HTTP 400 Bad Request recovery to strip `thinkingConfig` when targeting models without reasoning support, alongside 1-click popular presets for Gemini models in Settings (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.5-flash`).

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

