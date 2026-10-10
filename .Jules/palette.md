## 2026-10-10 - Added ARIA labels to Daily HQ tasks
**Learning:** The 'Change why' and 'Say what got in the way' buttons for daily tasks lacked contextual aria-labels, making them confusing for screen readers when multiple tasks are present on the page.
**Action:** Added task-specific `aria-label` attributes to these buttons in `EndOfDay.jsx` and `TodayList.jsx` to provide context about which task is being addressed.
