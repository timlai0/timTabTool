# Privacy Policy for timTabTool

**Last Updated:** 2026-11-01

## Overview

timTabTool is a browser extension for Chrome and Firefox that helps you organize, search and manage your browser tabs using a built-in rule engine and, optionally, an AI provider that you configure yourself. It has no accounts, no servers of its own, and no analytics. We do not receive any of your data.

## Data the extension handles

The extension works with the following data, all of which stays on your device in `chrome.storage.local` (`browser.storage.local` in Firefox) unless you use an optional AI feature (see below):

- **Open tabs:** titles, URLs, favicons, tab group and window membership, used for grouping, search and the popup list.
- **Recently closed tabs and visit history:** a bounded list of tabs you or the extension closed, so you can search and restore them.
- **Settings:** your preferences, custom prompts, window names and, if you add them, AI provider settings including your API key.
- **AI operation log:** a local record of AI requests and responses (including the tab titles and URLs that were sent) so you can review what happened. You can filter, export and clear it in Settings.
- **Window Chat conversations:** the threads, messages, summaries and undo information for the optional chat feature.

We do **not** read the content of the web pages you visit. The extension's content script only provides the search overlay; it does not read, collect or transmit page content, form data or keystrokes outside that overlay.

## Optional AI features

AI features are off until you add an API key. When you use one (for example "Group Tabs" with AI, classification, or Window Chat):

- Tab **titles and URLs** (and your own chat messages and the chat history needed for context) are sent **directly from your browser** to the AI provider you chose: OpenAI, Anthropic, Google Gemini, OpenRouter, or a custom OpenAI-compatible endpoint you entered (including local servers such as Ollama).
- Requests happen only when you trigger an AI action or send a chat message (or when an optional automatic feature that you enabled runs).
- We do not proxy, see or store these requests. Your API key is stored locally and is sent only to the provider you configured. The provider's own privacy policy governs what it does with the data.
- Requests to OpenRouter include an `X-Title: timTabTool` and a `HTTP-Referer` header that identify the app to OpenRouter; they contain no tab data.
- Unencrypted `http://` endpoints are refused for public hosts; they are allowed only for localhost and private-network servers.

### Tab actions in Window Chat

If you enable tab actions in Window Chat, the assistant may *propose* closing, grouping, ungrouping, pinning, unpinning or focusing tabs. Depending on the permission mode you choose (Off, Ask every time, Confirm closing, Auto), actions run after your approval or automatically. The extension validates every proposal locally: it never touches pinned tabs or its own pages, and it limits how many tabs one action can affect. Closed tabs can be restored with Undo. Tab titles and URLs come from websites and are treated as untrusted when sent to the model.

## Data we do not collect

- We do not collect, transmit, sell or share personal information, browsing history or tab contents with us or any third party other than the AI provider you explicitly configure.
- We do not use analytics, telemetry, advertising, tracking pixels or error-reporting services.
- We do not use your data for creditworthiness, lending or any purpose unrelated to the extension's tab-management features.

## Data storage and deletion

- Everything is stored locally with `chrome.storage.local` (`browser.storage.local` in Firefox). Nothing is synced to our servers and the extension does not use `chrome.storage.sync`.
- You can delete conversations, AI logs and history in the extension, or remove everything by uninstalling the extension.

## Permissions and why they are needed

| Permission | Purpose |
|-----------|---------|
| `tabs` | Read tab titles and URLs and manage tabs (group, move, close, focus) for classification, search and chat actions |
| `tabGroups` | Create, rename, color and dissolve native browser tab groups |
| `storage` | Keep settings, history, logs and chat threads on your device |
| `scripting` | Inject the search overlay into tabs that were already open when the extension was installed or updated, or on demand in Firefox |
| `favicon` | Show site icons in the tab list through Chrome's local favicon cache (Chrome build only; no external request) |
| `clipboardRead` | Let you paste an exported settings configuration ("Paste Config") |
| `contextMenus` | Add shortcuts to the toolbar icon's right-click menu (search and tab-group actions; includes the `menus` permission alias in the Firefox build) |
| Host access (`<all_urls>`) | Show the search overlay on any page, inject it into existing tabs, and call the AI endpoint you configure (which can be any host you choose) |

## Third-party services

None by default. If you enable AI features, data is sent to the provider you configure, as described above.

## Children's privacy

This extension is not directed at children under 13 and does not knowingly collect information from children.

## Changes to this policy

We may update this policy from time to time. Changes will be noted in the changelog and the "Last Updated" date above.

## Contact

Questions about this policy can be raised by opening an issue on the project's GitHub repository: https://github.com/timlai0/timTabTool/issues

---

*This privacy policy applies to timTabTool version 1.2.0 and later.*
