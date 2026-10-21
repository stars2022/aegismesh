import { installOfflineRuntime } from './runtime.mjs'
import { installDirector } from './director.mjs'

const runtime = installOfflineRuntime(window)
const params = new URLSearchParams(location.search)
if (params.has('reset_demo')) runtime.reset()
const entry = document.querySelector('script[data-production-entry]')?.dataset.productionEntry
if (!entry?.startsWith('/assets/')) throw new Error('正式前端入口未配置')
document.title = 'AegisMesh · 离线预置演示'
await import(entry)
installDirector(runtime)
