import { useEffect, useState } from "react";
import { Database, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { StatusDot } from "../components";

export function AccessControl() {
  const [settings, setSettings] = useState<{
    api_key_configured: boolean;
    api_key_from_environment: boolean;
    demo_password_enabled: boolean;
  } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [demoPassword, setDemoPassword] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void api.accessSettings().then(setSettings);
  }, []);
  const save = async () => {
    const payload: { api_key?: string; demo_password?: string } = {};
    if (apiKey) payload.api_key = apiKey;
    if (demoPassword) payload.demo_password = demoPassword;
    setSettings(await api.updateAccessSettings(payload));
    setApiKey("");
    setDemoPassword("");
    setNotice("已保存");
  };
  const download = async () => {
    const url = URL.createObjectURL(await api.exportDatabase());
    const link = document.createElement("a");
    link.href = url;
    link.download = "aegismesh-database.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  const upload = async (file: File) => {
    const data = JSON.parse(await file.text()) as Record<string, unknown>;
    await api.importDatabase(data, "merge");
    setNotice("已导入");
    window.setTimeout(() => window.location.reload(), 500);
  };
  return (
    <div className="access-grid">
      <section className="panel access-panel">
        <div className="panel-heading">
          <h2>访问控制</h2>
          <ShieldCheck size={18} />
        </div>
        <div className="access-form">
          <label>
            开放 API Key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                settings?.api_key_configured ? "已配置" : "输入至少 16 位"
              }
            />
          </label>
          <div className="access-status">
            <StatusDot
              status={settings?.api_key_configured ? "online" : "unknown"}
            />
            {settings?.api_key_from_environment
              ? "由环境变量管理"
              : settings?.api_key_configured
                ? "已启用"
                : "待配置"}
            {settings?.api_key_configured &&
              !settings.api_key_from_environment && (
                <button
                  onClick={async () =>
                    setSettings(
                      await api.updateAccessSettings({ clear_api_key: true }),
                    )
                  }
                >
                  清除
                </button>
              )}
          </div>
          <label>
            聊天访问密码
            <input
              type="password"
              value={demoPassword}
              onChange={(event) => setDemoPassword(event.target.value)}
              placeholder={
                settings?.demo_password_enabled ? "已启用" : "留空表示公开访问"
              }
            />
          </label>
          <div className="access-status">
            <StatusDot
              status={settings?.demo_password_enabled ? "online" : "unknown"}
            />
            {settings?.demo_password_enabled ? "已启用" : "公开访问"}
            {settings?.demo_password_enabled && (
              <button
                onClick={async () =>
                  setSettings(
                    await api.updateAccessSettings({
                      clear_demo_password: true,
                    }),
                  )
                }
              >
                关闭
              </button>
            )}
          </div>
          <button
            className="primary-button"
            disabled={
              (!apiKey && !demoPassword) ||
              Boolean(apiKey && apiKey.length < 16) ||
              Boolean(demoPassword && demoPassword.length < 8)
            }
            onClick={() => void save()}
          >
            保存
          </button>
          {notice && <span className="saved-note">{notice}</span>}
        </div>
      </section>
      <section className="panel access-panel">
        <div className="panel-heading">
          <h2>数据库</h2>
          <Database size={18} />
        </div>
        <div className="data-actions">
          <button className="secondary-button" onClick={() => void download()}>
            导出数据库
          </button>
          <label className="secondary-button">
            导入数据库
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          <p>导入采用合并模式，相同主键的记录会更新。</p>
        </div>
      </section>
    </div>
  );
}
