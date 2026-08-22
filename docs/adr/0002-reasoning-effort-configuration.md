# ADR 0002: Reasoning Effort Configuration for Thinking and Chain-of-Thought Models

## Status
Accepted

## Context
Complex reasoning models (such as \stealth/ox-alpha\, \deepseek/deepseek-r1\, \openai/o1\, and \openai/o3-mini\) default to maximum chain-of-thought intensity. When categorizing large batches of tabs (e.g., 50–200 tabs), these models generate thousands of internal reasoning tokens, causing latency spikes of up to 4+ minutes per request.

Both OpenRouter (\easoning: { effort: 'minimal' | 'low' | 'medium' | 'high' | 'max' }\) and OpenAI (\easoning_effort: 'low' | 'medium' | 'high'\) expose parameters to calibrate deliberation depth and token budgets.

## Decision
1. **Model & Provider Agnostic Configuration**: Add \easoningEffort\ (\'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'max'\) to \AIConfig\ and \ProviderSettings\.
2. **Payload Injection**:
   - For \openrouter\: Inject \easoning: { effort: config.reasoningEffort }\ when set and not \'auto'\.
   - For \openai\: Inject \easoning_effort: config.reasoningEffort\ when set and not \'auto'\.
   - For standard models: Omit reasoning parameters when set to \'auto'\ to maintain standard behavior.
3. **Per-Provider Memory**: Store \easoningEffort\ independently per provider snapshot in \ProviderSettings\.

## Consequences
- **Positive**: Users can reduce reasoning latency on models like \stealth/ox-alpha\ by 70–85% by selecting \Minimal\ or \Low\ effort.
- **Positive**: Settings persist seamlessly across provider switches without manual re-configuration.
- **Negative**: Non-reasoning models ignore the parameter or may return a warning if passed directly, mitigated by only passing when configured.
