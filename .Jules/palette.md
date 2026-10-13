## 2024-05-24 - QuickLog Tabs Missing ARIA Roles and Labels
**Learning:** The QuickLog component uses `role="tab"` but lacks proper `aria-controls` and `id` associations, reducing clarity for screen reader users on what each tab controls.
**Action:** Enhance accessibility by ensuring `role="tab"` buttons are semantically complete or stick to simple buttons with appropriate labels if tab panels are not explicitly used.

## 2024-05-24 - Adding Complete ARIA Semantics for Tabs
**Learning:** Buttons acting as tabs without explicit `tablist`, `tab`, and `tabpanel` roles, along with proper associations (`aria-controls`, `aria-labelledby`), lack context for screen reader users.
**Action:** Ensure custom tab implementations are correctly wrapped in a `tablist` and corresponding content is housed in an associated `tabpanel`.
