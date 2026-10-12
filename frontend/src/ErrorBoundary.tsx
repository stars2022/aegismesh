import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'

type Props = {
  children: ReactNode
  /** 整页兜底；否则只占据当前区域，侧栏和导航仍可使用。 */
  fullPage?: boolean
  label?: string
}

type State = { error: Error | null }

/** 渲染异常时显示可恢复的提示，而不是让整个应用白屏。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('界面渲染失败', error, info.componentStack)
  }

  private reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { fullPage, label = '这部分界面' } = this.props
    const body = (
      <section className={`error-boundary${fullPage ? ' login-card' : ''}`} role="alert">
        <div className="error-boundary-mark"><TriangleAlert size={18} /></div>
        <h2>{label}暂时无法显示</h2>
        <p>数据可能不完整或格式有变化。可以先重试；若仍失败，刷新页面即可恢复。</p>
        <div className="error-boundary-actions">
          <button type="button" className="primary-button" onClick={this.reset}><RotateCcw size={15} />重试</button>
          <button type="button" className="secondary-button" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
        <small>{error.message}</small>
      </section>
    )
    return fullPage ? <main className="login-page">{body}</main> : body
  }
}
