"""Encode actual browser capture frames; do not fabricate application frames."""
import argparse
import json
from pathlib import Path
import subprocess

CHAPTERS = {
    'create': '01 添加智能体 · 生成草稿、配置能力、提交注册与签发演示证书',
    'discovery': '02 发现与接入 · 查看 ACS 能力声明、固定执行智能体',
    'probes': '03 互联探针 · 检查身份、能力声明与通道',
    'first-use': '首次使用 · 刚注册的政策研究协作助手',
    'research': '04 使用智能体 · 协调者拆分科研任务、执行者返回结果',
    'research-detail': '协调分派 · 调用链、工具参数与执行者回传',
    'news': '05 多场景协作 · 区域新闻素材核验',
    'travel': '06 多场景协作 · 学术访问行程规划',
    'bounty': '07 竞标模式 · 任务认领、交付与验收',
    'bounty-detail': '竞标协作 · 认领者、验收条件、交付证据与复核',
    'structured': '08 可选内置能力 · JSON Schema 与结构化结果',
    'canvas': '09 画布协作 · 在原版编辑器中生成与编辑文稿',
    'canvas-review': '共享画布 · 两轮文稿协作、改动审查与接受',
    'group': '10 智能体群聊 · 成员、消息与协作黑板',
    'group-user': '用户主持群聊 · 点名、专家接力与共享黑板',
    'group-host': '智能体主持群聊 · 协调者、检索者、审查者接力',
    'human': '11 数字人服务厅 · 麦溪与预置咨询',
    'settings': '12 设置 · 主题、账号管理与用量',
    'api': '13 开放 API · 端点与调用示例',
    'overview': '14 管理后台 · 运行概览',
    'providers': '15 管理后台 · 模型供应商与搜索配置',
    'routing': '16 管理后台 · 路由策略与能力权重',
    'accounts': '17 管理后台 · 用户目录与角色控制',
    'quotas': '18 管理后台 · 分角色、供应商的配额策略',
    'access': '19 管理后台 · 访问控制与数据',
    'traces': '20 运行记录 · 任务、调用链与结果',
    'logs': '21 日志与审计 · 本地预置互联事件',
}


