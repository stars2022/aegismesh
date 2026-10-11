"""Private conversation history; session IDs and administrator roles confer no access."""
from __future__ import annotations

import json
import re
from datetime import timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import case, exists, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from .account_models import Conversation, ConversationHistory
from .database import get_db
from .models import Agent, GroupChat, Invocation, utcnow
from .services.identity import ConversationOwnershipError, bind_conversation, require_same_origin


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    text: str = Field(max_length=1_000_000)
    historyId: str | None = Field(default=None, max_length=128)
    result: dict | None = None
    attachments: list[dict] | None = Field(default=None, max_length=30)
    feedback: Literal["positive", "negative"] | None = None
    senderAgentId: str | None = Field(default=None, max_length=128)
    senderName: str | None = Field(default=None, max_length=120)
    isHost: bool | None = None
    createdAt: int | None = Field(default=None, ge=0)
    recoveryInvocationId: str | None = Field(default=None, max_length=128)
    # Running task handles are device-local, not credentials to resume on another device.
    streaming: bool | None = None
    taskId: str | None = Field(default=None, max_length=128)


class HistoryDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    session: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    title: str = Field(min_length=1, max_length=160)
    agentId: str | None = Field(default=None, max_length=128)
    messages: list[HistoryMessage] = Field(max_length=2000)
    queue: list[dict] | None = Field(default=None, max_length=100)
    isGroup: bool | None = None
    groupConfig: dict | None = None
    isCanvas: bool | None = None


def _millis(value):
    return int(value.replace(tzinfo=timezone.utc).timestamp() * 1000) if value else 0


def _owner(request: Request) -> str:
    owner = getattr(request.state, "browser_owner_id", "")
    if not owner:
        raise HTTPException(401, "身份尚未初始化，请刷新页面")
    if request.headers.get("X-Conversation-Owner", owner) != owner:
        raise HTTPException(401, "账号已切换，请刷新页面")
    return owner


def _owned(db, session, owner):
    mapping = db.get(Conversation, session)
    if mapping and mapping.owner_id == owner:
        return
    if not mapping:
        owners = set(db.scalars(select(Invocation.owner_id).where(Invocation.session_id == session)))
        if owners == {owner}:
            return
    raise HTTPException(404, "会话不存在或无权访问")


