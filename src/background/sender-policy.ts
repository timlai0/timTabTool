'use strict';

import type { ExtensionSettings } from '../shared/types'

/** Placeholder returned to untrusted contexts in place of a real API key. */
export const REDACTED_SECRET = '__REDACTED__'

/**
 * Actions that only the extension's own pages (popup, settings, search/chat pages) may call.
 * Content scripts run inside arbitrary web pages, so a compromised renderer must not be able to
 * read secrets, rewrite settings (e.g. point the AI endpoint elsewhere or enable MCP), or wipe data.
 */
export const PRIVILEGED_ACTIONS: ReadonlySet<string> = new Set([
  'SAVE_SETTINGS',
  'GET_MCP_STATUS',
  'RECONNECT_MCP',
  'GET_MCP_TOKEN',
  'REGENERATE_MCP_TOKEN',
  'GET_AI_LOGS',
  'CLEAR_AI_LOGS',
  'DELETE_AI_LOG',
  'GET_CLOSED_TABS',
  'RESTORE_CLOSED_TAB',
  'RESTORE_CLOSED_BATCH',
  'RESTORE_ALL_CLOSED_TABS',
  'DELETE_CLOSED_TAB',
  'DELETE_CLOSED_BATCH',
  'CLEAR_CLOSED_TABS',
  'EXPORT_KNOWN_TABS',
])

/**
 * Whether a message came from one of this extension's own pages rather than a content script.
 * A missing sender means an internal call from the background itself.
 * @param {chrome.runtime.MessageSender} [sender] - Message sender.
 * @returns {boolean} True for extension pages and internal calls.
 */
export function isTrustedSender(sender?: chrome.runtime.MessageSender): boolean {
  if (!sender) return true
  if (sender.id !== chrome.runtime.id) return false
  const extensionOrigin = chrome.runtime.getURL('')
  const senderUrl = sender.url || ''
  if (!senderUrl.startsWith(extensionOrigin)) return false
  // Chrome also reports origin; reject if it disagrees with the URL
  if (sender.origin && !extensionOrigin.startsWith(sender.origin)) return false
  return true
}

/**
 * Whether a sender may run the given action.
 * @param {string} action - Message action.
 * @param {chrome.runtime.MessageSender} [sender] - Message sender.
 * @returns {boolean} True if allowed.
 */
export function isActionAllowed(action: string, sender?: chrome.runtime.MessageSender): boolean {
  return !PRIVILEGED_ACTIONS.has(action) || isTrustedSender(sender)
}

/**
 * Copy settings with every API key replaced by a placeholder (empty keys stay empty,
 * so "is AI configured" checks keep working).
 * @param {ExtensionSettings} settings - Full settings.
 * @returns {ExtensionSettings} Settings safe to hand to a content script.
 */
export function redactSettingsSecrets(settings: ExtensionSettings): ExtensionSettings {
  const mask = (key?: string) => (key ? REDACTED_SECRET : key)
  const providerSettings = settings.ai?.providerSettings
    ? Object.fromEntries(
        Object.entries(settings.ai.providerSettings).map(([name, cfg]) => [
          name,
          cfg ? { ...cfg, apiKey: mask(cfg.apiKey) } : cfg,
        ]),
      )
    : settings.ai?.providerSettings
  return {
    ...settings,
    ai: {
      ...settings.ai,
      apiKey: mask(settings.ai?.apiKey) as string,
      providerSettings: providerSettings as ExtensionSettings['ai']['providerSettings'],
    },
  }
}

/**
 * Put stored API keys back wherever incoming settings still hold the placeholder,
 * so a redacted copy can never overwrite real keys.
 * @param {ExtensionSettings} incoming - Settings about to be saved.
 * @param {Partial<ExtensionSettings>} stored - Settings currently in storage.
 * @returns {ExtensionSettings} Settings with real keys restored.
 */
export function restoreRedactedSecrets(incoming: ExtensionSettings, stored: Partial<ExtensionSettings>): ExtensionSettings {
  if (!incoming?.ai) return incoming
  const result: ExtensionSettings = { ...incoming, ai: { ...incoming.ai } }
  if (result.ai.apiKey === REDACTED_SECRET) {
    result.ai.apiKey = stored.ai?.apiKey ?? ''
  }
  if (result.ai.providerSettings) {
    const restored: Record<string, any> = {}
    for (const [name, cfg] of Object.entries(result.ai.providerSettings)) {
      const storedCfg = (stored.ai?.providerSettings as Record<string, any> | undefined)?.[name]
      restored[name] = cfg && cfg.apiKey === REDACTED_SECRET ? { ...cfg, apiKey: storedCfg?.apiKey ?? '' } : cfg
    }
    result.ai.providerSettings = restored as ExtensionSettings['ai']['providerSettings']
  }
  return result
}
