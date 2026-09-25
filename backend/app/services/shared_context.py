from __future__ import annotations

import re
import time
from typing import Any

SECRET_PATTERNS = [
    re.compile(r'sk-[a-zA-Z0-9_-]{20,}'),
    re.compile(r'Bearer\s+[a-zA-Z0-9_\-\.]{20,}', re.IGNORECASE),
    re.compile(r'ghp_[a-zA-Z0-9]{20,}'),
    re.compile(r"(api[_-]?key|secret|password|auth_token)\s*[:=]\s*['\"]?([a-zA-Z0-9_\-\.]{12,})['\"]?", re.IGNORECASE),
]

MAX_SHARED_MESSAGES = 8
MAX_MESSAGE_CHARS = 1500
MAX_TOTAL_CHARS = 4000


def sanitize_text(text: str) -> str:
    if not text:
        return ''
    result = text
    for pattern in SECRET_PATTERNS:
        result = pattern.sub('[REDACTED_SECRET]', result)
    return result


def sanitize_history(history: list[dict[str, str]]) -> list[dict[str, str]]:
    bounded = history[-MAX_SHARED_MESSAGES:]
    sanitized: list[dict[str, str]] = []
    for msg in bounded:
        role = msg.get('role', 'user')
        content = msg.get('content', '')
        clean_content = sanitize_text(content)
        if len(clean_content) > MAX_MESSAGE_CHARS:
            clean_content = clean_content[:MAX_MESSAGE_CHARS] + '... [截断]'
        sanitized.append({'role': role, 'content': clean_content})
    return sanitized


