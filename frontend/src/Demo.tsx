import { FormEvent, useEffect, useState } from 'react'
import { LockKeyhole, Network } from 'lucide-react'
import { ChatDemo } from './App'
import { api } from './api'

export default function Demo() {
  const [session, setSession] = useState<{ enabled: boolean; authenticated: boolean } | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { api.demoSession().then(setSession).catch(() => setSession({ enabled: false, authenticated: true })) }, [])
  const login = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try { setSession(await api.demoLogin(password)); setPassword('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '验证失败') }
  }
  if (!session) return <div className="admin-loading"><Network size={22} /></div>
  if (!session.authenticated) return <main className="login-page"><section className="login-card"><div className="login-mark"><Network size={20} /></div><h1>访问验证</h1><form onSubmit={login}><label>密码<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="login-error">{error}</p>}<button className="primary-button" disabled={password.length < 8}><LockKeyhole size={15} />进入</button></form></section></main>
  return (
    <div className="demo-shell">
      <main className="demo-main">
        <ChatDemo onComplete={async () => undefined} />
      </main>
    </div>
  )
}
