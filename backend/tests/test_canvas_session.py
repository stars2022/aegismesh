from __future__ import annotations

import hashlib

import pytest

from app.services import canvas as canvas_module
from app.models import CanvasDoc, CanvasRevision, Invocation
from app.services.canvas import (
    CanvasError,
    apply_op,
    canvas_id_for,
    delete_section,
    get_or_create_session_canvas,
    parse_canvas_ops,
    replace_all,
    replace_document,
    write_section,
)


def test_canvas_updates_remain_in_the_same_session(db) -> None:
    doc = get_or_create_session_canvas(db, "session-one")
    apply_op(
        db, doc,
        editor_id="leader", editor_name="主智能体",
        op="write_section", section="摘要", content="第一版", base_version=doc.version,
    )

    continued = get_or_create_session_canvas(db, "session-one")
    assert continued.id == canvas_id_for("session-one")
    assert "## 摘要\n第一版" in continued.content
    assert continued.version == 2
    assert get_or_create_session_canvas(db, "session-two").id != continued.id


def test_session_canvas_keeps_legacy_document_and_revision(db) -> None:
    legacy = CanvasDoc(id="canvas-inv-old", title="旧文稿", content="# 旧文稿\n\n## 摘要\n已有内容\n", version=2)
    db.add(legacy)
    db.add(CanvasRevision(
        canvas_id=legacy.id, version=2, editor_id="partner", editor_name="专家",
        op="write_section", summary="修改摘要", content_after=legacy.content,
    ))
    db.add(Invocation(
        id="inv-old", session_id="session-legacy", query="写摘要", status="completed",
        result_data={"canvas": {
            "id": legacy.id, "title": legacy.title, "content": legacy.content,
            "version": legacy.version,
        }},
    ))
    db.commit()

    migrated = get_or_create_session_canvas(db, "session-legacy")
    assert migrated.id == canvas_id_for("session-legacy")
    assert migrated.content == legacy.content
    assert migrated.version == 2
    assert db.query(CanvasRevision).filter(CanvasRevision.canvas_id == migrated.id).count() == 1


def test_markdown_save_checks_owner_and_version(db) -> None:
    doc = get_or_create_session_canvas(db, "session-edit", "demo-owner")
    saved = replace_document(
        db, doc, content="# 新标题\n\n正文", base_version=1, owner_id="demo-owner",
    )
    assert saved.title == "新标题"
    assert saved.version == 2
    assert saved.content == "# 新标题\n\n正文"
    revisions = db.query(CanvasRevision).filter(CanvasRevision.canvas_id == saved.id).order_by(CanvasRevision.version).all()
    assert [revision.version for revision in revisions] == [1, 2]
    assert revisions[0].content_after == ""

    with pytest.raises(CanvasError, match="版本"):
        replace_document(db, saved, content="过期稿", base_version=1, owner_id="demo-owner")
    with pytest.raises(CanvasError, match="无权访问"):
        get_or_create_session_canvas(db, "session-edit", "demo-other")
    assert db.get(CanvasDoc, saved.id).content == "# 新标题\n\n正文"


def test_canvas_replace_selection_requires_unique_current_text(db) -> None:
    doc = get_or_create_session_canvas(db, "session-selection", "demo-owner")
    saved = replace_document(
        db, doc, content="# 研究\n\n唯一原文\n", base_version=1, owner_id="demo-owner",
    )
    with pytest.raises(CanvasError, match="版本号"):
        apply_op(db, saved, editor_id="leader", editor_name="主智能体", op="replace_selection", selection="唯一原文", content="新内容")
    with pytest.raises(CanvasError, match="版本冲突"):
        apply_op(db, saved, editor_id="leader", editor_name="主智能体", op="replace_selection", selection="唯一原文", content="新内容", base_version=1)
    with pytest.raises(CanvasError, match="匹配到 0 处"):
        apply_op(db, saved, editor_id="leader", editor_name="主智能体", op="replace_selection", selection="不存在", content="新内容", base_version=2)
    applied = apply_op(db, saved, editor_id="leader", editor_name="主智能体", op="replace_selection", selection="唯一原文", content="新内容", base_version=2)
    assert applied["version"] == 3
    assert db.get(CanvasDoc, saved.id).content == "# 研究\n\n新内容\n"


