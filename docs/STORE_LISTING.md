# Chrome Web Store & Mozilla Add-ons Listing

## English

### Name
timTabTool

### Summary (132 chars max)
Autopilot for your tabs. One-click smart grouping, instant search, optional AI enhancement — local-first, open source.

### Description
**Drowning in browser tabs?** timTabTool is the autopilot for your browser — it automatically organizes tabs into smart groups and lets you search through them instantly.

**One-Click Smart Grouping**
- Automatically categorizes tabs into groups: Work, Development, Learning, Social, Entertainment, Shopping, Docs, and more
- Uses a built-in rule engine with 155+ domain rules and keyword patterns
- Works instantly with zero configuration — no AI API key needed
- Creates native browser Tab Groups with color coding

**Lightning-Fast Tab Search**
- Search across all open tabs and recently closed tabs
- Fuzzy matching on titles and URLs
- Keyboard shortcut (Ctrl+Shift+F) to open search instantly
- Results highlighted with relevance scoring

**Optional AI Enhancement**
- Bring your own API key (OpenAI, Claude, Gemini, OpenRouter, or any OpenAI-compatible endpoint)
- AI handles the tabs that rule-based classification can't categorize
- Window Chat: ask questions about your open tabs, keep multiple chat threads, and let the assistant group, pin, focus or close tabs — you choose how much it may do on its own (off, ask every time, confirm closing, or auto) and can undo with one click
- Your API key stays on your device — we never see it
- Tab titles and URLs are sent to your chosen AI provider only when you use an AI feature

**Privacy First**
- All settings and history stored locally on your device
- No accounts, no tracking, no analytics
- Nothing is sent to our servers; the only network requests go to the AI provider you configure, and only when you use AI features
- Open source and transparent: https://github.com/timlai0/timTabTool

**Bilingual**
- Full English and Chinese (Simplified) support
- Automatically matches your browser language

**Perfect for:**
- Developers with 50+ tabs open
- Researchers managing multiple topics
- Anyone who wants a cleaner browser

### Category
Productivity

### Language
English, Chinese (Simplified)

---

## 中文

### 名称
timTabTool

### 简介 (132 字符)
标签页自动驾驶。一键智能分组、即时搜索、可选 AI 增强 — 本地优先、开源。

### 描述
**标签页太多？** timTabTool 是你的标签页自动驾驶仪 — 自动整理标签页为智能分组，支持即时搜索。

**一键智能分组**
- 自动将标签分为：工作、开发、学习、社交、娱乐、购物、文档等分组
- 内置规则引擎，包含 155+ 域名规则和关键词匹配
- 开箱即用，零配置 — 不需要 AI API 密钥
- 使用浏览器原生标签组，带颜色标识

**闪电搜索**
- 搜索所有打开的标签和最近关闭的标签
- 标题和 URL 模糊匹配
- 快捷键 (Ctrl+Shift+F) 即时打开搜索
- 结果高亮显示，按相关性排序

**可选 AI 增强**
- 自带 API 密钥（支持 OpenAI、Claude、Gemini、OpenRouter 或任何兼容接口）
- AI 处理规则引擎无法分类的标签
- Window Chat：就打开的标签页与 AI 对话，支持多个对话线程，并可让助手分组、固定、切换或关闭标签 — 你可以选择权限模式（关闭、每次询问、关闭时确认、自动），并可一键撤销
- API 密钥仅存储在本地 — 我们永远看不到
- 仅在你使用 AI 功能时，标签标题和 URL 才会发送到你选择的 AI 服务商

**隐私优先**
- 设置和历史记录仅存储在本地
- 无账号、无追踪、无分析
- 不向我们的服务器发送任何数据；仅在使用 AI 功能时向你配置的 AI 服务商发送请求
- 开源透明：https://github.com/timlai0/timTabTool

**适合：**
- 开了 50+ 标签页的开发者
- 管理多个主题的研究人员
- 任何想要更整洁浏览器的人

---

## Chrome Web Store submission checklist

Everything below is entered in the Chrome Web Store Developer Dashboard (the extension ZIP cannot carry it).

### Single purpose
Help users organize, search and manage their browser tabs (grouping, search, restore, and an optional AI assistant for the same tasks).

