'use strict';

import { DEFAULT_SETTINGS } from './constants'
import type { ExtensionSettings } from './types'

/** Settings that a pasted config may never change; they keep the current value. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set([])

const REDACTED_SECRET = '__REDACTED__'

/** Result of sanitizing a pasted config. */
export interface ImportedConfigResult {
  settings: ExtensionSettings
  /** Dotted paths of fields that were dropped because they were invalid or protected. */
  skipped: string[]
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAllowedEndpoint(value: string): boolean {
  if (value === '') return true
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function isUsableKey(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== REDACTED_SECRET
}

/**
 * Copies values from `incoming` onto `base`, keeping only fields whose type matches the default.
 * Fields with no default are kept as-is so optional settings survive a round trip.
 */
function mergeTyped(
  base: Record<string, any>,
  incoming: Record<string, any>,
  defaults: Record<string, any>,
  path: string,
  skipped: string[],
  skip: (key: string) => boolean
): Record<string, any> {
  const out = { ...base }
  for (const [key, value] of Object.entries(incoming)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (skip(key)) continue
    const fullPath = path ? `${path}.${key}` : key
    if (key in defaults && defaults[key] !== undefined && typeof value !== typeof defaults[key]) {
      skipped.push(fullPath)
      continue
    }
    if (key in defaults && isPlainObject(defaults[key]) && !isPlainObject(value)) {
      skipped.push(fullPath)
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Copy of the settings for "Copy Config": every API key is removed so the clipboard never holds secrets.
 * @param {ExtensionSettings} settings - Current settings.
 * @returns {Record<string, any>} Shareable config.
 */
export function buildExportableConfig(settings: ExtensionSettings): Record<string, any> {
  const config = JSON.parse(JSON.stringify(settings))
  if (config.ai) {
    delete config.ai.customModels
    delete config.ai.apiKey
    if (isPlainObject(config.ai.providerSettings)) {
      for (const provider of Object.values(config.ai.providerSettings)) {
        if (isPlainObject(provider)) delete provider.apiKey
      }
    }
  }
  delete config.customModels
  return config
}

/**
 * Validates a pasted config and merges it onto the current settings.
 * Wrong-typed fields and non-http(s) endpoints are dropped, protected settings are kept,
 * and API keys missing from the paste (as in configs made by "Copy Config") are kept.
 * @param {unknown} parsed - Parsed clipboard JSON.
 * @param {ExtensionSettings} current - Settings currently in the form.
 * @returns {ImportedConfigResult} Merged settings and the skipped fields.
 */
export function sanitizeImportedConfig(parsed: unknown, current: ExtensionSettings): ImportedConfigResult {
  if (!isPlainObject(parsed)) {
    throw new Error('Invalid configuration JSON')
  }
  const skipped: string[] = []
  const defaults = DEFAULT_SETTINGS as Record<string, any>

  const top = mergeTyped(
    { ...defaults, ...current },
    parsed,
    defaults,
    '',
    skipped,
    key => key === 'ai' || PROTECTED_KEYS.has(key)
  )

  const currentAi = (current.ai || DEFAULT_SETTINGS.ai) as Record<string, any>
  const incomingAi = isPlainObject(parsed.ai) ? parsed.ai : {}
  if (parsed.ai !== undefined && !isPlainObject(parsed.ai)) skipped.push('ai')

  const ai = mergeTyped(
    { ...DEFAULT_SETTINGS.ai, ...currentAi },
    incomingAi,
    DEFAULT_SETTINGS.ai as Record<string, any>,
    'ai',
    skipped,
    key => key === 'providerSettings' || key === 'apiKey'
  )
  ai.apiKey = isUsableKey(incomingAi.apiKey) ? incomingAi.apiKey : (currentAi.apiKey || '')

  const defaultProviders = DEFAULT_SETTINGS.ai.providerSettings as Record<string, any>
  const currentProviders = (currentAi.providerSettings || {}) as Record<string, any>
  const incomingProviders = isPlainObject(incomingAi.providerSettings) ? incomingAi.providerSettings : {}
  const providerSettings: Record<string, any> = {}
  for (const name of Object.keys(defaultProviders)) {
    const base = { ...defaultProviders[name], ...(currentProviders[name] || {}) }
    const incoming = isPlainObject(incomingProviders[name]) ? incomingProviders[name] : {}
    const merged = mergeTyped(base, incoming, defaultProviders[name], `ai.providerSettings.${name}`, skipped, key => key === 'apiKey')
    if (typeof merged.endpoint === 'string' && !isAllowedEndpoint(merged.endpoint)) {
      skipped.push(`ai.providerSettings.${name}.endpoint`)
      merged.endpoint = base.endpoint
    }
    merged.apiKey = isUsableKey(incoming.apiKey) ? incoming.apiKey : (base.apiKey || '')
    providerSettings[name] = merged
  }
  for (const name of Object.keys(incomingProviders)) {
    if (!(name in defaultProviders)) skipped.push(`ai.providerSettings.${name}`)
  }
  ai.providerSettings = providerSettings

  if (typeof ai.provider !== 'string' || !(ai.provider in defaultProviders)) {
    skipped.push('ai.provider')
    ai.provider = currentAi.provider || DEFAULT_SETTINGS.ai.provider
  }

  for (const key of PROTECTED_KEYS) {
    if (key in parsed && parsed[key] !== (current as Record<string, any>)[key]) skipped.push(key)
  }

  return { settings: { ...top, ai } as ExtensionSettings, skipped }
}
