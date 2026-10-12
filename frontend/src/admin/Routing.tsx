import { useRef, useState } from "react";
import { Check, ShieldCheck, Users } from "lucide-react";
import { api } from "../api";
import { equalizeWeights, normalizeWeights, rebalanceWeights } from "../routingWeights";
import { StatusDot, Switch } from "../components";
import type { Agent, Policy } from "../types";
import { stateNames } from "./labels";

export function Routing({
  policy,
  agents,
  onSaved,
}: {
  policy: Policy;
  agents: Agent[];
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Policy>(() => ({
    ...policy,
    weights: normalizeWeights(policy.weights),
  }));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const weightGesture = useRef<{ key: string; weights: Policy["weights"] } | null>(null);
  const labels: Record<string, string> = {
    skill: "匹配程度",
    reliability: "历史可靠性",
    feedback: "用户反馈",
    latency: "响应延迟",
    load: "实时负载",
    health: "健康状态",
    cost: "成本",
  };
  const total = Object.values(draft.weights).reduce(
    (sum, value) => sum + Math.round(value * 100),
    0,
  );
  const beginWeightGesture = (key: string) => {
    // Keep the other weights' proportions stable throughout a drag or keyboard adjustment.
    weightGesture.current = { key, weights: draft.weights };
  };
  const updateWeight = (key: string, percent: number) => {
    const gesture = weightGesture.current;
    setDraft((current) => ({
      ...current,
      weights: rebalanceWeights(
        gesture?.key === key ? gesture.weights : current.weights,
        key,
        percent,
      ),
    }));
    setSaved(false);
    setSaveError("");
  };
  const equalize = () => {
    weightGesture.current = null;
    setDraft((current) => ({ ...current, weights: equalizeWeights(current.weights) }));
    setSaved(false);
    setSaveError("");
  };
  const save = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await api.updatePolicy(draft);
      setSaved(true);
      await onSaved();
    } catch (reason) {
      setSaved(false);
      setSaveError(reason instanceof Error ? reason.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="routing-layout">
      <section className="panel policy-panel">
        <div className="panel-heading">
          <h2>排序比重 · {total}%</h2>
        </div>
        <p className="weight-help" id="weight-help">
          匹配程度指智能体技能和问题所需能力的匹配程度。这里调整各项比重，占本次排序的 72%。另外 28% 按本批候选的差距自动调整。连续失败后暂时暂停编排，以确保服务稳定；暂停结束后正在测试模型稳定程度，通过后再恢复编排。每次实际使用的比重和分项见运行记录。
        </p>
        <div className="weight-list">
          {Object.entries(draft.weights).map(([key, value]) => (
            <label key={key}>
              <div>
                <span>{labels[key] || key}</span>
                <strong>{Math.round(value * 100)}%</strong>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(value * 100)}
                aria-label={`${labels[key] || key}权重`}
                aria-valuetext={`${Math.round(value * 100)}%`}
                aria-describedby="weight-help"
                disabled={saving}
                onFocus={() => beginWeightGesture(key)}
                onPointerDown={() => beginWeightGesture(key)}
                onBlur={() => { weightGesture.current = null; }}
                onChange={(event) =>
                  updateWeight(key, Number(event.target.value))
                }
              />
            </label>
          ))}
        </div>
        {saveError && <p className="policy-error" role="alert">{saveError}</p>}
        <div className="policy-actions">
          <span className="valid-total">
            <Check size={14} /> 自动配平 · 合计 {total}%
          </span>
          <div className="policy-action-buttons">
            <button className="secondary-button" disabled={saving} onClick={equalize}>
              平均分配
            </button>
            <button
              className="primary-button"
              disabled={saving}
              onClick={() => void save()}
            >
              {saved ? <Check size={16} /> : null}
              {saving ? "保存中" : saved ? "已保存" : "保存策略"}
            </button>
          </div>
        </div>
      </section>
      <section className="panel rule-panel">
        <div className="panel-heading">
          <h2>故障策略</h2>
          <ShieldCheck size={18} />
        </div>
        <div className="setting-list">
          <Switch label="梧桐兼容模式" checked={Boolean(draft.interop_compatibility)} disabled={saving}
            onChange={(checked) => setDraft({ ...draft, interop_compatibility: checked })} />
          <p className="weight-help">开启后，智能体间派发统一走真实 AIP 调用：托管成员经认证 MQ，外部成员经 AIP。双方使用同一任务号记录 Access 日志；失败不回退内部直调。计榜以梧桐实际对账为准。随“保存策略”生效。</p>
          <Switch label="允许外部协调任务调用子智能体" checked={Boolean(draft.external_delegation_enabled)} disabled={saving}
            onChange={(checked) => setDraft({ ...draft, external_delegation_enabled: checked })} />
          <p className="weight-help">开启后，外部 AIP 请求可让协调型智能体发现并派发子任务，子调用始终走官方 AIP，不回退本地直调。关闭时仅执行自身任务；已配置的联网搜索不受影响。可能增加模型与子调用用量，最多三级调用链。保存后对新任务生效。</p>
          <Switch label="竞标模式" checked={Boolean(draft.bounty_enabled)} disabled={saving}
            onChange={checked => setDraft({ ...draft, bounty_enabled: checked })} />
          {draft.bounty_enabled && <>
            <NumberSetting label="参与成员上限" suffix="个" value={draft.bounty_max_workers ?? 3}
              onChange={value => setDraft({ ...draft, bounty_max_workers: Math.max(1, Math.min(5, value)) })} />
            <NumberSetting label="本轮任务上限" suffix="项" value={draft.bounty_max_items ?? 6}
              onChange={value => setDraft({ ...draft, bounty_max_items: Math.max(1, Math.min(12, value)) })} />
            <NumberSetting label="认领有效期" suffix="秒" value={draft.bounty_lease_seconds ?? 120}
              onChange={value => setDraft({ ...draft, bounty_lease_seconds: Math.max(10, Math.min(600, value)) })} />
          </>}
          <NumberSetting
            label="失败阈值"
            suffix="次"
            value={draft.failure_threshold}
            onChange={(value) =>
              setDraft({ ...draft, failure_threshold: value })
            }
          />
          <NumberSetting
            label="暂停时长"
            suffix="秒"
            value={draft.circuit_cooldown_seconds}
            onChange={(value) =>
              setDraft({ ...draft, circuit_cooldown_seconds: value })
            }
          />
          <NumberSetting
            label="最多尝试"
            suffix="个智能体"
            value={draft.max_attempts}
            onChange={(value) => setDraft({ ...draft, max_attempts: value })}
          />
          <NumberSetting
            label="单次超时"
            suffix="秒"
            value={draft.request_timeout_seconds}
            onChange={(value) =>
              setDraft({ ...draft, request_timeout_seconds: value })
            }
          />
        </div>
      </section>
      <section className="panel candidate-panel">
        <div className="panel-heading">
          <h2>候选池</h2>
          <Users size={18} />
        </div>
        <div className="candidate-list">
          {agents.map((agent) => (
            <div key={agent.id}>
              <span className="agent-glyph">{agent.name.slice(0, 1)}</span>
              <div>
                <strong>{agent.name}</strong>
                <span>
                  {agent.skills[0]?.name} · {agent.transport}
                </span>
              </div>
              <span className="inline-status">
                <StatusDot status={agent.circuit_state} />
                {stateNames[agent.circuit_state] || agent.circuit_state}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function NumberSetting({
  label,
  suffix,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <div>
        <input
          type="number"
          min="1"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <em>{suffix}</em>
      </div>
    </label>
  );
}
