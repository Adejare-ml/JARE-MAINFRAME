import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { applyOledPreference } from './lib/theme.js'

// Before the first paint, not inside a React effect -- an effect would apply
// the true-black background a frame after the default one had already
// painted, which is exactly the flash this exists to avoid.
applyOledPreference()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
