from __future__ import annotations

import pytest

from app.models import CanvasDoc, CanvasRevision, Invocation
from app.services.canvas import (
    CanvasError, apply_op, canvas_id_for, get_or_create_session_canvas, replace_document,
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
    assert db.query(CanvasRevision).filter(CanvasRevision.canvas_id == saved.id).count() == 1

    with pytest.raises(CanvasError, match="版本"):
        replace_document(db, saved, content="过期稿", base_version=1, owner_id="demo-owner")
    with pytest.raises(CanvasError, match="无权访问"):
        get_or_create_session_canvas(db, "session-edit", "demo-other")
    assert db.get(CanvasDoc, saved.id).content == "# 新标题\n\n正文"


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
