import React, { useState, useEffect, useRef, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  RotateCcw,
  RotateCw,
  Bold,
  Italic,
  Underline,
  Code,
  Link,
  Image as ImageIcon,
  Table as TableIcon,
  CheckSquare,
  Quote,
  List,
  ListOrdered,
  Minus,
  BookOpen,
  Copy,
  ChevronDown,
  Plus,
  Clock,
  Sparkles,
  FileText,
  Check,
  Tag,
  ArrowRight,
  X,
} from "lucide-react";
import type { CanvasDocument } from "./api";

export const DEFAULT_CANVAS_TEMPLATE = `# 产品设计笔记

记录产品设计过程中的思考、方法与实践经验。

## 🎯 1. 产品设计的核心目标
优秀的方案，始终围绕着 **用户价值** 展开。我们需要在 **用户需求**、**技术可行性** 与 **商业价值** 之间找到平衡，创造简单、优雅、高效的解决方案。

> 💡 **设计原则**
> 以用户为中心，保持简单，关注细节，持续迭代。

## 🎨 2. 设计方法与步骤
1. **发现问题**：通过用户调研、数据分析等方式，找到真正的用户需求。
2. **定义方案**：明确产品目标，梳理核心功能与体验路径。
3. **设计与验证**：快速原型设计，通过用户测试验证方案的有效性。
4. **持续迭代**：根据反馈不断优化，追求更好的用户体验。

## 📋 3. 本周待办清单
- [x] 完成用户访谈整理
- [x] 更新产品原型设计
- [ ] 与开发团队评审技术方案
- [ ] 整理竞品分析报告
- [ ] 撰写设计总结文档

## 📊 4. 竞品对比分析
| 产品 | 核心优势 | 不足之处 | 参考价值 |
| :--- | :--- | :--- | :--- |
| **Notion** | 灵活的模块化设计 | 学习成本较高 | ★★★★☆ |
| **语雀** | 本土化体验好 | 功能相对单一 | ★★★☆☆ |
| **飞书文档** | 协作能力强 | 个性化能力较弱 | ★★★★☆ |

## 💻 5. 示例代码
\`\`\`javascript
// 计算斐波那契数列
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
console.log(fibonacci(10)); // 55
\`\`\`

> “ 好的设计不是让复杂的东西看起来简单，而是让简单的东西变得更有力量。 ”
> —— Dieter Rams
`;

const COVER_PRESETS = [
  {
    name: "雪山旷野 (Alpine Snow)",
    bg: "url('https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1600&auto=format&fit=crop&q=80') center/cover no-repeat, linear-gradient(135deg, #1e3c72 0%, #2a5298 60%, #e0eafc 100%)",
  },
  {
    name: "晨曦极光 (Aurora Sky)",
    bg: "linear-gradient(135deg, #1e3c72 0%, #2a5298 50%, #70a1ff 100%)",
  },
  {
    name: "翡翠森林 (Emerald Forest)",
    bg: "linear-gradient(135deg, #134e5e 0%, #71b280 100%)",
  },
  {
    name: "暮色晚霞 (Sunset Glow)",
    bg: "linear-gradient(135deg, #ff7e5f 0%, #feb47b 100%)",
  },
  {
    name: "深邃赛博 (Cyber Mesh)",
    bg: "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)",
  },
];

export interface CanvasWorkspaceProps {
  document: CanvasDocument;
  onSave: (content: string, baseVersion: number) => Promise<CanvasDocument>;
}

