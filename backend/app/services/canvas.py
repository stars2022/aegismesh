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
_LEGACY_DEMO_TEMPLATE_SHA256 = "11b6c1b9751b9485123901ee9dca81154c9b25e1c9dc8add7b803c7022625bca"


def _retire_untouched_demo_template(db: Session, doc: CanvasDoc) -> CanvasDoc:
    """Only replace the exact original v1 sample; never touch user-edited documents."""
    if doc.version != 1 or hashlib.sha256(doc.content.encode()).hexdigest() != _LEGACY_DEMO_TEMPLATE_SHA256:
        return doc
    if not db.query(CanvasRevision.id).filter(CanvasRevision.canvas_id == doc.id, CanvasRevision.version == 1).first():
        db.add(CanvasRevision(
            canvas_id=doc.id, version=1, editor_name="系统", op="create",
            summary="旧版示例快照", content_after=doc.content,
        ))
    doc.content = DEFAULT_CANVAS_TEMPLATE
    doc.title = "协同画布"
    doc.version = 2
    db.add(CanvasRevision(
        canvas_id=doc.id, version=2, editor_name="系统", op="remove_demo_template",
        summary="移除未修改的旧版演示内容", content_after=doc.content,
    ))
    db.commit()
    db.refresh(doc)
    return doc


def canvas_id_for(session_id: str) -> str:
    """A canvas belongs to the conversation, not an individual turn."""
    return f"canvas-{hashlib.sha256(session_id.encode('utf-8')).hexdigest()[:32]}"


def _claim_canvas(db: Session, doc: CanvasDoc, session_id: str, owner_id: str | None) -> CanvasDoc:
    if not owner_id:
        return _retire_untouched_demo_template(db, doc)
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
    return _retire_untouched_demo_template(db, doc)


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


DEFAULT_CANVAS_TEMPLATE = "# 协同画布\n"


def get_or_create_canvas(
    db: Session, canvas_id: str, title: str = "协同画布", owner_id: str = ""
) -> CanvasDoc:
    doc = db.get(CanvasDoc, canvas_id)
    if doc is not None and owner_id and doc.owner_id != owner_id:
        raise CanvasError("画布不存在或无权访问")
    if doc is not None:
        return _retire_untouched_demo_template(db, doc)
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
        db.add(CanvasRevision(
            canvas_id=canvas_id, version=1, editor_id=owner_id,
            editor_name="系统", op="create", summary="创建空白画布",
            content_after=initial_content,
        ))
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


_EMPTY_SECTION_PLACEHOLDERS = {
    "",
    "（已清空）",
    "(已清空)",
    "（清空）",
    "(清空)",
    "（空）",
    "(空)",
    "（已删除）",
    "(已删除)",
    "（删除）",
    "(删除)",
    "（无）",
    "(无)",
    "（待补充）",
    "(待补充)",
    "(deleted)",
    "(cleared)",
    "deleted",
    "cleared",
    "none",
    "null",
}


def _get_section_bounds(content: str) -> list[tuple[str, int, int]]:
    """切分所有二级标题（## 标题）的边界 [(title, start, end)]。"""
    matches = list(SECTION_HEADING.finditer(content))
    bounds: list[tuple[str, int, int]] = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        bounds.append((m.group(0).lstrip("# ").strip(), m.start(), end))
    return bounds


def _find_matching_indices(bounds: list[tuple[str, int, int]], query: str) -> list[int]:
    """根据查询词匹配段落索引。优先完全一致匹配；无完全一致时使用双向包含匹配。"""
    q = query.strip().lower()
    # 1. 优先完全一致匹配
    exact = [i for i, (title, _, _) in enumerate(bounds) if title.strip().lower() == q]
    if exact:
        return exact
    # 2. 包含匹配
    fuzzy = [i for i, (title, _, _) in enumerate(bounds) if q in title.lower() or title.lower() in q]
    return fuzzy


def read_section(content: str, section: str | None) -> str:
    """按 `## 标题` 切分段落读取；section 为空返回全文。"""
    if not section:
        return content
    bounds = _get_section_bounds(content)
    matching = _find_matching_indices(bounds, section)
    if matching:
        _, start, end = bounds[matching[0]]
        return content[start:end].strip()
    existing_titles = [b[0] for b in bounds] or "无"
    raise CanvasError(f"画布中不存在段落「{section}」；现有段落：{existing_titles}")


