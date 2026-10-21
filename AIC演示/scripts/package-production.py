"""Package the exact production UI; only its HTML bootstrap is changed."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
FONT_CSS = 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600&display=swap'


def download_fonts():
    request = urllib.request.Request(FONT_CSS, headers={'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36'})
    with urllib.request.urlopen(request, timeout=45) as response:
        css = response.read().decode('utf-8')
    urls = sorted(set(re.findall(r'https://fonts\.gstatic\.com/[^)\s]+', css)))
    font_dir = ROOT / 'dist' / 'demo' / 'fonts'
    font_dir.mkdir(exist_ok=True)

    def get(url):
        name = hashlib.sha256(url.encode()).hexdigest()[:20] + '.woff2'
        target = font_dir / name
        if not target.exists():
            with urllib.request.urlopen(url, timeout=45) as response:
                data = response.read()
            if not data.startswith((b'wOF2', b'wOFF', b'\x00\x01\x00\x00')):
                raise ValueError('Unexpected font response')
            target.write_bytes(data)
        return url, '/demo/fonts/' + name

    for old, new in ThreadPoolExecutor(max_workers=10).map(get, urls):
        css = css.replace(old, new)
    (font_dir / 'fonts.css').write_text('/* Locally cached official Google Fonts CSS, unchanged font faces. */\n' + css)
    return len(urls)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('production_dist', type=Path)
    parser.add_argument('--source-commit', required=True, help='Exact frontend source commit used to build these assets')
    parser.add_argument('--download-fonts', action='store_true')
    args = parser.parse_args()
    source = args.production_dist.resolve()
    if not (source / 'index.html').is_file() or not (source / 'assets').is_dir():
        parser.error('Expected the actual production frontend/dist')
    target = ROOT / 'dist'
    if not re.fullmatch(r'[0-9a-f]{40}', args.source_commit):
        parser.error('--source-commit must be a full Git commit SHA')
    manifest = {'production_commit': args.source_commit, 'demo': True, 'assets': {}}
    for folder in ('assets', 'media'):
        for item in sorted((source / folder).rglob('*')):
            if not item.is_file():
                continue
            relative = item.relative_to(source).as_posix()
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, destination)
            manifest['assets'][relative] = hashlib.sha256(item.read_bytes()).hexdigest()
    original = (source / 'index.html').read_text()
    manifest['production_index_sha256'] = hashlib.sha256(original.encode()).hexdigest()
    html = re.sub(r'    <link rel="preconnect"[^\n]+\n', '', original)
    html = re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com/[^\n]+', '<link rel="stylesheet" href="/demo/fonts/fonts.css" />', html)
    html, count = re.subn(r'<script type="module" crossorigin src="(/assets/[^\"]+)"></script>',
                         r'<script type="module" src="/demo/bootstrap.mjs" data-production-entry="\1"></script>', html)
    if count != 1:
        raise ValueError('Expected one production entry module')
    (target / 'index.html').write_text(html)
    (target / 'demo' / 'production-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    fonts = download_fonts() if args.download_fonts else 0
    print(json.dumps({'identical_production_assets': len(manifest['assets']), 'local_font_files': fonts, 'production_commit': manifest['production_commit']}))


if __name__ == '__main__':
    main()
