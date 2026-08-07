# TabPilot Technical Documentation

## Architecture & Core Modules

This document serves as the master index for the architecture, namespaces, and core modules of the TabPilot repository. All files have been processed to include strict JSDoc blocks, narrative inline comments, and abandonment flags where applicable.

### Background Service & Core Logic (`src/background/`)

* **`src/background/classifier.ts`**
  * **Namespace:** `classify`, `classifyTabs`, `FreeGroupResult`, `groupTabsFreelyWithAI`
  * **Dependencies:** `../shared/types`, `../shared/ai-logger`, `../shared/rules`, `../shared/utils`, `../shared/ai-client`
  * **Responsibilities:** Classifying tabs into categories using the rule engine and free-form AI-based grouping logic.
* **`src/background/index.ts`**
  * **Namespace:** Background service worker, `getAIOverrides`
  * **Dependencies:** `./tab-manager`, `./searcher`, `./storage`, `../shared/constants`, `../shared/types`, `./mcp-bridge`, `../shared/ai-logger`
  * **Responsibilities:** Core service worker entrypoint. Manages context menus, keyboard shortcuts, background messaging routing, and lifecycle events for tabs/windows.
* **`src/background/mcp-bridge.ts`**
  * **Namespace:** `getMCPStatus`, `reconnectMCP`, `initMCPBridge`
  * **Dependencies:** `../shared/constants`, `../shared/types`
  * **Responsibilities:** WebSocket connection management and MCP (Model Context Protocol) command handling for manipulating tabs/groups externally.
* **`src/background/searcher.ts`**
  * **Namespace:** `searchTabs`
  * **Dependencies:** `../shared/types`
  * **Responsibilities:** Provides robust tab search logic using keyword matching and scoring across titles, URLs, and group titles.
* **`src/background/storage.ts`**
  * **Namespace:** `recordTabVisit`, `getHistoryEntries`
  * **Dependencies:** `../shared/types`, `../shared/constants`
  * **Responsibilities:** Managing local storage for tab history, capping history sizes, and retrieving ordered history entries.
* **`src/background/tab-manager.ts`**
  * **Namespace:** `setupOperationTimeout`, `updateOperationProgress`, `groupAllTabs`, `classifyNewTabs`, `splitGroup`
  * **Dependencies:** `./classifier`, `../shared/constants`, `../shared/utils`, `../shared/i18n`, `../shared/ai-client`, `../shared/ai-logger`, `../shared/types`
  * **Responsibilities:** Large centralized controller managing Tab Groups, caching, AI grouping delegation, timeouts, sorting logic, and tab manipulation primitives.

### Shared Utilities & Data Types (`src/shared/`)

* **`src/shared/ai-client.ts`**
  * **Namespace:** `AIClient`
  * **Dependencies:** `./types`, `./ai-logger`, `./constants`, `./utils`
  * **Responsibilities:** Provides a unified interface for interacting with LLM providers. Handles token estimations, safeguards against runaway billing, robust retry mechanisms, prompt formatting, and JSON response repair. Exposes business logic for clustering (`groupTabsFreely`), classifying (`classifyTabs`, `classifyNewTabsIntoGroups`), and merging (`decideMergeGroup`) browser tabs.
* **`src/shared/ai-logger.ts`**
  * **Namespace:** `AILogger`
  * **Dependencies:** `./types`, `./constants`
  * **Responsibilities:** Manages structured logging for AI operations with persistence to `chrome.storage.local`. Tracks individual lifecycle steps, raw requests/responses, token estimations, and execution status. Features automatic cleanup of orphaned or crashed tasks across browser restarts.
* **`src/shared/constants.ts`**
  * **Namespace:** Global constants
  * **Dependencies:** `./types`
  * **Responsibilities:** Defines all global, static configurations including group definitions, AI system prompts, LLM pricing data, and default settings.
* **`src/shared/i18n.ts`**
  * **Namespace:** `i18n`
  * **Dependencies:** None
  * **Responsibilities:** Lightweight wrapper around Chrome's i18n API to fetch localized strings, providing a transparent fallback to the key itself if the translation is missing.
