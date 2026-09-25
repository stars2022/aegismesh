from __future__ import annotations

import hashlib
import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.models import Agent, Invocation, InvocationFeedback


def test_feedback_is_idempotent_and_can_be_changed() -> None:
    suffix = uuid.uuid4().hex[:8]
    agent_id = f"feedback-agent-{suffix}"
    invocation_id = f"feedback-invocation-{suffix}"
    api_key = "test-public-api-key-123456"
    owner_id = f"api_{hashlib.sha256(api_key.encode()).hexdigest()[:24]}"
    headers = {"X-API-Key": api_key}
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(
                Agent(
                    id=agent_id,
                    aic=f"local:{agent_id}",
                    name=agent_id,
                    role="partner",
                    health="online",
                )
            )
            db.add(
                Invocation(
                    id=invocation_id,
                    session_id=f"session-{suffix}",
                    owner_id=owner_id,
                    query="test",
                    status="completed",
                    selected_agent_id=agent_id,
                )
            )
            db.commit()

        first = client.post(
            f"/api/invocations/{invocation_id}/feedback",
            json={"rating": "positive"},
            headers=headers,
        )
        assert first.status_code == 200
        assert first.json()["positive_count"] == 1

        repeated = client.post(
            f"/api/invocations/{invocation_id}/feedback",
            json={"rating": "positive"},
            headers=headers,
        )
        assert repeated.status_code == 200
        assert repeated.json()["positive_count"] == 1

        changed = client.post(
            f"/api/invocations/{invocation_id}/feedback",
            json={"rating": "negative"},
            headers=headers,
        )
        assert changed.status_code == 200
        assert changed.json()["positive_count"] == 0
        assert changed.json()["negative_count"] == 1

    with SessionLocal() as db:
        feedback = db.get(InvocationFeedback, invocation_id)
        agent = db.get(Agent, agent_id)
        assert feedback is not None and feedback.rating == "negative"
        assert agent is not None
        assert agent.feedback_positive_count == 0
        assert agent.feedback_negative_count == 1
