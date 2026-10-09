# ADR 0014: Background Service Worker and Shared Utilities Decomposition

## Status
Accepted

## Context
1. **Monolithic Service Worker & Tab Manager**:
   `src/background/tab-manager.ts` expanded beyond 3,400 lines and `src/background/index.ts` beyond 1,200 lines, violating Single Responsibility and the Rule of 30. Background operations (tab querying, grouping, sorting, duplicate detection, message routing, IPC broadcasting, and AI runners) were coupled in monolithic files, hindering maintainability and testability.
2. **Bundler DAG Invariants & Circular Dependencies**:
   `src/shared/utils.ts` contained URL normalization, string sanitization, and heavy duplicate detection logic. When downstream modules imported utilities while `utils.ts` imported domain entities, circular chunk references emerged during Rollup/Vite code splitting.
3. **Provider Logic Coupling**:
   Model fetching, pricing, BYOK metadata querying, and provider capabilities were tangled inside `src/shared/ai-client.ts`.

## Decision
1. **Decompose Background Modules**:
   - Extract message routing into `src/background/message-router.ts`.
   - Extract IPC broadcasting and dual-channel message routing into `src/background/ipc-broadcast.ts`.
   - Extract preview caching and auto-extension debouncing into `src/background/cache/preview-cache.ts`.
   - Extract atomic tab operations (querying, moving, grouping, closing, pinning) into `src/background/tabs/tab-query-actions.ts`, `tab-window-actions.ts`, and `ai-tab-operations.ts`.
   - Retain lightweight facades in `src/background/index.ts` and `src/background/tab-manager.ts` for backward compatibility.
2. **Leaf Module Isolation for Shared Utilities**:
   - Decompose `src/shared/utils.ts` into dedicated leaf modules: `src/shared/url-utils.ts` (URL sanitization, tracking parameter stripping, SPA hash preservation) and `src/shared/duplicate-detector.ts` (keeper tab scoring, cluster building, duplicate detection).
   - Re-export primitives via facade in `src/shared/utils.ts` while enforcing strict Directed Acyclic Graph (DAG) dependencies.
3. **Extract AI Provider Services**:
   - Isolate OpenRouter and Google model retrieval, pricing dictionaries, and BYOK metadata handling into `src/shared/ai-providers.ts`.

## Consequences
- **Positive**: Clear separation of concerns conforming to SRP and Rule of 30.
- **Positive**: Prevents bundler circular dependencies and improves tree-shaking across Vite chunks.
- **Positive**: Modular, isolated unit testing for individual tab operations and utility modules.
