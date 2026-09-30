"""Validate an existing Resend key and install mail settings without echoing it.

The private input file must be owner-only. Account and quota feature flags are
deliberately left untouched. No key is accepted as a command-line argument.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import smtplib
import ssl
import stat
import tempfile
from email.message import EmailMessage
from pathlib import Path

MAIL_HOST = "smtp.resend.com"
MAIL_FROM = "AegisMesh <no-reply@notify.demmo.cc.cd>"
PUBLIC_ORIGIN = "https://demmo.cc.cd"


def install(env_file: Path, secret: str) -> Path:
    target = env_file.resolve(strict=True)
    if not target.is_file():
        raise ValueError("Environment target must be an existing regular file")
    original = target.read_text()
    values = {
        "ACCOUNT_SMTP_HOST": MAIL_HOST,
        "ACCOUNT_SMTP_PORT": "465",
        "ACCOUNT_SMTP_USERNAME": "resend",
        "ACCOUNT_SMTP_PASSWORD": secret,
        "ACCOUNT_MAIL_FROM": MAIL_FROM,
        "ACCOUNT_PUBLIC_ORIGIN": PUBLIC_ORIGIN,
    }
    pattern = re.compile(r"^(?:export\s+)?(" + "|".join(values) + r")\s*=")
    lines = [line for line in original.splitlines() if not pattern.match(line)]
    lines += [f"{key}={json.dumps(value)}" for key, value in values.items()]
    backup_fd, backup_name = tempfile.mkstemp(prefix=".env.before-resend-", dir=target.parent)
    with os.fdopen(backup_fd, "w") as backup:
        backup.write(original)
    fd, staged_name = tempfile.mkstemp(prefix=".env.resend-", dir=target.parent)
    try:
        with os.fdopen(fd, "w") as staged:
            staged.write("\n".join(lines) + "\n")
            staged.flush()
            os.fsync(staged.fileno())
        os.replace(staged_name, target)
    finally:
        Path(staged_name).unlink(missing_ok=True)
    return Path(backup_name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secret-file", type=Path, required=True)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--test-recipient", help="Send one configuration test email after SMTP authentication")
    args = parser.parse_args()
    try:
        info = args.secret_file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("Secret input must be a private regular file (0600)")
        secret = args.secret_file.read_text().strip()
        if not re.fullmatch(r"re_[A-Za-z0-9_-]{20,200}", secret):
            raise ValueError("Invalid secret format")
        if args.test_recipient and not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", args.test_recipient):
            raise ValueError("Invalid test recipient")
        with smtplib.SMTP_SSL(MAIL_HOST, 465, timeout=20, context=ssl.create_default_context()) as smtp:
            smtp.login("resend", secret)
            print("SMTP TLS and authentication: OK")
            if args.test_recipient:
                message = EmailMessage()
                message["From"], message["To"] = MAIL_FROM, args.test_recipient
                message["Subject"] = "AegisMesh 邮件通道测试"
                message.set_content("这是一封你授权的邮件配置测试。\n\nAegisMesh 已通过 Resend 建立加密发信连接。此邮件不包含密码、密钥或验证码，也不会创建账号或修改账号状态。")
                refused = smtp.send_message(message)
                if refused:
                    raise RuntimeError("SMTP recipient was refused")
                print("Test message: accepted by SMTP (inbox delivery not yet confirmed)")
        if args.env_file:
            backup = install(args.env_file, secret)
            print(f"Mail configuration saved; feature flags unchanged. Private backup: {backup}")
    except Exception as exc:
        # SMTP replies can include input. Report class/status, never raw text.
        code = getattr(exc, "smtp_code", None)
        print(f"Mail configuration not completed: {type(exc).__name__}" + (f" (SMTP {code})" if code else ""))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
