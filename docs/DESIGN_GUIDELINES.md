# TabPilot Design Guidelines

This document specifies the design architecture, visual language, component patterns, and styling standards for the TabPilot extension.

---

## 1. Core Principles

- **Minimalist Functionality**: Form strictly follows function. Visual elements organize, clarify, and facilitate tab navigation and AI operations without decorative distraction.
- **System-Native Interface**: Clean typography, crisp 2px border radiuses, subtle translucency, restrained borders, and neutral tonal hierarchy.
- **High Information Density**: Compact vertical pacing and clear typographic hierarchy maximize visibility within restricted extension popup viewports.
- **Fluid Micro-Interactions**: Eased transitions (`cubic-bezier(0.25, 0.1, 0.25, 1)`) and tactile state responses (`transform: scale(0.99)`) provide immediate physical feedback.
- **Theme Equivalence**: Full light and dark mode parity with semantic CSS custom properties and dynamic system theme detection.

---

## 2. Design Tokens & Color Architecture

All interface components must utilize the CSS custom properties declared in [global.css](file:///d:/Downloads/tabpilot-v1.0.0/src/styles/global.css) and configured in [tailwind.config.ts](file:///d:/Downloads/tabpilot-v1.0.0/tailwind.config.ts). Never use hardcoded hex values in component templates or inline styles.

### 2.1 Theme Palettes

| Token | CSS Variable | Light Mode Value | Dark Mode Value | Usage |
| :--- | :--- | :--- | :--- | :--- |
| `primary` | `--bg-primary` | `#FFFFFF` | `#000000` | Primary container background, root canvas |
| `secondary` | `--bg-secondary` | `#F5F5F7` | `#1C1C1E` | Secondary panels, chips, icon wrappers |
| `elevated` | `--bg-elevated` | `#FFFFFF` | `#2C2C2E` | Modals, flyouts, popovers, dropdown surfaces |
| `t-primary` | `--text-primary` | `#1D1D1F` | `#F5F5F7` | Primary headings, active tab labels |
| `t-secondary` | `--text-secondary` | `#86868B` | `#98989D` | Secondary text, descriptions, inactive states |
| `t-tertiary` | `--text-tertiary` | `#AEAEB2` | `#636366` | Placeholders, hotkey badges, scrollbar thumb |
| `border` | `--border` | `rgba(0, 0, 0, 0.06)` | `rgba(255, 255, 255, 0.08)` | Structural dividers, card borders |
| `accent` | `--accent` | `#007AFF` | `#0A84FF` | Primary action buttons, active tab indicators |
| `accent-soft` | `--accent-soft` | `rgba(0, 122, 255, 0.1)` | `rgba(10, 132, 255, 0.15)` | Active item backgrounds, text selection, focus rings |
| `hover` | `--hover` | `rgba(0, 0, 0, 0.04)` | `rgba(255, 255, 255, 0.06)` | Row and button hover overlay |

### 2.2 Tab Group Category Colors

Tab group colors map to Chrome's native tab group color palette:

| Group Color | CSS Variable | Light Hex | Dark Hex | Tailwind Class |
| :--- | :--- | :--- | :--- | :--- |
| Blue | `--group-blue` | `#007AFF` | `#0A84FF` | `text-g-blue`, `bg-g-blue` |
| Green | `--group-green` | `#34C759` | `#30D158` | `text-g-green`, `bg-g-green` |
| Purple | `--group-purple` | `#AF52DE` | `#BF5AF2` | `text-g-purple`, `bg-g-purple` |
| Cyan | `--group-cyan` | `#5AC8FA` | `#64D2FF` | `text-g-cyan`, `bg-g-cyan` |
| Red | `--group-red` | `#FF3B30` | `#FF453A` | `text-g-red`, `bg-g-red` |
| Yellow | `--group-yellow` | `#FF9F0A` | `#FFD60A` | `text-g-yellow`, `bg-g-yellow` |
| Pink | `--group-pink` | `#FF2D55` | `#FF375F` | `text-g-pink`, `bg-g-pink` |
| Grey | `--group-grey` | `#8E8E93` | `#98989D` | `text-g-grey`, `bg-g-grey` |

---

## 3. Typography

### 3.1 Font Families

- **Primary UI Font Stack**:
  `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
- **Monospace Stack (Shortcuts, Code, Token Metrics)**:
  `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`

### 3.2 Hierarchy & Scale

| Level | Size | Weight | Line Height | Usage |
| :--- | :--- | :--- | :--- | :--- |
| Overlay Title / H1 | `16px` | 600 (Semibold) | 1.3 | Top-level modal headers, search input |
| Section Header / H2 | `14px` | 600 (Semibold) | 1.4 | Group titles, settings section headers |
| Body / Standard | `14px` | 400 (Regular) | 1.5 | General descriptions, settings options |
| Compact Row / Tab | `12px` | 400 (Regular) | 1.3 | Tab titles, group item counts, breadcrumbs |
| Caption / Metadata | `11px` | 500 (Medium) | 1.2 | Domain badges, token counters, status indicators |
| Keybind / Chip | `10px` | 500 (Medium) | 1.0 | Shortcut keys (`⌘K`, `ESC`), state pills |

---

## 4. Elevation, Radii & Geometry

### 4.1 Border Radii

TabPilot enforces strict geometric consistency:
- **Buttons (`rounded-btn` / `rounded-sm`)**: `2px`
- **Cards & Containers (`rounded-card` / `rounded-sm`)**: `2px`
- **Pills / Badges**: `2px` to `4px`
- **Favicon Containers**: `2px`

### 4.2 Shadows & Elevation

| Elevation Level | Light Mode Shadow | Dark Mode Shadow | Usage |
| :--- | :--- | :--- | :--- |
| `shadow-xs` | `0 0.5px 1px rgba(0, 0, 0, 0.04)` | `0 0.5px 1px rgba(0, 0, 0, 0.15)` | Status pills, minor chips |
| `shadow-sm` | `0 1px 3px rgba(0, 0, 0, 0.06), 0 0.5px 1px rgba(0, 0, 0, 0.04)` | `0 1px 3px rgba(0, 0, 0, 0.25), 0 0.5px 1px rgba(0, 0, 0, 0.15)` | Action buttons, group headers |
| `shadow-card` | `0 2px 8px rgba(0, 0, 0, 0.06), 0 0 0 0.5px rgba(0, 0, 0, 0.04)` | `0 2px 8px rgba(0, 0, 0, 0.3), 0 0 0 0.5px rgba(255, 255, 255, 0.06)` | Flyouts, hover popovers, duplicate cards |
| `search-modal` | `0 24px 80px -16px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.06)` | `0 24px 80px -16px rgba(0, 0, 0, 0.6), 0 0 0 0.5px rgba(255, 255, 255, 0.08)` | Modal command palette container |

---

## 5. Component Patterns & Layouts

### 5.1 Header & Status Bar ([App.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/App.vue))
- **Container**: `px-4 py-3`, bottom divider `0.5px solid var(--border)`.
- **Title Block**: Extension icon (`20x20px`), title label (`15px font-semibold tracking-tight`), version pill with build number.
- **Metrics Badges**: Tab, group, and window counts in `text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-md`.
- **AI Status Indicator**:
  - *Active Operations*: Pulse-animated accent pill displaying ongoing AI task counts. Hover expands task list with per-window cancel action.
  - *Last Operation*: Soft-accent or red error pill displaying summary. Hover expands execution breakdown (tabs processed, group shifts, created group tags, execution timestamp).
- **Duplicate Badge**: Red warning badge displaying exact/possible duplicate tab counts and duplicate group clusters. Hover triggers the unified deduplication popover.

### 5.2 Multi-Window Management ([App.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/App.vue))
- **Window Header**:
  - Collapsible header bar with window title, active indicator, tab count pill, and quick actions (`Group`, `Classify`, `More Menu`).
  - Inline title editing via double-click on title label.
  - Context actions: Collapse/Expand all groups, toggle group titles, move tabs to active window, merge duplicates.
- **Active Window Indicator**: Distinct visual highlight for the currently focused Chrome window.

### 5.3 Tab Row ([TabItem.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/components/TabItem.vue))
- **Height / Padding**: `px-2 py-[5px]` (compact vertical spacing).
- **Structure**:
  - `16x16px` favicon container with `var(--bg-secondary)` fallback background.
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
- **Container**: Elevated card surface anchored to status badge (`w-[320px] max-h-[320px] overflow-y-auto`).
- **Exact Duplicates**: Listed with favicons, titles, and individual close buttons plus "Close Exact" batch trigger.
- **Possible Duplicates (URL Parameter Variations)**: Grouped by domain cluster with "Dedupe" (keep canonical) or "Group All" action triggers.
- **Duplicate Group Names**: Cross-window and intra-window duplicate group name detection with merge actions.

### 5.6 Search & Command Overlay ([search-overlay.ts](file:///d:/Downloads/tabpilot-v1.0.0/src/content/search-overlay.ts), [search-overlay.css](file:///d:/Downloads/tabpilot-v1.0.0/src/content/search-overlay.css))
- **Host Context**: Injected via Shadow DOM (`z-index: 2147483647`) to prevent CSS contamination with host pages.
- **Backdrop**: Fixed full-viewport layer with `rgba(0, 0, 0, 0.65)` and `backdrop-filter: blur(2px)`.
- **Container**: Centered modal, `max-width: 580px` (or full width in standalone mode).
- **Input Field**: Large `16px` borderless input with dynamic placeholder and shortcut indicators (`⌘K`, `ESC`).
- **Result Item**: Two-line layout with tab title, domain badge, group tag, and window indicator.
- **Progress Banner**: In-overlay AI grouping progress bar with batch counter, status message, ETA timer, and cancel/hide controls.
- **Keyboard Navigation**: Full arrow-key selection cycle (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`, `Tab`).

