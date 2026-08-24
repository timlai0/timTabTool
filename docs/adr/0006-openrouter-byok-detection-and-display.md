# 6. OpenRouter Bring Your Own Key (BYOK) Detection and Visual Display

Date: 2026-08-23

## Status

Accepted

## Context

When utilizing OpenRouter, users frequently attach their own upstream provider keys (e.g. Google AI Studio, Anthropic, OpenAI) via OpenRouter's Bring Your Own Key (BYOK) feature. OpenRouter routes these requests directly to the user's upstream accounts with 0% token markup, but the public `/api/v1/models` catalog continues to return standard list prices. Users lacked visibility in the extension UI into whether their configured OpenRouter key was operating in BYOK direct billing mode, standard credit billing mode, or what upstream providers were linked.

## Decision

1. **Key Metadata & BYOK Query Function**:
   - Implemented `fetchOpenRouterKeyInfo` in `src/shared/ai-client.ts`.
   - Queries `GET /api/v1/key` (with fallback to `GET /api/v1/auth/key`) to retrieve key labels, credit usage, spending limits, and `byok_usage` statistics.
   - Queries `GET /api/v1/byok` to retrieve configured upstream credentials (e.g. Google, Anthropic) when permitted by key permissions.
   - Evaluates `isByokActive` as `true` when `byokUsage > 0` or configured upstream provider credentials exist.

2. **Schema & State Persistence**:
   - Defined `OpenRouterKeyInfo` interface in `src/shared/types.ts`.
   - Added `openRouterByokManual`, `openRouterByokActive`, and `openRouterKeyInfo` fields to `ProviderSettings` and `AIConfig`.
   - Updated `syncActiveToProviderSettings` and `loadProviderSettings` in `src/popup/components/SettingsView.vue` and `getAIOverrides` in `src/background/index.ts` to preserve BYOK status across provider switches and sessions.

3. **UI Visual Indicators**:
   - Added `[BYOK Direct]` tags to model option items in `SettingsView.vue`.
   - Added a dedicated "Check Key / BYOK" action and BYOK status card in `SettingsView.vue` displaying live BYOK status, key label, total BYOK usage in USD, standard credit usage, and detected upstream providers.
   - Added manual override toggle `Assume BYOK Active (Direct Billing)` for newly created keys with zero initial usage.
   - Added `BYOK Direct Billing Active` badge in the main popup AI popover in `src/popup/App.vue`.

## Consequences

- Clear visibility for users regarding whether BYOK or standard OpenRouter billing is active.
- Transparent reporting of external BYOK usage alongside standard credits.
- Manual toggle ensures full support even for new zero-usage keys where the management API is unexposed.
