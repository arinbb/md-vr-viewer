"""Draws the app icons (icons/icon-192.png, icons/icon-512.png): a water molecule on the
viewer's dark background. Needs Pillow (pip install pillow). Run: python tools/make_icons.py"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), '..')
BG = (13, 17, 23)
O, H, BOND = (255, 13, 13), (235, 235, 235), (139, 148, 158)


def icon(size):
    s = 4 * size  # draw large, then downsample for smooth edges
    im = Image.new('RGB', (s, s), BG)
    d = ImageDraw.Draw(im)
    u = s / 100  # icon units; keep everything inside the central 80% (maskable safe zone)
    o = (50 * u, 44 * u)
    hs = [(27 * u, 62 * u), (73 * u, 62 * u)]
    for h in hs:
        d.line([o, h], fill=BOND, width=int(5 * u))
    for h in hs:
        d.ellipse([h[0] - 10 * u, h[1] - 10 * u, h[0] + 10 * u, h[1] + 10 * u], fill=H)
    d.ellipse([o[0] - 17 * u, o[1] - 17 * u, o[0] + 17 * u, o[1] + 17 * u], fill=O)
    # small highlight so the spheres read as 3D
    d.ellipse([o[0] - 10 * u, o[1] - 11 * u, o[0] - 3 * u, o[1] - 4 * u], fill=(255, 120, 120))
    return im.resize((size, size), Image.LANCZOS)


os.makedirs(os.path.join(ROOT, 'icons'), exist_ok=True)
for n in (192, 512):
    icon(n).save(os.path.join(ROOT, 'icons', f'icon-{n}.png'))
print('icons written')
