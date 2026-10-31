# timTabTool Design Guidelines

This document specifies the design architecture, visual language, component patterns, and styling standards for the timTabTool extension.

---

## 1. Core Principles

- **Minimalist Functionality**: Form strictly follows function. Visual elements organize, clarify, and facilitate tab navigation, search indexing, and AI operations without decorative distraction.
- **System-Native Interface**: Clean typography, crisp 2px border radiuses, subtle translucency, restrained borders, and neutral tonal hierarchy.
- **High Information Density**: Compact vertical pacing, tabular numbers, and clear typographic hierarchy maximize visibility within restricted extension popup viewports.
- **Fluid Micro-Interactions**: Eased transitions (`cubic-bezier(0.25, 0.1, 0.25, 1)`) and tactile state responses (`transform: scale(0.99)`) provide immediate physical feedback.
- **Theme Equivalence**: Full light and dark mode parity with semantic CSS custom properties and dynamic system theme detection.
- **Zero-Distraction Typography**: Strict prohibition of decorative emojis and promotional marketing terminology.

---

## 2. Design Tokens & Color Architecture

All interface components must utilize the CSS custom properties declared in [global.css](file:///d:/Downloads/tabpilot-v1.0.0/src/styles/global.css) and configured in [tailwind.config.ts](file:///d:/Downloads/tabpilot-v1.0.0/tailwind.config.ts). Never use hardcoded hex values, RGB values, or un-tokenized Tailwind color classes in component templates or inline styles.

### 2.1 Theme Palettes

| Token | CSS Variable | Light Mode Value | Dark Mode Value | Usage |
| :--- | :--- | :--- | :--- | :--- |
| `primary` | `--bg-primary` | `#FFFFFF` | `#000000` | Primary container background, root canvas |
| `secondary` | `--bg-secondary` | `#F5F5F7` | `#1C1C1E` | Secondary panels, chips, icon wrappers |
| `elevated` | `--bg-elevated` | `#FFFFFF` | `#2C2C2E` | Modals, flyouts, popovers, dropdown surfaces, message cards |
| `t-primary` | `--text-primary` | `#1D1D1F` | `#F5F5F7` | Primary headings, active tab labels, body copy |
| `t-secondary` | `--text-secondary` | `#86868B` | `#98989D` | Secondary text, descriptions, inactive states |
| `t-tertiary` | `--text-tertiary` | `#AEAEB2` | `#636366` | Placeholders, hotkey badges, scrollbar thumb |
| `border` | `--border` | `rgba(0, 0, 0, 0.06)` | `rgba(255, 255, 255, 0.08)` | Structural dividers, card borders |
| `accent` | `--accent` | `#007AFF` | `#0A84FF` | Primary action buttons, active tab indicators, user message bubbles |
| `accent-soft` | `--accent-soft` | `rgba(0, 122, 255, 0.1)` | `rgba(10, 132, 255, 0.15)` | Active item backgrounds, text selection, focus rings |
| `hover` | `--hover` | `rgba(0, 0, 0, 0.04)` | `rgba(255, 255, 255, 0.06)` | Row and button hover overlay |

### 2.2 Tab Group Category Colors

Tab group colors map to Chrome's native tab group color palette:

| Group Color | CSS Variable | Light Hex | Dark Hex | Tailwind Class | Semantic Usage |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Blue | `--group-blue` | `#007AFF` | `#0A84FF` | `text-g-blue`, `bg-g-blue` | General / Research categories |
| Green | `--group-green` | `#34C759` | `#30D158` | `text-g-green`, `bg-g-green` | BYOK active, Success status, Communication |
| Purple | `--group-purple` | `#AF52DE` | `#BF5AF2` | `text-g-purple`, `bg-g-purple` | Media / Design categories |
| Cyan | `--group-cyan` | `#5AC8FA` | `#64D2FF` | `text-g-cyan`, `bg-g-cyan` | Docs / Reference categories |
| Red | `--group-red` | `#FF3B30` | `#FF453A` | `text-g-red`, `bg-g-red` | Errors, Duplicates, Destructive actions |
| Yellow | `--group-yellow` | `#FF9F0A` | `#FFD60A` | `text-g-yellow`, `bg-g-yellow` | Live reasoning trace, Warnings, In-progress states |
| Pink | `--group-pink` | `#FF2D55` | `#FF375F` | `text-g-pink`, `bg-g-pink` | Social / Shopping categories |
| Grey | `--group-grey` | `#8E8E93` | `#98989D` | `text-g-grey`, `bg-g-grey` | Utilities / System / Inactive tabs |

---

## 3. Typography

### 3.1 Font Families

- **Primary UI Font Stack**:
  `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
- **Monospace Stack (Shortcuts, Code, Token Metrics, Live Reasoning)**:
  `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`

### 3.2 Hierarchy & Scale

| Level | Size | Weight | Line Height | Usage |
| :--- | :--- | :--- | :--- | :--- |
| Overlay Title / H1 | `16px` | 600 (Semibold) | 1.3 | Top-level modal headers, search input |
| Section Header / H2 | `14px` | 600 (Semibold) | 1.4 | Group titles, settings section headers |
| Body / Standard | `14px` | 400 (Regular) | 1.5 | General descriptions, settings options |
| Compact Row / Tab | `12px` | 400 (Regular) | 1.3 | Tab titles, chat messages, group item counts |
| Caption / Metadata | `11px` | 500 (Medium) | 1.2 | Domain badges, token counters, status indicators |
| Keybind / Chip | `10px` | 500 (Medium) | 1.0 | Shortcut keys (`⌘K`, `ESC`), state pills, token metrics |
| Micro Badge | `9px` | 600 (Semibold) | 1.0 | Model tags, BYOK indicators, batch counters |

---

## 4. Elevation, Radii & Geometry

### 4.1 Border Radii Hierarchy

timTabTool enforces strict 2px geometric consistency configured in [tailwind.config.ts](file:///d:/Downloads/tabpilot-v1.0.0/tailwind.config.ts):

| Token Alias | Value | Usage |
| :--- | :--- | :--- |
| `DEFAULT` | `2px` | Default fallback for all unadorned `rounded` classes |
| `rounded-xs` | `1px` | Micro indicator tags |
| `rounded-sm` | `2px` | Standard buttons, cards, tab rows, message bubbles, inputs |
| `rounded-md` | `2px` | Popovers, modal containers, flyouts |
| `rounded-lg` | `2px` | Large panels (normalized to 2px) |
| `rounded-btn` | `2px` | Action buttons, icon buttons |
| `rounded-card`| `2px` | Group cards, window cards, settings cards |
| `rounded-full`| `9999px` | Exclusively for circular elements: spinners, ping dots, toggle thumbs/tracks |

### 4.2 Shadows & Elevation

| Elevation Level | Light Mode Shadow | Dark Mode Shadow | Usage |
| :--- | :--- | :--- | :--- |
| `shadow-xs` | `0 0.5px 1px rgba(0, 0, 0, 0.04)` | `0 0.5px 1px rgba(0, 0, 0, 0.15)` | Status pills, minor chips, user bubbles |
| `shadow-sm` | `0 1px 3px rgba(0, 0, 0, 0.06), 0 0.5px 1px rgba(0, 0, 0, 0.04)` | `0 1px 3px rgba(0, 0, 0, 0.25), 0 0.5px 1px rgba(0, 0, 0, 0.15)` | Action buttons, group headers |
| `shadow-card` | `0 2px 8px rgba(0, 0, 0, 0.06), 0 0 0 0.5px rgba(0, 0, 0, 0.04)` | `0 2px 8px rgba(0, 0, 0, 0.3), 0 0 0 0.5px rgba(255, 255, 255, 0.06)` | Flyouts, hover popovers, duplicate cards |
| `search-modal` | `0 24px 80px -16px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.06)` | `0 24px 80px -16px rgba(0, 0, 0, 0.6), 0 0 0 0.5px rgba(255, 255, 255, 0.08)` | Modal command palette container |

---

## 5. Component Patterns & Layouts

### 5.1 Header & Status Bar ([App.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/App.vue))
- **Container**: `px-4 py-3`, bottom divider `0.5px solid var(--border)`.
- **Title Block**: Extension icon (`20x20px`), title label (`15px font-semibold tracking-tight`), version pill with build number.
- **Metrics Badges**: Tab, group, and window counts in `text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-sm`.
- **AI Status Indicator**:
  - *Active Operations*: Pulse-animated accent pill displaying ongoing AI task counts. Hover expands task list with per-window cancel action, batch progress, and stage tracking.
  - *Last Operation*: Soft-accent or red error pill displaying summary. Hover expands execution breakdown (tabs processed, group shifts, created group tags, execution timestamp).
- **Duplicate Badge**: Red warning badge displaying exact/possible duplicate tab counts and duplicate group clusters. Hover triggers the unified deduplication popover.

### 5.2 Multi-Window Management ([App.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/App.vue))
- **Window Header**:
  - Collapsible header bar with window title, active indicator, tab count pill, and quick actions (`Group`, `Classify`, `Chat`, `More Menu`).
  - Inline title editing via double-click on title label.
  - Context actions: Collapse/Expand all groups, toggle group titles, move tabs to active window, merge duplicates, and **Merge All Windows into Target Window**.
- **Active Window Indicator**: Distinct visual highlight for the currently focused Chrome window.

### 5.3 Tab Row ([TabItem.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/components/TabItem.vue))
- **Height / Padding**: `px-2 py-[5px]` (compact vertical spacing).
- **Structure**:
  - `16x16px` favicon container with `var(--bg-secondary)` fallback background and `rounded-sm`.
  - `12px` truncated title (`truncate flex-1 min-w-0`).
  - Contextual close action (`opacity-0 group-hover:opacity-100`), styled with red hover highlight (`hover:bg-red-500/20 hover:text-red-500`).
- **Active State**: Highlighted with `background: var(--accent-soft)` and text in `var(--accent)`.
- **Interaction**: Single click focuses tab; middle click closes tab immediately.

### 5.4 Tab Group Card ([GroupItem.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/components/GroupItem.vue))
- **Visual Modes**:
  - *Header Mode*: Distinct group card with colored category dot, group title, tab counter, split/merge action triggers, and chevron toggle.
  - *Bar Mode*: Minimalist layout with left colored border strip on tab list.
- **Accordion Transition**: Uses `.collapse-grid` CSS grid row animation (`grid-template-rows: 0fr` to `1fr` in `250ms cubic-bezier(0.25, 0.1, 0.25, 1)`).
- **AI Action Triggers**:
  - *Split Group*: Breaks large groups into specific sub-topics with live token/cost estimation tooltips.
  - *Merge Group*: Consolidates related groups.
- **Empty State**: Explicit zero-state messaging when no tabs match filter criteria.

### 5.5 Deduplication & Cleanup Popover ([App.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/App.vue))
- **Container**: Elevated card surface anchored to status badge (`w-[355px] max-h-[460px] overflow-y-auto rounded-sm`).
- **Exact Duplicates**: Listed with favicons, titles, and individual close buttons plus "Close Exact" batch trigger.
- **Possible Duplicates (URL Parameter Variations)**: Grouped by domain cluster with "Dedupe" (keep canonical) or "Group All" action triggers.
- **Duplicate Group Names**: Intra-window and cross-window duplicate group name detection with cluster merge actions.

### 5.6 Search & Command Overlay ([search-overlay.ts](file:///d:/Downloads/tabpilot-v1.0.0/src/content/search-overlay.ts), [search-overlay.css](file:///d:/Downloads/tabpilot-v1.0.0/src/content/search-overlay.css))
- **Host Context**: Injected via Shadow DOM (`z-index: 2147483647`) to prevent CSS contamination with host pages.
- **Backdrop**: Fixed full-viewport layer with `rgba(0, 0, 0, 0.65)` and `backdrop-filter: blur(2px)`.
- **Container**: Centered modal, `max-width: 580px` (or full width in standalone mode).
- **Input Field**: Large `16px` borderless input with dynamic placeholder and shortcut indicators (`⌘K`, `ESC`).
- **Result Item**: Two-line layout with tab title, domain badge, group tag, and window indicator.
- **Integrated Progress Bar**: In-overlay AI grouping progress bar with batch counter, status message, ETA timer, and standardized `2px` button controls (`Hide`, `Close`, `Stop & Apply`).
- **Domain Chips**: Scrollable quick-filter domain pills with `4px` border radius.
- **Keyboard Navigation**: Full arrow-key selection cycle (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`, `Tab`).