* **`src/shared/polyfill.ts`**
  * **Namespace:** Global Polyfills
  * **Dependencies:** None
  * **Responsibilities:** Provides a Firefox compatibility shim by routing Chrome API calls through the Promise-based `browser` object.
* **`src/shared/rules.ts`**
  * **Namespace:** `DOMAIN_RULES`, `KEYWORD_RULES`
  * **Dependencies:** `./types`
  * **Responsibilities:** Defines static fallback classification rules for domains and regex-based keyword matching.
* **`src/shared/types.ts`**
  * **Namespace:** TypeScript Interfaces & Types
  * **Dependencies:** None
  * **Responsibilities:** Central repository for data schemas across the extension.
* **`src/shared/utils.ts`**
  * **Namespace:** Shared Utility Functions
  * **Dependencies:** None
  * **Responsibilities:** Houses pure, stateless helper methods. Includes URL manipulation, data extraction, UI formatting, and duplicate tab detection.
* **`src/shared/version.ts`**
  * **Namespace:** Version Constants
  * **Dependencies:** None
  * **Responsibilities:** Exposes application version strings, build numbers, commit hashes, and build timestamps, injected at compile-time by the bundler.

### UI Components (Popup & Content Scripts)

* **`src/content/search-overlay.ts`**
  * **Namespace:** `ContentScript::SearchOverlay`
  * **Dependencies:** `AIClient`, `utils`, `search-overlay.css`
  * **Responsibilities:** Injects a global search UI across pages, allowing cross-tab searching, running commands, computing grouping costs, and rendering UI chips.
* **`src/popup/components/GroupItem.vue`**
  * **Namespace:** `Popup::Components::GroupItem`
  * **Dependencies:** `TabItem.vue`, `AIClient`, `utils`
  * **Responsibilities:** Renders a single tab group in the popup UI. Allows toggling visibility, AI-based splitting and merging of groups, and tracking active token/cost approximations.
* **`src/popup/components/GroupList.vue`**
  * **Namespace:** `Popup::Components::GroupList`
  * **Dependencies:** `GroupItem.vue`
  * **Responsibilities:** Container for a collection of `GroupItem` components. Handles empty states gracefully and bubbles up events.
* **`src/popup/components/SettingsView.vue`**
  * **Namespace:** `Popup::Components::SettingsView`
  * **Dependencies:** `AIClient`, `utils`, Chrome storage API
  * **Responsibilities:** Manages AI configuration settings (provider, API keys, models, system prompts). Includes logic to fetch and autocomplete live models.
* **`src/popup/components/TabItem.vue`**
  * **Namespace:** `Popup::Components::TabItem`
  * **Dependencies:** `utils`
  * **Responsibilities:** Displays an individual tab's basic info (title, icon). Exposes actions to close the tab or switch focus.
* **`src/popup/App.vue`**
  * **Namespace:** `Popup::App`
  * **Dependencies:** `GroupList.vue`, `SettingsView.vue`, background service worker API
  * **Responsibilities:** Main entry point for the popup overlay. Aggregates data on all windows, tabs, and groups. Orchestrates AI command requests and manages overall theme state.
* **`src/popup/main.ts`**
  * **Namespace:** `Popup::Main`
  * **Dependencies:** Vue (`createApp`), `App.vue`
  * **Responsibilities:** Initializes the popup app environment. Applies synchronous theme variables to avoid FOUC before delegating rendering to Vue.
* **`src/popup/search-page.ts`**
  * **Namespace:** `Popup::StandaloneSearch`
  * **Dependencies:** `search-overlay.ts`, Vue (`createApp`), `App.vue`
  * **Responsibilities:** Provides a bootstrap entry for standalone search pages, bridging the content script overlay with the standard popup logic.
* **`src/env.d.ts`**
  * **Namespace:** `Typings`
  * **Dependencies:** `vite/client`
  * **Responsibilities:** Global TypeScript definitions for Vue SFCs and environment-injected build metadata.
