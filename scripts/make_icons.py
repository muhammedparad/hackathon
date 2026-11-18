#!/usr/bin/env python3
"""Generates the PWA / home-screen icons in public/ from the RoomTrace logo design.

Pure Python (no Pillow needed):  python scripts/make_icons.py
Writes: icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")

C1 = (37, 99, 235)    # #2563EB
C2 = (29, 78, 216)    # #1D4ED8
CX, CY = 0.5, 0.30    # radar emitter
RINGS = [(0.16, 0.95), (0.27, 0.75), (0.38, 0.5)]  # (radius, opacity), stroke below
HALF_STROKE = 0.028
FAN = (38.0, 142.0)   # degrees, 90 = straight down
DOT_R = 0.058


def in_round_rect(x, y, r):
    if x < 0 or y < 0 or x > 1 or y > 1:
        return False
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def sample(x, y, maskable):
    """Return (r, g, b, a) 0..255 for one sample point in unit coordinates."""
    if maskable:
        bg_alpha = 1.0
        # keep the emblem inside the 80% safe zone
        ux, uy = 0.5 + (x - 0.5) / 0.74, 0.5 + (y - 0.5) / 0.74
    else:
        bg_alpha = 1.0 if in_round_rect(x, y, 0.22) else 0.0
        ux, uy = x, y
    t = (x + y) / 2
    r = C1[0] + (C2[0] - C1[0]) * t
    g = C1[1] + (C2[1] - C1[1]) * t
    b = C1[2] + (C2[2] - C1[2]) * t

    cover = 0.0
    dx, dy = ux - CX, uy - CY
    dist = math.hypot(dx, dy)
    if dist <= DOT_R:
        cover = 1.0
    else:
        ang = math.degrees(math.atan2(dy, dx))
        if FAN[0] <= ang <= FAN[1]:
            for radius, op in RINGS:
                if abs(dist - radius) <= HALF_STROKE:
                    cover = max(cover, op)
    r += (255 - r) * cover
    g += (255 - g) * cover
    b += (255 - b) * cover
    return r, g, b, bg_alpha


def render(size, maskable=False, ss=3):
    rows = []
    step = 1.0 / (size * ss)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            ar = ag = ab = aa = 0.0
            for sy in range(ss):
                y = (py * ss + sy + 0.5) * step
                for sx in range(ss):
                    x = (px * ss + sx + 0.5) * step
                    r, g, b, a = sample(x, y, maskable)
                    ar += r * a
                    ag += g * a
                    ab += b * a
                    aa += a
            n = ss * ss
            if aa > 0:
                row += bytes((round(ar / aa), round(ag / aa), round(ab / aa), round(255 * aa / n)))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def png_bytes(size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return png


def write_png(path, size, rows):
    with open(path, "wb") as f:
        f.write(png_bytes(size, rows))


def write_ico(path, sizes):
    """favicon.ico with PNG-encoded images. Small sizes use bolder rings so they stay readable at 16 px."""
    global HALF_STROKE, DOT_R
    keep = (HALF_STROKE, DOT_R)
    images = []
    for size in sizes:
        HALF_STROKE, DOT_R = (0.06, 0.105) if size <= 24 else (0.045, 0.085)
        images.append((size, png_bytes(size, render(size, False, ss=6))))
    HALF_STROKE, DOT_R = keep
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    blobs = b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    with open(path, "wb") as f:
        f.write(head + entries + blobs)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, maskable in [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),  # iOS rounds the corners itself: full-bleed square
    ]:
        write_png(os.path.join(OUT, name), size, render(size, maskable, ss=3 if size >= 400 else 4))
        print("wrote", name)
    write_ico(os.path.join(OUT, "favicon.ico"), [16, 32, 48])
    print("wrote favicon.ico")


if __name__ == "__main__":
    main()
