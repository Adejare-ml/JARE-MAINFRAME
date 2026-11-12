💡 What:
- Added explicit `type="button"` attributes to 12 non-submitting action buttons in `QuickLog.jsx` (such as navigation controls, tab switchers, and the close button).
- Added `aria-live="polite"` and `.sr-only` descriptions to the "Log It / Move It" submit button to announce loading and success states.
- Wrapped emojis in `QuickLog` tabs inside `<span aria-hidden="true">` elements.

🎯 Why:
- React buttons default to `type="submit"`. Adding `type="button"` ensures no accidental form submissions or page reloads occur when standard UI buttons are interacted with.
- Enhances the accessibility experience by providing audible feedback to screen readers when async submission actions (loading, success) take place.
- Prevents screen readers from redundantly announcing emojis, simplifying the auditory layout of transaction type tabs.

📸 Before/After:
No visual changes; UX enhancements are entirely structural (type attributes) and accessible (screen reader annotations).

♿ Accessibility:
- Added explicit state announcements (`Logging transaction...`, `Successfully logged`) dynamically.
- Hid decorative elements to reduce screen reader clutter.
- Explicitly marked button types to strictly enforce intended behaviors.
