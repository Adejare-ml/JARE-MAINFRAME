## 2026-09-05 - Accessible Icon Buttons in Lists
**Learning:** Icon-only buttons in mapped lists (like wallets) need dynamic `aria-label`s (e.g., `Edit ${w.name}`) to give screen reader users context of what they are acting on, rather than just reading 'Edit' repeatedly. Proper roles and state tracking (like `role="switch"` and `aria-checked`) are also critical for custom toggle components.
**Action:** Always include item context in ARIA labels for actions within lists and map semantic HTML roles to custom interactive UI elements.
