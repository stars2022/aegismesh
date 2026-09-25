import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Demo from './Demo'
import Admin from './Admin'
import { applyTheme, loadSettings, watchSystemTheme } from './settings'
import './styles.css'

applyTheme(loadSettings())
watchSystemTheme(applyTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname.startsWith('/admin') ? <Admin /> : <Demo />}
  </StrictMode>,
)
