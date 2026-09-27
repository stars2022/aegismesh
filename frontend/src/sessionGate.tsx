import { useEffect, useState } from 'react'
import { Network } from 'lucide-react'

export function useServiceSession<T>(load: () => Promise<T>) {
  const [session, setSession] = useState<T | null>(null)
  const [serviceError, setServiceError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const refresh = async (attempt: number) => {
      try {
        const value = await load()
        if (disposed) return
        setSession(value)
        setServiceError('')
      } catch (reason) {
        if (disposed) return
        setServiceError(reason instanceof Error ? reason.message : '服务暂时不可用')
        retryTimer = setTimeout(
          () => void refresh(attempt + 1),
          Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4)),
        )
      }
    }

    void refresh(0)
    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [load, reloadToken])

  const retry = () => {
    setSession(null)
    setServiceError('')
    setReloadToken((value) => value + 1)
  }

  return { session, setSession, serviceError, retry }
}

export function ServiceUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="login-page">
      <section className="login-card service-unavailable" role="status" aria-live="polite">
        <div className="login-mark"><Network size={20} /></div>
        <h1>连接暂时中断</h1>
        <p>项目服务暂时不可用。页面会自动重试，恢复后继续打开。</p>
        <button type="button" className="primary-button" onClick={onRetry}>立即重连</button>
        <small>{message}</small>
      </section>
    </main>
  )
}