def delete_section(content: str, section: str) -> str:
    """彻底删除指定段落（包括 ## 标题和正文）。若存在同名/匹配的重复段落，全部彻底清除，绝不残留空标题壳或孤儿段落。"""
    bounds = _get_section_bounds(content)
    matching = _find_matching_indices(bounds, section)
    if not matching:
        existing_titles = [b[0] for b in bounds] or "无"
        raise CanvasError(f"画布中不存在匹配「{section}」的段落；现有段落：{existing_titles}")

    matched_set = set(matching)
    # 取第一段 ## 之前的头部（如 # 文档大标题 与 导语）
    header = content[:bounds[0][1]].rstrip() if bounds else ""
    kept_blocks = [
        content[b[1]:b[2]].strip()
        for i, b in enumerate(bounds)
        if i not in matched_set and content[b[1]:b[2]].strip()
    ]

    if header:
        if kept_blocks:
            return header + "\n\n" + "\n\n".join(kept_blocks) + "\n"
        return header + "\n"
    elif kept_blocks:
        return "\n\n".join(kept_blocks) + "\n"
    return ""


def write_section(content: str, section: str, body: str) -> str:
    """
    更新或创建指定段落（按 `## 标题` 匹配）。
    优化点：
    1. 若正文为空或为「（已清空）」等占位符，自动转为彻底删除该段落，防止留下空标题壳。
    2. 若画布中存在多个同名重复段落，更新首个匹配项并彻底清除所有后续重复段落，消除歧义与冗余。
    3. 若段落不存在，规范追加至文稿末尾。
    """
    clean_body = body.strip()
    # 容错：当智能体通过空文本或占位符假装删除时，直接彻底删除
    if not clean_body or clean_body.lower() in _EMPTY_SECTION_PLACEHOLDERS:
        try:
            return delete_section(content, section)
        except CanvasError:
            return content

    new_block = f"## {section.strip()}\n{clean_body}"
    bounds = _get_section_bounds(content)
    matching = _find_matching_indices(bounds, section)

    if matching:
        first_idx = matching[0]
        matched_set = set(matching)
        header = content[:bounds[0][1]].rstrip() if bounds else ""
        kept_blocks: list[str] = []
        for i, b in enumerate(bounds):
            if i == first_idx:
                kept_blocks.append(new_block)
            elif i in matched_set:
                # 剔除同名重复的多余章节，彻底消除歧义与孤儿章节
                continue
            else:
                block_txt = content[b[1]:b[2]].strip()
                if block_txt:
                    kept_blocks.append(block_txt)
        if header:
            return header + "\n\n" + "\n\n".join(kept_blocks) + "\n"
        return "\n\n".join(kept_blocks) + "\n"

    # 不存在匹配段落，追加至末尾
    if not content.strip():
        return new_block + "\n"
    return content.rstrip() + "\n\n" + new_block + "\n"


def replace_all(content: str, new_content: str, default_title: str = "协同画布") -> str:
    """全篇替换或清空画布。若 new_content 为空，清空全部正文并保留一级大标题。"""
    stripped = new_content.strip()
    if not stripped:
        # 清空模式：保留原有的一级大标题
        heading = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
        top_title = heading.group(1).strip() if heading else default_title
        return f"# {top_title}\n"

    heading = re.search(r"^#\s+(.+)$", stripped, re.MULTILINE)
    if heading:
        return stripped + "\n"
    # 如果新文本没有一级标题，补充已有的大标题
    old_heading = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    top_title = old_heading.group(1).strip() if old_heading else default_title
    return f"# {top_title}\n\n{stripped}\n"


