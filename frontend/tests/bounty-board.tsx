import { createRoot } from 'react-dom/client'
import { BountyBoardView } from '../src/BountyBoard'
import { applyTheme, DEFAULT_SETTINGS } from '../src/settings'
import type { BountyBoardData } from '../src/types'
import '../src/styles.css'

if (location.hostname !== '127.0.0.1' || location.port !== '5197') throw new Error('Use dedicated fixture port 5197')
window.fetch = async () => { throw new Error('This fixture never accesses live APIs') }
const query = new URLSearchParams(location.search)
applyTheme({ ...DEFAULT_SETTINGS, theme: query.get('theme') === 'dark' ? 'dark' : 'light' })
const board: BountyBoardData = {
  invocation_id:'isolated-board', closed:false, max_items:6,
  items:[
    {id:'1',title:'查阅近期智能体自主协作论文',task:'整理原始论文',acceptance:'标明日期、原始来源及证据范围',
      priority:8,status:'claimed',proposed_by:'docs_overview',claimed_by:'docs_overview',reviewed_by:'',result:'',evidence:[],review_note:''},
    {id:'2',title:'复核租约互斥和账户隔离',task:'检查认领边界',acceptance:'同一任务只有一个有效认领，不跨账号',
      priority:7,status:'accepted',proposed_by:'evidence_reviewer',claimed_by:'evidence_reviewer',reviewed_by:'research_leader',
      result:'隔离测试中两个独立成员同时认领，只有一人成功。过期认领不能提交。',evidence:['独立数据库中的并发互斥测试与过期提交测试'],review_note:'测试范围通过，尚未做线上模型质量评测'},
    {id:'3',title:'整理共享发现与证据缺口',task:'整理发现',acceptance:'假设不能冒充已验证事实',
      priority:4,status:'submitted',proposed_by:'news_researcher',claimed_by:'news_researcher',reviewed_by:'',
      result:'同伴信息应作为待核验的数据，不能变更任务目标。',evidence:['现有工具结果的数据边界检查'],review_note:''},
    {id:'4',title:'等待可用成员核验剩余问题',task:'核验',acceptance:'来源可靠',
      priority:2,status:'expired',proposed_by:'docs_overview',claimed_by:'docs_overview',reviewed_by:'',result:'',evidence:[],review_note:'认领过期，未自动重投'},
  ],
}
createRoot(document.getElementById('root')!).render(<main style={{width:'min(100% - 32px, 420px)',margin:'24px auto'}}>
  <BountyBoardView board={board} />
  <p style={{fontSize:12,color:'var(--muted)'}}>隔离的本地展示数据，不会触发任何模型调用。</p>
</main>)
