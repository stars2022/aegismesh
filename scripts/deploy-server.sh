#!/usr/bin/env bash
# New-host deployment only. Does not replace the historical deployment script.
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 -I -S "$project_dir/scripts/deploy_server.py" "$@"