def conversation_router(require_demo, chat_response):
    def private_response(response: Response):
        response.headers["Cache-Control"] = "no-store"
    router = APIRouter(prefix="/api/account/history", tags=["history"], dependencies=[Depends(require_demo), Depends(private_response)])

    @router.get("")
    def index(request: Request, db: Session = Depends(get_db),
              offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=100)):
        owner = _owner(request)
        # Aggregate only this principal's calls, never load large result_data for the sidebar.
        calls = select(Invocation.session_id.label("session"), func.max(Invocation.created_at).label("latest"),
                       func.count().label("count")).where(Invocation.owner_id == owner).group_by(Invocation.session_id).subquery()
        foreign = aliased(Invocation)
        sessions = select(Conversation.id.label("id"), Conversation.created_at.label("created")).where(Conversation.owner_id == owner).union_all(
            select(Invocation.session_id, func.min(Invocation.created_at)).where(Invocation.owner_id == owner,
                ~exists(select(Conversation.id).where(Conversation.id == Invocation.session_id)),
                ~exists(select(foreign.id).where(foreign.session_id == Invocation.session_id, foreign.owner_id != owner))
                ).group_by(Invocation.session_id)).subquery()
        first_query = select(func.substr(Invocation.query, 1, 80)).where(
            Invocation.session_id == sessions.c.id, Invocation.owner_id == owner).order_by(Invocation.created_at, Invocation.id).limit(1).scalar_subquery()
        updated = case((calls.c.latest > ConversationHistory.updated_at, calls.c.latest),
                       else_=func.coalesce(ConversationHistory.updated_at, calls.c.latest, sessions.c.created))
        query = select(sessions.c.id, calls.c.count, first_query, ConversationHistory.payload,
                       ConversationHistory.revision, ConversationHistory.deleted_at,
                       updated.label("updated"))\
            .select_from(sessions).outerjoin(calls, calls.c.session == sessions.c.id)\
            .outerjoin(ConversationHistory, (ConversationHistory.id == sessions.c.id) & (ConversationHistory.owner_id == owner))
        rows = db.execute(query.order_by(updated.desc(), sessions.c.id)
                          .offset(offset).limit(limit + 1)).all()
        items = []
        for session, count, title, payload, revision, deleted, updated_at in rows[:limit]:
            payload = payload or {}
            items.append({"id": payload.get("id", session), "session": session,
                          "title": payload.get("title") or title or "会话",
                          "agentId": payload.get("agentId"), "messageCount": max(len(payload.get("messages", [])), (count or 0) * 2),
                          "isCanvas": payload.get("isCanvas", False), "isGroup": payload.get("isGroup", False),
                          "groupMemberCount": len((payload.get("groupConfig") or {}).get("members", [])),
                          "updatedAt": _millis(updated_at), "revision": revision or 0, "deleted": bool(deleted)})
        return {"items": items, "next_offset": offset + limit if len(rows) > limit else None}

    @router.get("/{session}")
    def read(session: str, request: Request, db: Session = Depends(get_db)):
        owner = _owner(request)
        _owned(db, session, owner)
        row = db.get(ConversationHistory, session)
        if row and row.deleted_at:
            raise HTTPException(410, "会话已删除，可在数据管理中恢复")
        document = json.loads(json.dumps(row.payload)) if row and row.payload else {"id": session, "session": session, "title": "会话", "messages": []}
        invocations = list(db.scalars(select(Invocation).where(Invocation.session_id == session, Invocation.owner_id == owner)
                                     .order_by(Invocation.created_at, Invocation.id)))
        by_id = {inv.id: inv for inv in invocations}
        messages = document["messages"]
        represented = set()
        for message in messages:
            ref = (message.get("result") or {}).get("invocation_id") or message.get("recoveryInvocationId")
            if ref in by_id:
                inv = by_id[ref]
                represented.add(ref)
                result = chat_response(inv, [], db.get(Agent, inv.selected_agent_id) if inv.selected_agent_id else None, db).model_dump(mode="json")
                message["result"] = result
                if inv.result_text:
                    message["text"] = inv.result_text
            message.pop("taskId", None)
            message.pop("streaming", None)
        for inv in invocations:
            if inv.id in represented:
                continue
            # A browser may have saved the user turn immediately before starting a call.
            pending = messages[-1] if messages else None
            if not pending or pending.get("role") != "user" or pending.get("text") != inv.query:
                messages.append({"role": "user", "text": inv.query, "historyId": "user-" + inv.id, "createdAt": _millis(inv.created_at)})
            result = chat_response(inv, [], db.get(Agent, inv.selected_agent_id) if inv.selected_agent_id else None, db).model_dump(mode="json")
            messages.append({"role": "assistant", "text": inv.result_text or ("任务未完成" if inv.status in {"failed", "cancelled"} else "任务处理中"),
                             "result": result, "historyId": "assistant-" + inv.id, "createdAt": _millis(inv.finished_at or inv.created_at)})
        if (not row or not row.payload) and invocations:
            document["title"] = invocations[0].query[:80] or "会话"
            document["agentId"] = invocations[-1].selected_agent_id
        return {"conversation": document, "revision": row.revision if row else 0}

    @router.put("/{session}")
    async def save(session: str, request: Request, db: Session = Depends(get_db)):
        require_same_origin(request)
        owner = _owner(request)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 2 * 1024 * 1024:
                raise HTTPException(413, "会话超过云端保存大小上限，本地原件仍保留")
        try:
            body = json.loads(raw)
            revision = body["revision"]
            if type(revision) is not int or revision < 0:
                raise ValueError()
            document = HistoryDocument.model_validate(body["conversation"]).model_dump(exclude_none=True)
        except (KeyError, ValueError, TypeError, ValidationError):
            raise HTTPException(422, "会话数据格式不正确") from None
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", session) or document["session"] != session:
            raise HTTPException(422, "会话标识不一致")
        group = document.get("groupConfig") or {}
        if group.get("backendId"):
            backend = db.get(GroupChat, group["backendId"])
            if not backend or backend.owner_id != owner:
                raise HTTPException(404, "群聊不存在或无权访问")
        for message in document["messages"]:
            ref = (message.get("result") or {}).get("invocation_id") or message.get("recoveryInvocationId")
            if ref:
                inv = db.get(Invocation, ref)
                if not inv or inv.owner_id != owner or inv.session_id != session:
                    raise HTTPException(404, "任务不存在或无权访问")
                message["result"] = {"invocation_id": ref}
            else:
                message.pop("result", None)
            message.pop("streaming", None)
            message.pop("taskId", None)
        try:
            bind_conversation(db, session, owner)
        except ConversationOwnershipError:
            raise HTTPException(404, "会话不存在或无权访问") from None
        row = db.get(ConversationHistory, session)
        if row and row.deleted_at:
            raise HTTPException(410, "会话已删除，可在数据管理中恢复")
        now = utcnow()
        if row:
            changed = db.execute(update(ConversationHistory).where(ConversationHistory.id == session,
                ConversationHistory.owner_id == owner, ConversationHistory.revision == revision,
                ConversationHistory.deleted_at.is_(None)).values(payload=document, revision=revision + 1, updated_at=now)).rowcount
            if not changed:
                db.rollback()
                raise HTTPException(409, "会话已在其他页面更新，请合并后重试")
        else:
            if revision != 0:
                raise HTTPException(409, "会话版本已变化，请重新加载")
            db.add(ConversationHistory(id=session, owner_id=owner, payload=document, revision=1, updated_at=now))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "会话已在其他页面更新，请合并后重试") from None
        return {"revision": revision + 1}

    @router.delete("/{session}")
    def delete(session: str, request: Request, revision: int = Query(ge=0), db: Session = Depends(get_db)):
        require_same_origin(request)
        owner = _owner(request)
        _owned(db, session, owner)
        row = db.get(ConversationHistory, session)
        if not row:
            if revision != 0:
                raise HTTPException(409, "会话版本已变化")
            db.add(ConversationHistory(id=session, owner_id=owner, payload={}, revision=1, deleted_at=utcnow()))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                raise HTTPException(409, "会话版本已变化") from None
        elif not db.execute(update(ConversationHistory).where(ConversationHistory.id == session,
                ConversationHistory.owner_id == owner, ConversationHistory.revision == revision)
                .values(deleted_at=utcnow(), revision=revision + 1)).rowcount:
            db.rollback()
            raise HTTPException(409, "会话版本已变化")
        else:
            db.commit()
        return {"deleted": True}

    @router.post("/{session}/restore")
    def restore(session: str, request: Request, revision: int = Query(ge=1), db: Session = Depends(get_db)):
        require_same_origin(request)
        owner = _owner(request)
        _owned(db, session, owner)
        changed = db.execute(update(ConversationHistory).where(ConversationHistory.id == session,
            ConversationHistory.owner_id == owner, ConversationHistory.revision == revision,
            ConversationHistory.deleted_at.is_not(None)).values(deleted_at=None, revision=revision + 1, updated_at=utcnow())).rowcount
        if not changed:
            db.rollback()
            raise HTTPException(409, "会话版本已变化")
        db.commit()
        return {"revision": revision + 1}

    return router
