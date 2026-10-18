## 2026-10-10 - Added ARIA labels to Daily HQ tasks
**Learning:** The 'Change why' and 'Say what got in the way' buttons for daily tasks lacked contextual aria-labels, making them confusing for screen readers when multiple tasks are present on the page.
**Action:** Added task-specific `aria-label` attributes to these buttons in `EndOfDay.jsx` and `TodayList.jsx` to provide context about which task is being addressed.

## 2024-05-19 - ARIA Tab Patterns in Jare Mainframe
**Learning:** Custom tab implementations often omit the `aria-controls` bindings and corresponding `tabpanel` structures, limiting screen reader context.
**Action:** When updating tabbed interfaces across this repository, ensure `tablist` containers have explicitly linked `tab` and `tabpanel` roles utilizing `aria-controls` and `aria-labelledby` attributes.

## 2024-05-18 - Accessibility on Custom Tabs
**Learning:** Custom tab implementations without standard accessible roles make it difficult or impossible for screen readers to understand the structure. Screen readers don't know it's a tab list or how many tabs exist, nor which panel the tab controls.
**Action:** When implementing custom tabs with standard buttons, always ensure the container has `role="tablist"` and each tab has `role="tab"`. Also, provide `aria-selected` matching the active state, `aria-controls` referencing the ID of the controlled panel, and set the panel's `role="tabpanel"`.
