import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme, loadSettings, watchSystemTheme } from './settings'
import { LoadingFlow } from './LoadingFlow'
import './styles.css'

const Demo = lazy(() => import('./Demo'))
const Admin = lazy(() => import('./Admin'))

applyTheme(loadSettings())
watchSystemTheme(applyTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<LoadingFlow label="正在加载界面…" fullPage />}>
      {window.location.pathname.startsWith('/admin') ? <Admin /> : <Demo />}
    </Suspense>
  </StrictMode>,
)
