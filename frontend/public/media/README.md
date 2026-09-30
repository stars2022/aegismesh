# 数字人形象素材

- 当前底图：`digital-human-matte.png`（1024 × 1536），不透明蓝灰色背景，已移除旧图的白色光晕。静态封面为 `digital-human-matte-poster.jpg`。
- 图片通过内置 `image_gen.imagegen` 编辑；视频经用户授权，在 Chrome 的 Grok Imagine 中以同一底图作为首尾参考生成（2026-09-30）。未使用真人照片或外部图库。
- 用途：`/digital-human` 老式企业服务门户中的原创虚拟客服。名牌为 AegisMesh 标志，不代表其他企业或政府机构。
- `digital-human-greet.mp4`：首次进入咨询时招手一次；`digital-human-idle.mp4`：安静待机；`digital-human-talk.mp4`：仅在本机语音实际播放时进行嘴部和讲解动作。
- 视频约 6 秒、640 × 954、H.264/yuv420p、faststart，无音轨；单段低于 1 MB。文件经过人物、手部、名牌、背景与首尾抽帧检查。
- 说话片段是装饰性循环，**不是逐字/逐音素口型同步**。真实音频仍来自设备本地中文 TTS；暂停、停止、切换咨询和后台状态不会让旧语音继续驱动嘴部。
- 支持手动暂停动作；减少动态效果、节省流量、不可见或媒体播放失败时回退封面，不阻断文字对话。不自动鼓掌。
- 旧图 `digital-human-retro-badge.png` / `digital-human-retro.png` 保留作来源记录，不再用于页面展示。第一轮带光晕试片未纳入发布素材。

## 去光晕编辑提示词（内置 imagegen）

```text
Use case: precise-object-edit. Input image 1 is the edit target, an ORIGINAL SYNTHETIC ADULT CGI female virtual attendant for the AegisMesh website. Remove the entire bright white outer glow, halo, bloom and spotlight behind her shoulders, arms, hair and body. Replace the entire background with a completely flat, solid opaque muted blue-gray (#d4e1ec), identical tone everywhere, no gradient, no vignette, no shadows or luminous border. Preserve her exact face, black bob haircut, gently closed smiling mouth, white and pale-blue uniform, scarf, clasped hands and camera crop as closely as possible. Keep the intentionally dated 2000s CGI look. Preserve the small existing physical name badge including its black connected-node icon and exact text "AegisMesh". Lighting on the character should remain neutral and soft, but with no rim light or halo whatsoever. Only change the background and remove the glow; no extra objects, no new text, no scene, no new accessories. Maintain original 2:3 portrait composition, complete head and clasped hands visible.
```

## Grok 视频提示词

每段均上传 `digital-human-matte.png` 作为首尾参考，时长 6 秒，关闭视频音频。网页显示的分辨率选项不作为实际交付尺寸依据；下载原片经 ffprobe 检查为 784 × 1168，再压缩到上述发布尺寸。

### 说话讲解

```text
Create a 6-second SILENT video of this ORIGINAL SYNTHETIC ADULT CGI service attendant visibly TALKING to the viewer with restrained hand gestures. Preserve the exact character, face, black bob, white/light-blue uniform, blue scarf and existing AegisMesh badge. The lips MUST MOVE naturally as if giving a calm explanation: small open, closed, rounded and wider mouth shapes, subtle jaw motion and occasional teeth; no frozen closed smile and no exaggerated chewing. Begin and end in the neutral closed-mouth reference pose for about half a second. While speaking, briefly open the hands slightly at waist level to explain, then return them clasped. Keep the deliberately dated 2000s Chinese service-portal CGI style. Locked camera, original full portrait framing, no zoom or cuts. The background must remain the SAME absolutely flat solid matte pale blue-gray of the supplied reference for every frame: NO glow, NO halo, NO white haze, NO spotlight, NO vignette, NO gradient, NO lighting changes. Natural five-finger hands, tiny blink, no head turn. Silent motion asset only: no audio track, no music, no subtitles, no new objects or text. Exact matching neutral start and end frames for a loop.
```

