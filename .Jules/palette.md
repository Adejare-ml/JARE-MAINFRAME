## 2025-05-18 - Missing label form associations and ARIA labels on common elements
**Learning:** Even frequently used forms (like the QuickLog modal) can suffer from missing structural accessibility features (e.g., input lack IDs, label lacks htmlFor, close button lacks aria-label) despite using standard modal components.
**Action:** When working on complex modals or dialogs, actively check if every input is explicitly associated with a label, and that all icon-only action buttons (like Close) possess screen-reader-friendly labels.
