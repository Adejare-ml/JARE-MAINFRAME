## 2024-05-18 - Aria-pressed on custom toggle buttons
**Learning:** Screen readers cannot infer selection state from CSS styling or standard React state alone when building pseudo-radio or toggle button groups from generic `<button>` elements.
**Action:** Always apply `aria-pressed={true|false}` to buttons acting as toggles or single-select grid options.
