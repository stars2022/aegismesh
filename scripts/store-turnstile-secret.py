"""Install a new widget response from stdin into the approved ignored secret store."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

target = Path("var/private/account-runtime.env")
subprocess.run(["git", "check-ignore", "-q", str(target)], check=True)
result = json.load(sys.stdin)
assert result.get("status") == "ok"
assert re.fullmatch(r"\S{1,256}", result["sitekey"])
assert re.fullmatch(r"\S{1,1024}", result["secret"])
target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
target.parent.chmod(0o700)
values = {"TURNSTILE_ENABLED": "true", "TURNSTILE_HOSTNAMES": "demmo.cc.cd",
          "TURNSTILE_SITE_KEY": result["sitekey"], "TURNSTILE_SECRET": result["secret"]}
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    for key, value in values.items():
        stream.write(f"{key}={json.dumps(value)}\n")
    stream.flush()
    os.fsync(stream.fileno())
print(json.dumps({"sitekey": result["sitekey"], "saved": str(target.resolve()), "secret_displayed": False}))