### 招手

```text
Create a 6-second silent greeting animation of the ORIGINAL SYNTHETIC ADULT female CGI service attendant in the provided identical start/end reference. Preserve exact face, black bob, uniform, scarf, proportions and AegisMesh badge. Keep the deliberately dated 2000s service-portal CGI style. Locked front camera and unchanged portrait framing. Keep the background absolutely flat solid matte pale blue-gray exactly like the reference throughout, with NO glow, halo, spotlight, haze, gradient or lighting changes. Begin with hands folded at waist. Politely raise her right hand beside the shoulder, palm toward viewer, give two small gentle waves, then return to the exact folded-hands neutral pose by the last second. Natural five-finger hand, restrained motion, small smile, quick natural blink. No talking in this greeting gesture, lips relaxed. No audio, subtitles, new text, extra objects, camera movement or zoom.
```

### 待机

```text
Create a seamless silent 6-second IDLE loop from the provided identical start/end image of the ORIGINAL SYNTHETIC ADULT CGI service attendant. Preserve exact face, uniform, hair, scarf and small AegisMesh badge. Fixed camera and original portrait framing. Very subtle breathing and one quick blink only, eyes open at start and end. Hands stay clasped in the reference pose for the entire video. Lips stay gently closed, with no talking. No head turn, gestures, zoom, or camera movement. Keep the background exactly the reference flat opaque pale blue-gray, absolutely constant: no halo, glow, vignette, gradient, haze, spotlight or light changes. Same intentionally dated 2000s service-portal CGI style. Natural anatomy, unchanged five-finger hands and badge. Start and end match exactly. No audio, subtitles, new text or new objects.
```

## 原始静态形象生成提示词（历史）

```text
Use case: stylized-concept
Asset type: transparent cutout character asset for an intentionally retro Chinese enterprise service-portal digital-human assistant.
Primary request: one original adult East Asian female virtual customer-service attendant, waist-up, centered, looking directly at camera, polite fixed smile, both hands clasped neatly at waist. Short black bob haircut. White and pale sky-blue stiff polyester business uniform with small blue neck scarf, anonymous blank name badge, absolutely no real organization logo.
Style/medium: deliberately dated budget 2008-2013 Chinese enterprise virtual-host CGI, slightly uncanny porcelain/plastic skin, oversized glossy eyes, stiff symmetrical pose, obviously artificial 3D character, old promotional CD-ROM render feel. Charming in its awkwardness, not horror, not glamorous, not photorealistic, not a modern luxury mascot.
Composition/framing: portrait 2:3 framing, head fully visible with margin, hands visible, figure fills most of frame, crisp isolated silhouette.
Lighting: flat bright studio light, cheap smooth plastic highlights.
Background: genuinely transparent alpha, no background scene, no checkerboard, no floor, no text, no watermark. Only one character.
```

## 名牌局部编辑提示词

模式仍为内置 imagegen；输入为原始形象和用户提供的 AegisMesh Logo 截图，透明背景保持开启。

```text
Use case: precise-object-edit
Asset type: existing digital-human character for AegisMesh.
Input images: Image 1 is the edit target, the full transparent CGI character. Image 2 is the exact logo reference, not a background to copy.
Primary request: Edit only the blank rectangular name badge on her jacket. Place the white connected-node network icon from the reference inside a small black rounded square on the badge left, and the word "AegisMesh" in black on the badge right. Fit the badge naturally with its original perspective and rim, with readable but realistic small printing.
Constraints: Preserve the exact original adult CGI face, short black hair, pose, hands, blue scarf, blue and white uniform, lighting, proportions and crop. Keep genuine transparent background and original alpha silhouette. Do not change any other part of the image. No other text, logos or objects. Do not copy the reference screenshot background.
```
