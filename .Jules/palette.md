## 2024-05-18 - Input Labeling in Forms
**Learning:** Some inputs like Note in QuickLog are using `label` elements as visual text but don't properly link to the `input` using `htmlFor` and an `id`, hurting screen reader accessibility.
**Action:** Always link a `label` to an `input` using an `htmlFor` prop that matches the input's `id`.
