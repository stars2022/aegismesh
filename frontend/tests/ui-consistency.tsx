// Dev-only fixture: actual shared components/styles; no API or production writes.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Paperclip, Shield, X } from 'lucide-react'
import { Dropdown, Switch } from '../src/components'
import { DispatchCard } from '../src/DispatchCard'
import { AgentPicker } from '../src/AgentPicker'
import type { AgentChoice } from '../src/agentMenu'
import '../src/styles.css'
import '../src/CanvasWorkspace.css'

const task = '围绕研究主题检索核心文献，给出来源、时间与证据等级；只呈现能够核实的信息，不得编造引用。\n'.repeat(12)
const agents: AgentChoice[] = [
  {id:'discovery',name:'智能体发现助手',role:'leader'},
  {id:'research',name:'科研智能体协作工作台',role:'leader'},
  {id:'travel',name:'旅行规划与行程协调智能体',role:'leader'},
  {id:'news',name:'新闻研判与简报协调智能体',role:'leader'},
  ...['文献检索与知识综述智能体','名胜古迹与文化导览智能体','信息来源与事实核验智能体','地方美食与餐饮推荐智能体','新闻检索与摘要智能体','出行交通与预算智能体','事件时间线与背景梳理智能体','研究设计与数据分析智能体','论文评审与学术写作智能体'].map((name,i)=>({id:`executor-${i}`,name,role:'partner' as const})),
]
function Preview() {
  const [enabled, setEnabled] = useState(false)
  const [theme, setTheme] = useState('dark')
  const [choice, setChoice] = useState('0')
  const [agentId, setAgentId] = useState('discovery')
  return <main className="ui-check">
    <style>{`.ui-check{max-width:1050px;margin:auto;padding:24px}.check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.check-grid section{padding:20px;min-width:0}.check-grid h2{font-size:15px}.check-grid .chat-layout{display:block;height:auto;min-height:0}.check-grid .composer{position:static;width:100%;margin:0;padding:16px}.check-grid .dropdown{max-width:100%}.check-grid .form-stack{margin:18px 0}.check-grid .route-dispatches-list{margin-top:16px}.check-grid .canvas-wysiwyg-toolbar{margin-top:16px}.fixture-actions{display:flex;gap:12px;margin:16px 0}@media(max-width:650px){.ui-check{padding:12px}.check-grid{grid-template-columns:1fr;gap:12px}}`}</style>
    <h1>界面一致性回归预览</h1>
    <div className="fixture-actions"><button className="secondary-button" onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); document.documentElement.dataset.theme = next }}>切换深浅色</button></div>
    <div className="check-grid">
      <section className="panel design-next">
        <h2>管理后台 · 通用控件</h2>
        <div className="setting-list"><Switch label="梧桐兼容模式" checked={enabled} onChange={setEnabled} /><Switch label="保存中" checked disabled onChange={()=>{}} /></div>
        <div className="form-stack"><label>模型供应商<Dropdown title="供应商选择" value={choice} onChange={setChoice} options={Array.from({length:15},(_,i)=>({value:String(i),label:`供应商 ${i+1} · 统一菜单样式`}))}/></label><label>智能体名称<input defaultValue="文献检索与知识综述智能体" /></label></div>
        <div className="fixture-actions"><button className="primary-button">保存</button><button className="secondary-button">取消</button><button className="icon-button" aria-label="关闭"><X size={16}/></button></div>
      </section>
      <section className="panel">
        <h2>聊天 / 画布 · 路由任务</h2>
        <div className="route-dispatches-list"><DispatchCard dispatch={{id:'literature',name:'文献检索与知识综述智能体',status:'completed',task,latency_ms:1200}}/><DispatchCard dispatch={{id:'design',name:'研究设计与数据分析智能体',status:'running',task}}/><DispatchCard dispatch={{id:'review',name:'论文评审与学术写作智能体',status:'error',task,error:'示例：目标暂时不可达，可展开查看任务。'}}/></div>
      </section>
      <section className="panel chat-layout"><h2>聊天 · 输入区</h2><div className="composer"><p>请输入问题</p><div className="composer-bottom-left"><button className="composer-upload-btn"><Paperclip size={16}/><span>上传材料</span></button><AgentPicker className="runtime-mode" agents={agents} value={agentId} onChange={setAgentId}/></div></div></section>
      <section className="panel chat-layout"><h2>画布 · 输入区与工具栏</h2><div className="composer"><p>描述要写入或修改的内容</p><div className="floating-actions-row"><div className="actions-left"><button className="floating-upload-btn"><Paperclip size={16}/><span>上传材料</span></button><AgentPicker className="floating-agent-dropdown" agents={agents.filter(a=>a.role==='leader')} value={agentId} onChange={setAgentId}/></div></div></div><div className="canvas-wysiwyg-toolbar"><button>样式</button><button>编辑</button><button><Shield size={14}/>工具</button></div></section>
    </div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
