from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import CanvasDoc, CanvasRevision, Invocation


class CanvasError(RuntimeError):
    pass


SECTION_HEADING = re.compile(r"^##\s+.+$", re.MULTILINE)


def canvas_id_for(session_id: str) -> str:
    """A canvas belongs to the conversation, not an individual turn."""
    return f"canvas-{hashlib.sha256(session_id.encode('utf-8')).hexdigest()[:32]}"


def _claim_canvas(db: Session, doc: CanvasDoc, session_id: str, owner_id: str | None) -> CanvasDoc:
    if not owner_id:
        return doc
    if doc.owner_id and doc.owner_id != owner_id:
        raise CanvasError("画布不存在或无权访问")
    if not doc.owner_id:
        prior_owner = (
            db.query(Invocation.owner_id)
            .filter(Invocation.session_id == session_id, Invocation.owner_id != "")
            .order_by(Invocation.created_at.desc())
            .limit(1)
            .scalar()
        )
        if prior_owner and prior_owner != owner_id:
            raise CanvasError("画布不存在或无权访问")
        db.execute(
            update(CanvasDoc)
            .where(CanvasDoc.id == doc.id, CanvasDoc.owner_id == "")
            .values(owner_id=owner_id)
        )
        db.commit()
        db.refresh(doc)
        if doc.owner_id != owner_id:
            raise CanvasError("画布不存在或无权访问")
    return doc


def get_or_create_session_canvas(
    db: Session, session_id: str, owner_id: str | None = None
) -> CanvasDoc:
    canvas_id = canvas_id_for(session_id)
    existing = db.get(CanvasDoc, canvas_id)
    if existing is not None:
        return _claim_canvas(db, existing, session_id, owner_id)

    # Older turns used one canvas per invocation. Keep their latest document
    # when the user continues an existing conversation after this upgrade.
    prior = (
        db.query(Invocation)
        .filter(Invocation.session_id == session_id)
        .order_by(Invocation.created_at.desc())
        .all()
    )
    for invocation in prior:
        if owner_id and invocation.owner_id and invocation.owner_id != owner_id:
            raise CanvasError("画布不存在或无权访问")
        snapshot = (invocation.result_data or {}).get("canvas")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("content"), str):
            continue
        doc = CanvasDoc(
            id=canvas_id,
            owner_id=owner_id or "",
            title=str(snapshot.get("title") or "协同画布")[:160],
            content=snapshot["content"],
            version=max(1, int(snapshot.get("version") or 1)),
        )
        db.add(doc)
        legacy_id = snapshot.get("id")
        if isinstance(legacy_id, str):
            for revision in (
                db.query(CanvasRevision)
                .filter(CanvasRevision.canvas_id == legacy_id)
                .order_by(CanvasRevision.version.asc())
                .all()
            ):
                db.add(CanvasRevision(
                    canvas_id=canvas_id,
                    version=revision.version,
                    editor_id=revision.editor_id,
                    editor_name=revision.editor_name,
                    op=revision.op,
                    summary=revision.summary,
                    content_after=revision.content_after,
                    created_at=revision.created_at,
                ))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.get(CanvasDoc, canvas_id)
            if existing is None:
                raise
            return _claim_canvas(db, existing, session_id, owner_id)
        return doc
    return get_or_create_canvas(db, canvas_id, owner_id=owner_id or "")


