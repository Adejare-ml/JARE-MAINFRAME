## 2026-09-03 - Unreviewed indicator accessibility
**Learning:** Status indicators that are purely visual (like a colored dot) require visually hidden text (e.g. `<span className="sr-only">Text</span>`) so screen readers can convey the status. The visual element itself should be marked with `aria-hidden="true"`.
**Action:** When adding visual indicators like notification badges or unread dots, always pair them with visually hidden text and hide the decorative element from screen readers.
