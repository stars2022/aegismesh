"""Prepare an ignored private release environment from the verified backup."""
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

target = Path("var/private/accounts-release.env")
subprocess.run(["git", "check-ignore", "-q", str(target)], check=True)
with tarfile.open("var/production-backups/pre-accounts-20260930T064010Z.tar.gz") as archive:
    original = archive.extractfile("release/.env").read().decode()
values = {"ACCOUNTS_ENABLED": "true", "ACCOUNT_EMAIL_ENABLED": "true",
          "ACCOUNT_OWNER_EMAIL": "2046738782@qq.com", "ACCOUNT_PUBLIC_ORIGIN": "https://demmo.cc.cd",
          "ACCOUNT_OAUTH": "{}", "QUOTA_MODE": "enforce", "QUOTA_GUEST_TURNS": "3",
          "QUOTA_DAILY_TASKS": "20", "QUOTA_CONCURRENT_TASKS": "2",
          "QUOTA_MEMBER_MONTHLY_UNITS": "1600000", "QUOTA_PUBLIC_MONTHLY_UNITS": "160000000",
          "QUOTA_MODEL_OUTPUT_TOKENS": "4096", "ADMIN_COOKIE_SECURE": "true"}
turnstile = Path("var/private/account-runtime.env").read_text()
keys = set(values) | {"TURNSTILE_ENABLED", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", "TURNSTILE_HOSTNAMES"}
pattern = re.compile(r"^(?:export\s+)?(" + "|".join(keys) + r")\s*=")
text = "\n".join(line for line in original.splitlines() if not pattern.match(line)) + "\n"
text += "\n".join(f"{key}={json.dumps(value)}" for key, value in values.items()) + "\n" + turnstile
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(text)
print(json.dumps({"saved": str(target.resolve()), "secret_displayed": False}))
