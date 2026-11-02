#!/usr/bin/env python3
"""Generate WordFind icons as PNG without third-party dependencies."""

import math
import os
import struct
import zlib

SS = 4  # supersampling factor
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")


def rounded_rect(x, y, w, h, r):
    if x < 0 or y < 0 or x > w or y > h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def circle_ring(x, y, cx, cy, radius, width):
    d = math.hypot(x - cx, y - cy)
    return radius - width / 2 <= d <= radius + width / 2


def segment(x, y, x1, y1, x2, y2, width):
    dx, dy = x2 - x1, y2 - y1
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(x - x1, y - y1) <= width / 2
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / length_sq))
    px, py = x1 + t * dx, y1 + t * dy
    return math.hypot(x - px, y - py) <= width / 2


def bar(x, y, cx, baseline, width, height):
    half = width / 2
    radius = min(half, height / 2)
    left, right = cx - half, cx + half
    top, bottom = baseline - height, baseline
    if x < left or x > right or y < top or y > bottom:
        return False
    closest_x = min(max(x, left + radius), right - radius)
    closest_y = min(max(y, top + radius), bottom - radius)
    return (x - closest_x) ** 2 + (y - closest_y) ** 2 <= radius * radius


def blend(dst, src):
    sr, sg, sb, sa = src
    if sa >= 1.0:
        return (sr, sg, sb, 1.0)
    dr, dg, db, da = dst
    out_a = sa + da * (1 - sa)
    if out_a <= 0:
        return (0, 0, 0, 0)
    out_r = (sr * sa + dr * da * (1 - sa)) / out_a
    out_g = (sg * sa + dg * da * (1 - sa)) / out_a
    out_b = (sb * sa + db * da * (1 - sa)) / out_a
    return (out_r, out_g, out_b, out_a)


def render(size):
    w = size * SS
    canvas = [(0, 0, 0, 0.0)] * (w * w)
    radius = 0.225 * w
    for y in range(w):
        for x in range(w):
            if not rounded_rect(x + 0.5, y + 0.5, w, w, radius):
                continue
            t = (x + y) / (2 * w)
            r = 30 + (59 - 30) * t
            g = 58 + (130 - 58) * t
            b = 138 + (246 - 138) * t
            canvas[y * w + x] = (r, g, b, 1.0)

    cx, cy = 0.44 * w, 0.415 * w
    ring_r = 0.205 * w
    ring_w = 0.082 * w
    handle_w = 0.105 * w

    for y in range(w):
        for x in range(w):
            px, py = x + 0.5, y + 0.5
            color = canvas[y * w + x]
            if color[3] == 0:
                continue
            if math.hypot(px - cx, py - cy) <= ring_r - ring_w / 2:
                color = blend(color, (255, 255, 255, 0.16))
            if circle_ring(px, py, cx, cy, ring_r, ring_w):
                color = blend(color, (255, 255, 255, 1.0))
            angle = math.radians(45)
            hx = cx + math.cos(angle) * ring_r
            hy = cy + math.sin(angle) * ring_r
            ex, ey = 0.775 * w, 0.755 * w
            if segment(px, py, hx, hy, ex, ey, handle_w):
                color = blend(color, (255, 255, 255, 1.0))
            canvas[y * w + x] = color

    bars = [(0.365, 0.075), (0.44, 0.115), (0.515, 0.155)]
    for y in range(w):
        for x in range(w):
            px, py = x + 0.5, y + 0.5
            for bar_cx, height in bars:
                if bar(px, py, bar_cx * w, 0.505 * w, 0.048 * w, height * w):
                    canvas[y * w + x] = blend(canvas[y * w + x], (255, 255, 255, 0.98))
                    break

    # downsample
    out = bytearray()
    for oy in range(size):
        out.append(0)  # filter type 0
        for ox in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    pr, pg, pb, pa = canvas[(oy * SS + sy) * w + (ox * SS + sx)]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            if a == 0:
                out.extend((0, 0, 0, 0))
            else:
                out.extend((round(r / a), round(g / a), round(b / a), round(a / (SS * SS) * 255)))
    return bytes(out)


def write_png(path, size, pixels):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = zlib.compress(pixels, 9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        pixels = render(size)
        write_png(os.path.join(OUT_DIR, "icon%d.png" % size), size, pixels)
        print("wrote icon%d.png" % size)


if __name__ == "__main__":
    main()
