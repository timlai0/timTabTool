<p align="center">
  <img src="public/icons/icon-128.png" width="80" height="80" alt="timTabTool logo" />
</p>

<h1 align="center">timTabTool</h1>

<p align="center">
  <strong>Autopilot for your browser tabs.</strong><br/>
  Smart grouping · Instant search · Optional AI · 100% private
</p>

<p align="center">
  <a href="https://github.com/timlai0/timTabTool/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/manifest-v3-green.svg" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/chrome-extension-yellow.svg" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/firefox-addon-orange.svg" alt="Firefox Add-on" />
  <img src="https://img.shields.io/badge/vue-3-brightgreen.svg" alt="Vue 3" />
  <img src="https://img.shields.io/badge/typescript-5-blue.svg" alt="TypeScript" />
</p>

<p align="center">
  <a href="#features-ai-optimized-capabilities">Features</a> ·
  <a href="#keyboard-shortcuts">Keyboard Shortcuts</a> ·
  <a href="#install">Install</a> ·
  <a href="#why-timtabtool">Why timTabTool</a> ·
  <a href="#architecture--project-structure">Architecture</a> ·
  <a href="#setup--development">Setup & Development</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a>
</p>

---

> **timTabTool** is a free, open-source Chrome and Firefox extension for **automatic tab grouping** and management.
> It works out of the box with **155+ built-in rules** — no API key required.
> Optionally connect **OpenAI, Claude, Gemini, OpenRouter**, or any local LLM (Ollama, DeepSeek) to boost accuracy to ~95% and chat with your open tabs.
> All data stays on your device. No accounts, no tracking, no cloud.
>
> **timTabTool** 是一款免费开源的 Chrome 与 Firefox 标签页自动分组管理扩展。
> 内置 155+ 规则，开箱即用无需 API 密钥。
> 可选接入 OpenAI、Claude、Gemini、OpenRouter 或本地大模型，准确率提升至 ~95%。
> 所有数据本地存储，无需注册，不追踪，不上传。

---

## Features (AI-Optimized Capabilities)

### Capability: Rule-Based Tab Grouping
- **Trigger**: User interaction (One-click).
- **Action**: Aggregates open browser tabs into native browser Tab Groups.
- **Mechanism**: Local deterministic rule engine utilizing 155+ domain-specific rules and 20+ keyword patterns.
- **Dependencies**: None (Offline functionality, no external API key required).

### Capability: Global Tab Search
- **Trigger**: Keyboard shortcut (`Ctrl+Shift+F`).
- **Action**: Injects and renders a Spotlight-style search overlay interface via content script.
- **Mechanism**: Fuzzy text matching, keyword highlighting, and relevance scoring across all currently open and recently closed tabs.

### Capability: LLM-Enhanced Classification & Window Chat
- **Trigger**: User interaction (Requires configured API key).
- **Action**: Connects to external or local LLM providers to improve grouping accuracy (yielding ~95% accuracy versus ~75% base rule engine), name windows semantically, and run interactive multi-thread Window Chat with undoable tab actions.
- **Supported Providers**: OpenAI (`gpt-4o-mini`), Claude (`claude-sonnet-4-20250514`), Gemini (`gemini-2.5-flash`), OpenRouter, or any Custom OpenAI-compatible endpoint.
- **Execution Modes**:
  - *Enhance Mode*: LLM processes exclusively the tabs unmatched by the local rule engine.
  - *Free-form Mode*: LLM dynamically generates contextual group nomenclatures and assigns group colors.

### Capability: Continuous Tab Auto-Classification
- **Trigger**: User interaction.
- **Action**: Identifies newly opened, unclassified tabs and dynamically evaluates and assigns them to existing AI-generated Tab Groups.

### Capability: Local-First Privacy & Security
- **Data Storage**: Strictly utilizes `chrome.storage.local` (`browser.storage.local` in Firefox). See [docs/PRIVACY_POLICY.md](docs/PRIVACY_POLICY.md).
- **Network Outbound**: Restricted entirely to configured LLM API endpoints. No telemetry, tracking, or remote account requirements.

### Capability: Internationalization (i18n)
- **Support**: Native bilingual interface (English and Simplified Chinese), automatically syncing with the browser's locale settings.

## Keyboard Shortcuts

timTabTool provides customizable keyboard shortcuts for quick access to its core features:

| Command | Default Shortcut | Description |
|---------|------------------|-------------|
| **Open Popup** | `Ctrl+Shift+S` (Mac: `Cmd+Shift+S`) | Opens the timTabTool extension popup. |
| **Global Tab Search** | `Ctrl+Shift+F` (Mac: `Cmd+Shift+F`) | Opens the Spotlight-style search overlay to quickly find and switch tabs. |
| **Alternative Search** | `Ctrl+Shift+7` (Mac: `Cmd+Shift+7`) | An alternative shortcut to open the search overlay. |

> **Note:** You can customize these shortcuts at any time via `chrome://extensions/shortcuts` in Chrome or `about:addons` (Manage Extension Shortcuts) in Firefox.

