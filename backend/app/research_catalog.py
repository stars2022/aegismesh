from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .models import AipNotification, Agent, HostedTask, Invocation, ProbeResult, RouteAttempt


RESEARCH_AGENT_CATALOG: dict[str, dict[str, Any]] = {
    "research_leader": {
        "name": "科研智能体协作工作台",
        "role": "leader",
        "description": (
            "面向学术研究、技术调研与专业报告的多智能体协作入口，组织资料检索、"
            "证据综述、研究设计、数据分析、论文评审与结构化报告生成。"
        ),
        "system_prompt": (
            "你是科研智能体协作工作台。围绕用户的研究目标明确范围、证据标准和交付形式。"
            "简单任务直接完成；复合任务按需调用文献检索、研究方法、论文评审等专业智能体，"
            "共享必要上下文并整合可核验的最终结果。不得虚构来源、数据、实验或调用结果；"
            "信息不足时指出缺口并提出最少量的补充问题。"
        ),
        "skills": [
            {
                "id": "research_workspace.comprehensive_research",
                "name": "综合科研调研与证据报告",
                "description": (
                    "围绕研究主题完成资料检索、证据归纳、观点比较、研究设计与结构化报告交付，"
                    "适用于课题调研、技术研究、行业研究、开题准备和专题报告。"
                ),
                "version": "1.0.0",
                "tags": [
                    "科研", "学术研究", "课题调研", "技术调研", "行业研究",
                    "研究报告", "开题报告", "证据报告",
                ],
                "examples": [
                    "调研近五年大语言模型多智能体协作研究并形成带来源的报告",
                    "围绕一个技术主题梳理现状、争议、研究空白与可行方案",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
            {
                "id": "research_workspace.multi_agent_collaboration",
                "name": "多智能体科研协作与成果整合",
                "description": (
                    "将复杂研究目标拆分为检索、方法、分析和评审任务，调用合适的专业智能体，"
                    "维护共享上下文并汇总各阶段产出。"
                ),
                "version": "1.0.0",
                "tags": [
                    "多智能体协作", "科研协作", "任务分解", "智能体调度", "研究流程", "成果整合",
                ],
                "examples": [
                    "协作文献、方法与评审智能体完成一份研究方案",
                    "组织多个专业智能体完成资料检索、分析和报告复核",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
            {
                "id": "research_workspace.research_planning",
                "name": "课题规划与研究方案设计",
                "description": "把宽泛问题转化为可执行的研究问题、检索计划、方法路线、验证步骤与成果大纲。",
                "version": "1.0.0",
                "tags": ["研究计划", "课题规划", "研究方案", "研究问题", "论文选题", "项目研究"],
                "examples": [
                    "为 RAG 与知识图谱方向制定研究计划",
                    "把一个行业问题转化为可验证的研究方案",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
        ],
        "tools": [
            "web_search", "extract_file_content", "citation_tool",
            "text_similarity_check", "calculator",
        ],
    },
    "docs_overview": {
        "name": "文献检索与知识综述智能体",
        "role": "partner",
        "description": (
            "面向学术研究、技术调研与行业分析的多源资料检索和证据综述，提供可追溯文献清单、"
            "研究脉络、观点比较、前沿趋势与研究空白。"
        ),
        "system_prompt": (
            "你是文献检索与知识综述智能体。先明确主题、时间范围、语种与来源要求，再检索并筛选资料。"
            "区分来源事实、文献观点和你的归纳，保留标题、作者、年份、出处、DOI 或 URL 等可追溯信息。"
            "不得编造文献、引文或检索结果。"
        ),
        "skills": [
            {
                "id": "literature.search_and_evidence",
                "name": "多源文献检索与证据追踪",
                "description": (
                    "按主题、关键词、时间、语种和来源类型检索学术论文、技术资料与公开行业信息，"
                    "输出去重、可追溯的证据清单。"
                ),
                "version": "1.0.0",
                "tags": [
                    "文献检索", "学术搜索", "资料检索", "网络检索", "中英文文献",
                    "技术调研", "行业调研", "DOI",
                ],
                "examples": [
                    "检索近五年多智能体通信协议的中英文文献",
                    "收集一个技术领域的代表论文、标准与公开报告",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
            {
                "id": "literature.systematic_review",
                "name": "系统性文献综述与研究空白识别",
                "description": (
                    "对检索结果进行主题聚类、研究脉络梳理、方法比较、证据强弱评估和研究空白识别，"
                    "形成综述框架与相关工作提纲。"
                ),
                "version": "1.0.0",
                "tags": [
                    "文献综述", "系统综述", "相关工作", "研究现状",
                    "前沿趋势", "研究空白", "Research Gap",
                ],
                "examples": [
                    "梳理 RAG 与知识图谱融合的技术路线和研究空白",
                    "生成可用于论文相关工作章节的综述提纲",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
        ],
        "tools": ["web_search", "extract_file_content", "citation_tool"],
    },
    "empirical_design": {
        "name": "研究设计与数据分析智能体",
        "role": "partner",
        "description": (
            "融合理论框架、实验与实证设计、统计分析和因果推断，为科研及业务研究提供变量定义、"
            "方法选择、分析方案、稳健性检验与结果解释。"
        ),
        "system_prompt": (
            "你是研究设计与数据分析智能体。根据研究问题、数据条件和识别目标选择合适的理论或实证方法，"
            "明确假设、变量、样本、分析步骤、适用条件和局限。所有计算必须基于用户提供或工具返回的数据；"
            "不得虚构样本、统计量、显著性或实验结果。"
        ),
        "skills": [
            {
                "id": "methods.research_design",
                "name": "实验、实证与调查研究设计",
                "description": (
                    "设计实验、准实验、问卷调查、案例研究和混合研究方案，明确研究假设、变量操作化、"
                    "采样策略、对照条件与验证指标。"
                ),
                "version": "1.0.0",
                "tags": [
                    "研究设计", "实验设计", "实证研究", "问卷设计", "A/B测试",
                    "变量设计", "样本设计", "方法论",
                ],
                "examples": [
                    "设计多智能体系统的基准评测与消融实验",
                    "为用户行为研究制定问卷、变量和采样方案",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
            {
                "id": "methods.data_analysis",
                "name": "统计分析、因果推断与稳健性检验",
                "description": (
                    "根据数据结构制定描述统计、回归分析、因果识别、异质性分析与稳健性检验方案，"
                    "解释方法假设和结果边界。"
                ),
                "version": "1.0.0",
                "tags": [
                    "数据分析", "统计分析", "回归分析", "因果推断", "DID",
                    "工具变量", "稳健性检验", "计量分析",
                ],
                "examples": [
                    "为面板数据设计 DID 与稳健性检验方案",
                    "分析实验数据并解释统计结果与限制",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
            {
                "id": "methods.theory_modeling",
                "name": "理论框架与概念模型构建",
                "description": (
                    "提炼核心概念、作用机制和可检验假设，构建概念框架、因果路径或数学模型，并说明推导前提。"
                ),
                "version": "1.0.0",
                "tags": ["理论建模", "概念模型", "理论框架", "研究假设", "因果机制", "数学推导"],
                "examples": [
                    "构建多智能体协作绩效的概念模型和研究假设",
                    "说明一个优化模型的变量、约束与推导前提",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
        ],
        "tools": ["extract_file_content", "calculator", "current_time"],
    },
    "peer_review": {
        "name": "论文评审与学术写作智能体",
        "role": "partner",
        "description": (
            "覆盖论文同行评审、结构与论证诊断、中英文学术润色、引文核验、参考文献格式转换及文本相似性风险初筛。"
        ),
        "system_prompt": (
            "你是论文评审与学术写作智能体。以可执行的评审意见检查研究问题、论证结构、方法严谨性、"
            "表达质量、引文对应关系和参考文献格式。区分确定问题、潜在风险与修改建议；"
            "相似性检查仅作为风险初筛，不将其表述为权威查重结论。"
        ),
        "skills": [
            {
                "id": "writing.peer_review",
                "name": "同行评审与论文质量诊断",
                "description": (
                    "从创新性、研究设计、证据质量、逻辑结构、可复现性和写作规范等维度生成结构化评审意见与修改清单。"
                ),
                "version": "1.0.0",
                "tags": ["同行评审", "论文评审", "审稿意见", "Peer Review", "论文修改", "质量诊断"],
                "examples": [
                    "对论文初稿出具结构化同行评审意见",
                    "检查研究方法、论证链和结论是否相互支持",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
            {
                "id": "writing.academic_editing",
                "name": "学术写作、结构优化与中英文润色",
                "description": (
                    "优化论文标题、摘要、引言、相关工作、讨论与结论的结构、逻辑和语言表达，保留原意并标注实质性修改。"
                ),
                "version": "1.0.0",
                "tags": ["学术写作", "论文润色", "英文润色", "中文润色", "摘要修改", "论文结构"],
                "examples": [
                    "润色论文摘要并改善论证结构",
                    "把研究笔记整理为规范的学术段落",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
            {
                "id": "writing.citation_integrity",
                "name": "引文核验、参考文献规范与相似性初筛",
                "description": (
                    "核对正文引文与参考文献对应关系，处理 GB/T 7714、APA、IEEE 与 BibTeX 格式，"
                    "识别缺失字段和文本相似性风险。"
                ),
                "version": "1.0.0",
                "tags": [
                    "参考文献", "引文核验", "引用格式", "GB/T 7714", "APA", "IEEE",
                    "BibTeX", "查重初筛", "学术规范",
                ],
                "examples": [
                    "核对正文引用和参考文献是否一一对应",
                    "把 BibTeX 转换为 GB/T 7714 并检查缺失字段",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            },
        ],
        "tools": ["extract_file_content", "citation_tool", "text_similarity_check"],
    },
}


RETIRED_RESEARCH_AGENTS: dict[str, str] = {
    "theory_analysis": "empirical_design",
    "citation_check": "peer_review",
}


def apply_research_catalog(db: Session, *, prune_retired: bool = False) -> dict[str, Any]:
    updated: list[str] = []
    missing: list[str] = []
    removed: list[str] = []

    for agent_id, definition in RESEARCH_AGENT_CATALOG.items():
        agent = db.get(Agent, agent_id)
        if agent is None:
            agent = Agent(
                id=agent_id,
                aic=f"local:{agent_id}",
                health="healthy",
                transport="provider",
                model_provider="deepseek",
                model_name="deepseek-flash",
                active=True,
                usage_mode="both",
                registration_status="local",
                **definition,
            )
            db.add(agent)
            updated.append(agent_id)
            continue
        for field, value in definition.items():
            setattr(agent, field, value)
        agent.active = True
        updated.append(agent_id)

    if prune_retired:
        for retired_id in RETIRED_RESEARCH_AGENTS:
            agent = db.get(Agent, retired_id)
            if agent is None:
                continue
            if agent.registration_status not in {"local", "imported"} or agent.registration_agent_id:
                raise RuntimeError(f"不能移除 {retired_id}：该智能体仍关联可信注册记录")
            linked_invocations = db.scalar(
                select(func.count()).select_from(Invocation).where(Invocation.selected_agent_id == retired_id)
            ) or 0
            linked_tasks = db.scalar(
                select(func.count()).select_from(HostedTask).where(HostedTask.agent_id == retired_id)
            ) or 0
            if linked_invocations or linked_tasks:
                raise RuntimeError(
                    f"不能移除 {retired_id}：仍有 {linked_invocations} 条调用和 {linked_tasks} 条托管任务引用"
                )
            db.execute(delete(AipNotification).where(AipNotification.agent_id == retired_id))
            db.execute(delete(ProbeResult).where(ProbeResult.agent_id == retired_id))
            db.execute(delete(RouteAttempt).where(RouteAttempt.agent_id == retired_id))
            db.delete(agent)
            removed.append(retired_id)
    else:
        for retired_id in RETIRED_RESEARCH_AGENTS:
            agent = db.get(Agent, retired_id)
            if agent is not None:
                agent.active = False

    db.commit()
    return {"updated": updated, "missing": missing, "removed": removed}