DEFAULT_CANVAS_TEMPLATE = (
    "# 产品设计笔记\n\n"
    "记录产品设计过程中的思考、方法与实践经验。\n\n"
    "## 🎯 1. 产品设计的核心目标\n"
    "优秀的方案，始终围绕着 **用户价值** 展开。我们需要在 **用户需求**、**技术可行性** 与 **商业价值** 之间找到平衡，创造简单、优雅、高效的解决方案。\n\n"
    "> 💡 **设计原则**\n"
    "> 以用户为中心，保持简单，关注细节，持续迭代。\n\n"
    "## 🎨 2. 设计方法与步骤\n"
    "1. **发现问题**：通过用户调研、数据分析等方式，找到真正的用户需求。\n"
    "2. **定义方案**：明确产品目标，梳理核心功能与体验路径。\n"
    "3. **设计与验证**：快速原型设计，通过用户测试验证方案的有效性。\n"
    "4. **持续迭代**：根据反馈不断优化，追求更好的用户体验。\n\n"
    "## 📋 3. 本周待办清单\n"
    "- [x] 完成用户访谈整理\n"
    "- [x] 更新产品原型设计\n"
    "- [ ] 与开发团队评审技术方案\n"
    "- [ ] 整理竞品分析报告\n"
    "- [ ] 撰写设计总结文档\n\n"
    "## 📊 4. 竞品对比分析\n"
    "| 产品 | 核心优势 | 不足之处 | 参考价值 |\n"
    "| :--- | :--- | :--- | :--- |\n"
    "| **Notion** | 灵活的模块化设计 | 学习成本较高 | ★★★★☆ |\n"
    "| **语雀** | 本土化体验好 | 功能相对单一 | ★★★☆☆ |\n"
    "| **飞书文档** | 协作能力强 | 个性化能力较弱 | ★★★★☆ |\n\n"
    "## 💻 5. 示例代码\n"
    "```javascript\n"
    "// 计算斐波那契数列\n"
    "function fibonacci(n) {\n"
    "  if (n <= 1) return n;\n"
    "  return fibonacci(n - 1) + fibonacci(n - 2);\n"
    "}\n"
    "console.log(fibonacci(10)); // 55\n"
    "```\n\n"
    "> “ 好的设计不是让复杂的东西看起来简单，而是让简单的东西变得更有力量。 ”\n"
    "> —— Dieter Rams\n"
)


def get_or_create_canvas(
    db: Session, canvas_id: str, title: str = "产品设计笔记", owner_id: str = ""
) -> CanvasDoc:
    doc = db.get(CanvasDoc, canvas_id)
    if doc is not None and owner_id and doc.owner_id != owner_id:
        raise CanvasError("画布不存在或无权访问")
    if doc is None:
        initial_content = (
            DEFAULT_CANVAS_TEMPLATE
            if title in ("协同画布", "产品设计笔记", "未命名画布")
            else f"# {title}\n"
        )
        doc = CanvasDoc(
            id=canvas_id, owner_id=owner_id, title=title,
            content=initial_content, version=1,
        )
        db.add(doc)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.get(CanvasDoc, canvas_id)
            if existing is None:
                raise
            if owner_id and existing.owner_id != owner_id:
                raise CanvasError("画布不存在或无权访问")
            return existing
    return doc


def replace_document(
    db: Session, doc: CanvasDoc, *, content: str, base_version: int, owner_id: str
) -> CanvasDoc:
    """Save a complete Markdown draft only if the version has not changed."""
    if doc.owner_id != owner_id:
        raise CanvasError("画布不存在或无权访问")
    heading = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    title = heading.group(1).strip()[:160] if heading else doc.title
    changed = db.execute(
        update(CanvasDoc)
        .where(
            CanvasDoc.id == doc.id,
            CanvasDoc.owner_id == owner_id,
            CanvasDoc.version == base_version,
        )
        .values(content=content, title=title, version=base_version + 1)
    ).rowcount
    if changed != 1:
        db.rollback()
        raise CanvasError("画布版本已变化，请先查看最新内容，再决定如何合并草稿")
    db.add(CanvasRevision(
        canvas_id=doc.id,
        version=base_version + 1,
        editor_id=owner_id,
        editor_name="用户",
        op="replace_document",
        summary="手动编辑 Markdown",
        content_after=content,
    ))
    db.commit()
    db.refresh(doc)
    return doc


def read_section(content: str, section: str | None) -> str:
    """按 `## 标题` 切分段落读取；section 为空返回全文。"""
    if not section:
        return content
    matches = list(SECTION_HEADING.finditer(content))
    bounds: list[tuple[str, int, int]] = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        bounds.append((m.group(0).lstrip("# ").strip(), m.start(), end))
    for title, start, end in bounds:
        if section.lower() in title.lower():
            return content[start:end].strip()
    raise CanvasError(f"画布中不存在段落「{section}」；现有段落：{[b[0] for b in bounds] or '无'}")


