## 2026-10-10 - Added ARIA labels to Daily HQ tasks
**Learning:** The 'Change why' and 'Say what got in the way' buttons for daily tasks lacked contextual aria-labels, making them confusing for screen readers when multiple tasks are present on the page.
**Action:** Added task-specific `aria-label` attributes to these buttons in `EndOfDay.jsx` and `TodayList.jsx` to provide context about which task is being addressed.

## 2024-05-19 - ARIA Tab Patterns in Jare Mainframe
**Learning:** Custom tab implementations often omit the `aria-controls` bindings and corresponding `tabpanel` structures, limiting screen reader context.
**Action:** When updating tabbed interfaces across this repository, ensure `tablist` containers have explicitly linked `tab` and `tabpanel` roles utilizing `aria-controls` and `aria-labelledby` attributes.
