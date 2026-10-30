#!/usr/bin/env python3
"""Builds every hat image from the source artwork in brand/hat-source.webp.

  python3 scripts/brand-assets.py

Outputs
  brand/hat.png               the hat on a transparent background, cropped
  extension/icons/hat.png     the hat without its band (transparent where the band was)
  extension/icons/hat-band.png the band alone, used as a CSS mask so the UI can tint it
  extension/icons/icon{16,32,48,128}.png  toolbar/store icons: the hat on a dark rounded tile
  site/icon32.png, site/icon128.png, site/hat.png, site/hat-band.png  copies for the homepage
"""
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "hat-source.webp"
TILE = (0xF6, 0xF3, 0xEE)  # cream: the black hat stays legible at 16 px on light and dark toolbars
BG_TOLERANCE = 28       # how far from the corner colour still counts as background
PAD = 0.06              # padding around the hat in the cropped image, as a fraction


def remove_background(img):
    """Flood-fills from the borders, so dark pixels inside the hat are kept."""
    img = img.convert("RGB")
    w, h = img.size
    px = img.load()
    corner = px[0, 0]
    is_bg = lambda p: sum(abs(a - b) for a, b in zip(p, corner)) <= BG_TOLERANCE
    seen = bytearray(w * h)
    queue = deque()
    for x in range(w):
        queue.extend(((x, 0), (x, h - 1)))
    for y in range(h):
        queue.extend(((0, y), (w - 1, y)))
    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x] or not is_bg(px[x, y]):
            continue
        seen[y * w + x] = 1
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    out = img.convert("RGBA")
    alpha = Image.frombytes("L", (w, h), bytes(0 if s else 255 for s in seen))
    out.putalpha(alpha)
    return out


def is_band(p):
    r, g, b, a = p
    return a > 0 and r > 140 and r - g > 55 and r - b > 55


def split_band(hat):
    """Returns (hat without band, band only as a white mask)."""
    base = hat.copy()
    band = Image.new("RGBA", hat.size, (0, 0, 0, 0))
    bp, hp, bd = base.load(), hat.load(), band.load()
    w, h = hat.size
    for y in range(h):
        for x in range(w):
            p = hp[x, y]
            if is_band(p):
                bp[x, y] = (0, 0, 0, 0)
                bd[x, y] = (255, 255, 255, p[3])
    return base, band


def crop_with_padding(images):
    box = images[0].getbbox()
    pad = int(max(box[2] - box[0], box[3] - box[1]) * PAD)
    box = (max(0, box[0] - pad), max(0, box[1] - pad), box[2] + pad, box[3] + pad)
    return [im.crop(box) for im in images]


def rounded_tile(size, radius_frac=0.22):
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * radius_frac), fill=TILE + (255,))
    return tile


def fit(im, box_w, box_h):
    scale = min(box_w / im.width, box_h / im.height)
    return im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)


def icon(hat, size):
    tile = rounded_tile(size)
    art = fit(hat, int(size * 0.86), int(size * 0.86))
    tile.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2 + int(size * 0.02)))
    return tile


def main():
    hat = remove_background(Image.open(SRC))
    base, band = split_band(hat)
    hat, base, band = crop_with_padding([hat, base, band])

    (ROOT / "brand").mkdir(exist_ok=True)
    hat.save(ROOT / "brand" / "hat.png")

    icons = ROOT / "extension" / "icons"
    site = ROOT / "site"
    # UI mark layers at a size that stays crisp up to ~80 CSS px on a 2× screen.
    for name, im in (("hat.png", base), ("hat-band.png", band)):
        small = fit(im, 160, 160)
        small.save(icons / name)
        small.save(site / name)
    for size in (16, 32, 48, 128):
        im = icon(hat, size)
        im.save(icons / f"icon{size}.png")
        if size in (32, 128):
            im.save(site / f"icon{size}.png")
    print(f"hat {hat.size}, band pixels {sum(1 for p in band.getdata() if p[3])}")


if __name__ == "__main__":
    main()
