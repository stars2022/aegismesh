import { useEffect, useRef, useState } from 'react'

type WidgetAPI = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (id: string) => void
  reset: (id: string) => void
}
declare global { interface Window { turnstile?: WidgetAPI; aegismeshTurnstileReady?: () => void } }
let loading: Promise<WidgetAPI> | undefined

function loadWidget(): Promise<WidgetAPI> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!loading) loading = new Promise<WidgetAPI>((resolve, reject) => {
    const script = document.createElement('script')
    const fail = () => { script.remove(); loading = undefined; reject(new Error('人机验证加载失败，请刷新重试')) }
    const timeout = window.setTimeout(fail, 15000)
    window.aegismeshTurnstileReady = () => {
      window.clearTimeout(timeout)
      if (window.turnstile) resolve(window.turnstile)
      else fail()
    }
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=aegismeshTurnstileReady&render=explicit'
    script.async = true
    script.onerror = () => { window.clearTimeout(timeout); fail() }
    document.head.appendChild(script)
  })
  return loading
}

export function Turnstile({ siteKey, action, resetCount, onToken }: {
  siteKey: string; action: string; resetCount: number; onToken: (value: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    onToken(''); setError('')
    void loadWidget().then(api => {
      if (!active || !host.current) return
      widget.current = api.render(host.current, {
        sitekey: siteKey, action, theme: 'auto', size: host.current.clientWidth < 300 ? 'compact' : 'flexible', language: 'zh-cn',
        callback: (token: string) => { if (active) { onToken(token); setError('') } },
        'expired-callback': () => { if (active) onToken('') },
        'error-callback': () => { if (active) { onToken(''); setError('人机验证暂不可用，请刷新重试') } },
      })
    }).catch(() => { if (active) setError('人机验证加载失败，请刷新重试') })
    return () => {
      active = false
      if (widget.current !== null) window.turnstile?.remove(widget.current)
      widget.current = null
    }
  }, [siteKey, action, onToken])
  useEffect(() => {
    onToken('')
    if (widget.current !== null) window.turnstile?.reset(widget.current)
  }, [resetCount, onToken])
  return <div className="account-turnstile"><div ref={host}/>{error && <p className="login-error" role="alert">{error}</p>}</div>
}
