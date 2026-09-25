from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..models import Agent, RoutingPolicy


@dataclass(slots=True)
class RoutingRequirements:
    query: str
    requested_skill: str | None = None
    input_mode: str = "text/plain"
    output_mode: str = "application/json"
    required_security: str | None = None
    required_transport: str | None = None


@dataclass(slots=True)
class ScoredCandidate:
    agent: Agent
    eligible: bool
    score: float
    breakdown: dict[str, float]
    reasons: list[str]
    rank: int | None = None
    weights: dict[str, float] = field(default_factory=dict)


# Bidirectional aliases so a Chinese query can meet an English skill name, and the reverse.
_SKILL_ALIASES: dict[str, set[str]] = {
    "文献": {"literature", "paper", "papers"},
    "检索": {"search", "retrieval"},
    "综述": {"review", "survey"},
    "路由": {"routing", "router"},
    "多智能体": {"multi-agent", "multiagent"},
    "论文": {"paper", "papers"},
    "评审": {"review", "peer-review"},
    "实验": {"experiment", "experiments"},
    "写作": {"writing"},
}


def _tokens(text: str) -> set[str]:
    latin = re.findall(r"[a-z0-9][a-z0-9_-]+", text.lower())
    chinese = re.findall(r"[\u4e00-\u9fff]{2,8}", text)
    chunks: set[str] = set(latin)
    for phrase in chinese:
        chunks.add(phrase)
        chunks.update(phrase[index : index + 2] for index in range(max(0, len(phrase) - 1)))
    return _expand_aliases(text, chunks)


# Concept ids shared by abbreviations and paraphrases. Cosine is computed on these sets.
_CONCEPTS: tuple[tuple[str, set[str]], ...] = (
    ("concept:literature", {"文献", "literature", "paper", "papers", "论文"}),
    ("concept:search", {"检索", "search", "retrieval", "retrieve"}),
    ("concept:nlp", {"nlp", "自然语言", "自然语言处理"}),
    ("concept:llm", {"llm", "大模型", "大语言模型"}),
    ("concept:mas", {"mas", "多智能体", "multi-agent", "multiagent"}),
    ("concept:ml", {"ml", "机器学习"}),
    ("concept:rag", {"rag", "检索增强"}),
    ("concept:review", {"评审", "综述", "review", "peer-review"}),
    ("concept:sql", {"sql", "数据库"}),
    ("concept:experiment", {"实验", "experiment", "experiments"}),
)


def _expand_aliases(text: str, tokens: set[str]) -> set[str]:
    lowered = text.lower()
    expanded = set(tokens)
    for phrase, aliases in _SKILL_ALIASES.items():
        phrase_hit = phrase in text or phrase in tokens
        alias_hit = any(alias in lowered or alias in tokens for alias in aliases)
        if phrase_hit or alias_hit:
            expanded.add(phrase)
            expanded.update(aliases)
    for concept, members in _CONCEPTS:
        if any(member in lowered or member in expanded for member in members):
            expanded.add(concept)
            expanded.update(members)
    return expanded


