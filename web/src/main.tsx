import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { initAppearance } from './appearance.js'
import { store } from './store.js'
import './styles.css'

// Apply the saved theme/zoom/font before the first paint, so there is no
// flash of the default dark theme when a light-theme user loads the page.
initAppearance()
store.connect()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
