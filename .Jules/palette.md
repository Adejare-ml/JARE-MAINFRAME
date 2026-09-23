
## 2024-05-18 - Icon-only buttons
**Learning:** Icon-only close buttons (like '✕') lack inherent context for screen readers. While obvious visually, they are completely silent to assistive technology.
**Action:** Always verify icon-only buttons have an `aria-label` describing their action (e.g. `aria-label="Close"`).