def apply_op(
    db: Session,
    doc: CanvasDoc,
    *,
    editor_id: str,
    editor_name: str,
    op: str,  # "write_section" | "delete_section" | "replace_all" | "append"
    section: str | None = None,
    selection: str | None = None,
    content: str = "",
    base_version: int | None = None,
) -> dict[str, Any]:
    """应用一次画布编辑；版本冲突时抛 CanvasError 并携带当前版本。"""
    if base_version is not None and base_version != doc.version:
        raise CanvasError(
            f"版本冲突：你基于 v{base_version} 编辑，画布当前为 v{doc.version}。"
            f"请先 canvas_read 刷新内容后重试。"
        )
    if op == "replace_selection" and base_version is None:
        raise CanvasError("划词修改必须携带读取画布时的版本号")
    if op == "write_section":
        if not section:
            raise CanvasError("write_section 需要提供 section（段落标题）")
        doc.content = write_section(doc.content, section, content)
        if content.strip().lower() in _EMPTY_SECTION_PLACEHOLDERS:
            summary = f"删除段落：「{section}」"
        else:
            summary = f"更新段落：「{section}」"
    elif op == "delete_section":
        if not section:
            raise CanvasError("delete_section 需要提供 section（段落标题）")
        doc.content = delete_section(doc.content, section)
        summary = f"删除段落：「{section}」"
    elif op == "replace_selection":
        if not selection or not selection.strip():
            raise CanvasError("划词修改需要非空的原文")
        matches = doc.content.count(selection)
        if matches != 1:
            raise CanvasError(f"划词原文在当前画布中匹配到 {matches} 处；请重新读取并提供唯一原文")
        doc.content = doc.content.replace(selection, content, 1)
        summary = "局部修改选中文本"
    elif op in ("replace_all", "clear"):
        doc.content = replace_all(doc.content, content, default_title=doc.title)
        summary = "清空画布内容" if not content.strip() else "全篇重写画布"
    elif op == "append":
        doc.content = doc.content.rstrip() + "\n\n" + content.strip() + "\n"
        summary = "追加内容"
    else:
        raise CanvasError(f"未知画布操作：{op}")

    heading = re.search(r"^#\s+(.+)$", doc.content, re.MULTILINE)
    if heading:
        doc.title = heading.group(1).strip()[:160]

    doc.version += 1
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
    "下方提供共享画布的当前内容（v{version}）。如需修改或编辑文稿，请在回复的末尾输出标准 JSON 代码块：\n"
    '- 更新或新增章节：```json\n{{"name": "canvas_write_section", "parameters": {{"section": "章节标题", "content": "该章节完整新内容", "base_version": {version}}}}}\n```\n'
    '- 彻底删除某个章节：```json\n{{"name": "canvas_delete_section", "parameters": {{"section": "要删除的章节标题", "base_version": {version}}}}}\n```\n'
    '- 重置/整篇重写画布：```json\n{{"name": "canvas_replace_all", "parameters": {{"content": "整篇完整新内容（Markdown，传空字符串则清空全部章节）", "base_version": {version}}}}}\n```\n'
    '- 仅修改唯一匹配的划词原文：```json\n{{"name": "canvas_replace_selection", "parameters": {{"selection": "原文", "replacement": "修改后文本", "base_version": {version}}}}}\n```\n'
    '- 末尾追加内容：```json\n{{"name": "canvas_append", "parameters": {{"content": "追加内容"}}}}\n```\n'
    "正文里请先简要说明你做了什么修改；未修改则不要输出 JSON 块。\n\n"
    "【画布当前内容 v{version}】\n{content}"
)

_CANVAS_OP_PATTERN = re.compile(
    r"```(?:json)?\s*(\{[\s\S]*?\"name\"\s*:\s*\"canvas_(?:write_section|delete_section|replace_all|replace_selection|append)\"[\s\S]*?\})\s*```",
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
        if name == "canvas_write_section":
            op = "write_section"
        elif name == "canvas_delete_section":
            op = "delete_section"
        elif name == "canvas_replace_all":
            op = "replace_all"
        elif name == "canvas_replace_selection":
            op = "replace_selection"
        else:
            op = "append"
        ops.append(
            {
                "op": op,
                "section": str(parameters.get("section") or "") or None,
                "selection": str(parameters.get("selection") or "") or None,
                "content": str(parameters.get("replacement") or "") if op == "replace_selection" else str(parameters.get("content") or ""),
                "base_version": parameters.get("base_version"),
            }
        )
    return ops


def new_canvas_key() -> str:
    return uuid.uuid4().hex[:10]
