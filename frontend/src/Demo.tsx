import { FormEvent, Suspense, lazy, useState } from 'react'
import { LockKeyhole, Network } from 'lucide-react'
import { api } from './api'
import { LoadingFlow } from './LoadingFlow'
import { ServiceUnavailable, useServiceSession } from './sessionGate'

const ChatDemo = lazy(() => import('./App').then(({ ChatDemo }) => ({ default: ChatDemo })))

export default function Demo() {
  const { session, setSession, serviceError, retry } = useServiceSession(api.demoSession)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const login = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try { setSession(await api.demoLogin(password)); setPassword('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '验证失败') }
  }
  if (serviceError && !session) return <ServiceUnavailable message={serviceError} onRetry={retry} />
  if (!session) return <LoadingFlow label="正在连接工作台…" fullPage />
  if (!session.authenticated) return <main className="login-page"><section className="login-card"><div className="login-mark"><Network size={20} /></div><h1>访问验证</h1><form onSubmit={login}><label>密码<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="login-error">{error}</p>}<button className="primary-button" disabled={password.length < 8}><LockKeyhole size={15} />进入</button></form></section></main>
  return (
    <div className="demo-shell">
      <main className="demo-main">
        <Suspense fallback={<LoadingFlow label="正在加载工作台…" fullPage />}>
          <ChatDemo onComplete={async () => undefined} />
        </Suspense>
      </main>
    </div>
  )
}
