'use strict';

import { DEFAULT_ENDPOINTS, MODEL_PRICING, PROVIDER_DEFAULTS } from './constants'
import type { OpenRouterProviderItem, OpenRouterKeyInfo } from './types'

export interface GoogleModelItem {
  id: string
  name: string
  complexity: string
  costFactor: string
  maxTokens: string
  inputCost?: number
  outputCost?: number
  costDetails?: string
  rawMaxOutputTokens?: number
  isByok?: boolean
}

export function getGoogleModelPricing(id: string): { input: number; output: number } {
  const lower = id.toLowerCase()

  // 1. Direct match in MODEL_PRICING
  if (MODEL_PRICING[id]) {
    return MODEL_PRICING[id]
  }

  for (const [key, rates] of Object.entries(MODEL_PRICING)) {
    if (key.toLowerCase() === lower) {
      return rates
    }
  }

  // 2. Open weights / free Gemma models
  if (lower.includes('gemma')) {
    return { input: 0, output: 0 }
  }

  // 3. Gemini 3.5+ / 3.6+ / 3.7+ / 4.x series
  if (lower.includes('gemini-3.5') || lower.includes('gemini-3.6') || lower.includes('gemini-3.7') || lower.includes('gemini-4')) {
    if (lower.includes('lite')) return { input: 0.25, output: 1.50 }
    if (lower.includes('pro')) return { input: 2.00, output: 12.00 }
    return { input: 1.50, output: 9.00 } // Flash 3.5/3.6 standard
  }

  // 4. Gemini 3.0 / 3.1 series
  if (lower.includes('gemini-3')) {
    if (lower.includes('lite')) return { input: 0.25, output: 1.50 }
    if (lower.includes('pro')) return { input: 2.00, output: 12.00 }
    return { input: 0.50, output: 3.00 } // Flash 3.0 standard
  }

  // 5. Gemini 2.5 series
  if (lower.includes('gemini-2.5')) {
    if (lower.includes('lite')) return { input: 0.10, output: 0.40 }
    if (lower.includes('pro')) return { input: 1.25, output: 10.00 }
    return { input: 0.30, output: 2.50 }
  }

  // 6. Gemini 2.0 series
  if (lower.includes('gemini-2')) {
    if (lower.includes('lite')) return { input: 0.075, output: 0.30 }
    if (lower.includes('pro')) return { input: 1.25, output: 5.00 }
    return { input: 0.10, output: 0.40 }
  }

  // Fallbacks
  if (lower.includes('pro')) return { input: 2.00, output: 12.00 }
  if (lower.includes('lite')) return { input: 0.25, output: 1.50 }
  if (lower.includes('flash')) return { input: 1.50, output: 9.00 }

  return PROVIDER_DEFAULTS.gemini
}

