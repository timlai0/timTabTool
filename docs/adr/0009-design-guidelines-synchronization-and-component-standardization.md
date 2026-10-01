# 9. Design Guidelines Synchronization and Component Standardization

Date: 2026-09-10

## Status

Accepted

## Context

As the TabPilot extension evolved with features such as Window Chat (`ChatView.vue`), live reasoning streaming, multi-window consolidation, provider routing badges, and enhanced search overlay progress mechanisms, several UI inconsistencies emerged:
1. `docs/DESIGN_GUIDELINES.md` lacked formal design specifications for Window Chat, live reasoning stream cards, saved prompt chips, multi-window actions, and provider routing tokens.
2. `ChatView.vue` contained arbitrary border radii (`rounded-lg`, `rounded-full` on rectangular chips, unadorned `rounded`), hardcoded colors (`bg-blue-500`, `text-blue-500`, `text-amber-500`, `bg-red-500/20`, `text-red-500`, `bg-[#1a1a1a]`, `text-gray-400`), and decorative emojis (`🌐`).
3. `SettingsView.vue` contained unadorned `rounded` classes in execution log cards and stack trace displays.
4. `App.vue` contained a `rounded-md` class on the duplicates popover card.
5. `src/content/search-overlay.css` utilized non-standard button radii (`border-radius: 6px;`) and an oversized domain chip radius (`12px`).
6. Prohibited marketing terminology appeared within code comments in the search overlay.

## Decision

1. **Comprehensive Design Guidelines Specification**:
   - Updated `docs/DESIGN_GUIDELINES.md` with full component specifications for `ChatView.vue` (header, scope selector, saved prompt chips, user and assistant message bubbles, request/reasoning inspector, live token streaming, and cancellation controls).
   - Documented live thought and reasoning preview conventions using `--group-yellow`.
   - Documented multi-window consolidation patterns, deduplication cluster cards, and OpenRouter provider routing badges.
   - Enforced zero-emoji and zero prohibited marketing terminology directives.

2. **Tailwind Geometric Configuration**:
   - Configured `DEFAULT: '2px'`, `xs: '1px'`, `sm: '2px'`, `md: '2px'`, `lg: '2px'`, `card: '2px'`, and `btn: '2px'` in `tailwind.config.ts`. This ensures any unadorned or standard Tailwind radius class resolves to the Apple-native 2px system geometry.

3. **Component Refactoring**:
   - Refactored `ChatView.vue` to strictly adhere to design tokens (`var(--accent)`, `var(--text-secondary)`, `var(--group-yellow)`, `var(--group-red)`, `var(--bg-primary)`, `var(--text-primary)`, `var(--bg-elevated)`), replaced all arbitrary radii with `rounded-sm`, purged the globe emoji in favor of clean technical text ("All Windows"), and tokenized interactive markdown link states.
   - Standardized execution log containers, error cards, and stack trace blocks in `SettingsView.vue` to `rounded-sm`.
   - Standardized the duplicates popover card in `App.vue` to `rounded-sm`.
   - Standardized progress bar button radii to `2px` and domain chips to `4px` in `src/content/search-overlay.css`.
   - Purged all occurrences of prohibited marketing terminology.

## Consequences

- 100% visual consistency and adherence to the 2px geometric system native to TabPilot.
- Full token parity across light and dark modes with zero hardcoded values.
- Clean, clinical, and enterprise-grade design guidelines synchronized with the implementation.
