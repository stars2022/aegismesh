import { useEffect, useRef, useState } from "react";
import { ExternalLink, Mic, MicOff, Volume2 } from "lucide-react";
import { api, type DigitalHumanAdminSettings } from "../api";
import { Dropdown, Switch } from "../components";
import { LoadingFlow } from "../LoadingFlow";
import type { Provider } from "../types";
import { mediaRecorderSupported, startWavRecorder, type AudioRecorderSession } from "../wavEncoder";
import "../AccountAdministration.css";

const ttsBackendOptions = [
  { value: "browser", label: "浏览器本地语音（Web Speech）" },
  { value: "deepseek", label: "DeepSeek 语音合成（/v1/tools/tts）" },
  { value: "disabled", label: "关闭语音播报" },
];

const asrBackendOptions = [
  { value: "browser", label: "浏览器内置识别（SpeechRecognition）" },
  { value: "deepseek", label: "DeepSeek 语音识别（/v1/tools/asr）" },
  { value: "disabled", label: "关闭语音输入" },
];

const voiceOptions = [
  { value: "stella", label: "海星（stella · 女声）" },
  { value: "tide", label: "暗潮（tide · 男声）" },
];

export function DigitalHumanSettings({ providers }: { providers: Provider[] }) {
  const [draft, setDraft] = useState<DigitalHumanAdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testText, setTestText] = useState("您好，我是麦溪，DeepSeek 语音合成连接测试成功。");
  const [asrResult, setAsrResult] = useState<{ text: string; duration_ms: number; latency_ms: number } | null>(null);
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [clearTtsKey, setClearTtsKey] = useState(false);
  const [asrApiKey, setAsrApiKey] = useState("");
  const [clearAsrKey, setClearAsrKey] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<AudioRecorderSession | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string>("");

  const deepseekProviders = providers.filter((provider) => {
    try {
      return provider.active && provider.key_configured && new URL(provider.base_url).origin === "https://api.deepseek.com";
    } catch {
      return false;
    }
  });

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const settings = await api.digitalHumanSettings();
      setDraft(settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取数字人配置失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      recorderRef.current?.cancel();
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const update = (patch: Partial<DigitalHumanAdminSettings>) => {
    if (busy) return;
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setError("");
    setNotice("");
  };

  const buildPayload = () => ({
    ...draft!,
    tts_api_key: ttsApiKey.trim() || undefined,
    clear_tts_api_key: clearTtsKey,
    asr_api_key: asrApiKey.trim() || undefined,
    clear_asr_api_key: clearAsrKey,
  });

  const save = async () => {
    if (!draft || busy) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const saved = await api.updateDigitalHumanSettings(buildPayload());
      setDraft(saved);
      setTtsApiKey("");
      setClearTtsKey(false);
      setAsrApiKey("");
      setClearAsrKey(false);
      setNotice("数字人配置已保存，刷新数字人服务台即可生效。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存数字人配置失败");
    } finally {
      setBusy("");
    }
  };

  const testTts = async () => {
    if (!draft || busy) return;
    setBusy("tts");
    setError("");
    setNotice("");
    try {
      audioRef.current?.pause();
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = "";
      }
      const blob = await api.testDigitalHumanTts(buildPayload(), testText.trim() || undefined);
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      await audio.play();
      setNotice("DeepSeek 语音合成测试成功，正在播放试听音频。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "语音合成测试失败");
    } finally {
      setBusy("");
    }
  };

  const toggleAsrTest = async () => {
    if (!draft) return;
    if (recording && recorderRef.current) {
      setRecording(false);
      setBusy("asr");
      setError("");
      setNotice("");
      try {
        const wavBlob = await recorderRef.current.stop();
        recorderRef.current = null;
        const result = await api.testDigitalHumanAsr(
          wavBlob,
          draft.asr_provider_id,
          draft.asr_timeout_seconds,
          draft.asr_base_url,
          asrApiKey.trim(),
        );
        setAsrResult(result);
        setNotice("DeepSeek 语音识别测试成功。");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "语音识别测试失败");
      } finally {
        setBusy("");
      }
      return;
    }
    if (busy) return;
    if (!mediaRecorderSupported()) {
      setError("当前浏览器不支持麦克风录音，请使用 Chrome、Edge、Safari 或 Firefox 最新版本。");
      return;
    }
    setError("");
    setNotice("");
    setAsrResult(null);
    try {
      recorderRef.current = await startWavRecorder();
      setRecording(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法访问麦克风，请检查浏览器权限。");
    }
  };

  if (loading && !draft) {
    return <LoadingFlow label="正在读取数字人配置…" />;
  }

  return (
    <div className="account-admin">
      <div className="admin-section-heading">
        <div>
          <h2>数字人服务台</h2>
          <p className="admin-note" style={{ margin: "6px 0 0" }}>
            配置数字人形象、高级实时模式，以及独立的 DeepSeek 语音合成（TTS）与语音识别（ASR）服务。
          </p>
        </div>
        <a
          className="secondary-button"
          style={{ textDecoration: "none", color: "var(--ink)" }}
          href="/digital-human"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={15} />
          <span>打开数字人服务台</span>
        </a>
      </div>

      {error && <div className="admin-feedback error" role="alert">{error}</div>}
      {notice && <div className="admin-feedback" style={{ background: "var(--green-soft)", color: "var(--green)" }} role="status">{notice}</div>}

      {!draft ? (
        <section className="admin-surface">
          <button className="secondary-button" onClick={() => void load()}>重新读取</button>
        </section>
      ) : (
        <fieldset className="admin-fieldset" disabled={Boolean(busy)}>
          <section className="admin-surface">
            <div className="admin-detail-heading">
              <h3>基础与形象</h3>
            </div>
            <div className="admin-fieldset">
              <div className="admin-form-grid">
                <Switch
                  label="启用数字人服务台"
                  checked={draft.enabled}
                  disabled={Boolean(busy)}
                  onChange={(enabled) => update({ enabled })}
                />
                <Switch
                  label="默认开启高级实时模式（Dynamic UI + 隐藏后台任务）"
                  checked={draft.realtime_mode}
                  disabled={Boolean(busy)}
                  onChange={(realtime_mode) => update({ realtime_mode })}
                />
              </div>
              <div className="admin-form-grid">
                <label className="admin-field">
                  <span>数字人名称</span>
                  <input
                    type="text"
                    maxLength={64}
                    value={draft.display_name}
                    onChange={(e) => update({ display_name: e.target.value })}
                  />
                </label>
                <label className="admin-field">
                  <span>开场白</span>
                  <input
                    type="text"
                    maxLength={500}
                    value={draft.greeting}
                    onChange={(e) => update({ greeting: e.target.value })}
                  />
                </label>
              </div>
            </div>
          </section>

          <section className="admin-surface">
            <div className="admin-detail-heading">
              <h3>语音合成（TTS）</h3>
            </div>
            <div className="admin-fieldset">
              <div className="admin-form-grid">
                <label className="admin-field">
                  <span>播报引擎</span>
                  <Dropdown
                    value={draft.tts_backend}
                    options={ttsBackendOptions}
                    title="播报引擎"
                    disabled={Boolean(busy)}
                    onChange={(tts_backend) => update({ tts_backend: tts_backend as DigitalHumanAdminSettings["tts_backend"] })}
                  />
                </label>
                {draft.tts_backend === "deepseek" && (
                  <label className="admin-field">
                    <span>默认音色</span>
                    <Dropdown
                      value={draft.tts_voice_id}
                      options={voiceOptions}
                      title="默认音色"
                      disabled={Boolean(busy)}
                      onChange={(tts_voice_id) => update({ tts_voice_id: tts_voice_id as "stella" | "tide" })}
                    />
                  </label>
                )}
                {draft.tts_backend === "deepseek" && (
                  <label className="admin-field">
                    <span>超时（秒）</span>
                    <input
                      type="number"
                      min={5}
                      max={120}
                      value={draft.tts_timeout_seconds}
                      onChange={(e) => update({ tts_timeout_seconds: Number(e.target.value) })}
                    />
                  </label>
                )}
              </div>

              {draft.tts_backend === "browser" && (
                <p className="admin-note" style={{ margin: 0 }}>
                  使用访问设备自带的本地中文语音（Web Speech API），无需额外费用，但依赖用户设备系统音色。
                </p>
              )}

              {draft.tts_backend === "deepseek" && (
                <>
                  <div className="admin-form-grid">
                    <label className="admin-field">
                      <span>独立语音服务地址（Base URL）</span>
                      <input
                        type="url"
                        placeholder="https://api.deepseek.com"
                        value={draft.tts_base_url}
                        onChange={(e) => update({ tts_base_url: e.target.value })}
                      />
                    </label>
                    <label className="admin-field">
                      <span>独立语音 API Key</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={ttsApiKey}
                        placeholder={draft.tts_key_configured ? "留空保留已保存密钥" : "输入 DeepSeek API Key（独立于模型供应商）"}
                        onChange={(e) => { setTtsApiKey(e.target.value); setClearTtsKey(false); }}
                      />
                    </label>
                    {deepseekProviders.length > 0 && (
                      <label className="admin-field">
                        <span>或复用已有 DeepSeek 供应商（可选）</span>
                        <Dropdown
                          value={draft.tts_provider_id}
                          options={[{ value: "", label: "使用独立配置" }, ...deepseekProviders.map((p) => ({ value: p.id, label: p.name }))]}
                          placeholder="使用独立配置"
                          title="DeepSeek 语音合成供应商"
                          disabled={Boolean(busy)}
                          onChange={(tts_provider_id) => update({ tts_provider_id })}
                        />
                      </label>
                    )}
                  </div>
                  <div className="admin-form-grid">
                    <Switch
                      label="朗读前自动过滤 Markdown 标记"
                      checked={draft.tts_filter_markdown}
                      disabled={Boolean(busy)}
                      onChange={(tts_filter_markdown) => update({ tts_filter_markdown })}
                    />
                    {draft.tts_key_configured && (
                      <Switch
                        label="清除独立语音合成密钥"
                        checked={clearTtsKey}
                        disabled={Boolean(busy)}
                        onChange={(v) => { setClearTtsKey(v); if (v) setTtsApiKey(""); }}
                      />
                    )}
                  </div>
                  <div className="admin-savebar" style={{ marginTop: 4, paddingTop: 16 }}>
                    <label className="admin-field">
                      <span>试听测试文本</span>
                      <input
                        type="text"
                        maxLength={500}
                        value={testText}
                        onChange={(e) => setTestText(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={Boolean(busy) || (!ttsApiKey.trim() && !(draft.tts_key_configured && !clearTtsKey) && !deepseekProviders.some((p) => p.id === draft.tts_provider_id))}
                      onClick={() => void testTts()}
                    >
                      <Volume2 size={16} />
                      <span>{busy === "tts" ? "正在合成…" : "测试语音合成"}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="admin-surface">
            <div className="admin-detail-heading">
              <h3>语音识别（ASR）</h3>
            </div>
            <div className="admin-fieldset">
              <div className="admin-form-grid">
                <label className="admin-field">
                  <span>识别引擎</span>
                  <Dropdown
                    value={draft.asr_backend}
                    options={asrBackendOptions}
                    title="识别引擎"
                    disabled={Boolean(busy)}
                    onChange={(asr_backend) => update({ asr_backend: asr_backend as DigitalHumanAdminSettings["asr_backend"] })}
                  />
                </label>
                {draft.asr_backend === "deepseek" && (
                  <label className="admin-field">
                    <span>超时（秒）</span>
                    <input
                      type="number"
                      min={5}
                      max={120}
                      value={draft.asr_timeout_seconds}
                      onChange={(e) => update({ asr_timeout_seconds: Number(e.target.value) })}
                    />
                  </label>
                )}
              </div>

              {draft.asr_backend === "browser" && (
                <p className="admin-note" style={{ margin: 0 }}>
                  使用浏览器内置语音识别，部分网络环境或 Firefox 浏览器可能不可用。切换为 DeepSeek 语音识别可统一由后端代理转写。
                </p>
              )}

              {draft.asr_backend === "deepseek" && (
                <>
                  <div className="admin-form-grid">
                    <label className="admin-field">
                      <span>独立识别服务地址（Base URL）</span>
                      <input
                        type="url"
                        placeholder="https://api.deepseek.com"
                        value={draft.asr_base_url}
                        onChange={(e) => update({ asr_base_url: e.target.value })}
                      />
                    </label>
                    <label className="admin-field">
                      <span>独立识别 API Key</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={asrApiKey}
                        placeholder={draft.asr_key_configured ? "留空保留已保存密钥" : "输入 DeepSeek API Key（独立于模型供应商）"}
                        onChange={(e) => { setAsrApiKey(e.target.value); setClearAsrKey(false); }}
                      />
                    </label>
                    {deepseekProviders.length > 0 && (
                      <label className="admin-field">
                        <span>或复用已有 DeepSeek 供应商（可选）</span>
                        <Dropdown
                          value={draft.asr_provider_id}
                          options={[{ value: "", label: "使用独立配置" }, ...deepseekProviders.map((p) => ({ value: p.id, label: p.name }))]}
                          placeholder="使用独立配置"
                          title="DeepSeek 语音识别供应商"
                          disabled={Boolean(busy)}
                          onChange={(asr_provider_id) => update({ asr_provider_id })}
                        />
                      </label>
                    )}
                  </div>
                  {draft.asr_key_configured && (
                    <Switch
                      label="清除独立语音识别密钥"
                      checked={clearAsrKey}
                      disabled={Boolean(busy)}
                      onChange={(v) => { setClearAsrKey(v); if (v) setAsrApiKey(""); }}
                    />
                  )}
                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={Boolean(busy) || (!asrApiKey.trim() && !(draft.asr_key_configured && !clearAsrKey) && !deepseekProviders.some((p) => p.id === draft.asr_provider_id))}
                      onClick={() => void toggleAsrTest()}
                    >
                      {recording ? <MicOff size={16} /> : <Mic size={16} />}
                      <span>{recording ? "停止录音并识别" : busy === "asr" ? "正在识别…" : "录音测试识别"}</span>
                    </button>
                    {asrResult && (
                      <span className="admin-note" style={{ margin: 0 }}>
                        识别结果：「{asrResult.text}」（音频 {asrResult.duration_ms} ms · 耗时 {asrResult.latency_ms} ms）
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="admin-savebar" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void load()}>
                重新载入
              </button>
              <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void save()}>
                {busy === "save" ? "保存中…" : "保存数字人配置"}
              </button>
            </div>
          </section>
        </fieldset>
      )}
    </div>
  );
}
