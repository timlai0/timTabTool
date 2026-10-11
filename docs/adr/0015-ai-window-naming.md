# ADR 0015: AI-Powered Browser Window Naming and Workspace Differentiation

## Status
Accepted

## Context
1. **Window Identification in Multi-Window Workspaces**:
   Users operating across multiple browser windows frequently accumulate heterogeneous sets of tabs (e.g., project documentation, code reviews, media streaming, administrative dashboards). Chrome's native window titles reflect only the active tab's title, offering no workspace-level context.
2. **Platform & Extension API Limitations**:
   Chrome's Extensions Manifest V3 API lacks a direct write API to mutate native OS window titles dynamically. The extension already maintains a custom window name map (`customWindowNames: Record<number, string>`) in `chrome.storage.local` to provide user-defined naming inside popup headers and search overlays.
3. **Automated Semantic Labeling Need**:
   Manually renaming every browser window is tedious. An automated mechanism powered by configured LLMs (OpenAI, Gemini, OpenRouter, Custom) was needed to analyze open tabs within a window—or across all open windows simultaneously—and generate concise, mutually contrasting workspace titles.

## Decision
1. **Dual Generation Modes in `AIClient`**:
   - `generateWindowName(tabs, options)`: Analyzes tab titles and domains for a single window. Accepts an optional list of `existingNames` to guarantee contrast with other active windows.
   - `generateAllWindowsNames(windows, options)`: Analyzes all open browser windows concurrently in a single prompt, ensuring holistic workspace separation and enforcing unique naming with collision resolution (appending numeric suffixes if collisions occur).
2. **JSON Envelope Unwrapping & Safety Recovery**:
   - Unwraps object envelopes (`windows`, `results`, `names`, `items`, `data`, `decisions`) and property aliases (`windowId`, `id`, `window_id`, `name`, `title`, `windowName`, `newName`).
   - Bounds titles to a maximum of 40 characters and strips enclosing quotes and markdown wrappers.
   - Recovers from content safety policy blocks (`PROHIBITED_CONTENT`, `content safety`) by automatically retrying with URL domains only.
3. **Background Lifecycle Routing & Standardized Execution**:
   - Integrated `GENERATE_WINDOW_NAME` and `GENERATE_ALL_WINDOW_NAMES` message actions into `runAIOperation` in `src/background/message-router.ts`.
   - Operations track execution status under operation type `'name_window'` in `activeOperationsMap` and record telemetry through `AILogger`.
   - Results are persisted to `chrome.storage.local` under `customWindowNames` and broadcasted via `WINDOW_NAMES_UPDATED` to both extension views (`chrome.runtime.sendMessage`) and injected content scripts (`chrome.tabs.sendMessage`).
4. **UI Integrations**:
   - **Popup Window Header**: Added an inline AI sparkle generator button alongside the manual rename trigger on window headers.
   - **Global Action Bar**: Added an "AI Name All Windows" action in the popup header when multiple windows are open.
   - **More Actions Menu**: Added "AI Generate Window Name" and "AI Name All Windows" items to window popover menus.
   - **Context Menus**: Added `generate-window-name` item to the extension action context menu.
   - **Search Overlay**: Added `/name-window` and `/name-all-windows` slash commands.
   - **Settings View**: Added a dedicated "Window Naming Prompt" card under advanced prompt configurations with default restoration.

## Consequences
- **Positive**: Seamless, one-click semantic labeling of single or multiple browser windows.
- **Positive**: Strict adherence to MV3 storage model and dual-channel broadcast routing.
- **Positive**: Resilient against LLM formatting deviations, schema variations, and prompt safety blocks.
- **Positive**: Comprehensive unit test suite covering prompts, JSON extraction, background tab operations, and IPC dispatches.