### 5.7 Standalone Search Page ([search.html](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/search.html), [search-page.ts](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/search-page.ts))
- **Layout**: Split-view layout featuring a 380px fixed-width TabPilot sidebar paired with a full-viewport search view.
- **Full Viewport Responsive**: Adapts automatically when opened as a dedicated browser tab or window.

### 5.8 Form Controls & Settings ([SettingsView.vue](file:///d:/Downloads/tabpilot-v1.0.0/src/popup/components/SettingsView.vue))
- **Inputs & Selects**: Bordered with `var(--border)`, background `var(--bg-primary)`, focus state with `3px var(--accent-soft)` ring.
- **Section Grouping**: Visual grouping via distinct secondary background cards with `2px` border radius.
- **Model Configuration**: Clear provider selection, API key inputs with visibility toggle, custom model inputs, temperature sliders, and live pricing/context summaries.

---

## 6. Motion & Interaction Specifications

- **Standard Timing Function**: `cubic-bezier(0.25, 0.1, 0.25, 1)` (smooth easing curve).
- **Transition Durations**:
  - Standard hover / focus / active states: `200ms`.
  - Accordion expand / collapse: `250ms`.
  - Overlay open / close fade: `150ms` to `200ms`.
- **Tactile Feedback**: Interactive buttons and tab rows scale to `0.99` on `:active`.
- **Focus Rings**: Standardized outline-free focus ring using `box-shadow: 0 0 0 3px var(--accent-soft)`.

---

## 7. Accessibility & Usability Directives

- **Contrast Ratios**: Maintain WCAG AA compliance (minimum 4.5:1 for normal text, 3:1 for large text and UI components).
- **Keyboard Operability**:
  - All interactive elements must receive visible `:focus-visible` styling.
  - Command palette supports full keyboard traversal without requiring mouse pointer positioning.
- **Screen Smoothing**: Enforce `-webkit-font-smoothing: antialiased` and `-moz-osx-font-smoothing: grayscale` across root contexts.
- **Scrollbar Styling**: Discrete 5px scrollbar thumb with transparent track; thumb matches `var(--text-tertiary)` with hover state transition.

---

## 8. Anti-Patterns & Prohibited Practices

- Do not use arbitrary large border radiuses (`rounded-xl`, `rounded-2xl`, `rounded-full` on rectangular surfaces).
- Do not use pure colored borders or glowing neon outlines.
- Do not hardcode HEX, RGB, or HSL values inside component styles. Use tokenized variables.
- Do not use gradient text fills across headers.
- Do not alter layout structures abruptly; all size changes must be transition-governed.
- Do not load external network assets (fonts, icons, stylesheets) dynamically in popup or content contexts; all resources must be packaged locally.