def write_section(content: str, section: str, body: str) -> str:
    """替换指定段落（按 `## 标题` 匹配）；不存在则追加到末尾。"""
    new_block = f"## {section}\n{body.strip()}\n"
    matches = list(SECTION_HEADING.finditer(content))
    for i, m in enumerate(matches):
        title = m.group(0).lstrip("# ").strip()
        if section.lower() in title.lower():
            end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
            return content[: m.start()] + new_block + ("\n" if end < len(content) else "") + content[end:]
    return content.rstrip() + "\n\n" + new_block


def apply_op(
    db: Session,
    doc: CanvasDoc,
    *,
    editor_id: str,
    editor_name: str,
    op: str,  # "write_section" | "append"
    section: str | None,
    content: str,
    base_version: int | None,
) -> dict[str, Any]:
    """应用一次画布编辑；版本冲突时抛 CanvasError 并携带当前版本。"""
    if base_version is not None and base_version != doc.version:
        raise CanvasError(
            f"版本冲突：你基于 v{base_version} 编辑，画布当前为 v{doc.version}。"
            f"请先 canvas_read 刷新内容后重试。"
        )
    if op == "write_section":
        if not section:
            raise CanvasError("write_section 需要提供 section（段落标题）")
        doc.content = write_section(doc.content, section, content)
    elif op == "append":
        doc.content = doc.content.rstrip() + "\n\n" + content.strip() + "\n"
    else:
        raise CanvasError(f"未知画布操作：{op}")
    doc.version += 1
    summary = f"{op}" + (f"：「{section}」" if section and op == "write_section" else "")
    db.add(
        CanvasRevision(
            canvas_id=doc.id,
            version=doc.version,
            editor_id=editor_id,
            editor_name=editor_name,
            op=op,
            summary=summary[:255],
            content_after=doc.content,
        )
    )
    db.commit()
    return {"version": doc.version, "summary": summary}


def history(db: Session, canvas_id: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = list(
        db.query(CanvasRevision)
        .filter(CanvasRevision.canvas_id == canvas_id)
        .order_by(CanvasRevision.version.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "version": r.version,
            "editor_id": r.editor_id,
            "editor_name": r.editor_name,
            "op": r.op,
            "summary": r.summary,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# 外部国标 Partner 的提示词协议：
# 画布快照随任务下发（dataItems 文本），Partner 在回复文本中输出标准 JSON 块
# {"name": "canvas_write_section", "parameters": {...}}，平台解析后应用。
# ---------------------------------------------------------------------------

CANVAS_PROTOCOL_INSTRUCTIONS = (
    "【画布协作说明（国标载荷约定）】\n"
    "下方提供共享画布的当前内容（v{version}）。如需修改报告，请在回复的末尾输出一个 JSON 代码块：\n"
    '```json\n{{"name": "canvas_write_section", "parameters": {{"section": "段落标题", "content": "该段落的完整新内容", "base_version": {version}}}}}\n```\n'
    "也可以使用 {\"name\": \"canvas_append\", \"parameters\": {{\"content\": \"追加内容\"}}。"
    "正文里请先简要说明你做了什么修改；未修改则不要输出 JSON 块。\n\n"
    "【画布当前内容 v{version}】\n{content}"
)

_CANVAS_OP_PATTERN = re.compile(
    r"```(?:json)?\s*(\{[\s\S]*?\"name\"\s*:\s*\"canvas_(?:write_section|append)\"[\s\S]*?\})\s*```",
    re.IGNORECASE,
)


def parse_canvas_ops(text: str) -> list[dict[str, Any]]:
    """从 Partner 回复文本中解析画布编辑操作（提示词协议）。"""
    ops: list[dict[str, Any]] = []
    for m in _CANVAS_OP_PATTERN.finditer(text or ""):
        try:
            payload = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        name = str(payload.get("name") or "")
        parameters = payload.get("parameters")
        if not isinstance(parameters, dict):
            parameters = {k: v for k, v in payload.items() if k != "name"}
        op = "write_section" if name == "canvas_write_section" else "append"
        ops.append(
            {
                "op": op,
                "section": str(parameters.get("section") or "") or None,
                "content": str(parameters.get("content") or ""),
                "base_version": parameters.get("base_version"),
            }
        )
    return ops


def new_canvas_key() -> str:
    return uuid.uuid4().hex[:10]
