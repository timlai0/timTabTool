# 5. OpenRouter Provider Routing and BYOK Support

Date: 2026-08-23

## Status

Accepted

## Context

When utilizing OpenRouter as the AI provider, requests by default route dynamically across multiple third-party model hosts based on OpenRouter's internal load balancer. Users utilizing Bring Your Own Key (BYOK) configurations on OpenRouter (e.g. Google Vertex / Google AI Studio BYOK credentials, NVIDIA, Groq) or users requiring specific latency, compliance, or throughput profiles need the capability to pin requests to specific upstream providers (such as `google`, `nvidia`, `together`, `deepinfra`, `groq`, `fireworks`, etc.) and decide whether automatic fallback to other providers should be permitted.

## Decision

1. **Provider Routing Configuration Schema**:
   - Added `openrouterProvider?: string` and `openrouterAllowFallbacks?: boolean` to `ProviderSettings` and `AIConfig` in `src/shared/types.ts`.
   - Added `OpenRouterProviderItem` interface (`{ slug: string; name: string }`) and `customProviders` dictionary to persist live-discovered OpenRouter providers.
   - Updated `DEFAULT_SETTINGS` with `openrouterProvider: ''` (Auto / All Providers) and `openrouterAllowFallbacks: true`.

2. **Predefined and Live Provider Catalogs**:
   - Created `OPENROUTER_PROVIDERS` catalog in `src/shared/constants.ts` with major providers (Google, Google Vertex, NVIDIA, Groq, Together, DeepInfra, Fireworks, Anthropic, OpenAI, Mistral, Hyperbolic, Lambda, SambaNova, Chutes, DeepSeek, Novita, Lepton, Amazon Bedrock, Azure, Cloudflare, Cohere, Perplexity).
   - Implemented `fetchOpenRouterProviders` in `src/shared/ai-client.ts` to query `https://openrouter.ai/api/v1/providers` dynamically with optional API key authentication.

3. **Request Body Injection**:
   - In `AIClient.chatOpenAI`: when `provider === 'openrouter'` and `openrouterProvider` is explicitly selected (non-empty and not `'auto'`), the request payload includes OpenRouter's `provider` parameter:
     ```json
     "provider": {
       "order": [openrouterProvider],
       "allow_fallbacks": openrouterAllowFallbacks
     }
     ```
   - If `openrouterProvider` is empty (`""` or `'auto'`), the `provider` block is omitted to preserve default OpenRouter load balancing.

4. **UI Integration & State Synchronization**:
   - Added "OpenRouter Provider Routing" dropdown, custom slug entry, and "Fetch Live Providers from OpenRouter" action in `src/popup/components/SettingsView.vue`.
   - Added "Allow Provider Fallbacks" toggle to give users granular control over failover behavior when pinning specific providers.
   - Persisted provider preferences seamlessly across provider tab transitions via `syncActiveToProviderSettings` and `loadProviderSettings`.

## Consequences

- Full support for OpenRouter BYOK keys and pinned upstream providers.
- Prevents unintended fallback charges when fallbacks are disabled.
- Fully backward compatible with existing settings stores and default load-balancing workflows.