### 5.7 Standalone Search Page ([search.html](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/search.html), [search-page.ts](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/search-page.ts))
- **Layout**: Split-view layout featuring a 380px fixed-width timTabTool sidebar paired with a full-viewport search view.
- **Full Viewport Responsive**: Adapts automatically when opened as a dedicated browser tab or window.

### 5.8 Form Controls & Settings ([SettingsView.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/components/SettingsView.vue))
- **Inputs & Selects**: Bordered with `var(--border)`, background `var(--bg-primary)`, focus state with `3px var(--accent-soft)` ring, and `rounded-sm`.
- **Section Grouping**: Visual grouping via distinct secondary background cards with `2px` border radius.
- **Model Configuration & Provider Routing**:
  - Dynamic provider selection (OpenRouter, OpenAI, Google Gemini, Anthropic, Ollama, DeepSeek).
  - OpenRouter provider routing preferences, fallback ordering, and BYOK indicators (`var(--group-green)` status dots).
  - Free model filter toggle and safety validation.
  - Reasoning effort configuration (`auto`, `minimal`, `low`, `medium`, `high`, `max`) for thinking models.
- **Execution Logs Inspector**:
  - Detailed crash and error stack views with `rounded-sm` code blocks.
  - Token usage and cost comparison table (estimated vs actual response).
  - Raw API request and AI response inspectors with feedback-enabled clipboard copy buttons.

