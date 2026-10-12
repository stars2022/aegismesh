import { FormEvent, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Database,
  GitBranch,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { api } from "../api";
import { confirmDialog } from "../dialog";
import { Dropdown, Switch } from "../components";
import { SchemaEditors, StructuredCapability } from "../StructuredIO";
import { parseSchemaText, schemaText } from "../structuredIOModel";
import type { Agent, Provider, Skill } from "../types";

function SkillSubModal({
  skill,
  onSave,
  onClose,
}: {
  skill: Skill;
  onSave: (skill: Skill) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(skill.name || "");
  const [id, setId] = useState(skill.id || "");
  const [version, setVersion] = useState(skill.version || "1.0.0");
  const [description, setDescription] = useState(skill.description || "");
  const [tagsStr, setTagsStr] = useState((skill.tags || []).join(", "));
  const [examplesStr, setExamplesStr] = useState(
    (skill.examples || []).join("\n"),
  );
  const [inputModesStr, setInputModesStr] = useState(
    (skill.input_modes || ["text/plain", "application/json"]).join(", "),
  );
  const [outputModesStr, setOutputModesStr] = useState(
    (skill.output_modes || ["application/json", "text/markdown"]).join(", "),
  );
  const [inputSchema, setInputSchema] = useState(schemaText(skill.input_schema));
  const [outputSchema, setOutputSchema] = useState(schemaText(skill.output_schema));
  const [error, setError] = useState("");

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("请填写技能名称");
      return;
    }
    const cleanId = id.trim() || name.trim().toLowerCase().replace(/\s+/g, "-");
    const tags = tagsStr
      .split(/[,，]/)
      .map((t: string) => t.trim())
      .filter(Boolean);
    const examples = examplesStr
      .split("\n")
      .map((ex: string) => ex.trim())
      .filter(Boolean);
    const input_modes = inputModesStr
      .split(/[,，]/)
      .map((m: string) => m.trim())
      .filter(Boolean);
    const output_modes = outputModesStr
      .split(/[,，]/)
      .map((m: string) => m.trim())
      .filter(Boolean);

    let parsedInput, parsedOutput;
    try { parsedInput = parseSchemaText(inputSchema); parsedOutput = parseSchemaText(outputSchema); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Schema 格式不正确"); return; }
    onSave({
      ...skill,
      id: cleanId,
      name: name.trim(),
      version: version.trim() || "1.0.0",
      description: description.trim(),
      tags,
      examples,
      input_modes: input_modes.length > 0 ? input_modes : ["text/plain"],
      output_modes:
        output_modes.length > 0 ? output_modes : ["application/json"],
      input_schema: parsedInput,
      output_schema: parsedOutput,
    });
  };

  return (
    <div className="drawer-layer" style={{ zIndex: 1200 }}>
      <button className="drawer-backdrop" onClick={onClose} aria-label="关闭" />
      <div className="preview-modal-dialog skill-sub-dialog">
        <div className="preview-modal-header">
          <div>
            <h3>
              {skill.id ? "编辑技能配置 (二级菜单)" : "添加新技能规范 (二级菜单)"}
            </h3>
            <p className="preview-modal-sub">
              配置官方标准 ACS 所需的技能版本、描述、标签、提问示例与支持的输入输出模式。
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} className="skill-modal-form">
          <div className="preview-modal-body">
            {error && <div className="builder-error">{error}</div>}
            <div className="two-column">
              <label>
                <RequiredLabel>技能名称</RequiredLabel>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!id) {
                      setId(e.target.value.toLowerCase().replace(/\s+/g, "-"));
                    }
                  }}
                  placeholder="例如：行业研究、代码编写、财务审计"
                />
              </label>
              <label>
                <RequiredLabel>技能标识 (ID)</RequiredLabel>
                <input
                  type="text"
                  required
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="例如：industry-research"
                />
              </label>
            </div>

            <div className="two-column">
              <label>
                <RequiredLabel>规范版本 (Version)</RequiredLabel>
                <input
                  type="text"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.0.0"
                />
              </label>
              <label>
                <span>业务标签 (Tags，逗号分隔)</span>
                <input
                  type="text"
                  value={tagsStr}
                  onChange={(e) => setTagsStr(e.target.value)}
                  placeholder="研报, 投顾, 深度分析"
                />
              </label>
            </div>

            <label>
              <span>技能详细描述 (Description)</span>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="详细说明该技能的具体职责、输入约束与执行逻辑..."
              />
            </label>

            <label>
              <span>用户示例指令 / 提问示例 (Examples，每行一条)</span>
              <textarea
                rows={3}
                value={examplesStr}
                onChange={(e) => setExamplesStr(e.target.value)}
                placeholder="每行一个示例，例如：&#10;分析 2026 年新能源汽车出海格局&#10;出具光伏逆变器行业研报"
              />
            </label>

            <div className="two-column">
              <label>
                <span>支持输入格式 (Input Modes)</span>
                <input
                  type="text"
                  value={inputModesStr}
                  onChange={(e) => setInputModesStr(e.target.value)}
                  placeholder="text/plain, application/json"
                />
              </label>
              <label>
                <span>支持输出格式 (Output Modes)</span>
                <input
                  type="text"
                  value={outputModesStr}
                  onChange={(e) => setOutputModesStr(e.target.value)}
                  placeholder="application/json, text/markdown"
                />
              </label>
            </div>
            <details className="structured-skill-editors">
              <summary>结构化字段（可选）</summary>
              <SchemaEditors input={inputSchema} output={outputSchema} onInput={setInputSchema} onOutput={setOutputSchema} inherited/>
            </details>
          </div>
          <div className="preview-modal-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="primary-button">
              保存技能配置
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const SYSTEM_AVAILABLE_TOOLS = [
  {
    id: "web_search",
    name: "联网检索 (Web Search)",
    category: "检索与信息",
    description: "实时检索互联网最新公开信息与引用资料，避免大模型知识盲区与幻觉（支持 DeepSeek 等主流模型联网能力）。",
  },
  {
    id: "calculator",
    name: "基础算术计算器 (Calculator)",
    category: "计算与逻辑",
    description: "高精度执行加减乘除、乘方与数学算术表达式求值，保障关键指标计算无偏差。",
  },
  {
    id: "current_time",
    name: "系统与时区时钟 (Current Time)",
    category: "系统辅助",
    description: "获取指定 IANA 时区或系统当前的精确标准时间与日期，支持时间敏感型任务。",
  },
];