class SharedCollaborationContext:
    def __init__(
        self,
        root_invocation_id: str,
        session_id: str,
        overall_objective: str,
        history: list[dict[str, str]] | None = None,
        delegation_path: list[str] | None = None,
        call_chain: list[str] | None = None,
    ) -> None:
        self.root_invocation_id = root_invocation_id
        self.session_id = session_id
        self.overall_objective = sanitize_text(overall_objective.strip())
        self.session_history = sanitize_history(history or [])
        self.delegation_path = list(call_chain or delegation_path or [])
        self.subtasks: dict[str, dict[str, Any]] = {}
        self.completed_reports: list[dict[str, Any]] = []
        self.lineage: list[dict[str, Any]] = []
        self.dispatched_tasks: set[str] = set()
        self.running_agents: set[str] = set()
        self.blackboard_messages: list[dict[str, Any]] = []

    def add_blackboard_message(
        self,
        sender_id: str,
        sender_name: str,
        content: str,
        role: str = "expert",
        msg_type: str = "report",
        nickname: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        clean_text = sanitize_text(content.strip())
        if not clean_text:
            return
        clean_nickname = nickname or (f"@{sender_name.replace('智能体', '').strip() or sender_id}专家" if role != "leader" else "@主控协调员")
        self.blackboard_messages.append({
            "id": f"bb_{len(self.blackboard_messages) + 1}_{int(time.time()*1000)%100000}",
            "sender_id": sender_id,
            "sender_name": sender_name,
            "nickname": clean_nickname,
            "role": role,
            "type": msg_type,
            "content": clean_text,
            "timestamp": time.time(),
            "reply_to": reply_to,
            "metadata": metadata or {},
        })

    def check_dispatch_allowed(
        self,
        agent_id: str,
        task: str,
        current_call_chain: list[str] | None = None,
    ) -> tuple[bool, str]:
        chain_to_check = list(current_call_chain) if current_call_chain is not None else list(self.delegation_path)
        if agent_id in chain_to_check:
            path_str = ' -> '.join(chain_to_check + [agent_id])
            return False, f'禁止嵌套或循环调用：智能体 "{agent_id}" 已在当前调用链中 ({path_str})'
        if agent_id in self.running_agents:
            return False, f'并发冲突拦截：智能体 "{agent_id}" 当前已有正在执行的子任务，不可重复并发派发'
        normalized_task = ' '.join(task.strip().lower().split())
        if normalized_task in self.dispatched_tasks:
            return False, '重复任务拦截：相同内容的子任务目标已在本次协作中派发，请勿重复派发'
        return True, ''

    def register_subtask(
        self,
        task_id: str,
        agent_id: str,
        agent_name: str,
        task: str,
        parent_agent_id: str | None = None,
        call_chain: list[str] | None = None,
    ) -> None:
        clean_task = sanitize_text(task.strip())
        now = time.time()
        effective_chain = (
            list(call_chain)
            if call_chain is not None
            else list(self.delegation_path + [agent_id] if agent_id not in self.delegation_path else self.delegation_path)
        )
        parent_id = parent_agent_id or (
            effective_chain[-2] if len(effective_chain) >= 2 else (self.delegation_path[-1] if self.delegation_path else 'leader')
        )
        self.subtasks[task_id] = {
            'task_id': task_id,
            'agent_id': agent_id,
            'agent_name': agent_name,
            'parent_agent_id': parent_id,
            'call_chain': effective_chain,
            'task': clean_task,
            'status': 'running',
            'phase': 'waiting_first_token',
            'phase_name': '等待模型首字响应',
            'started_at': now,
            'last_progress_at': now,
            'completed_at': None,
            'error': None,
            'result': None,
            'token_count': None,
            'tokens_per_second': None,
            'tokens_per_second_approximate': None,
            'eta_seconds': None,
            'idle_deadline': None,
            'absolute_deadline': None,
        }
        self.running_agents.add(agent_id)
        normalized_task = ' '.join(clean_task.lower().split())
        self.dispatched_tasks.add(normalized_task)

        self.lineage.append({
            'task_id': task_id,
            'parent_agent_id': parent_id,
            'agent_id': agent_id,
            'agent_name': agent_name,
            'call_chain': effective_chain,
            'task': clean_task[:200],
            'timestamp': time.time(),
            'depth': len(effective_chain),
        })

        # 广播派发事件到集群群聊黑板
        self.add_blackboard_message(
            sender_id=parent_id,
            sender_name="主控协调员" if parent_id == "leader" else parent_id,
            role="leader" if parent_id == "leader" else "expert",
            msg_type="dispatch",
            content=f"已向 @{agent_name.replace('智能体', '').strip() or agent_id}专家 派发任务：{clean_task}",
            metadata={"task_id": task_id, "target_agent_id": agent_id, "target_agent_name": agent_name},
        )

    def update_subtask_progress(
        self,
        task_id: str,
        phase: str | None = None,
        phase_name: str | None = None,
        last_progress_at: float | None = None,
        token_count: int | None = None,
        tokens_per_second: float | None = None,
        tokens_per_second_approximate: bool | None = None,
        eta_seconds: float | None = None,
        idle_deadline: float | None = None,
        absolute_deadline: float | None = None,
    ) -> None:
        if task_id in self.subtasks:
            entry = self.subtasks[task_id]
            if phase is not None:
                entry['phase'] = phase
            if phase_name is not None:
                entry['phase_name'] = phase_name
            if last_progress_at is not None:
                entry['last_progress_at'] = last_progress_at
            if token_count is not None:
                entry['token_count'] = token_count
            if tokens_per_second is not None:
                entry['tokens_per_second'] = tokens_per_second
            if tokens_per_second_approximate is not None:
                entry['tokens_per_second_approximate'] = tokens_per_second_approximate
            if eta_seconds is not None:
                entry['eta_seconds'] = eta_seconds
            if idle_deadline is not None:
                entry['idle_deadline'] = idle_deadline
            if absolute_deadline is not None:
                entry['absolute_deadline'] = absolute_deadline

    def finish_subtask(
        self,
        task_id: str,
        agent_id: str,
        status: str,
        result: str | None = None,
        error: str | None = None,
        summary: str | None = None,
    ) -> None:
        self.running_agents.discard(agent_id)
        if task_id in self.subtasks:
            entry = self.subtasks[task_id]
            entry['status'] = status
            entry['completed_at'] = time.time()
            entry['error'] = error
            if status == 'completed':
                entry['phase'] = 'completed'
                entry['phase_name'] = '任务已完成'
            elif status == 'cancelled':
                entry['phase'] = 'cancelled'
                entry['phase_name'] = '任务已取消'
            else:
                entry['phase'] = 'failed'
                entry['phase_name'] = '任务执行失败'
            if result:
                clean_result = sanitize_text(result)
                if len(clean_result) > MAX_MESSAGE_CHARS:
                    clean_result = clean_result[:MAX_MESSAGE_CHARS] + '... [截断]'
                entry['result'] = clean_result

        if status == 'completed' and result:
            clean_result = sanitize_text(result)
            clean_summary = sanitize_text(summary or (clean_result[:200] if clean_result else ''))
            if len(clean_result) > MAX_MESSAGE_CHARS:
                clean_result = clean_result[:MAX_MESSAGE_CHARS] + '... [截断]'
            agent_disp_name = self.subtasks.get(task_id, {}).get('agent_name', agent_id)
            self.completed_reports.append({
                'task_id': task_id,
                'agent_id': agent_id,
                'agent_name': agent_disp_name,
                'task': self.subtasks.get(task_id, {}).get('task', ''),
                'summary': clean_summary,
                'result': clean_result,
                'completed_at': time.time(),
            })
            # 广播成果汇报到集群群聊黑板
            self.add_blackboard_message(
                sender_id=agent_id,
                sender_name=agent_disp_name,
                role="expert",
                msg_type="report",
                content=clean_summary or clean_result[:300],
                metadata={"task_id": task_id, "summary": clean_summary, "has_full_result": bool(clean_result)},
            )
        elif status == 'failed':
            agent_disp_name = self.subtasks.get(task_id, {}).get('agent_name', agent_id)
            self.add_blackboard_message(
                sender_id=agent_id,
                sender_name=agent_disp_name,
                role="expert",
                msg_type="error",
                content=f"任务执行异常：{error or '未知错误'}",
                metadata={"task_id": task_id, "error": error},
            )

    def read_shared_context_summary(self, caller_agent_id: str | None = None) -> dict[str, Any]:
        peer_reports = [
            {
                'agent_id': r['agent_id'],
                'agent_name': r['agent_name'],
                'task': r['task'][:200],
                'summary': r['summary'],
                'result': r['result'],
            }
            for r in self.completed_reports
            if not caller_agent_id or r['agent_id'] != caller_agent_id
        ]
        subtask_list = [
            {
                'task_id': tid,
                'agent_id': item['agent_id'],
                'agent_name': item['agent_name'],
                'parent_agent_id': item.get('parent_agent_id'),
                'call_chain': item.get('call_chain', []),
                'status': item['status'],
                'phase': item.get('phase', 'running'),
                'phase_name': item.get('phase_name', ''),
                'task': item['task'][:150],
                'last_progress_at': item.get('last_progress_at'),
                'token_count': item.get('token_count'),
                'tokens_per_second': item.get('tokens_per_second'),
                'tokens_per_second_approximate': item.get('tokens_per_second_approximate'),
                'eta_seconds': item.get('eta_seconds'),
                'idle_deadline': item.get('idle_deadline'),
                'absolute_deadline': item.get('absolute_deadline'),
            }
            for tid, item in self.subtasks.items()
        ]
        return {
            'root_invocation_id': self.root_invocation_id,
            'overall_objective': self.overall_objective[:1000],
            'subtasks_status': subtask_list,
            'peer_completed_reports': peer_reports,
            'total_completed_reports': len(peer_reports),
            'blackboard_messages': self.blackboard_messages[-20:],
        }

    def get_bounded_snapshot_text(self, caller_agent_id: str | None = None) -> str:
        summary = self.read_shared_context_summary(caller_agent_id)
        parts: list[str] = [
            f'【协作共享总目标】: {summary["overall_objective"]}',
        ]
        if summary['peer_completed_reports']:
            parts.append('【同伴智能体已完成回传成果】:')
            for report in summary['peer_completed_reports']:
                task_title = report["task"]
                summary_text = report["summary"]
                parts.append(f"- 来自 [{report['agent_name']}]: 任务 \"{task_title}\"\n  摘要: {summary_text}")
        text = "\n".join(parts)
        if len(text) > MAX_TOTAL_CHARS:
            text = text[:MAX_TOTAL_CHARS] + "\n... [共享上下文已截断至上限]"
        return text

    def to_dict(self) -> dict[str, Any]:
        return {
            'root_invocation_id': self.root_invocation_id,
            'session_id': self.session_id,
            'overall_objective': self.overall_objective,
            'delegation_path': self.delegation_path,
            'subtasks': list(self.subtasks.values()),
            'completed_reports': self.completed_reports,
            'lineage': self.lineage,
            'blackboard_messages': self.blackboard_messages,
        }
