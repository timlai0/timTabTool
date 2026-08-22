# 1. OpenRouter Provider and Per-Provider Settings Memory

Date: 2026-08-22

## Status

Accepted

## Context

Users require access to OpenRouter as an alternative AI provider to utilize models from multiple vendors (e.g., DeepSeek, Meta Llama, Anthropic, Google, Mistral) under a unified billing key. Furthermore, when switching between different AI providers (OpenAI, Claude, Gemini, OpenRouter, Custom), users frequently lost previously entered API credentials, custom endpoints, model selections, and token bounds.

## Decision

1. **OpenRouter Integration**:
   - Registered `openrouter` as a core `AIProvider` alongside `openai`, `claude`, `gemini`, and `custom`.
   - Set the default endpoint to `https://openrouter.ai/api/v1` and default model to `openai/gpt-4o-mini`.
   - Added a predefined model catalog in `PREDEFINED_MODELS.openrouter` and dynamic pricing entries in `MODEL_PRICING`, including free models (`stealth/ox-alpha`, `:free` models).
   - Implemented `fetchOpenRouterModels` to enable live model retrieval directly from `https://openrouter.ai/api/v1/models` with optional free-only filtering.
   - Standardized request dispatching via OpenAI-compatible endpoints with Bearer authentication and attribution headers (`HTTP-Referer`, `X-Title`).
   - Added `openRouterOnlyFree` setting to restrict dropdown selection, live model discovery, and enforce runtime prevention of paid API calls when enabled.

2. **Per-Provider Settings State Schema**:
   - Added `providerSettings?: Partial<Record<AIProvider, ProviderSettings>>` to `AIConfig` in `src/shared/types.ts`.
   - Top-level `settings.ai` fields (`apiKey`, `endpoint`, `model`, `maxTokens`, `batchSize`) mirror the currently active provider for 100% backward compatibility with existing background workers and consumers.
   - On provider change in `SettingsView.vue`:
     - Current active settings are committed to `providerSettings[oldProvider]`.
     - Target provider configuration is loaded from `providerSettings[newProvider]` or initialized with safe defaults if unconfigured.
     - Settings updates automatically synchronize to `providerSettings[activeProvider]`.

## Consequences

- Users can seamlessly switch between AI providers without having to re-enter credentials, endpoints, or model selections.
- Full access to OpenRouter's model catalog with live discovery and cost estimations.
- Retains backward compatibility with existing persistent storage structures.

