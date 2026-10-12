import { useState } from "react";
import { CirclePlus, Pencil, Play, ServerCog, Trash2, X } from "lucide-react";
import { api } from "../api";
import { confirmDialog } from "../dialog";
import { FlowMark } from "../LoadingFlow";
import { Dropdown, EmptyState, StatusDot, Switch } from "../components";
import { WebSearchSettings } from "../WebSearchSettings";
import type { Agent, Provider } from "../types";
import { Field } from "./AgentBuilder";
import { formatMs } from "../format";

export function Providers({
  providers,
  agents,
  onChanged,
}: {
  providers: Provider[];
  agents: Agent[];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Provider | null>(null);
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState("");
  const [notice, setNotice] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const remove = async (provider: Provider) => {
    if (!(await confirmDialog({ title: "删除供应商", message: `删除供应商“${provider.name}”？`, confirmLabel: "删除", danger: true }))) return;
    try {
      await api.deleteProvider(provider.id);
      await onChanged();
    } catch (reason) {
      setNotice({
        type: "error",
        message: reason instanceof Error ? reason.message : "删除失败",
      });
    }
  };
  const test = async (provider: Provider) => {
    setTesting(provider.id);
    setNotice(null);
    try {
      const result = await api.testProvider(provider.id);
      setNotice({
        type: "success",
        message: `${provider.name} 连接正常 · ${formatMs(result.latency_ms)}`,
      });
    } catch (reason) {
      setNotice({
        type: "error",
        message: reason instanceof Error ? reason.message : "连接失败",
      });
    } finally {
      setTesting("");
    }
  };
  return (
    <>
      <div className="toolbar provider-toolbar">
        <div className="provider-summary">
          <strong>{providers.length}</strong>
          <span>个供应商配置</span>
        </div>
        <button
          className="primary-button"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <CirclePlus size={16} />
          添加供应商
        </button>
      </div>
      {notice && (
        <div className={`connection-banner ${notice.type}`}>
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)}>关闭</button>
        </div>
      )}
      <div className="provider-grid">
        {providers.map((provider) => {
          const usage = agents.filter(
            (agent) => agent.model_provider === provider.id,
          ).length;
          return (
            <article className="panel provider-card" key={provider.id}>
              <div className="provider-card-head">
                <span className="provider-mark">
                  <ServerCog size={18} />
                </span>
                <span className="inline-status">
                  <StatusDot status={provider.active ? "online" : "unknown"} />
                  {provider.active ? "启用" : "停用"}
                </span>
              </div>
              <div>
                <h2>{provider.name}</h2>
                <code>{provider.kind}</code>
              </div>
              <dl>
                <div>
                  <dt>地址</dt>
                  <dd>{provider.base_url}</dd>
                </div>
                <div>
                  <dt>默认模型</dt>
                  <dd>{provider.default_model}</dd>
                </div>
                <div>
                  <dt>密钥</dt>
                  <dd>
                    {provider.api_key_env ||
                      (provider.key_configured ? "已安全保存" : "未配置")}
                  </dd>
                </div>
                <div>
                  <dt>智能体</dt>
                  <dd>{usage}</dd>
                </div>
              </dl>
              <div className="provider-actions">
                <button
                  onClick={() => void test(provider)}
                  disabled={testing === provider.id}
                >
                  {testing === provider.id ? (
                    <FlowMark className="flow-mark-compact" />
                  ) : (
                    <Play size={14} />
                  )}
                  测试
                </button>
                <button
                  onClick={() => {
                    setEditing(provider);
                    setOpen(true);
                  }}
                >
                  <Pencil size={14} />
                  编辑
                </button>
                <button onClick={() => void remove(provider)}>
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            </article>
          );
        })}
        {providers.length === 0 && (
          <div className="panel provider-empty">
            <EmptyState>添加模型供应商后即可创建托管智能体</EmptyState>
          </div>
        )}
      </div>
      {open && (
        <ProviderEditor
          provider={editing}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            await onChanged();
          }}
        />
      )}
      <WebSearchSettings providers={providers} />
    </>
  );
}

function ProviderEditor({
  provider,
  onClose,
  onSaved,
}: {
  provider: Provider | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    id: provider?.id || "",
    name: provider?.name || "",
    kind: provider?.kind || "openai-chat",
    base_url: provider?.base_url || "",
    default_model: provider?.default_model || "",
    api_key: "",
    api_key_env: provider?.api_key_env || "",
    active: provider?.active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (provider)
        await api.updateProvider(provider.id, {
          name: form.name,
          kind: form.kind,
          base_url: form.base_url,
          default_model: form.default_model,
          api_key: form.api_key || undefined,
          api_key_env: form.api_key_env,
          active: form.active,
        });
      else
        await api.createProvider({
          id: form.id,
          name: form.name,
          kind: form.kind,
          base_url: form.base_url,
          default_model: form.default_model,
          api_key: form.api_key || undefined,
          api_key_env: form.api_key_env,
          active: form.active,
        });
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" onClick={onClose} />
      <aside className="builder-drawer provider-drawer">
        <div className="drawer-header">
          <h2>{provider ? "编辑供应商" : "添加供应商"}</h2>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="form-stack">
            {error && <div className="builder-error">{error}</div>}
            <div className="two-column">
              <Field
                label="名称"
                value={form.name}
                onChange={(value) => update("name", value)}
                placeholder="例如 DeepSeek"
              />
              <Field
                label="标识"
                value={form.id}
                onChange={(value) => update("id", value)}
                placeholder="deepseek"
                disabled={Boolean(provider)}
              />
            </div>
            <label>
              接口类型
              <Dropdown
                value={form.kind}
                onChange={(value) => update("kind", value)}
                options={[
                  { value: "openai-chat", label: "兼容聊天补全" },
                  { value: "openai-responses", label: "OpenAI Responses" },
                  { value: "anthropic", label: "Anthropic Messages" },
                ]}
              />
            </label>
            <Field
              label="接口地址"
              value={form.base_url}
              onChange={(value) => update("base_url", value)}
              placeholder="https://api.example.com/v1"
            />
            <Field
              label="默认模型"
              value={form.default_model}
              onChange={(value) => update("default_model", value)}
              placeholder="模型标识"
            />
            <Field
              type="password"
              label="API Key"
              value={form.api_key}
              onChange={(value) => update("api_key", value)}
              placeholder={
                provider?.key_configured ? "留空保留现有密钥" : "输入密钥"
              }
            />
            <Field
              label="密钥环境变量"
              value={form.api_key_env}
              onChange={(value) => update("api_key_env", value)}
              placeholder="可选，例如 DEEPSEEK_API_KEY"
              hint="填写后优先读取服务器环境变量"
            />
            <Switch label="启用" checked={form.active} disabled={saving} onChange={(value) => update("active", value)} />
          </div>
        </div>
        <div className="drawer-footer">
          <button className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={
              saving ||
              !form.id ||
              !form.name ||
              !form.base_url ||
              !form.default_model ||
              (!provider?.key_configured && !form.api_key && !form.api_key_env)
            }
            onClick={() => void save()}
          >
            {saving ? "保存中" : "保存供应商"}
          </button>
        </div>
      </aside>
    </div>
  );
}
