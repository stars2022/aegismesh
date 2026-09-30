from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
import ssl
from urllib.parse import parse_qs, urlsplit

import pytest

from app import account_api
from app.config import get_settings
from app.services.account_mail import build_account_mail


class MailHTML(HTMLParser):
    def __init__(self, value):
        super().__init__()
        self.links, self.images, self.tags, self.text = [], [], [], []
        self.feed(value)

    def handle_starttag(self, tag, attributes):
        self.tags.append(tag)
        attributes = dict(attributes)
        if tag == "a":
            self.links.append(attributes.get("href"))
        if tag == "img":
            self.images.append(attributes.get("src"))
        assert not any(name.startswith("on") for name in attributes)

    def handle_data(self, value):
        self.text.append(value)


def build(purpose="register", **kwargs):
    return build_account_mail(sender="AegisMesh <no-reply@example.test>", recipient="reader@example.test",
                              origin="https://demmo.cc.cd", purpose=purpose,
                              token=kwargs.pop("token", "test-only-not-a-real-challenge"), **kwargs)


@pytest.mark.parametrize("purpose,subject,label", [
    ("register", "AegisMesh 邮箱验证", "验证邮箱"),
    ("reset", "AegisMesh 密码重置", "重置密码"),
])
def test_html_button_and_plain_text_keep_the_same_single_use_link(purpose, subject, label):
    message = BytesParser(policy=policy.default).parsebytes(build(purpose).as_bytes())
    assert message.get_content_type() == "multipart/alternative"
    assert message["Subject"] == subject
    assert message["Date"] and message["Message-ID"]
    plain = message.get_body(preferencelist=("plain",)).get_content()
    html = MailHTML(message.get_body(preferencelist=("html",)).get_content())
    assert label in "".join(html.text)
    assert "test-only-not-a-real-challenge" not in "".join(html.text)
    assert len(html.links) == 2 and html.links[0] == html.links[1]
    link = urlsplit(html.links[0])
    assert link.hostname == "demmo.cc.cd" and link.path == "/login"
    assert parse_qs(link.query) == {"account_action": [purpose]}
    assert parse_qs(link.fragment) == {"token": ["test-only-not-a-real-challenge"]}
    assert html.links[0] in plain
    assert "15 分钟" in plain and "浏览器" in plain
    assert "15 分钟" in "".join(html.text) and "浏览器" in "".join(html.text)


def test_logo_is_inline_and_no_scripts_or_remote_tracking_resources_are_added():
    message = build()
    html = MailHTML(message.get_body(preferencelist=("html",)).get_content())
    assert html.images == ["cid:brand@aegismesh"]
    assert not {"script", "iframe", "form", "link", "svg"}.intersection(html.tags)
    image = next(part for part in message.walk() if part.get_content_type() == "image/png")
    assert image["Content-ID"] == "<brand@aegismesh>"
    assert image.get_content_disposition() == "inline"
    assert image.get_payload(decode=True).startswith(b"\x89PNG\r\n\x1a\n")
    assert len(image.get_payload(decode=True)) < 16384


def test_token_is_encoded_and_cannot_inject_visible_html_or_attributes():
    token = '\"><img src=x onerror=alert(1)>&? #'
    message = build(token=token)
    html = MailHTML(message.get_body(preferencelist=("html",)).get_content())
    assert html.images == ["cid:brand@aegismesh"]
    assert token not in "".join(html.text)
    assert parse_qs(urlsplit(html.links[0]).fragment) == {"token": [token]}


def test_preview_has_no_authentication_challenge():
    message = build(preview=True)
    html = MailHTML(message.get_body(preferencelist=("html",)).get_content())
    assert all(link == "https://demmo.cc.cd/login" for link in html.links)
    assert "样式预览" in message["Subject"]
    assert "不会创建账号或修改密码" in "".join(html.text)
    assert "test-only-not-a-real-challenge" not in message.as_string()


def test_unknown_purpose_is_not_silently_rendered_as_a_password_reset():
    with pytest.raises(ValueError):
        build("unrecognized")


def test_existing_delivery_boundary_sends_the_multipart_email_without_logging_token(monkeypatch, capsys):
    cfg = get_settings()
    for key, value in dict(account_mail_from="AegisMesh <no-reply@example.test>", account_public_origin="https://demmo.cc.cd",
                           account_smtp_host="smtp.example.test", account_smtp_port=465,
                           account_smtp_username="resend", account_smtp_password="test-private-password").items():
        monkeypatch.setattr(cfg, key, value)
    monkeypatch.setattr(account_api, "mail_ready", lambda: True)
    messages = []

    class SMTP:
        def __init__(self, host, port, *, timeout, context):
            assert host == "smtp.example.test" and port == 465
            assert timeout == 15 and context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def login(self, username, password):
            assert (username, password) == ("resend", "test-private-password")

        def send_message(self, message):
            messages.append(message)

    monkeypatch.setattr(account_api.smtplib, "SMTP_SSL", SMTP)
    account_api.send_mail("reader@example.test", "register", "private-mail-proof")
    assert len(messages) == 1 and messages[0].get_body(preferencelist=("html",))
    output = capsys.readouterr()
    assert not output.out and not output.err
