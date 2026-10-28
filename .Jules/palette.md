## 2026-10-10 - Added ARIA labels to Daily HQ tasks
**Learning:** The 'Change why' and 'Say what got in the way' buttons for daily tasks lacked contextual aria-labels, making them confusing for screen readers when multiple tasks are present on the page.
**Action:** Added task-specific `aria-label` attributes to these buttons in `EndOfDay.jsx` and `TodayList.jsx` to provide context about which task is being addressed.

## 2024-05-19 - ARIA Tab Patterns in Jare Mainframe
**Learning:** Custom tab implementations often omit the `aria-controls` bindings and corresponding `tabpanel` structures, limiting screen reader context.
**Action:** When updating tabbed interfaces across this repository, ensure `tablist` containers have explicitly linked `tab` and `tabpanel` roles utilizing `aria-controls` and `aria-labelledby` attributes.

## 2024-05-18 - Accessibility on Custom Tabs
**Learning:** Custom tab implementations without standard accessible roles make it difficult or impossible for screen readers to understand the structure. Screen readers don't know it's a tab list or how many tabs exist, nor which panel the tab controls.
**Action:** When implementing custom tabs with standard buttons, always ensure the container has `role="tablist"` and each tab has `role="tab"`. Also, provide `aria-selected` matching the active state, `aria-controls` referencing the ID of the controlled panel, and set the panel's `role="tabpanel"`.

## 2026-10-10 - Added ARIA labels to Daily HQ tasks
**Learning:** The 'Change why' and 'Say what got in the way' buttons for daily tasks lacked contextual aria-labels, making them confusing for screen readers when multiple tasks are present on the page.
**Action:** Added task-specific `aria-label` attributes to these buttons in `EndOfDay.jsx` and `TodayList.jsx` to provide context about which task is being addressed.

## 2024-05-19 - ARIA Tab Patterns in Jare Mainframe
**Learning:** Custom tab implementations often omit the `aria-controls` bindings and corresponding `tabpanel` structures, limiting screen reader context.
**Action:** When updating tabbed interfaces across this repository, ensure `tablist` containers have explicitly linked `tab` and `tabpanel` roles utilizing `aria-controls` and `aria-labelledby` attributes.

## 2024-05-24 - QuickLog Tabs Missing ARIA Roles and Labels
**Learning:** The QuickLog component uses `role="tab"` but lacks proper `aria-controls` and `id` associations, reducing clarity for screen reader users on what each tab controls.
**Action:** Enhance accessibility by ensuring `role="tab"` buttons are semantically complete or stick to simple buttons with appropriate labels if tab panels are not explicitly used.

## 2024-05-24 - Adding Complete ARIA Semantics for Tabs
**Learning:** Buttons acting as tabs without explicit `tablist`, `tab`, and `tabpanel` roles, along with proper associations (`aria-controls`, `aria-labelledby`), lack context for screen reader users.
**Action:** Ensure custom tab implementations are correctly wrapped in a `tablist` and corresponding content is housed in an associated `tabpanel`.

## 2026-10-25 - ARIA Selection States on Custom Option Buttons
**Learning:** Custom selection or toggle buttons inside components (like QuickLog's category, wallet, and tag pickers) often lack `aria-pressed` states and explicit `type="button"` attributes, leaving screen readers unaware of the active selection and risking accidental form submissions.
**Action:** When auditing custom selection lists, ensure the selected state is conveyed via `aria-pressed={true/false}` on each button, and that `type="button"` is explicitly set to prevent unintended default behaviors.

## 2026-10-25 - ARIA Tab Patterns with Dynamic Rendered Panels
**Learning:** In tab interfaces where the tab content (tabpanel) is dynamically replaced instead of toggled, setting `aria-controls` on the tabs to point to dynamically changing IDs based on the active tab creates broken references for inactive tabs.
**Action:** Ensure that the `tabpanel` container has a stable, persistent `id` and all `tab` buttons point their `aria-controls` to this single stable ID. The `aria-labelledby` on the tabpanel should dynamically update to match the active tab.
