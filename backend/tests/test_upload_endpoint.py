from __future__ import annotations

import io
from pathlib import Path
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app, get_uploads_dir
from app.models import Base
from app.research_catalog import RESEARCH_AGENT_CATALOG
from app.schemas import Attachment, ChatRequest
from app.services.orchestrator import ReliableOrchestrator


def test_research_catalog_contains_only_the_four_registered_agents():
    assert set(RESEARCH_AGENT_CATALOG) == {
        "research_leader",
        "docs_overview",
        "empirical_design",
        "peer_review",
    }
    leader = RESEARCH_AGENT_CATALOG["research_leader"]
    assert leader["role"] == "leader"
    assert "extract_file_content" in leader["tools"]
    assert "citation_tool" in leader["tools"]
    assert "text_similarity_check" in leader["tools"]


def test_upload_and_serve_text_file():
    with TestClient(app) as client:
        file_content = b"# Academic Research Notes\nThis is a test note about multi-agent coordination."
        files = {"file": ("test_research.md", io.BytesIO(file_content), "text/markdown")}
        response = client.post(
            "/api/upload",
            files=files,
            headers={"X-API-Key": "test-public-api-key-123456"},
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["ok"] is True
        assert data["filename"] == "test_research.md"
        assert data["is_image"] is False
        assert "Academic Research Notes" in (data.get("extracted_text") or "")
        assert data["text_length"] > 0
        url = data["url"]

        # Test downloading / serving
        serve_res = client.get(url)
        assert serve_res.status_code == 200
        assert serve_res.content == file_content


def test_upload_image_file():
    with TestClient(app) as client:
        # 1x1 transparent PNG bytes
        png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
        files = {"file": ("figure1.png", io.BytesIO(png_bytes), "image/png")}
        response = client.post(
            "/api/upload",
            files=files,
            headers={"X-API-Key": "test-public-api-key-123456"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True
        assert data["is_image"] is True
        assert data["extracted_text"] is None

        # Test serving
        serve_res = client.get(data["url"])
        assert serve_res.status_code == 200
        assert serve_res.content == png_bytes


def test_upload_path_traversal_prevention():
    with TestClient(app) as client:
        response = client.get("/api/uploads/../../etc/passwd")
        assert response.status_code in {400, 404}


def test_orchestrator_enrich_message_with_attachments():
    att1 = Attachment(
        file_id="123",
        filename="paper.pdf",
        content_type="application/pdf",
        size=1024,
        url="/api/uploads/123_paper.pdf",
        is_image=False,
        extracted_text="Abstract: We propose an academic multi-agent fleet.",
        text_length=50,
    )
    att2 = Attachment(
        file_id="456",
        filename="architecture.png",
        content_type="image/png",
        size=2048,
        url="/api/uploads/456_architecture.png",
        is_image=True,
    )

    enriched = ReliableOrchestrator._enrich_message_with_attachments(
        "请分析这篇论文", [att1, att2]
    )
    assert "请分析这篇论文" in enriched
    assert "=== [附带参考文件与学术资料] ===" in enriched
    assert "【上传研究文件/文档: paper.pdf】" in enriched
    assert "Abstract: We propose an academic multi-agent fleet." in enriched
    assert "【上传图片附件】: architecture.png" in enriched