def _cosine(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / math.sqrt(len(left) * len(right))


class QualityRouter:
    """Hard-constraint routing with Bayesian, hybrid-entropy TOPSIS ranking."""

    def rank(
        self,
        agents: list[Agent],
        policy: RoutingPolicy,
        requirements: RoutingRequirements,
    ) -> list[ScoredCandidate]:
        candidates = [self.score(agent, policy, requirements) for agent in agents]
        eligible = [candidate for candidate in candidates if candidate.eligible]
        if eligible:
            matrix = [self._quality_metrics(candidate.agent, requirements) for candidate in eligible]
            hybrid_weights = self._hybrid_entropy_weights(matrix, policy.weights)
            vector_norms = {
                key: math.sqrt(sum(row[key] ** 2 for row in matrix)) or 1.0
                for key in hybrid_weights
            }
            weighted_rows = [
                {
                    key: row[key] / vector_norms[key] * hybrid_weights[key]
                    for key in hybrid_weights
                }
                for row in matrix
            ]
            ideal_best = {
                key: max(row[key] for row in weighted_rows) for key in hybrid_weights
            }
            ideal_worst = {
                key: min(row[key] for row in weighted_rows) for key in hybrid_weights
            }
            for candidate, raw, weighted in zip(eligible, matrix, weighted_rows, strict=True):
                distance_best = math.sqrt(
                    sum((weighted[key] - ideal_best[key]) ** 2 for key in hybrid_weights)
                )
                distance_worst = math.sqrt(
                    sum((weighted[key] - ideal_worst[key]) ** 2 for key in hybrid_weights)
                )
                distance_total = distance_best + distance_worst
                closeness = distance_worst / distance_total if distance_total else 0.5
                utility = sum(raw[key] * hybrid_weights[key] for key in hybrid_weights)
                # TOPSIS provides relative separation; utility keeps the score calibrated
                # when the candidate pool is small or nearly identical.
                candidate.score = round((0.8 * closeness + 0.2 * utility) * 100, 2)
                candidate.breakdown = {
                    key: round(raw[key] * hybrid_weights[key] * 100, 2)
                    for key in hybrid_weights
                }
                candidate.weights = {
                    key: round(value, 4) for key, value in hybrid_weights.items()
                }
                candidate.reasons.append(f"综合分 {closeness:.0%}")
            eligible.sort(key=lambda item: (-item.score, item.agent.id))
        for index, candidate in enumerate(eligible, start=1):
            candidate.rank = index
        ineligible = [candidate for candidate in candidates if not candidate.eligible]
        return eligible + ineligible

    def score(
        self,
        agent: Agent,
        policy: RoutingPolicy,
        requirements: RoutingRequirements,
    ) -> ScoredCandidate:
        reasons: list[str] = []
        now = datetime.now(timezone.utc)
        state = agent.circuit_state or "closed"
        open_until = (
            self._as_aware(agent.circuit_open_until) if agent.circuit_open_until else None
        )
        cooling = state == "open" and bool(open_until and open_until > now)
        probe_ready = state == "open" and not cooling

        if agent.active is False:
            reasons.append("未启用")
        if agent.health == "offline":
            reasons.append("离线")
        if cooling:
            reasons.append("连续失败后，暂时暂停编排确保服务稳定")
        if state == "half-open":
            reasons.append("正在测试模型稳定程度")
        supported_inputs = (
            agent.input_modes
            if agent.input_modes
            else ["text/plain", "application/json"]
        )
        if requirements.input_mode not in supported_inputs:
            reasons.append(f"输入模式不匹配：{requirements.input_mode}")

        supported_outputs = (
            agent.output_modes
            if agent.output_modes
            else ["application/json", "text/markdown", "text/plain"]
        )
        if requirements.output_mode not in supported_outputs:
            reasons.append(f"输出模式不匹配：{requirements.output_mode}")
        if requirements.required_security and requirements.required_security not in (
            agent.security_schemes or []
        ):
            reasons.append(f"安全方案不匹配：{requirements.required_security}")
        if requirements.required_transport and requirements.required_transport != agent.transport:
            reasons.append(f"传输方式不匹配：{requirements.required_transport}")

        eligible = not reasons
        if eligible and probe_ready:
            reasons.append("正在测试模型稳定程度")
        raw = self._quality_metrics(agent, requirements)
        skill = raw["skill"]
        success_count = agent.success_count or 0
        failure_count = agent.failure_count or 0
        request_total = success_count + failure_count
        reliability = raw["reliability"]
        feedback_positive = agent.feedback_positive_count or 0
        feedback_negative = agent.feedback_negative_count or 0
        feedback_total = feedback_positive + feedback_negative
        feedback = raw["feedback"]
        active_tasks = agent.active_tasks or 0
        queued_tasks = agent.queued_tasks or 0
        weights = self._normalized_weights(policy.weights, raw)
        weighted = {key: raw[key] * float(weights.get(key, 0)) for key in raw}
        score = round(sum(weighted.values()) * 100, 2) if eligible else 0.0

        if eligible:
            reasons.extend(
                [
                    f"智能体技能和问题所需能力的匹配程度 {skill:.0%}",
                    (
                        f"历史可靠性 {reliability:.0%}"
                        if request_total
                        else f"可靠性先验 {reliability:.0%}"
                    ),
                    (
                        f"用户满意度 {feedback:.0%}（{feedback_total} 条反馈）"
                        if feedback_total
                        else f"用户满意度先验 {feedback:.0%}"
                    ),
                    f"负载 {active_tasks} 运行 / {queued_tasks} 排队",
                ]
            )
        return ScoredCandidate(
            agent=agent,
            eligible=eligible,
            score=score,
            breakdown={key: round(value * 100, 2) for key, value in weighted.items()},
            reasons=reasons,
        )

    def _quality_metrics(
        self,
        agent: Agent,
        requirements: RoutingRequirements,
    ) -> dict[str, float]:
        success_count = agent.success_count or 0
        failure_count = agent.failure_count or 0
        feedback_positive = agent.feedback_positive_count or 0
        feedback_negative = agent.feedback_negative_count or 0
        latency_observation = agent.avg_latency_ms or 900
        return {
            "skill": self._skill_score(agent, requirements),
            "reliability": (success_count + 2) / (success_count + failure_count + 4),
            # Beta(2, 2) posterior mean: neutral at cold start and resistant to
            # isolated or adversarial votes.
            "feedback": (feedback_positive + 2)
            / (feedback_positive + feedback_negative + 4),
            "latency": 1 / (1 + max(latency_observation, 1) / 900),
            "load": 1 / (1 + (agent.active_tasks or 0) + 0.5 * (agent.queued_tasks or 0)),
            "health": {"online": 1.0, "degraded": 0.55, "unknown": 0.35}.get(
                agent.health or "online", 0.0
            ),
            "cost": 1 / (1 + max(agent.estimated_cost_per_1k or 0, 0) * 120),
        }

    @staticmethod
    def _normalized_weights(
        configured: dict[str, float],
        metrics: dict[str, float],
    ) -> dict[str, float]:
        available = {
            key: max(0.0, float(configured.get(key, 0.0))) for key in metrics
        }
        total = sum(available.values())
        if total <= 0:
            return {key: 1 / len(available) for key in available}
        return {key: value / total for key, value in available.items()}

    @classmethod
    def _hybrid_entropy_weights(
        cls,
        matrix: list[dict[str, float]],
        configured: dict[str, float],
        objective_ratio: float = 0.28,
    ) -> dict[str, float]:
        """Blend operator intent with entropy-derived request-local evidence."""
        subjective = cls._normalized_weights(configured, matrix[0])
        if len(matrix) < 2:
            return subjective
        entropy_divergence: dict[str, float] = {}
        normalizer = math.log(len(matrix))
        for key in subjective:
            values = [max(0.0, row[key]) for row in matrix]
            total = sum(values)
            if total <= 0 or normalizer <= 0:
                entropy_divergence[key] = 0.0
                continue
            probabilities = [value / total for value in values]
            entropy = -sum(
                probability * math.log(probability)
                for probability in probabilities
                if probability > 0
            ) / normalizer
            entropy_divergence[key] = max(0.0, 1.0 - entropy)
        divergence_total = sum(entropy_divergence.values())
        if divergence_total <= 1e-12:
            return subjective
        objective = {
            key: value / divergence_total for key, value in entropy_divergence.items()
        }
        blended = {
            key: (1 - objective_ratio) * subjective[key] + objective_ratio * objective[key]
            for key in subjective
        }
        total = sum(blended.values()) or 1.0
        return {key: value / total for key, value in blended.items()}

    @staticmethod
    def _as_aware(value: datetime) -> datetime:
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    @staticmethod
    def _skill_score(agent: Agent, requirements: RoutingRequirements) -> float:
        query_text = " ".join(filter(None, [requirements.query, requirements.requested_skill]))
        query_tokens = _tokens(query_text)
        if not query_tokens:
            return 0.5

        best = 0.0
        for skill in agent.skills or []:
            text = " ".join(
                [
                    str(skill.get("id", "")),
                    str(skill.get("name", "")),
                    str(skill.get("description", "")),
                    " ".join(skill.get("tags", [])),
                    " ".join(skill.get("examples", [])),
                ]
            )
            skill_tokens = _tokens(text)
            overlap = query_tokens & skill_tokens
            coverage = len(overlap) / max(1, min(len(query_tokens), 10))
            exact_bonus = 0.35 if requirements.requested_skill and requirements.requested_skill in text else 0
            direct_matches = sum(
                1
                for tag in skill.get("tags", [])
                if len(str(tag).strip()) >= 2 and str(tag).lower() in query_text.lower()
            )
            direct_score = 0.3 + min(0.7, direct_matches * 0.25) if direct_matches else 0
            lexical = min(1.0, 0.2 + coverage * 0.8 + exact_bonus)
            semantic = min(1.0, _cosine(query_tokens, skill_tokens) + exact_bonus)
            best = max(best, lexical, semantic, direct_score)

        generic = any(skill.get("id") == "general" for skill in (agent.skills or []))
        return max(best, 0.42 if generic else 0.12)
