"""Read-only server-side verification; no login credential is created or exposed.

This checks owner-scoped restoration and source hashes, not a browser login flow.
Run from the production release with OWNER_ID and optional stage manifest path.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import urllib.request

from dotenv import load_dotenv
load_dotenv('public-aip.env', override=True)
from fastapi import HTTPException, Request
from app.main import app
from app.database import SessionLocal

owner = sys.argv[1]
started = time.monotonic()
request = Request({'type': 'http', 'method': 'GET', 'path': '/api/account/history', 'headers': []})
request.state.browser_owner_id = owner
routes = {route.path: route.endpoint for route in app.routes if route.path.startswith('/api/account/history')}
with SessionLocal() as db:
    page = routes['/api/account/history'](request=request, db=db, offset=0, limit=100)
    summaries = []
    for item in page['items']:
        restored = routes['/api/account/history/{session}'](item['session'], request, db)
        summaries.append({'session': item['session'], 'messages': len(restored['conversation']['messages']),
                          'results': sum(bool(message.get('result')) for message in restored['conversation']['messages'])})
    database = Path(db.get_bind().url.database).resolve()
with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
    counts = {table: db.execute(f'SELECT count(*) FROM "{table}" WHERE owner_id=?', (owner,)).fetchone()[0]
              for table in ('conversations', 'invocations')}
    preserved = {}
    for table in ('conversations', 'invocations'):
        rows = db.execute(f'SELECT * FROM "{table}" WHERE owner_id=? ORDER BY id', (owner,)).fetchall()
        preserved[table] = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    total_invocations = db.execute('SELECT count(*) FROM invocations').fetchone()[0]
    history_snapshots = db.execute('SELECT count(*) FROM conversation_histories WHERE owner_id=?', (owner,)).fetchone()[0]
with urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=10) as response:
    health = json.load(response)['status']
manifest = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 else None
if manifest:
    for name, hashes in manifest['sources'].items():
        if hashlib.sha256(Path(name).read_bytes()).hexdigest() != hashes['after']:
            raise SystemExit('Live source mismatch: ' + name)
    if hashlib.sha256(Path('/var/www/aegismesh/index.html').read_bytes()).hexdigest() != manifest['index_sha256']:
        raise SystemExit('Live frontend entry mismatch')
units = subprocess.check_output(['systemctl', 'list-units', '--type=service', '--state=active', '--plain', '--no-legend', 'aegismesh-aip-agent@*.service'], text=True)
result = {'health': health, 'owner_counts': counts, 'restored_conversations': summaries,
          'owner_row_hashes': preserved, 'total_invocations': total_invocations,
          'history_snapshots': history_snapshots, 'active_aip_listeners': len(units.strip().splitlines()),
          'live_source_hashes_verified': bool(manifest), 'restoration_check_seconds': round(time.monotonic() - started, 3),
          'verification_scope': 'server-side owner-scoped read; browser UI verified separately in isolated fixture'}
print(json.dumps(result))
