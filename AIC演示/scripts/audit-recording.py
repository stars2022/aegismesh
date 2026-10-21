"""Audit native captures and create contact sheets; never repaint application frames."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw


def is_card(path):
    with Image.open(path) as image:
        # Native 1080p chapter page: fixed dark field and the light brand tile.
        background = [image.getpixel(point)[:3] for point in [(10, 10), (1900, 10), (10, 1060), (1900, 1060), (500, 250)]]
        tile = image.getpixel((75, 75))[:3]
        return all(max(abs(a - b) for a, b in zip(pixel, (12, 13, 15))) < 8 for pixel in background) and min(tile) > 180


def audit(root, output):
    output.mkdir(parents=True, exist_ok=True)
    chapters = []
    thumbs = []
    for manifest in sorted(root.glob('capture-*.json')):
        records = json.loads(manifest.read_text())
        chapter = records[0]['chapter']
        assert all(row.get('controls_isolated') and row['theme'] == 'dark' and row['state'] != 'error' for row in records)
        # Manifests are written only after captureRetake observes chapter-ready
        # or complete. A held last image can still carry its earlier frame state.
        # Check every native frame exists, is valid JPEG and has the right size.
        for row in records:
            with Image.open(root / row['file']) as image:
                assert image.size == (1920, 1080), (chapter, image.size)
                image.verify()
        opening = [(row, is_card(root / row['file'])) for row in records if row['time'] - records[0]['time'] < 9]
        first_card = next((row for row, card in opening if card), None)
        assert first_card, chapter
        card_end = next((row for row, card in opening if row['time'] > first_card['time'] and not card), None)
        assert card_end and card_end['time'] - first_card['time'] >= 5.7, chapter
        duration = records[-1]['time'] - records[0]['time']
        chapters.append({'chapter': chapter, 'frames': len(records), 'seconds': duration,
                         'controls_isolated': True, 'has_native_module_page': True,
                         'trim_before_file': first_card['file'], 'native_title_seconds': card_end['time'] - first_card['time']})
        # Every two seconds plus final frame, for whole-film visual QA.
        for second in list(range(0, int(duration), 2)) + [duration]:
            row = next((item for item in reversed(records) if item['time'] <= records[0]['time'] + second), records[0])
            with Image.open(root / row['file']) as image:
                thumb = image.copy()
                thumb.thumbnail((480, 270))
            thumbs.append((thumb, f'{chapter} +{second:.1f}s'))
    sheets = []
    for start in range(0, len(thumbs), 16):
        sheet = Image.new('RGB', (1920, 1184), '#333333')
        draw = ImageDraw.Draw(sheet)
        for index, (thumb, label) in enumerate(thumbs[start:start+16]):
            x, y = index % 4 * 480, index // 4 * 296
            sheet.paste(thumb, (x, y))
            draw.text((x + 8, y + 274), label, fill='white')
        path = output / f'全片检查-{start // 16 + 1:02}.jpg'
        sheet.save(path, quality=92)
        sheets.append(str(path))
    report = {'chapters': chapters, 'frames_verified': sum(row['frames'] for row in chapters),
              'visual_sampling_seconds': 2, 'contact_sheets': sheets}
    (output / '采集核验.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('frames', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    audit(args.frames.resolve(), args.output.resolve())
