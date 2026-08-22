# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- OpenRouter as a first-class AI provider option with default endpoint `https://openrouter.ai/api/v1` and default model `openai/gpt-4o-mini`.
- OpenRouter "Only Allow Free Models" toggle setting (`openRouterOnlyFree`) to restrict model selection, live discovery, and API requests to free models (e.g. `stealth/ox-alpha`, `:free` models).
- Predefined model catalog for OpenRouter including free models (`stealth/ox-alpha`, `meta-llama/llama-3.3-70b-instruct:free`, `deepseek/deepseek-r1:free`, `deepseek/deepseek-chat:free`, `google/gemini-2.0-flash-exp:free`, `google/gemini-2.0-flash-thinking-exp:free`, `qwen/qwen-2.5-coder-32b-instruct:free`, `mistralai/mistral-small-24b-instruct-2501:free`).
- Live model discovery function `fetchOpenRouterModels` with `onlyFree` filtering and "Fetch Live Models from OpenRouter" button in Settings.
- Per-provider settings memory: switching providers preserves each provider's API keys, endpoints, models, token limits, and batch sizes in `providerSettings`.
- Reasoning Effort dropdown setting (`auto`, `minimal`, `low`, `medium`, `high`, `max`) to control deliberation depth and reduce latency for thinking / chain-of-thought models (e.g. `stealth/ox-alpha`, `o3-mini`, `o1`).
- Architecture Decision Records `docs/adr/0001-openrouter-and-per-provider-settings.md` and `docs/adr/0002-reasoning-effort-configuration.md`.
- Unit test suite for OpenRouter API requests, model fetching, cost estimations, provider state persistence, and reasoning effort parameter injection.

### Changed
- `AIConfig` interface updated to include `AIProvider` union, `openRouterOnlyFree`, `reasoningEffort`, and `providerSettings` snapshot dictionary.
- Search overlay model switcher and provider detection updated to support OpenRouter models.
- Background worker `getAIOverrides` and `GET_SETTINGS` updated to handle OpenRouter and merge `providerSettings`.
