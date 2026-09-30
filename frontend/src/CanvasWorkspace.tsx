import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Image } from "@tiptap/extension-image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bold, BookOpen, Check, CheckSquare, ChevronDown, Code, Copy, FileText,
  Image as ImageIcon, Italic, Link, List, ListOrdered, Menu, Minus, Quote,
  Pencil, Redo2, Save, Sparkles, Table2, Underline, Undo2, X,
} from "lucide-react";
import type { CanvasDocument } from "./api";
import { api } from "./api";
import { FlowMark } from "./LoadingFlow";
import { canvasReviewEdits, resolveCanvasReview } from "./canvasMerge";
import "./CanvasWorkspace.css";

export const DEFAULT_CANVAS_TEMPLATE = "";

type LinkDialog = { kind: "link" | "image" | "cover"; url: string; alt: string };
type OutlineItem = { text: string; level: number; pos: number };
type SelectionAction = "polish" | "expand" | "correct" | "restructure";
type DiffChunk = { kind: "same" | "change"; before: string; after: string; index: number };

function safeUrl(raw: string, image: boolean): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    if (!image && url.protocol === "mailto:") return url.href;
  } catch {
    return null;
  }
  return null;
}

export function CanvasWorkspace({
  document,
  sessionTitle,
  onOpenHistory,
  showHistoryToggle = false,
  onSave,
  onAskAI,
  onUploadImage,
  agentBusy = false,
}: {
  document: CanvasDocument;
  sessionTitle: string;
  onOpenHistory: () => void;
  showHistoryToggle?: boolean;
  onSave: (content: string, baseVersion: number) => Promise<CanvasDocument>;
  onAskAI?: (selection: string, action: SelectionAction) => void;
  onUploadImage?: (file: File) => Promise<string>;
  agentBusy?: boolean;
}) {
  const initial = document.content ?? DEFAULT_CANVAS_TEMPLATE;
  const baseline = useRef({ version: document.version, content: initial });
  const initialized = useRef(false);
  const localMutation = useRef(false);
  const reviewAfterTask = useRef(false);
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const [outlineOpen, setOutlineOpen] = useState(() => !window.matchMedia("(max-width: 820px)").matches);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [priorRevision, setPriorRevision] = useState<{ version: number; content: string } | null>(null);
  const [pendingReview, setPendingReview] = useState<{ version: number; content: string; userContent?: string } | null>(null);
  const [reviewChoices, setReviewChoices] = useState<Record<number, boolean>>({});
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewError, setReviewError] = useState("");
  const [menuOpen, setMenuOpen] = useState<"style" | "insert" | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [dialog, setDialog] = useState<LinkDialog | null>(null);
  const [selection, setSelection] = useState("");
  const [selectionPosition, setSelectionPosition] = useState({ left: 0, top: 0 });
  const [copied, setCopied] = useState(false);
  const [draggingImage, setDraggingImage] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const closeSidebar = () => { setOutlineOpen(false); setReviewOpen(false); };
  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const change = () => { setCompact(media.matches); setOutlineOpen(!media.matches); setReviewOpen(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!compact || (!outlineOpen && !reviewOpen)) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") closeSidebar(); };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [compact, outlineOpen, reviewOpen]);
  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({ allowBase64: false }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content: initial,
    contentType: "markdown",
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { class: "canvas-prose", "aria-label": "画布正文" } },
    onUpdate: ({ editor: instance }) => setDraft(instance.getMarkdown()),
    onSelectionUpdate: ({ editor: instance }) => {
      const { from, to } = instance.state.selection;
      setSelection(from < to ? instance.state.doc.textBetween(from, to, " ").trim() : "");
      if (from < to) {
        const end = instance.view.coordsAtPos(to);
        setSelectionPosition({
          left: Math.max(8, Math.min(end.left, window.innerWidth - 360)),
          top: end.top > 62 ? end.top - 46 : end.bottom + 8,
        });
      }
    },
  }, [document.id]);

  useEffect(() => {
    if (!menuOpen && !selection) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest?.(".canvas-wysiwyg-menu-wrap")) setMenuOpen(null);
      if (!target.closest?.(".canvas-wysiwyg-selection-actions, .canvas-prose")) setSelection("");
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(null); setSelection(""); }
    };
    window.document.addEventListener("pointerdown", closeOutside);
    window.document.addEventListener("keydown", closeEscape);
    return () => { window.document.removeEventListener("pointerdown", closeOutside); window.document.removeEventListener("keydown", closeEscape); };
  }, [menuOpen, selection]);

  useEffect(() => { editor?.setEditable(editing); }, [editor, editing]);

  useEffect(() => {
    if (!agentBusy && pendingReview && reviewAfterTask.current) {
      reviewAfterTask.current = false;
      setReviewOpen(true);
    }
  }, [agentBusy, pendingReview]);

  useEffect(() => { setReviewChoices({}); setReviewIndex(0); }, [document.version]);

  useEffect(() => {
    if (!editor) return;
    if (!initialized.current) {
      const normalized = editor.getMarkdown();
      baseline.current = { version: document.version, content: normalized };
      setDraft(normalized);
      initialized.current = true;
      return;
    }
    if (document.version === baseline.current.version && document.content === baseline.current.content) {
      localMutation.current = false;
      return;
    }
    if (localMutation.current) return;
    if (agentBusy && !document.content.trim()) return;
    const hasVisibleAgentEdits = canvasReviewEdits(baseline.current.content, draft, document.content).length > 0;
    if (draft !== baseline.current.content && document.version !== baseline.current.version && hasVisibleAgentEdits) {
      setPendingReview((current) => current || { ...baseline.current, userContent: draft });
      reviewAfterTask.current = agentBusy;
      if (!agentBusy) setReviewOpen(true);
      setEditing(false);
      setError("");
      return;
    }
    if (draft !== baseline.current.content && document.version !== baseline.current.version) {
      baseline.current = { version: document.version, content: document.content };
      return;
    }
    if (draft === baseline.current.content) {
      if (document.version !== baseline.current.version) {
        if (!localMutation.current && hasVisibleAgentEdits) {
          setPendingReview((current) => current || { ...baseline.current });
          setPriorRevision(null);
          reviewAfterTask.current = agentBusy;
          if (!agentBusy) setReviewOpen(true);
        }
        localMutation.current = false;
      }
      editor.commands.setContent(document.content ?? DEFAULT_CANVAS_TEMPLATE, {
        contentType: "markdown", emitUpdate: false,
      });
      const normalized = editor.getMarkdown();
      baseline.current = { version: document.version, content: normalized };
      setDraft(normalized);
      setError("");
    }
  }, [editor, document.version, document.content]);

  const dirty = draft !== baseline.current.content;
  const conflicted = document.version !== baseline.current.version;
  const title = useMemo(() => draft.match(/^#\s+(.+)$/m)?.[1]?.trim() || "未命名文稿", [draft]);
  const outline = useMemo<OutlineItem[]>(() => {
    if (!editor) return [];
    const items: OutlineItem[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        items.push({ text: node.textContent || "未命名标题", level: node.attrs.level, pos });
      }
    });
    return items;
  }, [editor, draft]);
  const words = useMemo(() => {
    const text = editor?.state.doc.textContent || "";
    return (text.match(/[\u4e00-\u9fff]|[A-Za-z0-9_-]+/g) || []).length;
  }, [editor, draft]);
  const reviewedRevision = pendingReview || priorRevision;
  const userReviewContent = pendingReview?.userContent ?? pendingReview?.content ?? document.content;
  const reviewEdits = useMemo(() => reviewedRevision ? canvasReviewEdits(reviewedRevision.content, pendingReview ? userReviewContent : reviewedRevision.content, document.content) : [], [reviewedRevision, pendingReview, userReviewContent, document.content]);
  const reviewChunks = useMemo(() => {
    if (!reviewedRevision) return [];
    const source = reviewedRevision.content.split("\n");
    const chunks: DiffChunk[] = [];
    let cursor = 0;
    reviewEdits.forEach((edit, index) => {
      if (edit.start > cursor) {
        const same = source.slice(cursor, edit.start).join("\n");
        chunks.push({ kind: "same", before: same, after: same, index: -1 });
      }
      chunks.push({ kind: "change", before: edit.before.join("\n"), after: edit.after.join("\n"), index });
      cursor = edit.end;
    });
    if (cursor < source.length) {
      const same = source.slice(cursor).join("\n");
      chunks.push({ kind: "same", before: same, after: same, index: -1 });
    }
    return chunks;
  }, [reviewedRevision, reviewEdits]);
  useEffect(() => {
    if (!pendingReview || agentBusy || reviewEdits.length) return;
    // A streaming task can briefly change formatting, then finish with no visible edit.
    setPendingReview(null);
    setReviewOpen(false);
    reviewAfterTask.current = false;
    if (draft !== baseline.current.content) {
      baseline.current = { version: document.version, content: document.content };
      return;
    }
    editor?.commands.setContent(document.content, { contentType: "markdown", emitUpdate: false });
    const normalized = editor?.getMarkdown() ?? document.content;
    baseline.current = { version: document.version, content: normalized };
    setDraft(normalized);
  }, [pendingReview, agentBusy, reviewEdits.length, document.version, document.content, draft, editor]);
  const reviewAccepted = reviewEdits.map((edit, index) => reviewChoices[index] ?? !edit.conflictsWithUser);
  const showDiffPreview = Boolean(reviewedRevision && !editing && (reviewOpen || pendingReview) && !agentBusy);
  useEffect(() => {
    if (!showDiffPreview || !reviewEdits.length) return;
    window.document.querySelector(`[data-canvas-review-change="${reviewIndex}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [showDiffPreview, reviewIndex, reviewEdits.length]);

  const openReview = async () => {
    if (reviewOpen) { setReviewOpen(false); return; }
    setReviewOpen(true);
    setReviewError("");
    if (pendingReview) return;
    if (document.version < 2) return;
    try {
      const previous = await api.getCanvasRevision(document.id, document.version - 1);
      setPriorRevision(previous);
    } catch (reason) {
      setReviewError(reason instanceof Error ? reason.message : "读取版本失败");
    }
  };

  const save = async () => {
    if (!editor || !dirty || saving || conflicted) return;
    const submitted = editor.getMarkdown();
    setSaving(true);
    setError("");
    localMutation.current = true;
    try {
      const updated = await onSave(submitted, baseline.current.version);
      baseline.current = { version: updated.version, content: submitted };
      setDraft(submitted);
      setEditing(false);
      localMutation.current = false;
    } catch (reason) {
      localMutation.current = false;
      setError(reason instanceof Error ? reason.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    if (dirty && !window.confirm("放弃尚未保存的画布修改？")) return;
    editor?.commands.setContent(baseline.current.content, { contentType: "markdown", emitUpdate: false });
    setDraft(baseline.current.content);
    setError("");
    setEditing(false);
  };

  const finishReview = async (continueEditing = false) => {
    if (!pendingReview || saving || agentBusy) return;
    setSaving(true);
    setReviewError("");
    localMutation.current = true;
    try {
      const resolved = resolveCanvasReview(pendingReview.content, userReviewContent, document.content, reviewAccepted);
      const unchanged = resolved === document.content;
      const updated = unchanged ? document : await onSave(resolved, document.version);
      editor?.commands.setContent(updated.content ?? DEFAULT_CANVAS_TEMPLATE, { contentType: "markdown", emitUpdate: false });
      const normalized = editor?.getMarkdown() || updated.content;
      baseline.current = { version: updated.version, content: normalized };
      setDraft(normalized);
      setPendingReview(null);
      setPriorRevision(null);
      setReviewOpen(false);
      setEditing(continueEditing);
      setError("");
      localMutation.current = false;
    } catch (reason) {
      localMutation.current = false;
      setReviewError(reason instanceof Error ? reason.message : "提交审查失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const applyUrl = () => {
    if (!editor || !dialog) return;
    const url = safeUrl(dialog.url, dialog.kind !== "link");
    if (!url) {
      setError("请输入有效的 HTTPS/HTTP 地址；链接还支持 mailto。 ");
      return;
    }
    if (dialog.kind === "cover") {
      const first = editor.state.doc.firstChild;
      const range = first?.type.name === "image" ? { from: 0, to: first.nodeSize } : 0;
      editor.commands.insertContentAt(range, { type: "image", attrs: { src: url, alt: dialog.alt || "封面" } });
    } else if (dialog.kind === "image") {
      editor.chain().focus().setImage({ src: url, alt: dialog.alt || "图片" }).run();
    } else {
      if (editor.state.selection.empty) {
        editor.chain().focus().insertContent({
          type: "text", text: dialog.alt || url, marks: [{ type: "link", attrs: { href: url } }],
        }).run();
      } else {
        editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
      }
    }
    setDialog(null);
    setError("");
  };

  const copyMarkdown = async () => {
    if (!editor) return;
    try {
      await navigator.clipboard.writeText(editor.getMarkdown());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，请检查浏览器的剪贴板权限");
    }
  };

  const insertImageFiles = async (files: File[], position?: number) => {
    if (!editor || !onUploadImage || uploadingImage) return;
    const images = files.filter((file) => /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(file.type));
    if (images.length !== files.length || images.some((file) => file.size > 10 * 1024 * 1024)) {
      setError("仅支持不超过 10 MB 的 PNG、JPEG、WebP 或 GIF 图片");
      return;
    }
    setUploadingImage(true);
    setError("");
    let insertAt = position ?? editor.state.selection.from;
    try {
      for (const file of images) {
        const url = await onUploadImage(file);
        editor.commands.insertContentAt(insertAt, { type: "image", attrs: { src: url, alt: file.name } });
        insertAt += 1;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片上传失败");
    } finally {
      setUploadingImage(false);
    }
  };

  const toggleMenu = (kind: "style" | "insert", button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setMenuPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 170)),
      top: rect.bottom + 6,
    });
    setMenuOpen(menuOpen === kind ? null : kind);
  };

  return (
    <div className={`canvas-wysiwyg ${editing ? "is-editing" : "is-reading"}`}>
      <header className="canvas-wysiwyg-toolbar">
        <div className="canvas-wysiwyg-context">
          <button type="button" className={`canvas-wysiwyg-history-toggle ${showHistoryToggle ? "is-visible" : ""}`} aria-label="打开会话列表" title="会话列表" onClick={() => { if (compact) closeSidebar(); onOpenHistory(); }}><Menu size={18} /></button>
          <strong title={sessionTitle}>{sessionTitle}</strong>
        </div>
        <div className="canvas-wysiwyg-tools">
          <button type="button" title="撤销" aria-label="撤销" disabled={!editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={16} /></button>
          <button type="button" title="重做" aria-label="重做" disabled={!editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={16} /></button>
          <span className="canvas-wysiwyg-divider" />
          <div className="canvas-wysiwyg-menu-wrap">
            <button type="button" aria-expanded={menuOpen === "style"} onClick={(event) => toggleMenu("style", event.currentTarget)}>样式 <ChevronDown size={13} /></button>
            {menuOpen === "style" && <div className="canvas-wysiwyg-menu" style={menuPosition}>
              <button type="button" onClick={() => { editor?.chain().focus().setParagraph().run(); setMenuOpen(null); }}>正文</button>
              {[1, 2, 3].map((level) => <button key={level} type="button" onClick={() => { editor?.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 }).run(); setMenuOpen(null); }}>标题 {level}</button>)}
            </div>}
          </div>
          <span className="canvas-wysiwyg-divider" />
          <button type="button" title="加粗" aria-label="加粗" aria-pressed={editor?.isActive("bold") || false} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></button>
          <button type="button" title="斜体" aria-label="斜体" aria-pressed={editor?.isActive("italic") || false} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></button>
          <button type="button" title="下划线" aria-label="下划线" aria-pressed={editor?.isActive("underline") || false} onClick={() => editor?.chain().focus().toggleUnderline().run()}><Underline size={16} /></button>
          <button type="button" title="行内代码" aria-label="行内代码" aria-pressed={editor?.isActive("code") || false} onClick={() => editor?.chain().focus().toggleCode().run()}><Code size={16} /></button>
          <span className="canvas-wysiwyg-divider" />
          <button type="button" title="链接" aria-label="链接" onClick={() => setDialog({ kind: "link", url: editor?.getAttributes("link").href || "", alt: "" })}><Link size={16} /></button>
          <button type="button" title="图片" aria-label="图片" onClick={() => setDialog({ kind: "image", url: "", alt: "" })}><ImageIcon size={16} /></button>
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(event) => { if (event.target.files) void insertImageFiles(Array.from(event.target.files)); event.target.value = ""; }} />
          <button type="button" title="表格" aria-label="表格" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 size={16} /></button>
          <button type="button" title="待办" aria-label="待办" onClick={() => editor?.chain().focus().toggleTaskList().run()}><CheckSquare size={16} /></button>
          <button type="button" title="引用" aria-label="引用" onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={16} /></button>
          <button type="button" title="无序列表" aria-label="无序列表" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={16} /></button>
          <button type="button" title="有序列表" aria-label="有序列表" onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></button>
          <div className="canvas-wysiwyg-menu-wrap">
            <button type="button" aria-expanded={menuOpen === "insert"} onClick={(event) => toggleMenu("insert", event.currentTarget)}>插入 <ChevronDown size={13} /></button>
            {menuOpen === "insert" && <div className="canvas-wysiwyg-menu" style={menuPosition}>
              <button type="button" onClick={() => { setDialog({ kind: "cover", url: "", alt: "" }); setMenuOpen(null); }}>插入或更换封面</button>
              <button type="button" onClick={() => { imageInputRef.current?.click(); setMenuOpen(null); }}>从设备上传图片</button>
              <button type="button" onClick={() => { editor?.chain().focus().toggleCodeBlock().run(); setMenuOpen(null); }}>代码块</button>
              <button type="button" onClick={() => { editor?.chain().focus().setHorizontalRule().run(); setMenuOpen(null); }}>分隔线</button>
              <button type="button" onClick={() => { editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); setMenuOpen(null); }}>3 × 3 表格</button>
            </div>}
          </div>
          <button type="button" title="分隔线" aria-label="分隔线" onClick={() => editor?.chain().focus().setHorizontalRule().run()}><Minus size={16} /></button>
        </div>
        <div className="canvas-wysiwyg-actions">
          <button type="button" title={pendingReview ? "审查协同改动" : "审查上一版变更"} aria-label={pendingReview ? "审查协同改动" : "审查上一版变更"} aria-pressed={reviewOpen} onClick={() => void openReview()}><FileText size={16} /><span>{pendingReview ? "待确认" : "变更"}</span></button>
          <button type="button" title="复制 Markdown" onClick={() => void copyMarkdown()}>{copied ? <Check size={15} /> : <Copy size={15} />}<span>{copied ? "已复制" : "复制"}</span></button>
          {pendingReview ? <button type="button" title="按当前选择确认改动并进入编辑" aria-label="确认改动并编辑画布" disabled={saving || agentBusy} onClick={() => void finishReview(true)}><Pencil size={16} /><span>确认并编辑</span></button> : editing ? <>
            <button type="button" title="取消编辑" aria-label="取消编辑" onClick={cancelEdit}><X size={16} /><span>取消</span></button>
            <button type="button" className="canvas-wysiwyg-save" aria-label={saving ? "保存中" : "确认画布修改"} disabled={saving || conflicted} onClick={() => { if (dirty) void save(); else setEditing(false); }}><Save size={15} /><span>{saving ? "保存中" : "确认"}</span></button>
          </> : <button type="button" title="编辑画布" aria-label="编辑画布" disabled={Boolean(pendingReview)} onClick={() => setEditing(true)}><Pencil size={16} /><span>编辑</span></button>}
          <button type="button" title="大纲与文档信息" aria-label="大纲与文档信息" aria-expanded={outlineOpen && !reviewOpen} aria-controls="canvas-document-outline" aria-pressed={outlineOpen && !reviewOpen} onClick={() => { setOutlineOpen(reviewOpen || !outlineOpen); setReviewOpen(false); }}><BookOpen size={16} /></button>
        </div>
      </header>

      {error && <div className="canvas-wysiwyg-warning" role="alert">
        <span>{error}</span>
        {conflicted && !pendingReview && <><button type="button" onClick={() => void copyMarkdown()}>复制本地稿</button><button type="button" onClick={() => {
          editor?.commands.setContent(document.content, { contentType: "markdown", emitUpdate: false });
          const normalized = editor?.getMarkdown() || document.content;
          baseline.current = { version: document.version, content: normalized };
          setDraft(normalized);
          setError("");
        }}>载入最新版</button></>}
      </div>}

      <div className={`canvas-wysiwyg-body ${outlineOpen || reviewOpen ? "with-outline" : ""}`}>
        {compact && (outlineOpen || reviewOpen) && <button type="button" className="canvas-sidebar-backdrop" aria-label="关闭画布侧边栏" onClick={closeSidebar} />}
        <div className={`canvas-wysiwyg-scroll ${draggingImage ? "dragging-image" : ""}`} onScroll={() => { setMenuOpen(null); setSelection(""); }} onDragOver={(event) => { if (editing && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDraggingImage(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingImage(false); }} onDrop={(event) => {
          if (!editing || !event.dataTransfer.files.length) return;
          event.preventDefault();
          setDraggingImage(false);
          const pos = editor?.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void insertImageFiles(Array.from(event.dataTransfer.files), pos);
        }}>
          <div className="canvas-wysiwyg-paper">
            {showDiffPreview ? <div className="canvas-inline-review canvas-prose" aria-label="画布变更预览">
              {pendingReview?.userContent && <div className="canvas-inline-review-notice">你的未保存编辑已保留。冲突处默认保留你的内容，智能体提议仍显示在下方供审查。</div>}
              {reviewChunks.map((chunk, index) => chunk.kind === "same" ?
                <div key={index} className="canvas-inline-review-same"><ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.after}</ReactMarkdown></div> :
                <div key={index} data-canvas-review-change={chunk.index} className={`canvas-inline-review-change ${pendingReview && !reviewAccepted[chunk.index] ? "is-rejected" : "is-accepted"} ${reviewIndex === chunk.index ? "is-current" : ""}`}>
                  {chunk.before && <div className="canvas-inline-review-before" aria-label="原内容"><ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.before}</ReactMarkdown></div>}
                  {chunk.after && <div className="canvas-inline-review-after" aria-label={`智能体建议，${pendingReview && !reviewAccepted[chunk.index] ? "未接受" : "已接受"}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.after}</ReactMarkdown></div>}
                  {reviewEdits[chunk.index]?.conflictsWithUser && <small>与未保存的手工编辑冲突；接受会覆盖该处手工内容。</small>}
                </div>)}
            </div> : <EditorContent editor={editor} />}
          </div>
          {draggingImage && <div className="canvas-wysiwyg-drop-hint">松开以将图片插入文稿</div>}
          {uploadingImage && <div className="canvas-wysiwyg-upload-hint" role="status"><FlowMark className="flow-mark-compact" />图片上传中…</div>}
        </div>
        {reviewOpen ? <aside className="canvas-wysiwyg-outline canvas-wysiwyg-review" aria-label="版本变更审查">
          <div className="canvas-wysiwyg-review-header"><strong>{pendingReview ? "确认协同改动" : "版本变更"}</strong><button type="button" aria-label="关闭变更审查" onClick={() => { setReviewOpen(false); if (compact) setOutlineOpen(false); }}><X size={16} /></button></div>
          {reviewError ? <p role="alert">{reviewError}</p> : reviewedRevision ? <p>{reviewEdits.length ? `${reviewEdits.length} 处改动` : "这一版没有可见内容变化"}</p> : <p>{document.version < 2 ? "尚无上一版可供对比。" : "正在读取上一版…"}</p>}
          {pendingReview && <p>在正文中查看高亮；用底部工具栏接受或撤销。冲突处默认保留手工内容。</p>}
          {dirty && <p>手工草稿已保留。</p>}
          {!pendingReview && priorRevision && <button type="button" className="canvas-wysiwyg-restore" disabled={dirty} onClick={() => { if (!window.confirm("将上一版载入编辑器？需要再次保存才会生效。")) return; setEditing(true); editor?.commands.setContent(priorRevision.content, { contentType: "markdown" }); setReviewOpen(false); }}>载入上一版到编辑器</button>}
        </aside> : outlineOpen && <aside id="canvas-document-outline" className="canvas-wysiwyg-outline" aria-label="文档大纲侧边栏">
          <div className="canvas-wysiwyg-review-header"><strong>大纲</strong><button type="button" aria-label="关闭文档大纲" onClick={() => setOutlineOpen(false)}><X size={16} /></button></div>
          <strong className="canvas-wysiwyg-doc-title">{title}</strong>
          <nav aria-label="文档大纲">
            {outline.filter((item) => item.level > 1).length ? outline.filter((item) => item.level > 1).map((item, index) => (
              <button key={`${item.pos}-${index}`} type="button" className={`level-${item.level}`} onClick={() => { editor?.chain().setTextSelection(item.pos + 1).scrollIntoView().run(); if (compact) setOutlineOpen(false); }}>{item.text}</button>
            )) : <p>添加章节标题后会显示在这里。</p>}
          </nav>
          <div className="canvas-wysiwyg-info">
            <div><span>字数</span><strong>{words}</strong></div>
          </div>
        </aside>}
      </div>
      {pendingReview && !agentBusy && <div className="canvas-review-toolbar" role="toolbar" aria-label="审查智能体改动">
        {reviewError && <span className="canvas-review-error" role="alert">{reviewError}</span>}
        <button type="button" className="canvas-review-finish" disabled={saving} onClick={() => void finishReview()}>{saving ? "保存中…" : "完成"}</button>
        <button type="button" disabled={saving} onClick={() => setReviewChoices(Object.fromEntries(reviewEdits.map((_, index) => [index, true])))}>全部接受</button>
        <button type="button" disabled={saving} onClick={() => setReviewChoices(Object.fromEntries(reviewEdits.map((_, index) => [index, false])))}>全部撤销</button>
        <span className="canvas-review-separator" />
        <button type="button" disabled={!reviewEdits.length || saving} onClick={() => setReviewChoices((current) => ({ ...current, [reviewIndex]: true }))}>接受</button>
        <button type="button" disabled={!reviewEdits.length || saving} onClick={() => setReviewChoices((current) => ({ ...current, [reviewIndex]: false }))}>撤销</button>
        <span className="canvas-review-position">第 {reviewEdits.length ? reviewIndex + 1 : 0} 处 / 共 {reviewEdits.length} 处</span>
        <button type="button" aria-label="上一个改动" disabled={reviewIndex <= 0} onClick={() => setReviewIndex((index) => index - 1)}>↑</button>
        <button type="button" aria-label="下一个改动" disabled={reviewIndex >= reviewEdits.length - 1} onClick={() => setReviewIndex((index) => index + 1)}>↓</button>
      </div>}

      {selection && onAskAI && <div className="canvas-wysiwyg-selection-actions" role="toolbar" aria-label="选中文本操作" style={selectionPosition} onMouseDown={(event) => event.preventDefault()}>
        {editing && <><button type="button" title="加粗" aria-label="加粗选中文本" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={15} /></button>
        <button type="button" title="斜体" aria-label="斜体选中文本" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={15} /></button>
        <span className="canvas-wysiwyg-divider" /></>}
        {([ ["polish", "润色"], ["expand", "扩写"], ["correct", "纠错"], ["restructure", "重构"] ] as const).map(([action, label]) => <button key={action} type="button" onClick={() => { onAskAI(selection, action); setSelection(""); }}>{label}</button>)}
      </div>}

      {dialog && <div className="canvas-url-backdrop" onMouseDown={() => setDialog(null)}>
        <form className="canvas-url-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); applyUrl(); }}>
          <div><strong>{dialog.kind === "link" ? "插入链接" : dialog.kind === "cover" ? "设置封面" : "插入图片"}</strong><button type="button" aria-label="关闭" onClick={() => setDialog(null)}><X size={16} /></button></div>
          <label>地址<input autoFocus value={dialog.url} placeholder="https://example.com" onChange={(event) => setDialog({ ...dialog, url: event.target.value })} /></label>
          <label>{dialog.kind === "link" ? "显示文字（无选区时使用）" : "替代文字"}<input value={dialog.alt} placeholder={dialog.kind === "link" ? "链接文字" : "描述这张图片"} onChange={(event) => setDialog({ ...dialog, alt: event.target.value })} /></label>
          <button type="submit">插入</button>
        </form>
      </div>}
    </div>
  );
}
