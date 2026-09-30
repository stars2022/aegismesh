"""Rasterize the existing Lucide Network brand mark for inline email delivery.

Build-time only; production email sending has no Pillow dependency.
"""
from pathlib import Path

from PIL import Image, ImageDraw

scale = 4
image = Image.new("RGBA", (40 * scale, 40 * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 40 * scale - 1, 40 * scale - 1), radius=10 * scale, fill="#161614")
box = lambda x, y, w, h: tuple(int(v * scale) for v in (x + 8, y + 8, x + w + 8, y + h + 8))
for x, y in ((16, 16), (2, 16), (9, 2)):
    draw.rounded_rectangle(box(x, y, 6, 6), radius=scale, outline="#ffffff", width=2 * scale)
draw.line([(int((x + 8) * scale), int((y + 8) * scale)) for x, y in ((5, 16), (5, 13), (6, 12), (18, 12), (19, 13), (19, 16))], fill="#ffffff", width=2 * scale, joint="curve")
draw.line([(20 * scale, 20 * scale), (20 * scale, 16 * scale)], fill="#ffffff", width=2 * scale)
destination = Path(__file__).resolve().parents[1] / "backend/app/assets/account-mail-logo.png"
destination.parent.mkdir(parents=True, exist_ok=True)
image.resize((96, 96), Image.Resampling.LANCZOS).save(destination, optimize=True)
print(destination)
