## 2024-05-20 - Missing ARIA Labels on Icon-only Buttons
**Learning:** Found multiple instances where icon-only buttons (like edit, delete, activate, and close buttons) in `src/pages/Settings.jsx` lacked proper `aria-label` attributes. Screen readers would just read out the emoji or have no context. Adding ARIA labels to these buttons drastically improves accessibility for non-visual users.
**Action:** Always add `aria-label` attributes to icon-only buttons to clearly describe the action they perform.
