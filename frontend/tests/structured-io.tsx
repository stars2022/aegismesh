import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SchemaEditors, StructuredResult, StructuredTaskControls } from '../src/StructuredIO'
import { buildStructuredTask, schemaText } from '../src/structuredIOModel'
import type { Agent, JsonSchema } from '../src/types'
import '../src/styles.css'

const inputSchema: JsonSchema = {type:'object', properties: {topic:{type:'string',title:'研究主题'}, count:{type:'integer',title:'文献数量',minimum:1,maximum:10}, source:{type:'string',title:'来源',enum:['论文','新闻']}, filters:{type:'object',title:'附加条件'}}, required:['topic'], additionalProperties:false}
const outputSchema: JsonSchema = {type:'object', properties:{summary:{type:'string'},sources:{type:'array',items:{type:'string'}}}, required:['summary','sources'], additionalProperties:false}
const agent = {id:'fixture',name:'文献检索',structured_io_enabled:true,input_schema:inputSchema,output_schema:outputSchema,skills:[{id:'news',name:'新闻整理',input_schema:{type:'object',properties:{region:{type:'string',title:'地区'}},required:['region']}}]} as Agent

function Fixture() {
  const [enabled,setEnabled] = useState(false)
  const [skill,setSkill] = useState('')
  const [values,setValues] = useState<Record<string,string>>({})
  const [input,setInput] = useState(schemaText(inputSchema))
  const [output,setOutput] = useState(schemaText(outputSchema))
  const [error,setError] = useState('')
  const [result,setResult] = useState<Record<string,unknown>|null>(null)
  return <main style={{maxWidth:780,margin:'32px auto',padding:16}}><h2>结构化输入输出</h2><div className="panel"><StructuredTaskControls agent={agent} enabled={enabled} skillId={skill} values={values} onEnabled={setEnabled} onSkill={value=>{setSkill(value);setValues({})}} onValues={setValues}/><div style={{padding:16}}><button className="primary-button" onClick={()=>{try{const task=buildStructuredTask(agent,enabled,skill,values);setResult(task ? {summary:'本地静态结果预览，不调用模型',sources:[]}:null);setError(task?'':'普通聊天，不要求结构化字段')}catch(error){setError(String(error))}}}>检查输入</button>{error&&<p role="alert">{error}</p>}</div></div>{result&&<StructuredResult value={result}/>}<details style={{marginTop:24}}><summary>管理员字段编辑</summary><SchemaEditors input={input} output={output} onInput={setInput} onOutput={setOutput}/></details></main>
}
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'light'
createRoot(document.getElementById('root')!).render(<Fixture/> )