### 5.9 Window Chat & Tab Query Interface ([ChatView.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/components/ChatView.vue))
- **Layout Structure**: Full-height drawer/view with sticky header bar, scrollable message stream, and sticky input control dock.
- **Header Bar**:
  - Back navigation button (`rounded-sm`).
  - Title and scope indicator: Window ID badge and active tab counter.
  - Window scope dropdown: Switch between all windows (`All Windows`) and specific window target (`rounded-sm`).
  - Reasoning effort selector: Session-specific reasoning effort control (`rounded-sm`).
  - Action buttons: Clear chat history and pop out into a dedicated pinned tab.
- **Saved Prompts Bar**:
  - Horizontally scrollable chip row of user-saved prompts.
  - Chips styled with `var(--bg-elevated)`, `var(--border)`, and `rounded-sm`.
  - Quick-use trigger on text click; contextual remove button on hover (`hover:text-[var(--group-red)]`).
- **Message Architecture**:
  - *User Messages*: Right-aligned bubble, `var(--accent)` background, white text, `rounded-sm`, `shadow-xs`, max-width `85%`.
  - *Assistant Messages*: Left-aligned card surface, `bg-black/5 dark:bg-white/5`, `var(--border)` border, `rounded-sm`, max-width `95%`.
  - *Interactive Tab Links*: Markdown links to window tabs render in `var(--accent)`. Clicking activates the tab and focuses the window; visited links transition to strike-through with `var(--text-secondary)`.
  - *Request & Reasoning Inspector*: Collapsible toggle (`showDetails`) displaying the model reasoning trace in a `rounded-sm` monospace container and full request prompt with a copy button.
