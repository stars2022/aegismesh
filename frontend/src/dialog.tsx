import { useEffect, useId, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { TriangleAlert } from 'lucide-react'
import './dialog.css'

type DialogOptions = {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** 删除、清空等不可恢复操作：确认按钮用警示色，默认焦点落在“取消”上。 */
  danger?: boolean
}

type DialogProps = DialogOptions & { alertOnly: boolean; onClose: (confirmed: boolean) => void }

function Dialog({ title, message, confirmLabel, cancelLabel = '取消', danger = false, alertOnly, onClose }: DialogProps) {
  const id = useId()
  const confirmButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    ;(danger && !alertOnly ? cancelButton : confirmButton).current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(false) }
      if (event.key === 'Tab') {
        // 焦点只在对话框的按钮之间循环
        const buttons = [cancelButton.current, confirmButton.current].filter(Boolean) as HTMLButtonElement[]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        event.preventDefault()
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [alertOnly, danger, onClose])

  return (
    <div className="app-dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(false) }}>
      <section className="app-dialog" role={alertOnly ? 'alertdialog' : 'dialog'} aria-modal="true"
        aria-labelledby={title ? `${id}-title` : undefined} aria-describedby={`${id}-message`}>
        {danger && <div className="app-dialog-mark"><TriangleAlert size={18} /></div>}
        {title && <h2 id={`${id}-title`}>{title}</h2>}
        <p id={`${id}-message`}>{message}</p>
        <div className="app-dialog-actions">
          {!alertOnly && <button ref={cancelButton} type="button" className="secondary-button" onClick={() => onClose(false)}>{cancelLabel}</button>}
          <button ref={confirmButton} type="button" className={`primary-button${danger ? ' is-danger' : ''}`} onClick={() => onClose(true)}>
            {confirmLabel || (alertOnly ? '知道了' : '确定')}
          </button>
        </div>
      </section>
    </div>
  )
}

function open(options: DialogOptions, alertOnly: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const close = (confirmed: boolean) => {
      root.unmount()
      host.remove()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
      resolve(confirmed)
    }
    root.render(<Dialog {...options} alertOnly={alertOnly} onClose={close} />)
  })
}

/** 替代 window.confirm：返回用户是否确认。 */
export function confirmDialog(options: DialogOptions | string): Promise<boolean> {
  return open(typeof options === 'string' ? { message: options } : options, false)
}

/** 替代 window.alert：用户关闭后 resolve。 */
export function alertDialog(options: DialogOptions | string): Promise<void> {
  return open(typeof options === 'string' ? { message: options } : options, true).then(() => undefined)
}
