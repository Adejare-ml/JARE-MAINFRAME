// Flat config, ESLint 9. Three concerns and nothing stylistic: real mistakes
// (@eslint/js recommended), the rules of hooks, and the accessibility checks
// that caught the keyboard-less ledger row. Formatting is not linted; this
// repo has never had a formatter and a lint step that argues about commas
// is one nobody reads.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import react from 'eslint-plugin-react'

export default [
  { ignores: ['dist/**', 'node_modules/**', 'supabase/functions/**', 'public/sw.js'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    ...jsxA11y.flatConfigs.recommended,
    languageOptions: {
      ...jsxA11y.flatConfigs.recommended.languageOptions,
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks, react },
    settings: { react: { version: 'detect' } },
    rules: {
      // Only so a component used in JSX counts as used; none of the
      // plugin's style opinions.
      'react/jsx-uses-vars': 'error',
      ...reactHooks.configs.recommended.rules,
      // The React Compiler's rules (set-state-in-effect, refs, immutability)
      // describe code that works today and would be rewritten wholesale,
      // not fixed line by line. Warnings: visible, not blocking.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      // Forms here put the label text above the control without `for`;
      // every control also carries its own aria-label or placeholder.
      // Worth fixing form by form, not by failing the build.
      'jsx-a11y/label-has-associated-control': 'warn',
      // Sheets focus their first field on open on purpose: the sheet is the
      // whole screen on a phone and the keyboard should already be up.
      'jsx-a11y/no-autofocus': 'off',
      // Unused args named _ are the convention here for callbacks. A JSX
      // tag counts as a use: without the JSX awareness below every imported
      // component reads as unused.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  },
]