export async function fetchGoogleModels(apiKey: string, endpoint?: string): Promise<GoogleModelItem[]> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Google API Key is required to fetch models.')
  }
  const baseUrl = endpoint?.trim() || DEFAULT_ENDPOINTS.gemini
  const cleanBase = baseUrl.replace(/\/$/, '')
  const url = `${cleanBase}/v1beta/models`

  const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey.trim() } })
  if (!res.ok) {
    let errText = ''
    try {
      const errJson = await res.json()
      errText = errJson.error?.message || errJson.message || JSON.stringify(errJson)
    } catch {
      errText = await res.text().catch(() => res.statusText)
    }
    throw new Error(`Google API Error (${res.status}): ${errText || 'Failed to fetch models'}`)
  }

  const data = await res.json()
  if (!data.models || !Array.isArray(data.models)) {
    throw new Error('Invalid response structure from Google API: missing "models" array.')
  }

  // Strictly filter for compatible chat / text-generation models
  const compatibleModels = data.models.filter((m: any) => {
    const rawName: string = (m.name || '').toLowerCase()
    const methods: string[] = m.supportedGenerationMethods || []

    // 1. Must support text generation
    if (!methods.includes('generateContent')) return false

    // 2. Must be a Gemini or Gemma model
    if (!rawName.includes('gemini') && !rawName.includes('gemma')) return false

    // 3. Exclude non-chat / specialized incompatible models (embeddings, imagen, veo, aqa, bison, robotics)
    const incompatibleKeywords = ['embedding', 'imagen', 'veo', 'aqa', 'bison', 'robotics']
    if (incompatibleKeywords.some(keyword => rawName.includes(keyword))) return false

    return true
  })

  const results: GoogleModelItem[] = compatibleModels.map((m: any) => {
    const rawName: string = m.name || ''
    const id = rawName.replace(/^models\//, '')
    const displayName = m.displayName || id
    const lowerId = id.toLowerCase()

    const isGemma = lowerId.includes('gemma')
    const isPro = lowerId.includes('pro')
    const isLite = lowerId.includes('lite') || lowerId.includes('8b')

    let complexity = 'Medium'
    if (isPro) complexity = 'High'
    else if (isLite) complexity = 'Low'

    // Determine input and output costs per 1M tokens in USD
    const rates = getGoogleModelPricing(id)
    const inputCost = rates.input
    const outputCost = rates.output

    // Register into global MODEL_PRICING dynamically for cost calculations
    MODEL_PRICING[id] = { input: inputCost, output: outputCost }

    let costFactor = '25%'
    let costDetails = ''

    if (inputCost === 0 && outputCost === 0) {
      costFactor = 'Free'
      costDetails = 'Free'
    } else {
      costFactor = `$${inputCost.toFixed(3)}/1M in`
      costDetails = `$${inputCost}/$${outputCost} per 1M`
    }

    const outputLimitTokens = m.outputTokenLimit || 16384
    const outputLimit = Math.round(outputLimitTokens / 1024)
    const maxTokens = `${outputLimit > 0 ? outputLimit : 16}K`

    return {
      id,
      name: displayName,
      complexity,
      costFactor,
      costDetails,
      inputCost,
      outputCost,
      maxTokens,
      rawMaxOutputTokens: outputLimitTokens,
    }
  })

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Checks if a model is free based on ID, pricing, and metadata.
 */
export function isFreeModel(modelId?: string, modelObj?: { costFactor?: string; costDetails?: string; inputCost?: number; outputCost?: number }): boolean {
  if (!modelId) return false
  if (modelId === 'stealth/ox-alpha' || modelId.endsWith(':free')) return true
  if (modelObj?.costFactor === 'Free' || modelObj?.costDetails === 'Free') return true
  if (modelObj?.inputCost === 0 && modelObj?.outputCost === 0) return true
  const pricing = MODEL_PRICING[modelId]
  if (pricing && pricing.input === 0 && pricing.output === 0) return true
  return false
}

/**
 * Fetches the available models from OpenRouter API.
 */
export async function fetchOpenRouterModels(apiKey?: string, endpoint?: string, onlyFree = false): Promise<GoogleModelItem[]> {
  const baseUrl = endpoint?.trim() || DEFAULT_ENDPOINTS.openrouter
  const cleanBase = baseUrl.replace(/\/$/, '')
  const url = `${cleanBase}/models`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }

  const res = await fetch(url, { headers })
  if (!res.ok) {
    let errText = ''
    try {
      const errJson = await res.json()
      errText = errJson.error?.message || errJson.message || JSON.stringify(errJson)
    } catch {
      errText = await res.text().catch(() => res.statusText)
    }
    throw new Error(`OpenRouter API Error (${res.status}): ${errText || 'Failed to fetch models'}`)
  }

  const data = await res.json()
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Invalid response structure from OpenRouter API: missing "data" array.')
  }

  let results: GoogleModelItem[] = data.data.map((m: any) => {
    const id = m.id || ''
    const displayName = m.name || id
    const pricingPrompt = parseFloat(m.pricing?.prompt || '0')
    const pricingCompletion = parseFloat(m.pricing?.completion || '0')

    const inputCost = Math.round(pricingPrompt * 1000000 * 1000) / 1000
    const outputCost = Math.round(pricingCompletion * 1000000 * 1000) / 1000

    MODEL_PRICING[id] = { input: inputCost, output: outputCost }

    let complexity = 'Medium'
    if (inputCost >= 2.0 || id.includes('pro') || id.includes('r1') || id.includes('opus') || id.includes('sonnet')) {
      complexity = 'High'
    } else if (inputCost <= 0.25 || id.includes('mini') || id.includes('flash') || id.includes('haiku') || id.includes('small')) {
      complexity = 'Low'
    }

    let costFactor = '25%'
    let costDetails = ''
    if (inputCost === 0 && outputCost === 0) {
      costFactor = 'Free'
      costDetails = 'Free'
    } else {
      costFactor = `$${inputCost.toFixed(3)}/1M in`
      costDetails = `$${inputCost}/$${outputCost} per 1M`
    }

    const contextLength = typeof m.context_length === 'number' ? m.context_length : undefined
    let rawOutput = m.top_provider?.max_completion_tokens || m.per_request_limits?.completion_tokens
    if (!rawOutput || (contextLength !== undefined && rawOutput >= contextLength)) {
      const effectiveContext = contextLength || 16384
      if (effectiveContext <= 8192) {
        rawOutput = 4096
      } else if (effectiveContext <= 16384) {
        rawOutput = 8192
      } else if (effectiveContext <= 131072) {
        rawOutput = 16384
      } else {
        rawOutput = 32768
      }
    }
    const outputLimitTokens = Math.min(rawOutput, 65536)
    const outputLimit = Math.round(outputLimitTokens / 1024)
    const maxTokens = `${outputLimit > 0 ? outputLimit : 16}K`

    return {
      id,
      name: displayName,
      complexity,
      costFactor,
      costDetails,
      inputCost,
      outputCost,
      maxTokens,
      rawMaxOutputTokens: outputLimitTokens,
    }
  })

  if (onlyFree) {
    results = results.filter(m => isFreeModel(m.id, m))
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Fetches the available providers from OpenRouter API.
 */
export async function fetchOpenRouterProviders(apiKey?: string, endpoint?: string): Promise<OpenRouterProviderItem[]> {
  const baseUrl = endpoint?.trim() || DEFAULT_ENDPOINTS.openrouter
  const cleanBase = baseUrl.replace(/\/$/, '')
  const url = `${cleanBase}/providers`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }

  const res = await fetch(url, { headers })
  if (!res.ok) {
    let errText = ''
    try {
      const errJson = await res.json()
      errText = errJson.error?.message || errJson.message || JSON.stringify(errJson)
    } catch {
      errText = await res.text().catch(() => res.statusText)
    }
    throw new Error(`OpenRouter API Error (${res.status}): ${errText || 'Failed to fetch providers'}`)
  }

  const data = await res.json()
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Invalid response structure from OpenRouter API: missing "data" array.')
  }

  const results: OpenRouterProviderItem[] = data.data.map((p: any) => ({
    slug: p.slug || p.id || '',
    name: p.name || p.slug || p.id || '',
  })).filter((p: OpenRouterProviderItem) => p.slug && p.name)

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Fetches OpenRouter API key information, spending metrics, and BYOK status.
 */
