"""Add Azure narration to the recorded film without changing its video stream.

Credentials are requested with getpass, used only in request headers, and never
persisted. REST reference: https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech
"""
import argparse
import array
import getpass
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from xml.sax.saxutils import escape

RATE = 24000
MAX_SPEED = 1.18
TEXT_OVERRIDES = {
    'discovery': '查看能力与接口信息，将执行者接入协作网络。',
    'structured': '按需配置结构化能力，结果按约定字段展示，并支持复制或下载。',
}
SPLIT_BODIES = {
    'create': [
        ('在智能体管理中选择 AI 生成，描述需求后检查身份、能力和运行配置。', 7.6, 20.5),
        ('保存草稿，提交注册，再同步审核结果和证书状态，完成接入准备。', 22., 32.6),
    ],
    'research-detail': [
        ('协调者将科研需求拆为文献检索与独立复核。', 67., 74.8),
        ('展开协作详情，可以查看派发来源、调用链、工具参数和执行者回传，再由协调者汇总结果。', 75.5, 89.2),
    ],
    'bounty-detail': [
        ('任务板展示认领者、验收条件和交付证据。', 136.8, 145.5),
        ('协调者检查各项成果并复核，形成从任务发布、认领、提交到验收的可追踪流程。', 146., 158.4),
    ],
    'canvas-review': [
        ('第一轮生成研究方案，用户检查并接受改动。', 183., 194.3),
        ('第二轮补充验收与复核表，再次审查修订。', 196.5, 204.),
        ('交付物不止停留在聊天里，而是持续完善同一份文档。', 207., 215.6),
    ],
    'human': [
        ('用户以自然语言提出需求，由麦溪呈现咨询答复与播报入口。', 266.3, 277.2),
        ('至此，完成了创建、注册、发现、互联访问和多种协同方式的全流程展示。', 279., 288.7),
    ],
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_azure(region, key, resource, body=None):
    # Never accept arbitrary credential destinations from input metadata.
    if not re.fullmatch(r'[a-z]+[a-z0-9]*', region):
        raise ValueError('Invalid Azure region')
    if resource not in ('voices/list', 'v1'):
        raise ValueError('Invalid Speech resource')
    headers = {'Ocp-Apim-Subscription-Key': key, 'User-Agent': 'AegisMesh-Narration'}
    if body is not None:
        headers.update({'Content-Type': 'application/ssml+xml',
                        'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm'})
    req = urllib.request.Request(
        f'https://{region}.tts.speech.microsoft.com/cognitiveservices/{resource}',
        data=body, headers=headers)
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(3):
        try:
            with opener.open(req, timeout=90) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 2:
                wait = exc.headers.get('Retry-After', '5')
                time.sleep(min(30, max(2, int(wait))) if wait.isdigit() else 5)
                continue
            # No response bodies, request headers, or credentials in diagnostics.
            raise RuntimeError(f'Azure Speech HTTP {exc.code}; stopped') from None
        except urllib.error.URLError:
            raise RuntimeError('Azure Speech network/TLS failure; stopped') from None
    raise RuntimeError('Azure Speech retries exhausted')


def make_ssml(text, voice):
    if not re.fullmatch(r'zh-CN-[A-Za-z]+Neural', voice):
        raise ValueError('Expected a Mandarin neural voice')
    return (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xml:lang="zh-CN"><voice name="{escape(voice)}">'
            f'<prosody rate="+3%">{escape(text)}</prosody></voice></speak>').encode()


def read_pcm(path):
    with wave.open(str(path), 'rb') as handle:
        if (handle.getnchannels(), handle.getsampwidth(), handle.getframerate()) != (1, 2, RATE):
            raise ValueError('Unexpected PCM format')
        data = array.array('h', handle.readframes(handle.getnframes()))
    if sys.byteorder != 'little':
        data.byteswap()
    return data


def write_pcm(path, data):
    output = array.array('h', data)
    if sys.byteorder != 'little':
        output.byteswap()
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(output.tobytes())


def trim_silence(data):
    # Retain 70 ms on both sides of the actual speech envelope.
    frame = RATE // 100
    active = [i for i in range(0, len(data), frame)
              if data[i:i + frame] and max(abs(n) for n in data[i:i + frame]) > 180]
    if not active:
        raise ValueError('Synthesized audio is silent')
    pad = round(RATE * .07)
    return data[max(0, active[0] - pad):min(len(data), active[-1] + frame + pad)]


def build_segments(metadata, audit):
    cards = audit['module_pages']
    chapters = metadata['chapters']
    if len(cards) != len(chapters) or len(cards) != 12:
        raise ValueError('Expected the verified 12-chapter film')
    segments = []
    for index, (chapter, card) in enumerate(zip(chapters, cards)):
        if chapter['module'] != card['module']:
            raise ValueError('Module mismatch between metadata and audit')
        end = cards[index + 1]['start'] if index + 1 < len(cards) else audit['duration']
        parts = [('intro', chapter['intro'], card['start'] + .4, card['end'] - .35)]
        text = TEXT_OVERRIDES.get(chapter['key'], chapter['narration'])
        if chapter['key'] in SPLIT_BODIES:
            # Align registration, inspection and editing sentences to their actions.
            parts.extend((f'body-{i + 1}', body, begin, finish)
                         for i, (body, begin, finish) in enumerate(SPLIT_BODIES[chapter['key']]))
        else:
            parts.append(('body', text, card['end'] + .3, end - .4))
        for part, text, start, finish in parts:
            if not (0 <= start < finish <= audit['duration']):
                raise ValueError('Invalid narration slot')
            if part != 'intro' and not (card['end'] <= start < finish <= end):
                raise ValueError('Operation narration exceeds its chapter')
            segments.append({'id': f"{chapter['key']}-{part}", 'module': chapter['module'],
                             'text': text, 'start': start, 'slot_end': finish})
    for a, b in zip(segments, segments[1:]):
        if a['slot_end'] > b['start']:
            raise ValueError('Overlapping narration slots')
    return segments


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def probe(path):
    return json.loads(run('ffprobe', '-v', 'quiet', '-show_format', '-show_streams',
                          '-of', 'json', str(path)).stdout)


def stream_hash(path):
    return run('ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0',
               '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-').stdout.strip()


def timecode(seconds):
    ms = round(seconds * 1000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02}:{m:02}:{s:02},{ms:03}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region', default='eastus')
    parser.add_argument('--voice', default='zh-CN-YunyangNeural')
    parser.add_argument('--speech-tempo', type=float, default=.9,
                        help='Pitch-preserving pace adjustment; default is a measured explanatory pace')
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not .85 <= args.speech_tempo <= 1.1:
        raise ValueError('Speech tempo outside conservative range')
    if args.output.exists():
        raise ValueError('Output already exists; choose a new filename')
    metadata = json.loads(args.metadata.read_text())
    audit = json.loads(args.audit.read_text())
    segments = build_segments(metadata, audit)
    original_probe = probe(args.source)
    if abs(float(original_probe['format']['duration']) - audit['duration']) > .05:
        raise ValueError('Source does not match audited film')
    root = args.output.parent / (args.output.stem + '-音轨')
    root.mkdir(parents=True, exist_ok=True)
    key = getpass.getpass('Azure Speech key (hidden; memory only): ')
    if not key.strip():
        raise ValueError('No credential supplied')
    voices = json.loads(request_azure(args.region, key, 'voices/list'))
    voice = next((v for v in voices if v.get('ShortName') == args.voice), None)
    if not voice or voice.get('Locale') != 'zh-CN':
        raise ValueError('Requested Mandarin voice is not available')
    print(json.dumps({'voice': voice['ShortName'], 'gender': voice['Gender'],
                      'locale': voice['Locale'], 'segments': len(segments)}, ensure_ascii=False), flush=True)
    timeline = array.array('h', [0]) * math.ceil(audit['duration'] * RATE)
    for index, segment in enumerate(segments):
        ssml = make_ssml(segment['text'], args.voice)
        digest = hashlib.sha256(ssml).hexdigest()[:16]
        raw = root / f"{segment['id']}-{digest}.wav"
        if not raw.exists():
            blob = request_azure(args.region, key, 'v1', ssml)
            # Validate before accepting a cached response.
            if blob[:4] != b'RIFF' or blob[8:12] != b'WAVE':
                raise ValueError('Azure returned a non-WAV response')
            raw.write_bytes(blob)
        pcm = trim_silence(read_pcm(raw))
        available = segment['slot_end'] - segment['start']
        speed = max(args.speech_tempo, len(pcm) / RATE / available)
        if speed > MAX_SPEED:
            raise ValueError(f"{segment['id']} needs {speed:.3f}x; shorten narration instead")
        trimmed = root / f"{segment['id']}-trim.wav"
        write_pcm(trimmed, pcm)
        if abs(speed - 1) > .001:
            fitted = root / f"{segment['id']}-fit.wav"
            run('ffmpeg', '-v', 'error', '-y', '-i', str(trimmed), '-af',
                f'atempo={speed + .002:.6f}', '-ar', str(RATE), '-ac', '1', str(fitted))
            pcm = read_pcm(fitted)
        if len(pcm) > round(available * RATE):
            raise ValueError(f"{segment['id']} exceeds its slot; refusing to truncate speech")
        position = round(segment['start'] * RATE)
        timeline[position:position + len(pcm)] = pcm
        segment.update({'end': segment['start'] + len(pcm) / RATE,
                        'duration': len(pcm) / RATE, 'speed_adjustment': speed,
                        'cached_wav': raw.name})
        print(f"{index + 1}/{len(segments)} {segment['id']}: {len(pcm) / RATE:.2f}s, tempo {speed:.3f}", flush=True)
    del key
    mixed = root / 'aligned.wav'
    write_pcm(mixed, timeline)
    loudness = run('ffmpeg', '-hide_banner', '-i', str(mixed), '-af',
                   'loudnorm=I=-16:TP=-2.5:LRA=11:print_format=json', '-f', 'null', '-').stderr
    match = re.search(r'\{\s*"input_i".*?\}', loudness, re.S)
    if not match:
        raise ValueError('Loudness measurement failed')
    measured = json.loads(match.group())
    normalization = ('loudnorm=I=-16:TP=-2.5:LRA=11:linear=true:'
                     f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
                     f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
                     f"offset={measured['target_offset']}")
    audio = args.output.with_suffix('.wav')
    run('ffmpeg', '-v', 'error', '-y', '-i', str(mixed), '-af', normalization,
        '-ar', '48000', '-ac', '1', str(audio))
    run('ffmpeg', '-v', 'error', '-y', '-i', str(args.source), '-i', str(audio),
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
        '-t', f"{audit['duration']:.6f}", '-movflags', '+faststart', str(args.output))
    run('ffmpeg', '-v', 'error', '-y', '-i', str(audio), '-c:a', 'libmp3lame',
        '-b:a', '160k', str(args.output.with_suffix('.mp3')))
    final_probe = probe(args.output)
    if stream_hash(args.source) != stream_hash(args.output):
        raise ValueError('Video stream changed unexpectedly')
    if not 180 <= float(final_probe['format']['duration']) <= 300:
        raise ValueError('Final duration outside submission limits')
    if int(final_probe['format']['size']) >= 300_000_000:
        raise ValueError('Final file exceeds submission size limit')
    run('ffmpeg', '-v', 'error', '-i', str(args.output), '-f', 'null', '-')
    final_loudness = run('ffmpeg', '-hide_banner', '-i', str(args.output), '-vn', '-af',
                         'loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json', '-f', 'null', '-').stderr
    metrics = json.loads(re.search(r'\{\s*"input_i".*?\}', final_loudness, re.S).group())
    report = {'source': args.source.name, 'output': args.output.name, 'provider': 'Azure Speech',
              'region': args.region, 'voice': args.voice, 'duration': final_probe['format']['duration'],
              'bytes': final_probe['format']['size'], 'video_stream_unchanged': True,
              'full_decode_passed': True, 'loudness': metrics, 'segments': segments,
              'preset_visuals': True, 'burned_in_subtitles': False}
    args.output.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    subtitles = [f"{i + 1}\n{timecode(s['start'])} --> {timecode(s['end'])}\n{s['text']}\n"
                 for i, s in enumerate(segments)]
    args.output.with_suffix('.srt').write_text('\n'.join(subtitles))
    print(json.dumps({k: v for k, v in report.items() if k != 'segments'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Only our controlled errors or local subprocess errors are reported.
        if isinstance(exc, subprocess.CalledProcessError):
            print(f'Local media processing failed ({exc.returncode})', file=sys.stderr)
        else:
            print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        sys.exit(1)
