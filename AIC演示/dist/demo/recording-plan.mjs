// Editorial chapter cards and narration, separate from preset application data.
export const RECORDING_PLAN = [
  { key: 'create', title: '智能体创建与注册', seconds: 6,
    intro: '首先，创建并注册一个新的智能体。',
    narration: '在智能体管理中选择 AI 生成，描述需求后检查身份、能力和运行配置。保存草稿，提交注册，再同步审核结果和证书状态，完成接入准备。' },
  { key: 'discovery', title: '智能体发现与接入', seconds: 6,
    intro: '接下来，发现并接入所需的专业能力。',
    narration: '查看候选能力与接口信息，将所需执行者接入协作网络。' },
  { key: 'first-use', title: '首次访问与任务执行', seconds: 6,
    intro: '现在，直接使用刚刚注册的智能体。',
    narration: '选中政策研究助手并提交需求，查看适用范围与证据清单，完成首次任务执行。' },
  { key: 'research-detail', title: '协调分派与执行回传', seconds: 6,
    intro: '下面，展示协调智能体如何组织协作。',
    narration: '协调者将科研需求拆为文献检索与独立复核。展开协作详情，可以查看派发来源、调用链、工具参数和执行者回传，再由协调者汇总结果。' },
  { key: 'news', title: '新闻检索与联合核验', seconds: 6,
    intro: '同一套互联能力，也可用于新闻核验。',
    narration: '将不同地区的新闻素材交给专业执行者，按事件、时间和来源归并，再交由复核者区分事实与分析，保留需要进一步确认的事项。' },
  { key: 'travel', title: '出行规划与跨域协作', seconds: 6,
    intro: '接着，看一次跨领域的出行规划。',
    narration: '出行智能体安排交通、会议与参访，文献智能体补充会前材料。多个专业能力共同形成时间表、执行约束与备选方案。' },
  { key: 'bounty-detail', title: '竞标认领与交付验收', seconds: 6,
    intro: '竞标模式，让执行者围绕任务认领协作。',
    narration: '任务板展示认领者、验收条件和交付证据。协调者检查各项成果并复核，形成从任务发布、认领、提交到验收的可追踪流程。' },
  { key: 'structured', title: '可选结构化输入输出', seconds: 6,
    intro: '需要对接业务系统时，可开启结构化能力。',
    narration: '在详情中按需配置结构化能力。结果按约定字段展示，支持复制或下载 JSON，供其他程序读取。' },
  { key: 'canvas-review', title: '共享画布与版本审查', seconds: 6,
    intro: '共享画布，将多轮协作汇入同一份文稿。',
    narration: '第一轮生成研究方案，用户检查并接受改动；第二轮补充验收与复核表，再次审查修订。交付物不止停留在聊天里，而是持续完善同一份文档。' },
  { key: 'group-user', title: '用户主持的群组协作', seconds: 6,
    intro: '群组协作可以由用户直接主持。',
    narration: '用户点名文献检索者，执行后交接独立审查者。聊天保留简洁的协作信息，完整成果汇入共享黑板，也可以随时查看成员与主持设置。' },
  { key: 'group-host', title: '智能体主持的群组协作', seconds: 6,
    intro: '也可以指定协调智能体主持整个讨论。',
    narration: '主持者组织检索、交接与独立复核，各成员围绕共同任务接力。共享黑板集中保存成果，便于对照不同角色的交付与后续继续讨论。' },
  { key: 'human', title: '数字人交互服务', seconds: 6,
    intro: '最后，通过数字人入口提供统一咨询。',
    narration: '用户以自然语言提出需求，由麦溪呈现咨询答复与播报入口。至此，完成了创建、注册、发现、互联访问和多种协同方式的全流程展示。' },
]
export const RECORD_ONLY_KEY = 'aegismesh-record-only:v1'
export function isRecordOnly(params, storage) {
  if (params.get('record') === '1') storage.setItem(RECORD_ONLY_KEY, '1')
  return storage.getItem(RECORD_ONLY_KEY) === '1'
}
export async function chapterCard(chapter, signal, wait) {
  const item = RECORDING_PLAN.find(row => row.key === chapter)
  if (!item) return
  const page = document.createElement('div')
  page.className = 'recording-chapter-card'
  page.setAttribute('role', 'region'); page.setAttribute('aria-label', `章节：${item.title}`)
  page.innerHTML = `<style>
    .recording-chapter-card{position:fixed;inset:0;z-index:2147483646;background:#0c0d0f;color:#f3f3ee;font-family:Inter,"Noto Sans SC",sans-serif;display:grid;place-items:center}
    .recording-chapter-brand{position:absolute;top:56px;left:64px;display:flex;align-items:center;gap:16px;font-size:28px;font-weight:600;letter-spacing:-.025em}
    .recording-chapter-brand svg{width:30px;height:30px;padding:13px;border-radius:15px;background:#efefeb;color:#171815;box-sizing:content-box}
    .recording-chapter-center{text-align:center;max-width:80vw}
    .recording-chapter-card h1{font-size:clamp(32px,3.3vw,64px);font-weight:500;letter-spacing:.035em;margin:0}
  </style><div class="recording-chapter-brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M12 8v5M5 16v-3h14v3"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/></svg><span>AegisMesh</span></div><div class="recording-chapter-center"><h1></h1></div>`
  page.querySelector('h1').textContent = item.title
  document.body.append(page)
  try { await wait(item.seconds * 1000, signal) } finally { page.remove() }
}
