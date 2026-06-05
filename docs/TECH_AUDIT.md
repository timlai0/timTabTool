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



---