export function CanvasWorkspace({ document, onSave }: CanvasWorkspaceProps) {
  const initialContent = document.content || DEFAULT_CANVAS_TEMPLATE;
  const baseline = useRef({ version: document.version, content: initialContent });
  const [draft, setDraft] = useState(initialContent);
  const [view, setView] = useState<"preview" | "edit" | "split">("preview");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<"outline" | "info">("outline");
  const [coverIndex, setCoverIndex] = useState(0);
  const [tags, setTags] = useState<string[]>([
    "产品设计",
    "用户体验",
    "设计方法",
    "竞品分析",
    "总结",
  ]);
  const [newTagInput, setNewTagInput] = useState("");
  const [addingTag, setAddingTag] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);

  // Undo / Redo history
  const [history, setHistory] = useState<string[]>([initialContent]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== baseline.current.content;
  const conflicted = document.version !== baseline.current.version;

  // Sync when document version or content updates from outside (e.g. agent edits)
  useEffect(() => {
    if (draft === baseline.current.content) {
      const nextContent = document.content || DEFAULT_CANVAS_TEMPLATE;
      baseline.current = { version: document.version, content: nextContent };
      setDraft(nextContent);
      setError("");
      setHistory((prev) => [...prev.slice(-20), nextContent]);
      setHistoryIndex((prev) => prev + 1);
    } else if (document.version !== baseline.current.version) {
      setError("画布已被其他智能体更新。当前本地修改已保留，请对比后保存或重新加载。");
    }
  }, [document.version, document.content]);

  // Push to history on draft changes (debounced)
  const updateDraft = (newText: string) => {
    setDraft(newText);
    setHistory((prev) => {
      const sliced = prev.slice(0, historyIndex + 1);
      return [...sliced, newText].slice(-30);
    });
    setHistoryIndex((prev) => prev + 1);
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      setDraft(history[nextIndex]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      setHistoryIndex(nextIndex);
      setDraft(history[nextIndex]);
    }
  };

  const save = async () => {
    if (!dirty || saving || conflicted) return;
    const submitted = draft;
    setSaving(true);
    setError("");
    try {
      const updated = await onSave(submitted, baseline.current.version);
      baseline.current = { version: updated.version, content: submitted };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  // Cursor insertion utilities
  const insertAtCursor = (before: string, after: string = "", defaultText: string = "") => {
    const textarea = textareaRef.current;
    if (!textarea) {
      // If in preview mode, switch to edit and append
      setView("edit");
      updateDraft(draft + "\n\n" + before + defaultText + after);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = draft.substring(start, end) || defaultText;
    const replacement = before + selected + after;
    const newDraft = draft.substring(0, start) + replacement + draft.substring(end);
    updateDraft(newDraft);
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
    }, 0);
  };

  const handleToggleTask = (taskText: string, currentChecked: boolean) => {
    // Clean text to match line
    const cleanText = taskText.trim().replace(/^\[[ xX]\]\s*/, "");
    const searchPattern = currentChecked
      ? new RegExp(`- \\[x\\]\\s*${cleanText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
      : new RegExp(`- \\[ \\]\\s*${cleanText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const replacement = currentChecked ? `- [ ] ${cleanText}` : `- [x] ${cleanText}`;
    if (searchPattern.test(draft)) {
      const newDraft = draft.replace(searchPattern, replacement);
      updateDraft(newDraft);
    }
  };

  // Extract headings for Table of Contents
  const headings = useMemo(() => {
    const lines = draft.split("\n");
    const list: Array<{ level: number; text: string; id: string }> = [];
    lines.forEach((line) => {
      const match = line.match(/^(#{1,3})\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        const text = match[2].trim();
        const id = "sec-" + text.replace(/[^\w\u4e00-\u9fa5]+/g, "-").toLowerCase();
        list.push({ level, text, id });
      }
    });
    return list;
  }, [draft]);

  // Extract title and subtitle
  const docTitle = useMemo(() => {
    const match = draft.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : document.title || "产品设计笔记";
  }, [draft, document.title]);

  const docSubtitle = useMemo(() => {
    const lines = draft.split("\n").map((l) => l.trim()).filter(Boolean);
    const titleIdx = lines.findIndex((l) => l.startsWith("# "));
    if (titleIdx >= 0 && lines[titleIdx + 1] && !lines[titleIdx + 1].startsWith("#") && !lines[titleIdx + 1].startsWith(">")) {
      return lines[titleIdx + 1];
    }
    return "记录产品设计过程中的思考、方法与实践经验。";
  }, [draft]);

  // Word count & stats
  const stats = useMemo(() => {
    const chars = draft.length;
    const cjk = (draft.match(/[\u4e00-\u9fa5]/g) || []).length;
    const words = (draft.match(/[a-zA-Z0-9_-]+/g) || []).length;
    const wordCount = cjk + words;
    const readTime = Math.max(1, Math.ceil(wordCount / 300));
    return { chars, wordCount, readTime };
  }, [draft]);

  // Custom markdown components for rich preview
  const canvasMarkdownComponents = useMemo(
    () => ({
      h1: ({ children, ...props }: any) => {
        const text = String(children);
        const id = "sec-" + text.replace(/[^\w\u4e00-\u9fa5]+/g, "-").toLowerCase();
        return (
          <h1 id={id} className="canvas-h1" {...props}>
            {children}
          </h1>
        );
      },
      h2: ({ children, ...props }: any) => {
        const text = String(children);
        const id = "sec-" + text.replace(/[^\w\u4e00-\u9fa5]+/g, "-").toLowerCase();
        return (
          <h2 id={id} className="canvas-h2" {...props}>
            {children}
          </h2>
        );
      },
      h3: ({ children, ...props }: any) => {
        const text = String(children);
        const id = "sec-" + text.replace(/[^\w\u4e00-\u9fa5]+/g, "-").toLowerCase();
        return (
          <h3 id={id} className="canvas-h3" {...props}>
            {children}
          </h3>
        );
      },
      blockquote: ({ children, ...props }: any) => {
        const raw = String(children);
        if (
          raw.includes("💡") ||
          raw.includes("[!NOTE]") ||
          raw.includes("[!TIP]") ||
          raw.includes("设计原则")
        ) {
          return (
            <div className="canvas-callout">
              <div className="canvas-callout-icon">💡</div>
              <div className="canvas-callout-content">{children}</div>
            </div>
          );
        }
        if (
          raw.includes("“") ||
          raw.includes("”") ||
          raw.includes("——") ||
          raw.includes("Dieter Rams")
        ) {
          return (
            <div className="canvas-quote-card">
              <span className="canvas-quote-mark">“</span>
              <div className="canvas-quote-content">{children}</div>
            </div>
          );
        }
        return (
          <blockquote className="canvas-blockquote" {...props}>
            {children}
          </blockquote>
        );
      },
      table: ({ children, ...props }: any) => (
        <div className="canvas-table-wrapper">
          <table className="canvas-table" {...props}>
            {children}
          </table>
        </div>
      ),
      code: ({ inline, className, children, ...props }: any) => {
        if (inline) {
          return (
            <code className="canvas-inline-code" {...props}>
              {children}
            </code>
          );
        }
        const match = /language-(\w+)/.exec(className || "");
        const lang = match ? match[1] : "javascript";
        return (
          <div className="canvas-code-card">
            <div className="canvas-code-header">
              <span className="canvas-code-title">示例代码</span>
              <div className="canvas-code-actions">
                <span className="canvas-code-lang">{lang}</span>
                <button
                  type="button"
                  className="canvas-code-copy-btn"
                  onClick={() => void navigator.clipboard.writeText(String(children))}
                  title="复制代码"
                >
                  <Copy size={13} />
                </button>
              </div>
            </div>
            <pre className="canvas-code-pre">
              <code className={className} {...props}>
                {children}
              </code>
            </pre>
          </div>
        );
      },
      li: ({ children, className, checked, ...props }: any) => {
        if (typeof checked === "boolean") {
          return (
            <li className="canvas-task-item" {...props}>
              <input
                type="checkbox"
                checked={checked}
                className="canvas-task-checkbox"
                onChange={() => handleToggleTask(String(children), checked)}
              />
              <span className={`canvas-task-text ${checked ? "completed" : ""}`}>
                {children}
              </span>
            </li>
          );
        }
        return <li {...props}>{children}</li>;
      },
    }),
    [draft],
  );

  const handleCopyMarkdown = () => {
    void navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddTag = () => {
    if (newTagInput.trim() && !tags.includes(newTagInput.trim())) {
      setTags([...tags, newTagInput.trim()]);
      setNewTagInput("");
      setAddingTag(false);
    }
  };

  return (
    <div className="canvas-workspace">
      {/* Top Formatting Toolbar */}
      <header className="canvas-toolbar">
        <div className="canvas-toolbar-group left">
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={handleUndo}
            disabled={historyIndex <= 0}
            title="撤销 (Ctrl+Z)"
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={handleRedo}
            disabled={historyIndex >= history.length - 1}
            title="重做 (Ctrl+Y)"
          >
            <RotateCw size={15} />
          </button>

          <span className="canvas-tool-divider" />

          {/* Heading Style Dropdown */}
          <div className="canvas-dropdown-wrap">
            <button
              type="button"
              className="canvas-tool-btn dropdown-btn"
              onClick={() => {
                setStyleMenuOpen(!styleMenuOpen);
                setInsertMenuOpen(false);
              }}
              title="文本样式"
            >
              <span>正文</span>
              <ChevronDown size={13} />
            </button>
            {styleMenuOpen && (
              <div className="canvas-dropdown-menu">
                <button
                  type="button"
                  onClick={() => {
                    insertAtCursor("");
                    setStyleMenuOpen(false);
                  }}
                >
                  正文
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertAtCursor("# ", "", "一级标题");
                    setStyleMenuOpen(false);
                  }}
                >
                  <strong>标题 1 (H1)</strong>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertAtCursor("## ", "", "二级标题");
                    setStyleMenuOpen(false);
                  }}
                >
                  <strong>标题 2 (H2)</strong>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertAtCursor("### ", "", "三级标题");
                    setStyleMenuOpen(false);
                  }}
                >
                  <strong>标题 3 (H3)</strong>
                </button>
              </div>
            )}
          </div>

          <span className="canvas-tool-divider" />

          {/* Inline Formats */}
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("**", "**", "加粗文本")}
            title="加粗 (Ctrl+B)"
          >
            <Bold size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("*", "*", "斜体文本")}
            title="斜体 (Ctrl+I)"
          >
            <Italic size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("<u>", "</u>", "下划线文本")}
            title="下划线"
          >
            <Underline size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("`", "`", "代码")}
            title="行内代码"
          >
            <Code size={15} />
          </button>

          <span className="canvas-tool-divider" />

          {/* Block Inserts */}
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("[", "](https://example.com)", "链接描述")}
            title="插入链接"
          >
            <Link size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("![", "](https://example.com/image.png)", "图片描述")}
            title="插入图片"
          >
            <ImageIcon size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() =>
              insertAtCursor(
                "\n| 产品 | 核心优势 | 不足之处 | 参考价值 |\n| :--- | :--- | :--- | :--- |\n| Notion | 灵活的模块化设计 | 学习成本较高 | ★★★★☆ |\n| 语雀 | 本土化体验好 | 功能相对单一 | ★★★☆☆ |\n| 飞书文档 | 协作能力强 | 个性化能力较弱 | ★★★★☆ |\n\n",
              )
            }
            title="插入对比表格"
          >
            <TableIcon size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("- [ ] ", "", "待办事项")}
            title="待办清单"
          >
            <CheckSquare size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("> ", "", "引用内容")}
            title="插入引用"
          >
            <Quote size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("- ", "", "无序列表项")}
            title="无序列表"
          >
            <List size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("1. ", "", "有序列表项")}
            title="有序列表"
          >
            <ListOrdered size={15} />
          </button>
          <button
            type="button"
            className="canvas-tool-btn"
            onClick={() => insertAtCursor("\n---\n")}
            title="分割线"
          >
            <Minus size={15} />
          </button>

          {/* Insert Dropdown Menu */}
          <div className="canvas-dropdown-wrap">
            <button
              type="button"
              className="canvas-tool-btn dropdown-btn"
              onClick={() => {
                setInsertMenuOpen(!insertMenuOpen);
                setStyleMenuOpen(false);
              }}
              title="插入组件"
            >
              <span>插入</span>
              <ChevronDown size={13} />
            </button>
            {insertMenuOpen && (
              <div className="canvas-dropdown-menu">
                <button
                  type="button"
                  onClick={() => {
                    insertAtCursor(
                      "\n> 💡 **设计原则**\n> 以用户为中心，保持简单，关注细节，持续迭代。\n\n",
                    );
                    setInsertMenuOpen(false);
                  }}
                >
                  💡 提示高亮框 (Callout)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertAtCursor(
                      "\n1. **发现问题**：通过调研提炼用户核心诉求。\n2. **定义方案**：明确目标与核心功能路径。\n3. **设计与验证**：快速原型测试有效性。\n4. **持续迭代**：根据反馈不断优化。\n\n",
                    );
                    setInsertMenuOpen(false);
                  }}
                >
                  🔢 步骤卡片 (Step List)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertAtCursor(
                      "\n```javascript\n// 示例代码\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\nconsole.log(fibonacci(10)); // 55\n```\n\n",
                    );
                    setInsertMenuOpen(false);
                  }}
                >
                  💻 示例代码块 (Code Block)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertAtCursor(
                      '\n> “ 好的设计不是让复杂的东西看起来简单，而是让简单的东西变得更有力量。 ”\n> —— Dieter Rams\n\n',
                    );
                    setInsertMenuOpen(false);
                  }}
                >
                  “ 名言卡片 (Quote Card)
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Toolbar Actions */}
        <div className="canvas-toolbar-group right">
          {/* View Mode Switcher */}
          <div className="canvas-view-toggle-pills" role="group" aria-label="视图模式">
            <button
              type="button"
              className={view === "preview" ? "active" : ""}
              onClick={() => setView("preview")}
            >
              预览
            </button>
            <button
              type="button"
              className={view === "edit" ? "active" : ""}
              onClick={() => setView("edit")}
            >
              编辑
            </button>
            <button
              type="button"
              className={view === "split" ? "active" : ""}
              onClick={() => setView("split")}
            >
              双栏
            </button>
          </div>

          <button
            type="button"
            className="canvas-action-btn"
            onClick={handleCopyMarkdown}
            title="复制 Markdown"
          >
            {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>

          <button
            type="button"
            className={`canvas-save-badge-btn ${dirty ? "dirty" : "saved"}`}
            disabled={!dirty || saving || conflicted}
            onClick={() => void save()}
            title="保存修改 (Ctrl+S)"
          >
            <span className="status-dot" />
            <span>{saving ? "保存中..." : dirty ? "保存修改" : "已保存"}</span>
          </button>

          <button
            type="button"
            className={`canvas-action-btn outline-toggle ${inspectorOpen ? "active" : ""}`}
            onClick={() => setInspectorOpen(!inspectorOpen)}
            title="大纲与文档属性"
          >
            <BookOpen size={15} />
          </button>
        </div>
      </header>

      {/* Warning banner if conflicted */}
      {error && (
        <div className="canvas-editor-warning" role="alert">
          <span>{error}</span>
          {conflicted && (
            <button
              type="button"
              onClick={() => {
                const latest = document.content || DEFAULT_CANVAS_TEMPLATE;
                baseline.current = { version: document.version, content: latest };
                setDraft(latest);
                setError("");
              }}
            >
              载入最新版本
            </button>
          )}
        </div>
      )}

      {/* Main Document Workspace */}
      <div className="canvas-main-area">
        <div className="canvas-scroll-viewport">
          <div className="canvas-doc-paper">
            {/* Cover Banner */}
            <div
              className="canvas-cover-banner"
              style={{ background: COVER_PRESETS[coverIndex].bg }}
            >
              <button
                type="button"
                className="canvas-change-cover-btn"
                onClick={() => setCoverIndex((coverIndex + 1) % COVER_PRESETS.length)}
                title="更换封面风格"
              >
                <ImageIcon size={14} />
                <span>更换封面</span>
              </button>
            </div>

            {/* Document Header */}
            <div className="canvas-doc-header">
              <h1 className="canvas-doc-title">{docTitle}</h1>
              <p className="canvas-doc-subtitle">{docSubtitle}</p>

              {/* Tag Row */}
              <div className="canvas-tag-bar">
                {tags.map((tag) => (
                  <span key={tag} className="canvas-tag-chip">
                    #{tag}
                  </span>
                ))}
                {addingTag ? (
                  <div className="canvas-new-tag-input-wrap">
                    <input
                      type="text"
                      className="canvas-new-tag-input"
                      value={newTagInput}
                      placeholder="标签名"
                      autoFocus
                      onChange={(e) => setNewTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddTag();
                        if (e.key === "Escape") setAddingTag(false);
                      }}
                    />
                    <button type="button" onClick={handleAddTag}>
                      <Check size={12} />
                    </button>
                    <button type="button" onClick={() => setAddingTag(false)}>
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="canvas-add-tag-btn"
                    onClick={() => setAddingTag(true)}
                    title="添加标签"
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
            </div>

            {/* Document Content View */}
            {view === "edit" ? (
              <textarea
                ref={textareaRef}
                className="canvas-markdown-textarea"
                aria-label="Markdown 正文编辑器"
                spellCheck={false}
                value={draft}
                onChange={(e) => updateDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
            ) : view === "preview" ? (
              <div className="canvas-document-preview message-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={canvasMarkdownComponents}
                >
                  {draft}
                </ReactMarkdown>
              </div>
            ) : (
              /* Split View */
              <div className="canvas-split-container">
                <textarea
                  ref={textareaRef}
                  className="canvas-markdown-textarea split"
                  aria-label="Markdown 正文编辑器"
                  spellCheck={false}
                  value={draft}
                  onChange={(e) => updateDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                />
                <div className="canvas-document-preview split message-markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={canvasMarkdownComponents}
                  >
                    {draft}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Document Sidebar (大纲 & 文档信息) */}
        {inspectorOpen && (
          <aside className="canvas-doc-sidebar">
            <div className="canvas-sidebar-header">
              <div className="canvas-sidebar-tabs">
                <button
                  type="button"
                  className={inspectorTab === "outline" ? "active" : ""}
                  onClick={() => setInspectorTab("outline")}
                >
                  大纲
                </button>
                <button
                  type="button"
                  className={inspectorTab === "info" ? "active" : ""}
                  onClick={() => setInspectorTab("info")}
                >
                  文档信息
                </button>
              </div>
            </div>

            <div className="canvas-sidebar-body">
              {inspectorTab === "outline" ? (
                <div className="canvas-toc-panel">
                  <div className="canvas-toc-root-item">
                    <FileText size={14} />
                    <span>{docTitle}</span>
                  </div>
                  {headings.length > 0 ? (
                    <ul className="canvas-toc-list">
                      {headings.map((h, i) => (
                        <li
                          key={i}
                          className={`canvas-toc-item level-${h.level}`}
                          onClick={() => {
                            const el = window.document.getElementById(h.id);
                            if (el) el.scrollIntoView({ behavior: "smooth" });
                          }}
                        >
                          <span className="toc-bullet">›</span>
                          <span className="toc-text">{h.text}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="canvas-toc-empty">暂无章节标题（输入 ## 即可生成大纲）</p>
                  )}

                  {/* Tags section under Outline */}
                  <div className="canvas-sidebar-section">
                    <div className="canvas-sidebar-section-title">
                      <span>标签</span>
                      <button
                        type="button"
                        className="sidebar-add-tag"
                        onClick={() => setAddingTag(true)}
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                    <div className="canvas-sidebar-tags">
                      {tags.map((t) => (
                        <span key={t} className="sidebar-tag-pill">
                          #{t}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="canvas-info-panel">
                  <div className="canvas-sidebar-section">
                    <div className="canvas-sidebar-section-title">字数统计</div>
                    <div className="canvas-stat-row">
                      <span className="stat-label">正文</span>
                      <span className="stat-value">{stats.wordCount}</span>
                    </div>
                    <div className="canvas-stat-row">
                      <span className="stat-label">字符数</span>
                      <span className="stat-value">{stats.chars}</span>
                    </div>
                    <div className="canvas-stat-row">
                      <span className="stat-label">阅读时间</span>
                      <span className="stat-value">约 {stats.readTime} 分钟</span>
                    </div>
                  </div>

                  <div className="canvas-sidebar-section">
                    <div className="canvas-sidebar-section-title">文档属性</div>
                    <div className="canvas-stat-row">
                      <span className="stat-label">创建时间</span>
                      <span className="stat-value">2024-03-12 10:24</span>
                    </div>
                    <div className="canvas-stat-row">
                      <span className="stat-label">更新时间</span>
                      <span className="stat-value">今天 15:36</span>
                    </div>
                    <div className="canvas-stat-row">
                      <span className="stat-label">文档路径</span>
                      <span className="stat-value path">/产品设计/{docTitle}</span>
                    </div>
                    <div className="canvas-stat-row">
                      <span className="stat-label">状态</span>
                      <span className="stat-value status">
                        <span className="dot" /> 已保存
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
