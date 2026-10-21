"""Check the encoded MP4's actual chapter holds and narration alignment."""
import argparse
import json
from pathlib import Path
import subprocess
from PIL import Image


def audit(video, metadata):
    info = json.loads(metadata.read_text())
    command = ['ffmpeg', '-v', 'error', '-i', str(video), '-vf', 'fps=10,scale=192:108', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    intervals, index, start = [], 0, None
    while data := process.stdout.read(192 * 108 * 3):
        if len(data) != 192 * 108 * 3:
            raise RuntimeError('Incomplete decoded video frame')
        image = Image.frombytes('RGB', (192, 108), data)
        background = [image.getpixel(point) for point in [(1, 1), (190, 1), (1, 106), (190, 106), (50, 25)]]
        tile = image.getpixel((7, 7))
        card = all(max(abs(a - b) for a, b in zip(pixel, (12, 13, 15))) < 12 for pixel in background) and min(tile) > 150
        if card and start is None:
            start = index / 10
        if not card and start is not None:
            if index / 10 - start > 1:
                intervals.append({'start': start, 'end': index / 10, 'seconds': index / 10 - start})
            start = None
        index += 1
    if process.wait() != 0:
        raise RuntimeError('Video decode failed')
    assert len(intervals) == len(info['chapters']) == 12, intervals
    for interval, chapter in zip(intervals, info['chapters']):
        assert interval['seconds'] >= 5.7, interval
        assert abs(interval['start'] - chapter['start']) < .25, (interval, chapter['start'])
        interval['module'] = chapter['module']
    result = {'video': video.name, 'duration': info['duration'], 'decoded_sample_frames': index,
              'module_pages': intervals, 'narration_alignment_max_error_seconds': max(abs(a['start'] - b['start']) for a, b in zip(intervals, info['chapters']))}
    output = video.with_name(video.stem + '-成片核验.json')
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('metadata', type=Path)
    args = parser.parse_args()
    audit(args.video, args.metadata)
