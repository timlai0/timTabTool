<p align="center">
  <img src="public/icons/icon-128.png" width="80" height="80" alt="timTabTool logo" />
</p>

<h1 align="center">timTabTool</h1>

<p align="center">
  <strong>Autopilot for your browser tabs.</strong><br/>
  Smart grouping · Instant search · Optional AI · 100% private
</p>

<p align="center">
  <a href="https://github.com/florianlanx/timTabTool/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/manifest-v3-green.svg" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/chrome-extension-yellow.svg" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/vue-3-brightgreen.svg" alt="Vue 3" />
  <img src="https://img.shields.io/badge/typescript-5-blue.svg" alt="TypeScript" />
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#why-timtabtool">Why timTabTool</a> ·
  <a href="#development">Development</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <a href="README.zh-CN.md">🇨🇳 简体中文</a>
</p>

---

> **timTabTool** is a free, open-source Chrome extension for **automatic tab grouping** and management.
> It works out of the box with **155+ built-in rules** — no API key required.
> Optionally connect **OpenAI, Claude, Gemini**, or any local LLM (Ollama, DeepSeek) to boost accuracy to ~95%.
> All data stays on your device. No accounts, no tracking, no cloud.
>
> **timTabTool** 是一款免费开源的 Chrome 标签页自动分组管理扩展。
> 内置 155+ 规则，开箱即用无需 API 密钥。
> 可选接入 OpenAI、Claude、Gemini 或本地大模型，准确率提升至 ~95%。
> 所有数据本地存储，无需注册，不追踪，不上传。

---

## Features

### One-Click Smart Grouping

Organize all your tabs into Chrome Tab Groups with a single click. timTabTool classifies tabs using a **built-in rule engine** with 155+ domain rules and 20+ keyword patterns — no API key needed.

<!-- TODO: Replace with actual GIF after recording -->
<!-- ![Smart Grouping Demo](docs/assets/demo-grouping.gif) -->

### Lightning-Fast Search

Press `Ctrl+Shift+F` to open a Spotlight-style search overlay. Search across **all open tabs and recently closed tabs** with fuzzy matching, keyword highlighting, and relevance scoring.

<!-- ![Search Demo](docs/assets/demo-search.gif) -->

### Optional AI Enhancement

Bring your own API key to boost classification accuracy from ~75% to ~95%. timTabTool supports **4 AI providers**:

| Provider | Model |
|----------|-------|
| OpenAI | gpt-4o-mini |
| Claude | claude-sonnet-4-20250514 |
| Gemini | gemini-2.5-flash |
| Custom | Any OpenAI-compatible endpoint |

Two AI modes:
- **Enhance mode** — AI handles only the tabs the rule engine can't classify
- **Free-form mode** — AI creates custom group names and colors dynamically

### Auto-Classify New Tabs

After AI grouping, new tabs are automatically collected into a "New Tabs" group. One click to classify them into existing groups using AI.

### Privacy First

- All data stored locally via `chrome.storage.local`
- Your API key never leaves your device (except to the AI provider you choose)
- No accounts, no tracking, no analytics
- Fully open source — audit the code yourself

### Bilingual

Full English and Chinese (简体中文) support. Automatically matches your Chrome language.

## Install

### From Chrome Web Store

*(Coming soon)*

### From GitHub Releases (Recommended)

1. Go to the [Releases](https://github.com/florianlanx/timTabTool/releases) page and download the latest `timtabtool-vX.X.X.zip`
2. Unzip to a folder
3. Open `chrome://extensions` and enable **Developer Mode** (top right toggle)
4. Click **Load unpacked** and select the unzipped folder
5. Done! Pin timTabTool to the toolbar for quick access

### Build from Source

<details>
<summary>For developers who want to build from source</summary>

```bash
git clone https://github.com/florianlanx/timTabTool.git
cd timtabtool
pnpm install
pnpm build
```

Then load `dist/` as an unpacked extension in `chrome://extensions` (enable Developer Mode).

</details>

## Why timTabTool

Every heavy browser user suffers from tab overload. Developers are the worst — GitHub PRs, Stack Overflow, docs, Jira, Slack, all mixed together. Chrome's native Tab Groups require manual drag-and-drop organization that nobody actually does.

**Existing solutions all have trade-offs:**

| Category | Examples | Problem |
|----------|----------|---------|
| Tab savers | OneTab | Collapses tabs to a list — destructive, no classification |
| Workspace managers | Workona, Partizion | Requires upfront manual setup |
| AI-only organizers | AI Tab Master, Tabaroo | Requires API key — no key = no functionality |
| Domain groupers | Tabblar | Groups by website, misses context (a GitHub PR ≠ a GitHub profile) |

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
| Extension | Manifest V3 |
| Testing | Vitest |

## Project Structure

```
src/
├── background/     # Service worker: classifier, tab-manager, searcher, storage
├── popup/          # Popup UI (group preview + actions)
├── content/        # Spotlight search overlay
├── shared/         # Types, constants, rules, AI client, i18n, utils
└── styles/         # Global CSS (Tailwind)
```

## Development

```bash
pnpm install          # Install dependencies
pnpm dev              # Dev server with HMR
pnpm build            # Production build
pnpm test             # Run tests
pnpm typecheck        # Type check
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

If you find timTabTool useful, consider:

- Starring the repo on GitHub
- Sharing it with friends

## License

[MIT](LICENSE) © Florian
