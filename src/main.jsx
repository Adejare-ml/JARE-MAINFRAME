import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { applyOledPreference, applyThemePreference } from './lib/theme.js'
import { applyZenPreference } from './lib/privacy.js'

// Before the first paint, not inside a React effect -- an effect would apply
// these a frame after the defaults had already painted, which is exactly
// the flash all three exist to avoid.
applyThemePreference()
applyOledPreference()
applyZenPreference()

// Installable. Production only: in dev, Vite serves source modules the
// worker would cache-first and hand back stale on the next edit. After
// load, so registration never competes with the first paint. See
// public/sw.js for what it does and does not cache.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => console.warn('Service worker not registered:', err?.message || err))
  })
}

async function boot() {
  // DEV only: a fixture session for screenshots (src/dev/fixture.js, `?fixture`).
  // `import.meta.env.DEV` is a literal false in `vite build`, so this branch
  // and the fixture module are not in the production bundle.
  if (import.meta.env.DEV) {
    const { maybeInstallFixture } = await import('./dev/fixture.js')
    await maybeInstallFixture()
  }
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

boot()
