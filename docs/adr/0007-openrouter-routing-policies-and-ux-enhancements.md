# 7. OpenRouter Routing Strategies, Data Collection Policies, Model Fallbacks, and UX Enhancements

Date: 2026-08-23

## Status

Accepted

## Context

OpenRouter power users require granular control over upstream execution characteristics (sorting by price, latency, or throughput), strict privacy policies (zero data retention / non-logging upstream providers), automatic model fallback lists, parameter validation guarantees, and streamlined model discovery given OpenRouter's catalog of 300+ models.

## Decision

1. **Routing Strategy & Policy Schema**:
   - Added `OpenRouterSort` type (`'auto' | 'price' | 'throughput' | 'latency'`).
   - Added `OpenRouterDataCollection` type (`'allow' | 'deny'`).
   - Added `openrouterSort`, `openrouterDataCollection`, `openrouterRequireParams`, `openrouterIgnoreProviders`, and `openrouterFallbackModels` fields to `ProviderSettings` and `AIConfig` in `src/shared/types.ts`.
   - Updated `DEFAULT_SETTINGS` in `src/shared/constants.ts` with balanced defaults (`openrouterSort: 'auto'`, `openrouterDataCollection: 'allow'`, `openrouterRequireParams: false`).

2. **API Payload Injection (`AIClient.chatOpenAI`)**:
   - Injected OpenRouter-compliant `provider` object:
     - `sort`: `'price' | 'throughput' | 'latency'` when configured.
     - `data_collection`: `'deny'` for zero data retention upstream routing.
     - `require_parameters`: `true` to enforce strict parameter compatibility.
     - `ignore`: array of provider slugs to exclude.
   - Injected `models: [primaryModel, ...fallbackModels]` array when `openrouterFallbackModels` is defined.

3. **UX Enhancements in Settings & Status Popover**:
   - **Model Search & Category Pills**: Real-time substring search across model names and IDs, accompanied by filter pills (`All`, `Free Only`, `Reasoning`, `BYOK Direct`).
   - **Quick Presets**: 1-click preset buttons for popular models (`stealth/ox-alpha`, `deepseek/deepseek-r1:free`, `anthropic/claude-3.5-sonnet`, `openai/gpt-4o-mini`, `google/gemini-2.5-flash`).
   - **Direct OpenRouter Navigation Links**: Direct action buttons in the key card to open Keys, Integrations, and Activity Logs.
   - **Active Status Popover Badges**: Real-time display of routing strategy (`price`, `throughput`, `latency`) and zero data retention privacy status in the popup header.

## Consequences

- Full control over routing cost, throughput, and latency.
- Strict compliance with enterprise zero-data-retention requirements via `data_collection: 'deny'`.
- Faster and more intuitive model discovery across hundreds of OpenRouter endpoints.
- Fully backward compatible with existing user settings snapshots.