def test_only_untouched_legacy_sample_is_retired(db, monkeypatch) -> None:
    old = "# 旧版演示\n\n预置文章"
    monkeypatch.setattr(canvas_module, "_LEGACY_DEMO_TEMPLATE_SHA256", hashlib.sha256(old.encode()).hexdigest())
    doc = CanvasDoc(id=canvas_id_for("legacy-demo"), owner_id="owner", title="旧版演示", content=old, version=1)
    db.add(doc)
    db.commit()
    converted = get_or_create_session_canvas(db, "legacy-demo", "owner")
    assert converted.content == ""
    assert converted.version == 2
    assert [row.content_after for row in db.query(CanvasRevision).filter(CanvasRevision.canvas_id == doc.id).order_by(CanvasRevision.version)] == [old, ""]


def test_only_untouched_default_heading_is_removed(db) -> None:
    old = CanvasDoc(id=canvas_id_for("old-default"), owner_id="owner", title="协同画布", content="# 协同画布\n", version=1)
    edited = CanvasDoc(id=canvas_id_for("edited-default"), owner_id="owner", title="协同画布", content="# 协同画布\n\n用户正文", version=2)
    db.add_all([old, edited])
    db.commit()

    migrated = get_or_create_session_canvas(db, "old-default", "owner")
    assert migrated.content == ""
    assert migrated.title == "未命名画布"
    assert migrated.version == 2
    revisions = db.query(CanvasRevision).filter(CanvasRevision.canvas_id == old.id).order_by(CanvasRevision.version).all()
    assert [revision.content_after for revision in revisions] == ["# 协同画布\n", ""]
    assert get_or_create_session_canvas(db, "edited-default", "owner").content == "# 协同画布\n\n用户正文"


def test_blank_canvas_does_not_inject_title_on_agent_replace(db) -> None:
    doc = get_or_create_session_canvas(db, "blank-replace", "owner")
    assert doc.content == ""
    assert doc.title == "未命名画布"
    assert replace_all(doc.content, "新正文", default_title=doc.title) == "新正文\n"
    assert replace_all(doc.content, "", default_title=doc.title) == ""


def test_legacy_snapshot_cannot_be_claimed_by_another_owner(db) -> None:
    db.add(Invocation(
        id="inv-owned", session_id="session-owned", owner_id="demo-owner",
        query="写摘要", status="completed",
        result_data={"canvas": {"title": "私有文稿", "content": "# 私有文稿", "version": 1}},
    ))
    db.commit()

    with pytest.raises(CanvasError, match="无权访问"):
        get_or_create_session_canvas(db, "session-owned", "demo-other")
    assert db.get(CanvasDoc, canvas_id_for("session-owned")) is None
    assert get_or_create_session_canvas(db, "session-owned", "demo-owner").owner_id == "demo-owner"


def test_delete_section_cleans_duplicate_headings_completely() -> None:
    doc_content = (
        "# 协同文档\n\n"
        "导言段落。\n\n"
        "## 示例文本·树木如何感知四季\n"
        "这是 v2 初版正文。\n\n"
        "## 示例文本·树木如何感知四季\n"
        "这是 v3 专家修订版正文。\n\n"
        "## 核心结论\n"
        "四季感知机制完备。\n"
    )

    # 1. 彻底删除 duplicate 章节
    cleaned = delete_section(doc_content, "示例文本·树木如何感知四季")
    assert "示例文本·树木如何感知四季" not in cleaned
    assert "v2 初版正文" not in cleaned
    assert "v3 专家修订版正文" not in cleaned
    assert "# 协同文档" in cleaned
    assert "导言段落。" in cleaned
    assert "## 核心结论\n四季感知机制完备。" in cleaned

    # 2. 尝试删除不存在的章节抛出明确错误
    with pytest.raises(CanvasError, match="不存在匹配"):
        delete_section(cleaned, "不存在的章节")