### Permission justifications
| Permission | Justification |
|-----------|---------------|
| `tabs` | Read the title and URL of open tabs to classify, search and list them; close, move, pin and focus tabs on the user's request. |
| `tabGroups` | Create, rename, recolor and remove native Chrome tab groups, the core feature. |
| `storage` | Store settings, tab history, AI logs and chat threads locally (`chrome.storage.local`). |
| `scripting` | Inject the search overlay into tabs that were already open before the extension was installed or updated. No page content is read. |
| `favicon` | Show site icons through Chrome's local `_favicon` cache without external requests. |
| `clipboardRead` | "Paste Config" imports an exported settings configuration from the clipboard when the user clicks the button. |
| `contextMenus` | Shortcuts in the toolbar icon's right-click menu. |
| Host permission `<all_urls>` | (1) The search overlay content script runs on every page; (2) `scripting` injects it into existing tabs; (3) the extension calls the AI endpoint the user configures, which can be any host (OpenAI, Anthropic, Gemini, OpenRouter, a self-hosted server). No page content is read or transmitted. |

### Remote code
No. All JavaScript ships inside the package; there is no `eval`, remote script or WebAssembly download. The only remote calls are API requests to the AI endpoint the user configures.

### Data usage disclosures (Privacy practices tab)
Check these data types as handled by the extension (they are processed locally and only leave the device when the user uses an AI feature, directly to the provider the user configured):
- **Web history** — URLs and titles of tabs (sent to the configured AI provider on user action).
- **Website content** — tab titles (same as above).
- **Authentication information** — the user's own AI API key, stored locally and sent only to the provider it belongs to.

Certify that data is **not** sold, **not** used for purposes unrelated to the extension's single purpose, and **not** used for creditworthiness or lending.

### Privacy policy URL
Use the public repository URL:
`https://github.com/timlai0/timTabTool/blob/main/docs/PRIVACY_POLICY.md`

### Store assets to prepare
- At least one screenshot, 1280×800 or 640×400 (up to five). Suggested: popup with groups, search overlay, Window Chat with the thread sidebar, an action card with the Undo bar, Settings.
- Small promo tile 440×280 (required for listing visibility); marquee 1400×560 optional.
- Store icon 128×128: `public/icons/icon-128.png` (already in the package).

### Before each Chrome Web Store upload
1. `npm run typecheck && npm test`
2. `npm run build` (the `prebuild` step bumps the version; the store requires a higher version than the last upload).
3. Zip the *contents* of `dist/` (`bash scripts/build-store.sh`) to produce `timtabtool-chrome.zip` and upload.

---

## Mozilla Add-ons (Firefox AMO) submission checklist

### Add-on metadata (`dist-firefox/manifest.json`)
- **Gecko ID:** `timtabtool@timlai.de`
- **Minimum Firefox version:** `142.0` (required for native `tabGroups` API and `data_collection_permissions` manifest support)
- **Data collection permissions:** `required: ["none"]` (no telemetry or developer data collection; optional user-configured AI endpoints are disclosed in the privacy policy)
- **Firefox-specific manifest adjustments (applied automatically by `scripts/build-firefox.js`):**
  - Removes Chrome-only `favicon` permission, `_favicon/*` web-accessible resource, and `minimum_chrome_version`.
  - Adds `menus` alongside `contextMenus`.
  - Uses `background.scripts: ["background.js"]` (`type: "module"`).
  - Omits static `content_scripts` and injects `content.js` on demand via `scripting.executeScript` to minimize memory footprint across large tab counts.

### Source code submission & instructions for AMO Reviewers
Because the extension is bundled from TypeScript and Vue 3 SFCs using Vite, Mozilla Add-ons requires uploading the clean source archive (`timtabtool-source.zip`) alongside `timtabtool-firefox.zip`. Paste the following into the **"Notes to Reviewer"** field on AMO:

```text
Build environment requirements:
- OS: Linux, macOS, or Windows
- Node.js: v20.x LTS (or v22.x) and npm 10+ (included with Node.js)

Steps to reproduce the exact Firefox build from the source archive:
1. Extract the source archive and open a terminal in the root directory.
2. Install dependencies from the lockfile:
   npm ci
3. Build the Firefox distribution into dist-firefox/:
   npm run build:firefox
4. (Optional) Lint the generated package:
   npm run lint:firefox

The compiled extension output is generated in the `dist-firefox/` directory.
Note: `npm run build` (Chrome) runs a `prebuild` version bump script, whereas `npm run build:firefox` builds the exact version recorded in `manifest.json` without modifying version numbers.
```

### Before each Firefox AMO upload
1. Run `bash scripts/build-firefox-store.sh` (runs typecheck, tests, `npm run build:firefox`, `web-ext lint`, and packages both `timtabtool-firefox.zip` and `timtabtool-source.zip`).
2. Upload `timtabtool-firefox.zip` as the add-on file and `timtabtool-source.zip` as the source code archive at https://addons.mozilla.org/en-US/developers/.
