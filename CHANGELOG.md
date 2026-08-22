# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- OpenRouter as a first-class AI provider option with default endpoint `https://openrouter.ai/api/v1` and default model `openai/gpt-4o-mini`.
- Predefined model catalog for OpenRouter including OpenAI, Claude, Gemini, DeepSeek, Meta Llama, Qwen, and Mistral models.
- Live model discovery function `fetchOpenRouterModels` and "Fetch Live Models from OpenRouter" button in Settings.
- Per-provider settings memory: switching providers preserves each provider's API keys, endpoints, models, token limits, and batch sizes in `providerSettings`.
- Unit test suite for OpenRouter API requests, model fetching, cost estimations, and provider state persistence.
- Architecture Decision Record `docs/adr/0001-openrouter-and-per-provider-settings.md`.

### Changed
- `AIConfig` interface updated to include `AIProvider` union and `providerSettings` snapshot dictionary.
- Search overlay model switcher and provider detection updated to support OpenRouter models.
- Background worker `getAIOverrides` and `GET_SETTINGS` updated to handle OpenRouter and merge `providerSettings`.
