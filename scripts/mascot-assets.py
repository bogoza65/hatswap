#!/usr/bin/env python3
"""Slices the mascot character sheet into eight transparent poses.

  python3 scripts/mascot-assets.py

Expects brand/mascot-sheet.png: a 4×2 grid on a flat dark background, poses in
reading order. Writes site/mascot/pose-1.png … pose-8.png (and copies the ones
the popup uses into extension/icons/mascot/), each trimmed to the figure.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "mascot-sheet.png"
COLS, ROWS = 4, 2
BG_TOLERANCE = 30
MAX_SIDE = 480  # the figures are used at ≤ 240 CSS px, so 2× is plenty

# Which poses the popup shows, by cell number (reading order).
POPUP_POSES = {2: "wave", 5: "peek", 6: "key", 7: "asleep"}


def remove_background(img):
    """Flood-fills from the borders, so dark pixels inside the figure are kept."""
    from collections import deque
    img = img.convert("RGB")
    w, h = img.size
    px = img.load()
    corner = px[1, 1]
    is_bg = lambda p: sum(abs(a - b) for a, b in zip(p, corner)) <= BG_TOLERANCE
    seen = bytearray(w * h)
    queue = deque([(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)])
    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x] or not is_bg(px[x, y]):
            continue
        seen[y * w + x] = 1
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    out = img.convert("RGBA")
    out.putalpha(Image.frombytes("L", (w, h), bytes(0 if s else 255 for s in seen)))
    return out


def main():
    if not SRC.exists():
        raise SystemExit(f"Put the character sheet at {SRC.relative_to(ROOT)} first.")
    sheet = Image.open(SRC)
    cw, ch = sheet.width // COLS, sheet.height // ROWS
    out_site = ROOT / "site" / "mascot"
    out_ext = ROOT / "extension" / "icons" / "mascot"
    out_site.mkdir(exist_ok=True)
    out_ext.mkdir(exist_ok=True)
    for n in range(COLS * ROWS):
        col, row = n % COLS, n // COLS
        # Each cell has a faint frame drawn ~15–30 px inside it; crop past it.
        cell = sheet.crop((col * cw + 36, row * ch + 36, (col + 1) * cw - 36, (row + 1) * ch - 36))
        fig = remove_background(cell)
        box = fig.getbbox()
        if not box:
            print(f"cell {n + 1}: empty, skipped")
            continue
        fig = fig.crop(box)
        fig.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        fig.save(out_site / f"pose-{n + 1}.png")
        if n + 1 in POPUP_POSES:
            fig.save(out_ext / f"{POPUP_POSES[n + 1]}.png")
        print(f"cell {n + 1}: {fig.size}")


if __name__ == "__main__":
    main()