- **Real-Time Token Streaming & Feedback**:
  - *Active Status Bar*: Displays streaming model name, elapsed timer in seconds (`(elapsedMs / 1000).toFixed(1)s`), and active spinner.
  - *Live Reasoning Box*: Border-dashed container with yellow indicator (`var(--group-yellow)`) streaming thinking thoughts in real-time.
  - *Streaming Markdown*: Incremental token rendering with pulsing accent typing cursor (`w-1.5 h-3.5 bg-accent animate-pulse`).
  - *Cancellation Trigger*: Prominent "Stop Generating" button with elapsed timer and `var(--group-red)` styling for immediate abort.

---

## 6. Motion & Interaction Specifications

- **Standard Timing Function**: `cubic-bezier(0.25, 0.1, 0.25, 1)` (smooth easing curve).
- **Transition Durations**:
  - Standard hover / focus / active states: `200ms`.
  - Accordion expand / collapse: `250ms`.
  - Overlay open / close fade: `150ms` to `200ms`.
- **Tactile Feedback**: Interactive buttons, tab rows, and prompt chips scale to `0.99` on `:active`.
- **Focus Rings**: Standardized outline-free focus ring using `box-shadow: 0 0 0 3px var(--accent-soft)`.

---

## 7. Accessibility & Usability Directives

- **Contrast Ratios**: Maintain WCAG AA compliance (minimum 4.5:1 for normal text, 3:1 for large text and UI components).
- **Keyboard Operability**:
  - All interactive elements must receive visible `:focus-visible` styling.
  - Command palette and search overlay support full keyboard traversal without requiring mouse pointer positioning.
- **Screen Smoothing**: Enforce `-webkit-font-smoothing: antialiased` and `-moz-osx-font-smoothing: grayscale` across root contexts.
- **Scrollbar Styling**: Discrete 5px scrollbar thumb with transparent track; thumb matches `var(--text-tertiary)` with hover state transition.

---

## 8. Anti-Patterns & Prohibited Practices

- **No Arbitrary Radii**: Do not use large border radiuses (`rounded-lg`, `rounded-xl`, `rounded-2xl`, or `rounded-full` on rectangular surfaces). Enforce strict `2px` (`rounded-sm`).
- **No Emojis**: Do not use decorative or pictorial emojis anywhere in UI copy, placeholders, dropdown options, or status indicators.
- **No Prohibited Terminology**: Never use promotional marketing terms or tiered monetization labels.
- **No Pure Colored Borders**: Avoid high-contrast pure colored borders or neon glowing outlines. Use tokenized rgba borders (`var(--border)`).
- **No Hardcoded Values**: Do not hardcode HEX, RGB, or HSL values inside component styles or inline templates. Use tokenized variables.
- **No Gradient Text**: Do not use gradient text fills across headers or titles.
- **No Abrupt Layout Shifts**: Size and visibility transitions must be governed by standard timing functions.
- **No Remote Network Assets**: All fonts, icons, and stylesheets must be packaged locally within the extension.