export async function fetchOpenRouterKeyInfo(apiKey?: string, endpoint?: string): Promise<OpenRouterKeyInfo> {
  const baseUrl = endpoint?.trim() || DEFAULT_ENDPOINTS.openrouter
  const cleanBase = baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }

  let keyData: any = null

  // 1. Query /key with fallback to /auth/key
  const keyRes = await fetch(`${cleanBase}/key`, { headers }).catch(() => null)
  if (keyRes && keyRes.ok) {
    const json = await keyRes.json()
    keyData = json.data || json
  } else {
    const authRes = await fetch(`${cleanBase}/auth/key`, { headers }).catch(() => null)
    if (authRes && authRes.ok) {
      const json = await authRes.json()
      keyData = json.data || json
    } else {
      let errText = ''
      if (keyRes) {
        try {
          const errJson = await keyRes.json()
          errText = errJson.error?.message || errJson.message || JSON.stringify(errJson)
        } catch {
          errText = await keyRes.text().catch(() => keyRes.statusText)
        }
      } else if (authRes) {
        try {
          const authJson = await authRes.json()
          errText = authJson.error?.message || authJson.message || JSON.stringify(authJson)
        } catch {
          errText = await authRes.text().catch(() => authRes.statusText)
        }
      }
      throw new Error(`OpenRouter API Key Error: ${errText || 'Failed to fetch key info'}`)
    }
  }

  // 2. Query /byok to list configured upstream provider credentials
  let byokProviders: string[] = []
  try {
    const byokRes = await fetch(`${cleanBase}/byok`, { headers }).catch(() => null)
    if (byokRes && byokRes.ok) {
      const byokJson = await byokRes.json()
      if (Array.isArray(byokJson.data)) {
        byokProviders = byokJson.data
          .filter((item: any) => !item.disabled && item.provider)
          .map((item: any) => String(item.provider).toLowerCase())
      }
    }
  } catch {
    // Non-management keys or unpermitted endpoints safely fail silently
  }

  const byokUsage = typeof keyData?.byok_usage === 'number' ? keyData.byok_usage : (typeof keyData?.byokUsage === 'number' ? keyData.byokUsage : 0)
  const isByokActive = byokUsage > 0 || byokProviders.length > 0

  return {
    label: keyData?.label,
    usage: typeof keyData?.usage === 'number' ? keyData.usage : undefined,
    limit: typeof keyData?.limit === 'number' ? keyData.limit : (keyData?.limit === null ? null : undefined),
    isFreeTier: !!keyData?.is_free_tier,
    byokUsage,
    byokUsageDaily: typeof keyData?.byok_usage_daily === 'number' ? keyData.byok_usage_daily : undefined,
    byokUsageWeekly: typeof keyData?.byok_usage_weekly === 'number' ? keyData.byok_usage_weekly : undefined,
    byokUsageMonthly: typeof keyData?.byok_usage_monthly === 'number' ? keyData.byok_usage_monthly : undefined,
    byokProviders: byokProviders.length > 0 ? byokProviders : undefined,
    isByokActive,
  }
}