## Install

### From Browser Extension Stores

- **Chrome Web Store**: *(Publishing in progress)*
- **Firefox Add-ons (AMO)**: *(Publishing in progress — requires Firefox 142+)*

### From GitHub Releases (Recommended)

1. Go to the [Releases](https://github.com/timlai0/timTabTool/releases) page and download the latest `timtabtool-chrome-vX.X.X.zip` (Chrome) or `timtabtool-firefox-vX.X.X.zip` (Firefox).
2. **Chrome / Edge / Brave**:
   - Unzip `timtabtool-chrome-vX.X.X.zip` to a folder
   - Open `chrome://extensions` and enable **Developer Mode** (top right toggle)
   - Click **Load unpacked** and select the unzipped folder
3. **Firefox (142+)**:
   - Open `about:debugging#/runtime/this-firefox`
   - Click **Load Temporary Add-on...** and select `timtabtool-firefox-vX.X.X.zip`

### Build from Source

<details>
<summary>For developers and package reviewers building from source</summary>

**Prerequisites:** Node.js 20+ and npm 10+ (or pnpm 10+).

```bash
git clone https://github.com/timlai0/timTabTool.git
cd timTabTool
npm ci

# Build Chrome extension (outputs to dist/)
npx vite build

# Build Firefox extension (outputs to dist-firefox/)
npm run build:firefox
```

- **Chrome**: Load `dist/` as an unpacked extension in `chrome://extensions` (enable Developer Mode).
- **Firefox**: Load `dist-firefox/manifest.json` in `about:debugging#/runtime/this-firefox`.

</details>

## Why timTabTool

Every heavy browser user suffers from tab overload. Developers are the worst — GitHub PRs, Stack Overflow, docs, Jira, Slack, all mixed together. Native Tab Groups require manual drag-and-drop organization that nobody actually does.

**Existing solutions all have trade-offs:**

| Category | Examples | Problem |
|----------|----------|---------|
| Tab savers | OneTab | Collapses tabs to a list — destructive, no classification |
| Workspace managers | Workona, Partizion | Requires upfront manual setup |
| AI-only organizers | AI Tab Master, Tabaroo | Requires API key — no key = no functionality |
| Domain groupers | Tabblar | Groups by website, misses context (a GitHub PR != a GitHub profile) |

**timTabTool's approach: progressive enhancement.**

1. **Level 0 (zero config)** — Rule engine with 155+ domain rules and 20+ keyword patterns covers ~75% of tabs accurately
2. **Level 1 (add API key)** — AI enhances the remaining ~25%, boosting accuracy to ~95%
3. **Level 2 (free-form AI)** — AI creates entirely custom groups with dynamic names and colors

The best tab manager should work instantly with zero configuration, then get smarter with optional AI.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript |
| UI | Vue 3 + Composition API |
| Build | Vite + CRXJS |
| Styling | Tailwind CSS |
| Extension | Manifest V3 (Chrome & Firefox 142+) |
| Testing | Vitest |

## Architecture & Project Structure

The project follows a standard Manifest V3 extension architecture, cleanly separating the UI, background service workers, and injected content scripts.

```text
src/
├── background/     # Service worker: Handles classification, storage state, and LLM API interactions
├── popup/          # Popup UI: Vue 3 application for group previews, Window Chat, and user actions
├── content/        # Content script: Injected Spotlight search overlay
├── shared/         # Core logic: Types, rules engine, LLM client, i18n, and utilities
└── styles/         # Global styles utilizing Tailwind CSS
```

### Data Flow
- **Popup to Background**: Communicates via `chrome.runtime.sendMessage` for manual grouping triggers, chat tool execution, and settings management.
- **Content to Background**: Queries the background worker to search across open and recently closed tabs.
- **Storage**: State, settings, and external API keys are persisted entirely locally using `chrome.storage.local`.

## Setup & Development

### Environment Variables
No `.env` file is required for local development or building from source. AI API keys (OpenAI, Claude, Gemini, OpenRouter, etc.) are configured directly within the extension's UI and stored locally in browser extension storage.

### Commands

```bash
npm ci                # Install dependencies from lockfile
npm run dev           # Dev server with HMR
npm run build         # Production build for Chrome (bumps build version via prebuild)
npx vite build        # Production build for Chrome (without bumping version)
npm run build:firefox # Production build for Firefox (outputs to dist-firefox/)
npm run lint:firefox  # Validate Firefox build with web-ext lint
npm test              # Run Vitest test suite
npm run typecheck     # Run TypeScript compiler checks
```

## Contributing

We welcome contributions. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

If you find timTabTool useful, consider:

- Starring the repo on GitHub
- Sharing it with friends

## Acknowledgements

**timTabTool** is a fork of the open-source Chrome extension [TabPilot](https://github.com/florianlanx/tabpilot), originally created by Florian.

## License

This project is licensed under the [MIT License](LICENSE).
Original TabPilot code is Copyright (c) 2025-present Florian.
timTabTool modifications and additions are Copyright (c) 2026-present Tim Lai.