def test_write_section_deduplicates_duplicate_headings() -> None:
    doc_content = (
        "# 协同文档\n\n"
        "## 示例文本·树木如何感知四季\n"
        "初版内容\n\n"
        "## 示例文本·树木如何感知四季\n"
        "重复孤儿内容\n\n"
        "## 附录\n"
        "参考资料\n"
    )

    # 写入新内容时，首个替换，同名重复项彻底清除
    updated = write_section(doc_content, "示例文本·树木如何感知四季", "最终整合版内容")
    assert updated.count("示例文本·树木如何感知四季") == 1
    assert "最终整合版内容" in updated
    assert "初版内容" not in updated
    assert "重复孤儿内容" not in updated
    assert "## 附录\n参考资料" in updated


def test_write_section_auto_deletes_when_given_placeholder_or_empty() -> None:
    doc_content = (
        "# 协同文档\n\n"
        "## 示例文本·树木如何感知四季\n"
        "初版内容\n\n"
        "## 附录\n"
        "参考资料\n"
    )

    # 模拟智能体试图通过「（已清空）」或空字符串假装删除
    cleared_1 = write_section(doc_content, "示例文本·树木如何感知四季", "（已清空）")
    assert "示例文本·树木如何感知四季" not in cleared_1
    assert "（已清空）" not in cleared_1
    assert "## 附录" in cleared_1

    cleared_2 = write_section(doc_content, "示例文本·树木如何感知四季", "   ")
    assert "示例文本·树木如何感知四季" not in cleared_2
    assert "## 附录" in cleared_2


def test_replace_all_and_clear_operation(db) -> None:
    doc = get_or_create_session_canvas(db, "session-replace-test")
    apply_op(
        db, doc,
        editor_id="user", editor_name="用户",
        op="write_section", section="第一章", content="旧内容",
    )
    assert "## 第一章" in doc.content

    # 1. replace_all 全篇重写
    res1 = apply_op(
        db, doc,
        editor_id="leader", editor_name="主智能体",
        op="replace_all", content="# 全新方案\n\n## 架构设计\n全新架构",
    )
    assert res1["version"] == 3
    assert doc.title == "全新方案"
    assert "旧内容" not in doc.content
    assert "## 架构设计\n全新架构" in doc.content

    # 2. replace_all 传空字符串清空正文保留大标题
    res2 = apply_op(
        db, doc,
        editor_id="leader", editor_name="主智能体",
        op="replace_all", content="",
    )
    assert res2["version"] == 4
    assert doc.content == "# 全新方案\n"
    assert "## 架构设计" not in doc.content

    # 3. delete_section apply_op
    apply_op(
        db, doc,
        editor_id="leader", editor_name="主智能体",
        op="write_section", section="临时章节", content="待删除",
    )
    assert "## 临时章节" in doc.content
    res3 = apply_op(
        db, doc,
        editor_id="leader", editor_name="主智能体",
        op="delete_section", section="临时章节",
    )
    assert "临时章节" not in doc.content
    assert res3["summary"] == "删除段落：「临时章节」"


def test_parse_canvas_ops_protocol_support() -> None:
    text = (
        "我已分析完毕，以下是我的修改：\n"
        "```json\n"
        '{"name": "canvas_delete_section", "parameters": {"section": "过时章节", "base_version": 5}}\n'
        "```\n"
        "并且重置整体文档：\n"
        "```json\n"
        '{"name": "canvas_replace_all", "parameters": {"content": "# 新标题\\n\\n全新内容", "base_version": 6}}\n'
        "```\n"
    )
    ops = parse_canvas_ops(text)
    assert len(ops) == 2
    assert ops[0]["op"] == "delete_section"
    assert ops[0]["section"] == "过时章节"
    assert ops[0]["base_version"] == 5

    assert ops[1]["op"] == "replace_all"
    assert ops[1]["content"] == "# 新标题\n\n全新内容"
    assert ops[1]["base_version"] == 6
