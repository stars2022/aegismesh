import { FormEvent, Suspense, lazy, useEffect, useState } from 'react'
import { LockKeyhole, Network } from 'lucide-react'
import { api } from './api'
import { LoadingFlow } from './LoadingFlow'
import { ServiceUnavailable, useServiceSession } from './sessionGate'
import { setConversationOwner } from './conversationStorage'
import { LoginPage } from './AccountPanel'

const ChatDemo = lazy(() => import('./App').then(({ ChatDemo }) => ({ default: ChatDemo })))
const DigitalHuman = lazy(() => import('./DigitalHuman'))

export default function Demo() {
  const { session, setSession, serviceError, retry } = useServiceSession(api.demoSession)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const check = () => { void api.demoSession().then(next => { if (session?.owner_id && next.owner_id !== session.owner_id) window.location.reload() }).catch(() => undefined) }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [session?.owner_id])
  const login = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try { await api.demoLogin(password); setSession(await api.demoSession()); setPassword('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '验证失败') }
  }
  if (serviceError && !session) return <ServiceUnavailable message={serviceError} onRetry={retry} />
  if (!session) return <LoadingFlow label="正在连接工作台…" fullPage />
  if (session.owner_id) setConversationOwner(session.owner_id)
  if (new URLSearchParams(window.location.search).has('account_action') || window.location.pathname === '/login') return <LoginPage/>
  if (!session.authenticated) return <main className="login-page"><section className="login-card"><div className="login-mark"><Network size={20} /></div><h1>访问验证</h1><form onSubmit={login}><label>密码<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="login-error">{error}</p>}<button className="primary-button" disabled={password.length < 8}><LockKeyhole size={15} />进入</button></form></section></main>
  if (window.location.pathname === '/digital-human') return <Suspense fallback={<LoadingFlow label="正在打开数字人服务厅…" fullPage/>}>{session.owner_id ? <DigitalHuman key={session.owner_id} ownerId={session.owner_id}/> : <ServiceUnavailable message="未能获取会话身份，请刷新后重试" onRetry={retry}/>}</Suspense>
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
