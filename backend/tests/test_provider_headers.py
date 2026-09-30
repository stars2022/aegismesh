import pytest

from app.services.transport import provider_request_headers


def test_opencode_session_header_is_stable_opaque_and_conversation_specific():
    first = provider_request_headers("https://opencode.ai/zen/go/v1", "test-key", "private-session")
    again = provider_request_headers("https://opencode.ai/zen/go/v1/", "test-key", "private-session")
    second = provider_request_headers("https://opencode.ai/zen/go/v1", "test-key", "other-session")
    assert first["x-opencode-session"] == again["x-opencode-session"]
    assert first["x-opencode-session"] != second["x-opencode-session"]
    assert "private-session" not in first["x-opencode-session"]
    assert first["Authorization"] == "Bearer test-key"


@pytest.mark.parametrize("url", ["https://api.deepseek.com", "http://opencode.ai/zen/go/v1",
    "https://opencode.ai.evil.test/zen/go/v1", "https://opencode.ai:444/zen/go/v1", "https://opencode.ai/other"])
def test_other_endpoints_do_not_receive_opencode_metadata(url):
    assert "x-opencode-session" not in provider_request_headers(url, "test-key", "s")
