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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
