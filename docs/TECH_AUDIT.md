# Technical Documentation & Code Audit

## Architecture Overview

timTabTool is a Manifest V3 Chrome Extension built with Vue 3, TypeScript, and Vite.
The project is structured into several core modules:

- **Background (`src/background/`)**: Service worker handling tab management, search indexing, and classification.
- **Popup (`src/popup/`)**: The extension's popup UI for previewing groups and triggering actions.
- **Content (`src/content/`)**: Injected scripts, primarily the Spotlight-style search overlay.
- **Shared (`src/shared/`)**: Shared types, constants, rule engine logic, AI client, and utilities.
- **Styles (`src/styles/`)**: Global Tailwind CSS styles.

## Unused Code (Abandoned Code Audit)

A recent scan for unused exports and abandoned code identified the following items. These should be considered for removal or refactoring to keep the codebase clean.

### Fully Unused
- `src/shared/constants.ts`: `ALL_CATEGORIES` (Line 14) - Exported but never imported by any other module.

### Unused Externally (Used only within module)
These exports are not used outside their respective files and could be un-exported to reduce the public API surface:
- `src/background/tab-manager.ts`: `activeAbortControllers` (Line 20), `OperationStatus` (Line 22)
- `src/shared/ai-client.ts`: `repairTruncatedJson` (Line 805), `SYSTEM_PROMPT` (Line 5)
- `src/shared/constants.ts`: `DEFAULT_SPLIT_PROMPT` (Line 25), `DEFAULT_CLASSIFY_PROMPT` (Line 26), `DEFAULT_MERGE_PROMPT` (Line 27), `PREDEFINED_MODELS` (Line 102)
- `src/shared/types.ts`: `GroupIndicatorStyle` (Line 77), `ThemeMode` (Line 79)

---