export function AgentBuilder({
  agent,
  providers,
  onClose,
  onSaved,
}: {
  agent: Agent | null;
  providers: Provider[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [structuredEnabled, setStructuredEnabled] = useState(agent?.structured_io_enabled ?? false);
  const [structuredDetailsOpen, setStructuredDetailsOpen] = useState(false);
  const [inputSchema, setInputSchema] = useState(schemaText(agent?.input_schema));
  const [outputSchema, setOutputSchema] = useState(schemaText(agent?.output_schema));
  const [toolsSubmenuOpen, setToolsSubmenuOpen] = useState(true);
  const [customToolInput, setCustomToolInput] = useState("");
  const [skills, setSkills] = useState<Skill[]>(() => {
    if (agent?.skills && agent.skills.length > 0) {
      return agent.skills.map((s) => ({
        ...s,
        id: s.id || "",
        name: s.name || "",
        version: s.version || "1.0.0",
        description: s.description || "",
        tags: s.tags || [],
        examples: s.examples || [],
        input_modes: s.input_modes || ["text/plain", "application/json"],
        output_modes: s.output_modes || ["application/json", "text/markdown"],
      }));
    }
    return [
      {
        id: "industry-research",
        name: "行业研究",
        version: "1.0.0",
        description: "提供专业深入的行业研究、数据整理与综合分析研报。",
        tags: ["行业研究", "数据分析", "研报生成"],
        examples: ["分析 2026 年新能源汽车出海格局", "出具光伏逆变器行业研报"],
        input_modes: ["text/plain", "application/json"],
        output_modes: ["application/json", "text/markdown"],
      },
    ];
  });
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [editingSkillIndex, setEditingSkillIndex] = useState<number | null>(null);

  const [form, setForm] = useState({
    id: agent?.id || "",
    name: agent?.name || "",
    role: agent?.role || "partner",
    description: agent?.description || "",
    system_prompt: agent?.system_prompt || "",
    aic: agent?.aic || "",
    transport: agent?.transport || "provider",
    endpoint_url: agent?.endpoint_url || "",
    identity_mode: agent?.aic ? "trusted" : "local",
    usage_mode: agent?.usage_mode || "internal",
    streaming_enabled: agent?.streaming_enabled ?? true,
    model_provider: agent?.model_provider || "",
    model_name: agent?.model_name || "",
    tools: agent?.tools.join(", ") || "",
  });
  const update = (key: string, value: string) => {
    setSaveError("");
    setForm((current) => ({ ...current, [key]: value }));
  };

  const activeTools = useMemo(() => {
    return form.tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }, [form.tools]);

  const toggleTool = (toolId: string, enabled: boolean) => {
    let next: string[];
    if (enabled) {
      next = activeTools.includes(toolId) ? activeTools : [...activeTools, toolId];
    } else {
      next = activeTools.filter((t) => t !== toolId);
    }
    update("tools", next.join(", "));
  };

  const handleAddCustomTool = () => {
    const trimmed = customToolInput.trim();
    if (!trimmed) return;
    if (!activeTools.includes(trimmed)) {
      update("tools", [...activeTools, trimmed].join(", "));
    }
    setCustomToolInput("");
  };
  const idPattern = /^[A-Za-z0-9_.-]+$/;
  const endpointPattern = /^https?:\/\/\S+$/;
  const validAic = (value: string) => {
    const parts = value.trim().toUpperCase().split(".");
    if (parts.length !== 10 || parts.slice(0, 4).join(".") !== "1.2.156.3088")
      return false;
    const limits = [
      [1, 1],
      [1, 6],
      [1, 6],
      [1, 9],
      [1, 9],
      [4, 4],
    ];
    return parts
      .slice(4)
      .every(
        (part, index) =>
          /^[0-9A-Z]+$/.test(part) &&
          part.length >= limits[index][0] &&
          part.length <= limits[index][1],
      );
  };
  const stepError = (index: number) => {
    if (index === 0) {
      if (!form.name.trim()) return "请填写名称";
      if (!form.id.trim()) return "请填写标识";
      if (!agent && !idPattern.test(form.id.trim()))
        return "标识仅支持字母、数字与 . _ -";
      if (form.identity_mode === "trusted" && !form.aic.trim())
        return "请填写可信注册签发的 AIC";
      if (form.identity_mode === "trusted" && !validAic(form.aic))
        return "AIC 格式不符合官方规范";
      return "";
    }
    if (index === 1) {
      if (skills.length === 0) return "请至少配置一个业务能力技能";
      if (skills.some((s) => !s.name.trim())) return "存在未命名技能，请完善技能配置";
      try { parseSchemaText(inputSchema); parseSchemaText(outputSchema); }
      catch (reason) { return `结构化输入输出：${reason instanceof Error ? reason.message : "Schema 格式不正确"}`; }
      if (structuredEnabled && !inputSchema.trim() && !outputSchema.trim() && !skills.some(skill => skill.input_schema || skill.output_schema)) return "结构化输入输出：请配置至少一个输入或输出 Schema";
      return "";
    }
    if (index === 2) {
      if (form.transport === "provider")
        return form.model_provider ? "" : "请选择模型供应商";
      if (!form.endpoint_url.trim()) return "请填写 AIP 端点";
      return endpointPattern.test(form.endpoint_url.trim())
        ? ""
        : "端点必须是 http(s) 地址";
    }
    return "";
  };
  const goToStep = (target: number) => {
    if (target <= step) {
      setSaveError("");
      setStep(target);
      return;
    }
    for (let index = 0; index < target; index += 1) {
      const error = stepError(index);
      if (error) {
        if (error.startsWith("结构化输入输出：")) setStructuredDetailsOpen(true);
        setStep(index);
        setSaveError(error);
        return;
      }
    }
    setSaveError("");
    setStep(target);
  };

  const handleOpenAddSkill = () => {
    setEditingSkillIndex(null);
    setSkillModalOpen(true);
  };

  const handleOpenEditSkill = (index: number) => {
    setEditingSkillIndex(index);
    setSkillModalOpen(true);
  };

  const handleSaveSkill = (savedSkill: Skill) => {
    if (editingSkillIndex !== null && editingSkillIndex >= 0) {
      setSkills((prev) => {
        const next = [...prev];
        next[editingSkillIndex] = savedSkill;
        return next;
      });
    } else {
      setSkills((prev) => [...prev, savedSkill]);
    }
    setSkillModalOpen(false);
    setEditingSkillIndex(null);
  };

  const handleDeleteSkill = (index: number) => {
    if (skills.length <= 1) {
      setSaveError("至少保留一个业务技能");
      return;
    }
    setSkills((prev) => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    for (let index = 0; index < 3; index += 1) {
      const error = stepError(index);
      if (error) {
        if (error.startsWith("结构化输入输出：")) setStructuredDetailsOpen(true);
        setStep(index);
        setSaveError(error);
        return;
      }
    }
    setSaving(true);
    setSaveError("");
    const payload = {
      id: form.id || `agent-${Date.now()}`,
      name: form.name,
      role: form.role as "leader" | "partner",
      description: form.description,
      system_prompt: form.system_prompt,
      aic:
        form.identity_mode === "trusted" ? form.aic.trim().toUpperCase() : "",
      transport: form.transport,
      usage_mode: form.identity_mode === "local" ? "internal" : form.usage_mode,
      streaming_enabled: form.streaming_enabled,
      structured_io_enabled: structuredEnabled,
      input_schema: parseSchemaText(inputSchema),
      output_schema: parseSchemaText(outputSchema),
      endpoint_url: form.endpoint_url,
      input_modes: ["text/plain", "application/json"],
      output_modes: ["application/json", "text/markdown"],
      security_schemes: ["mtls"],
      skills: skills.map((s) => ({
        ...s,
        id: s.id.trim() || s.name.trim().toLowerCase().replace(/\s+/g, "-"),
        name: s.name.trim(),
        version: s.version?.trim() || "1.0.0",
        description: s.description?.trim() || "",
        tags: s.tags || [],
        examples: s.examples || [],
        input_modes:
          s.input_modes && s.input_modes.length > 0
            ? s.input_modes
            : ["text/plain", "application/json"],
        output_modes:
          s.output_modes && s.output_modes.length > 0
            ? s.output_modes
            : ["application/json", "text/markdown"],
      })),
      tools: form.tools
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      model_provider: form.model_provider,
      model_name: form.model_name,
      active: true,
      health: "unknown",
      estimated_cost_per_1k: 0,
    };
    try {
      if (agent) await api.updateAgent(agent.id, payload);
      else await api.createAgent(payload);
      await onSaved();
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const steps = ["身份", "能力", "运行", "确认"];
  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" onClick={onClose} />
      <aside className="builder-drawer">
        <div className="drawer-header">
          <h2>{agent ? "编辑智能体" : "创建智能体"}</h2>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="stepper">
          {steps.map((label, index) => (
            <button
              key={label}
              className={index === step ? "active" : index < step ? "done" : ""}
              onClick={() => goToStep(index)}
            >
              <span>{index < step ? <Check size={13} /> : index + 1}</span>
              {label}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {saveError && <div className="builder-error">{saveError}</div>}
          {step === 0 && (
            <div className="form-stack">
              <label>
                <RequiredLabel>角色</RequiredLabel>
                <div className="role-selector">
                  <button
                    className={form.role === "leader" ? "active" : ""}
                    onClick={() => update("role", "leader")}
                  >
                    <GitBranch size={20} />
                    <strong>协调型</strong>
                    <span>规划与协调任务</span>
                  </button>
                  <button
                    className={form.role === "partner" ? "active" : ""}
                    onClick={() => update("role", "partner")}
                  >
                    <Bot size={20} />
                    <strong>执行型</strong>
                    <span>执行专业任务</span>
                  </button>
                </div>
              </label>
              <label>
                <RequiredLabel>身份方式</RequiredLabel>
                <div className="role-selector identity-selector">
                  <button
                    className={form.identity_mode === "local" ? "active" : ""}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        identity_mode: "local",
                        aic: "",
                        usage_mode: agent ? current.usage_mode : "internal",
                      }))
                    }
                  >
                    <Database size={20} />
                    <strong>本地创建</strong>
                    <span>创建后可提交可信审核</span>
                  </button>
                  <button
                    className={form.identity_mode === "trusted" ? "active" : ""}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        identity_mode: "trusted",
                        usage_mode: agent ? current.usage_mode : "both",
                      }))
                    }
                  >
                    <ShieldCheck size={20} />
                    <strong>已有可信 AIC</strong>
                    <span>接入已取得的可信身份</span>
                  </button>
                </div>
              </label>
              <Field
                required
                label="名称"
                value={form.name}
                onChange={(value) => update("name", value)}
                placeholder="例如研究协调器"
              />
              <Field
                required
                label="标识"
                value={form.id}
                onChange={(value) => update("id", value)}
                placeholder="research-lead"
                hint="字母、数字、点、下划线或连字符"
                disabled={Boolean(agent)}
              />
              {form.identity_mode === "trusted" ? (
                <Field
                  required
                  label="AIC"
                  value={form.aic}
                  onChange={(value) => update("aic", value)}
                  placeholder="1.2.156.3088.…"
                  hint="填写可信注册已签发的 10 段 AIC"
                />
              ) : (
                <div className="info-block">
                  <ShieldCheck size={16} />
                  <div>
                    <strong>先在本地创建</strong>
                    <p>
                      保存后可从智能体卡片提交可信审核，审核通过后平台会同步
                      AIC。
                    </p>
                  </div>
                </div>
              )}
              <label>
                描述
                <textarea
                  rows={4}
                  value={form.description}
                  onChange={(event) =>
                    update("description", event.target.value)
                  }
                  placeholder="说明职责和边界"
                />
              </label>
            </div>
          )}
          {step === 1 && (
            <div className="form-stack">
              <StructuredCapability
                enabled={structuredEnabled} onEnabled={value => { setStructuredEnabled(value); setSaveError(""); }}
                open={structuredDetailsOpen} onOpen={setStructuredDetailsOpen}
                input={inputSchema} output={outputSchema}
                onInput={value => { setInputSchema(value); setSaveError(""); }}
                onOutput={value => { setOutputSchema(value); setSaveError(""); }}
              />
              <div className="skills-mgr-box">
                <div className="skills-mgr-header">
                  <div>
                    <label style={{ margin: 0 }}>
                      <RequiredLabel>业务能力与技能规范 (Skills)</RequiredLabel>
                    </label>
                    <p className="skills-mgr-hint">
                      遵循可信互联规范，支持配置技能版本、描述、标签、提问示例与支持的输入输出模式。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button add-skill-btn"
                    onClick={handleOpenAddSkill}
                  >
                    + 添加新技能
                  </button>
                </div>

                <div className="skills-cards-list">
                  {skills.map((skillItem, sIndex) => (
                    <div key={skillItem.id || sIndex} className="skill-mgr-card">
                      <div className="skill-mgr-card-top">
                        <div className="skill-mgr-title-group">
                          <span className="skill-mgr-title">{skillItem.name || "未命名技能"}</span>
                          <span className="skill-badge-id">{skillItem.id}</span>
                          <span className="skill-badge-ver">v{skillItem.version || "1.0.0"}</span>
                        </div>
                        <div className="skill-mgr-actions">
                          <button
                            type="button"
                            className="text-link-btn"
                            onClick={() => handleOpenEditSkill(sIndex)}
                          >
                            编辑规范
                          </button>
                          {skills.length > 1 && (
                            <button
                              type="button"
                              className="text-link-btn danger"
                              onClick={() => handleDeleteSkill(sIndex)}
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </div>

                      {skillItem.description && (
                        <div className="skill-mgr-desc">{skillItem.description}</div>
                      )}

                      <div className="skill-mgr-meta-row">
                        {skillItem.tags && skillItem.tags.length > 0 && (
                          <div className="skill-mgr-tags">
                            {skillItem.tags.map((t: string) => (
                              <span key={t} className="skill-mgr-tag">
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}
                        {skillItem.examples && skillItem.examples.length > 0 && (
                          <span className="skill-mgr-examples-count">
                            {skillItem.examples.length} 个提问示例
                          </span>
                        )}
                        <span className="skill-mgr-io-hint">
                          模式: [{(skillItem.input_modes || []).join(", ")}] → [{(skillItem.output_modes || []).join(", ")}]
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="tools-subgroup-panel">
                <div
                  className="tools-subgroup-header"
                  onClick={() => setToolsSubmenuOpen((prev) => !prev)}
                >
                  <div className="tools-header-info">
                    <Wrench size={16} className="tools-header-icon" />
                    <div>
                      <h4 className="tools-header-title">可用工具管理 (Tools)</h4>
                      <p className="tools-header-subtitle">
                        子菜单开关配置智能体可用工具能力，无需手动输入
                      </p>
                    </div>
                  </div>
                  <div className="tools-header-actions">
                    <span
                      className={`tools-count-pill ${activeTools.length > 0 ? "has-active" : ""}`}
                    >
                      已启用 {activeTools.length} 项
                    </span>
                    <button
                      type="button"
                      className="tools-submenu-toggle"
                      aria-label={toolsSubmenuOpen ? "收起工具子菜单" : "展开工具子菜单"}
                    >
                      {toolsSubmenuOpen ? (
                        <ChevronUp size={15} />
                      ) : (
                        <ChevronDown size={15} />
                      )}
                    </button>
                  </div>
                </div>

                {activeTools.length > 0 && (
                  <div className="tools-active-pills">
                    {activeTools.map((t) => (
                      <span key={t} className="tool-active-pill">
                        {t}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleTool(t, false);
                          }}
                          title="移出可用工具"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {toolsSubmenuOpen && (
                  <div className="tools-list">
                    {SYSTEM_AVAILABLE_TOOLS.map((item) => {
                      const isEnabled = activeTools.includes(item.id);
                      return (
                        <div
                          key={item.id}
                          className={`tool-card ${isEnabled ? "active" : ""}`}
                          onClick={() => toggleTool(item.id, !isEnabled)}
                        >
                          <div className="tool-card-main">
                            <div className="tool-card-head">
                              <span className="tool-card-name">{item.name}</span>
                              <span className="tool-card-category">
                                {item.category}
                              </span>
                              <code className="tool-card-code">{item.id}</code>
                            </div>
                            <p className="tool-card-desc">{item.description}</p>
                          </div>
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: "flex", alignItems: "center" }}
                          >
                            <Switch
                              checked={isEnabled}
                              onChange={(val) => toggleTool(item.id, val)}
                            />
                          </div>
                        </div>
                      );
                    })}

                    {activeTools
                      .filter(
                        (t) =>
                          !SYSTEM_AVAILABLE_TOOLS.some((item) => item.id === t),
                      )
                      .map((customId) => (
                        <div
                          key={customId}
                          className="tool-card active"
                          onClick={() => toggleTool(customId, false)}
                        >
                          <div className="tool-card-main">
                            <div className="tool-card-head">
                              <span className="tool-card-name">
                                自定义工具 ({customId})
                              </span>
                              <span className="tool-card-category">扩展</span>
                              <code className="tool-card-code">{customId}</code>
                            </div>
                            <p className="tool-card-desc">
                              自定义外部注册工具
                            </p>
                          </div>
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: "flex", alignItems: "center" }}
                          >
                            <Switch
                              checked={true}
                              onChange={(val) => toggleTool(customId, val)}
                            />
                          </div>
                        </div>
                      ))}

                    <div className="tools-custom-add">
                      <input
                        type="text"
                        placeholder="输入其他自定义扩展工具（如 mcp_custom_tool）"
                        value={customToolInput}
                        onChange={(e) => setCustomToolInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAddCustomTool();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={handleAddCustomTool}
                        disabled={!customToolInput.trim()}
                      >
                        + 添加工具
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <label>
                系统提示词 (System Prompt)
                <textarea
                  rows={6}
                  value={form.system_prompt}
                  onChange={(event) =>
                    update("system_prompt", event.target.value)
                  }
                  placeholder="编写这个智能体的身份、任务边界和输出要求"
                />
              </label>
            </div>
          )}
          {step === 2 && (
            <div className="form-stack">
              <label>
                <RequiredLabel>运行方式</RequiredLabel>
                <Dropdown
                  value={form.transport}
                  onChange={(value) => update("transport", value)}
                  options={[
                    { value: "provider", label: "托管模型" },
                    { value: "aip-rpc", label: "AIP 智能体" },
                  ]}
                />
              </label>
              <label>
                <RequiredLabel>使用方式</RequiredLabel>
                {form.identity_mode === "local" ? (
                  <div className="locked-selection">
                    <ShieldCheck size={15} />
                    <span>
                      <strong>仅内部调度</strong>
                      <small>可信验证完成后可开启对外服务</small>
                    </span>
                  </div>
                ) : (
                  <>
                    <Dropdown
                      value={form.usage_mode}
                      onChange={(value) => update("usage_mode", value)}
                      options={[
                        { value: "both", label: "内部调度 + 对外提供" },
                        { value: "internal", label: "仅内部调度" },
                        { value: "external", label: "仅对外提供" },
                      ]}
                    />
                    <small>控制智能体参与内部协同或对外提供服务</small>
                  </>
                )}
              </label>
              <div className="switch-row stream-switch">
                <span>
                  <strong>实时流式输出</strong>
                  <small>逐段返回模型内容，并在 ACS 中声明流式能力</small>
                </span>
                <Switch
                  checked={form.streaming_enabled}
                  onChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      streaming_enabled: value,
                    }))
                  }
                  label="实时流式输出"
                />
              </div>
              {form.transport === "provider" ? (
                <>
                  <label>
                    <RequiredLabel>模型供应商</RequiredLabel>
                    <Dropdown
                      value={form.model_provider}
                      onChange={(value) => update("model_provider", value)}
                      placeholder="选择供应商"
                      options={[
                        { value: "", label: "选择供应商" },
                        ...providers
                          .filter((provider) => provider.active)
                          .map((provider) => ({
                            value: provider.id,
                            label: provider.name,
                          })),
                      ]}
                    />
                  </label>
                  <Field
                    label="模型"
                    value={form.model_name}
                    onChange={(value) => update("model_name", value)}
                    placeholder={
                      providers.find(
                        (provider) => provider.id === form.model_provider,
                      )?.default_model || "模型标识"
                    }
                    hint="留空使用供应商默认模型"
                  />
                </>
              ) : (
                <Field
                  required
                  label="AIP 端点"
                  value={form.endpoint_url}
                  onChange={(value) => update("endpoint_url", value)}
                  placeholder="https://agent.example.com/rpc"
                />
              )}
            </div>
          )}
          {step === 3 && (
            <div className="review-card">
              <span className="agent-glyph large">
                {form.name.slice(0, 1) || "A"}
              </span>
              <span className="role-pill">{form.role}</span>
              <h3>{form.name || "未命名智能体"}</h3>
              <p>{form.description || "暂无描述"}</p>
              <dl>
                <div>
                  <dt>能力</dt>
                  <dd>
                    {skills.map((s) => `${s.name} (v${s.version || "1.0.0"})`).join("、") || "通用能力"}
                  </dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>
                    {form.model_provider} · {form.model_name}
                  </dd>
                </div>
                <div>
                  <dt>传输</dt>
                  <dd>{form.transport}</dd>
                </div>
                <div>
                  <dt>工具</dt>
                  <dd>{form.tools || "—"}</dd>
                </div>
                <div>
                  <dt>内置能力</dt>
                  <dd>{structuredEnabled ? "结构化输入输出" : "—"}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>
        <div className="drawer-footer">
          {agent && (
            <button
              type="button"
              className="secondary-button"
              style={{ color: "#dc2626", borderColor: "#fca5a5", marginRight: "auto", display: "inline-flex", alignItems: "center", gap: "4px" }}
              disabled={saving}
              onClick={async () => {
                if (!(await confirmDialog({ title: "删除智能体", message: `确定要删除智能体「${agent.name}」吗？该操作不可恢复。`, confirmLabel: "删除", danger: true }))) return;
                try {
                  await api.deleteAgent(agent.id);
                  onClose();
                  await onSaved();
                } catch (err) {
                  setSaveError(err instanceof Error ? err.message : "删除失败");
                }
              }}
            >
              <Trash2 size={13} />
              删除智能体
            </button>
          )}
          <span className="required-note" style={agent ? { marginLeft: "0" } : undefined}>
            <em>*</em> 必填
          </span>
          <button
            className="secondary-button"
            onClick={step === 0 ? onClose : () => goToStep(step - 1)}
          >
            {step === 0 ? "取消" : "上一步"}
          </button>
          {step < 3 ? (
            <button
              className="primary-button"
              onClick={() => goToStep(step + 1)}
            >
              继续 <ChevronRight size={16} />
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "保存中" : "保存智能体"}
            </button>
          )}
        </div>
      </aside>
      {skillModalOpen && (
        <SkillSubModal
          skill={
            editingSkillIndex !== null && skills[editingSkillIndex]
              ? skills[editingSkillIndex]
              : {
                  id: "",
                  name: "",
                  version: "1.0.0",
                  description: "",
                  tags: [],
                  examples: [],
                  input_modes: ["text/plain", "application/json"],
                  output_modes: ["application/json", "text/markdown"],
                }
          }
          onSave={handleSaveSkill}
          onClose={() => {
            setSkillModalOpen(false);
            setEditingSkillIndex(null);
          }}
        />
      )}
    </div>
  );
}

function RequiredLabel({ children }: { children: string }) {
  return (
    <span className="required-label">
      {children}
      <em>*</em>
    </span>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  disabled,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      {required ? <RequiredLabel>{label}</RequiredLabel> : label}
      <input
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}