def timecode(seconds):
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('frames', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--extra-frames', type=Path, action='append', default=[])
    parser.add_argument('--name', default='AegisMesh-全功能演示')
    parser.add_argument('--submission', action='store_true', help='3–5 minute main film; omit unrelated administration')
    parser.add_argument('--audit', type=Path, help='Native frame QA report; trim loading flashes before module cards')
    args = parser.parse_args()
    frames_dir = args.frames.resolve()
    by_chapter = {}
    for root in [frames_dir, *[path.resolve() for path in args.extra_frames]]:
        incoming = {}
        for manifest in sorted(root.glob('capture-*.json')):
            for record in json.loads(manifest.read_text()):
                record['_root'] = root
                incoming.setdefault(record['chapter'], []).append(record)
        by_chapter.update(incoming)
    if args.submission:
        required = {'create', 'discovery', 'first-use', 'research-detail', 'bounty-detail', 'structured', 'canvas-review', 'group-user', 'group-host', 'news', 'travel', 'human'}
        if missing := required - by_chapter.keys():
            raise RuntimeError(f'Missing required recorded chapters: {sorted(missing)}')
        for original, replacement in [('research', 'research-detail'), ('bounty', 'bounty-detail'), ('canvas', 'canvas-review')]:
            if replacement in by_chapter:
                by_chapter.pop(original, None)
        if 'group-user' in by_chapter and 'group-host' in by_chapter:
            by_chapter.pop('group', None)
        for key in ['probes', 'settings', 'api', 'overview', 'providers', 'routing', 'accounts', 'quotas', 'access', 'traces', 'logs']:
            by_chapter.pop(key, None)
    if args.submission:
        if not args.audit:
            raise RuntimeError('Submission requires a native frame audit report')
        audit = json.loads(args.audit.read_text())
        for chapter, rows in by_chapter.items():
            verified = next(row for row in audit['chapters'] if row['chapter'] == chapter)
            start = next(index for index, row in enumerate(rows) if row['file'] == verified['trim_before_file'])
            by_chapter[chapter] = rows[start:]
    records = [record for chapter in by_chapter.values() for record in chapter]
    order = {key: i for i, key in enumerate(CHAPTERS)}
    records = sorted(records, key=lambda item: (order.get(item['chapter'], 999), item['time']))
    if len(records) < 10:
        raise SystemExit('Not enough recorded browser frames')
    if args.submission:
        if any(item.get('controls_isolated') is not True for item in records):
            raise RuntimeError('Submission requires controller-isolated native captures')
        if any(item.get('state') == 'error' for item in records):
            raise RuntimeError('A failed recording cannot be included')
        file_chapters = {}
        for item in records:
            path = str(item['_root'] / item['file'])
            if path in file_chapters and file_chapters[path] != item['chapter']:
                raise RuntimeError('Capture file reused by different chapters')
            file_chapters[path] = item['chapter']
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Chapter-paced capture leaves deliberate gaps between capture cells. Omit
    # only those idle gaps, preserving every captured application frame.
    raw_times = [item['time'] for item in records]
    elapsed = 0.0
    for index, item in enumerate(records):
        if index:
            gap = raw_times[index] - raw_times[index - 1]
            elapsed += 0.3 if item['chapter'] != records[index - 1]['chapter'] else max(0, gap)
        item['time'] = elapsed
    start = 0.0
    duration = records[-1]['time'] - start + 2
    concat = ['ffconcat version 1.0']
    chapters = []
    previous = None
    for i, item in enumerate(records):
        name = item['file']
        if not name.startswith('frame-') or '/' in name or not (item['_root'] / name).is_file():
            raise ValueError('Unexpected capture filename')
        # The JPEG demuxer's default 1/25 time base rounds every frame gap,
        # accumulating drift against the narration over thousands of images.
        concat.extend([f"file '{item['_root'] / name}'", 'option framerate 1000', f"duration {records[i + 1]['time'] - item['time'] if i + 1 < len(records) else 2:.6f}"])
        if item.get('chapter') and item['chapter'] != previous:
            chapters.append({'key': item['chapter'], 'title': CHAPTERS.get(item['chapter'], item['chapter']), 'start': item['time'] - start})
            previous = item['chapter']
    concat.append(f"file '{records[-1]['_root'] / records[-1]['file']}'")
    concat.append('option framerate 1000')
    concat_path = frames_dir / 'frames.ffconcat'
    concat_path.write_text('\n'.join(concat) + '\n')
    subtitles = []
    for i, chapter in enumerate(chapters):
        end = chapters[i + 1]['start'] if i + 1 < len(chapters) else duration
        subtitles.append(f"{i + 1}\n{timecode(chapter['start'])} --> {timecode(end)}\n{chapter['title']}\n")
        chapter['end'] = end
    (output / f'{args.name}.srt').write_text('\n'.join(subtitles))
    video = output / f'{args.name}.mp4'
    # Clean application-only recording, per user request. No watermark or banner.
    # Preset-data provenance stays in the sidecar, not in application pixels.
    filters = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=24"
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y', '-safe', '0', '-f', 'concat', '-i', str(concat_path),
                    '-vf', filters, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(video)], check=True)
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', str(video)]))
    planned_duration = duration
    duration = float(probe['format']['duration'])
    chapters[-1]['end'] = duration
    subtitles[-1] = subtitles[-1].replace(timecode(planned_duration), timecode(duration))
    (output / f'{args.name}.srt').write_text('\n'.join(subtitles))
    if args.submission and not (180 <= float(probe['format']['duration']) <= 300 and int(probe['format']['size']) < 300_000_000):
        raise RuntimeError('Main film does not satisfy 3–5 minutes and <300 MB')
    demo_root = Path(__file__).resolve().parents[1]
    source_manifest = json.loads((demo_root / 'dist/demo/production-manifest.json').read_text())
    plan_module = (demo_root / 'dist/demo/recording-plan.mjs').as_uri()
    plan = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', f'import {{ RECORDING_PLAN }} from {json.dumps(plan_module)}; console.log(JSON.stringify(RECORDING_PLAN))']))
    narration = ['# AegisMesh 全流程视频口播稿', '', f'成片时长：{duration:.2f} 秒。每段先显示 6 秒模块页，再进入操作；过场页只读引入句，讲解正文从操作开始后读。', '',
                 '建议语速：每分钟约 230–260 字；按照时间码录音，句间自然停顿。不用读章节序号。当前交付是无声画面与配套口播稿，未合成人声。', '',
                 '录制素材使用预置数据；口播不将其描述为实时检索、真实签证书、性能测试或平台认证证据。云端真实访问截图另行提供。', '']
    voice_srt = []
    for chapter in chapters:
        item = next((row for row in plan if row['key'] == chapter['key']), None)
        if not item:
            continue
        intro_end = min(chapter['start'] + item['seconds'], chapter['end'])
        narration.extend([f"## {timecode(chapter['start'])[:-4]}—{timecode(chapter['end'])[:-4]}　{item['title']}", '',
                          f"过场页（{item['seconds']} 秒）：{item['intro']}", '', f"操作画面：{item['narration']}", ''])
        for begin, finish, text in [(chapter['start'], intro_end, item['intro']), (intro_end, chapter['end'], item['narration'])]:
            voice_srt.append(f"{len(voice_srt)+1}\n{timecode(begin)} --> {timecode(finish)}\n{text}\n")
        chapter.update({'module': item['title'], 'title_card_seconds': item['seconds'], 'intro': item['intro'], 'narration': item['narration']})
    (output / f'{args.name}-口播稿.md').write_text('\n'.join(narration))
    (demo_root / '口播稿.md').write_text('\n'.join(narration))
    (output / f'{args.name}-口播字幕.srt').write_text('\n'.join(voice_srt))
    metadata = {'demo': True, 'capture': 'actual shared production frontend UI in local browser; preset API data; editorial module cards', 'source_commit': source_manifest['production_commit'],
                'controls_isolated': args.submission, 'title_card_seconds': 6,
                'frames': len(records), 'duration': duration, 'chapters': chapters, 'video': video.name,
                'format': probe['format'], 'streams': [{key: stream.get(key) for key in ('codec_name', 'codec_type', 'width', 'height', 'r_frame_rate', 'nb_frames')} for stream in probe['streams']]}
    (output / f'{args.name}-录制信息.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'video': str(video), 'frames': len(records), 'chapters': len(chapters), 'duration': probe['format']['duration'], 'bytes': probe['format']['size']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
