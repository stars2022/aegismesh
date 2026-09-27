import { FormEvent, Suspense, lazy, useState } from 'react'
import { LockKeyhole, Network } from 'lucide-react'
import { api } from './api'
import { LoadingFlow } from './LoadingFlow'
import { ServiceUnavailable, useServiceSession } from './sessionGate'

const App = lazy(() => import('./App'))

export default function Admin() {
  const { session, setSession, serviceError, retry } = useServiceSession(api.adminSession)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const login = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true); setError('')
    try {
      setSession(await api.adminLogin(username, password))
      setPassword('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  const logout = async () => {
    await api.adminLogout()
    setSession({ enabled: true, authenticated: false, username: null })
  }

  if (serviceError && !session) return <ServiceUnavailable message={serviceError} onRetry={retry} />
  if (session && (!session.enabled || session.authenticated)) {
    return <Suspense fallback={<LoadingFlow label="正在加载管理界面…" fullPage />}>
      <App onLogout={session.enabled ? logout : undefined} />
    </Suspense>
  }
  if (!session) return <LoadingFlow label="正在加载管理界面…" fullPage />

  return <main className="login-page"><section className="login-card"><div className="login-mark"><Network size={20} /></div><span className="eyebrow">AegisMesh Console</span><h1>管理后台</h1><form onSubmit={login}><label>用户名<input autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="login-error">{error}</p>}<button className="primary-button" disabled={submitting || !username || password.length < 8}><LockKeyhole size={15} />{submitting ? '登录中' : '登录'}</button></form><a href="/">返回聊天</a></section></main>
}
