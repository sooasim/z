#!/usr/bin/env python
"""Generate the JETPOOL app icons from the brand artwork.

    python -I scripts/brand/app-icon.py                 # writes into apps/web/public
    python -I scripts/brand/app-icon.py <out-dir>       # or somewhere else, to preview

(The share card is not here: app/opengraph-image.tsx renders it at build time.)

The lockup is unreadable as an app icon -- "JETPOOL" is 11 glyphs wide and turns to
grey mush below about 64px -- so the icon carries only the jet and its contrail, the
part of the artwork that still reads as JETPOOL at 16px.

The jet is not redrawn by eye: it is the outline traced off
scripts/brand/source/jetpool-lockup-source.jpg with marching squares at the 50%-ink
iso-level and simplified with Douglas-Peucker at 0.8px, normalised so its bounding
box starts at the origin. A pixel mask would have stair-stepped; the iso-level puts
each edge where the artwork's own anti-aliasing says it is.

The contrail is re-cut rather than traced. The artwork's runs 430px to the right of a
wide lockup and would be a hairline in a square, so it keeps the original's gesture --
a point where it meets the aircraft, widening as it falls away, closed by a raked
chisel rather than a blunt end -- at a width the tile can hold. It is deliberately let
run off the lower-left edge and clipped to the tile: keeping the whole ribbon inside
the square would mean shrinking the jet to about 2.5x, which is where it stopped
reading at 16px.

Three square variants, all from the same geometry so they cannot drift apart:
  icons/icon.svg            rounded tile, the browser favicon and the PWA "any" icon
  icons/maskable.svg        full-bleed, mark inside the 80% maskable safe circle
  icons/apple-touch-icon.png  180px, full bleed -- iOS applies its own superellipse
                            mask, and Safari ignores an SVG apple-touch-icon outright

Deliberately numpy + Pillow only, and no whole-image float pipeline, for the same
reason cutout-logo.py is: this box runs at its Windows commit-charge ceiling.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# ---------------------------------------------------------------------------- brand constants
NAVY, SKY = (0x15, 0x5E, 0xAB), (0x1D, 0x9A, 0xDC)   # measured off the lockup's J and L
SIZE = 512          # icon viewBox / render size
RADIUS = 112        # the tile's corner radius, inherited from the icon it replaces
SS = 4              # supersampling for the PNG rasteriser (Pillow's draw has no AA)

# Jet traced off the lockup; bounding box 84.78 x 71.23 with its top-left at the origin.
JET = [
    (11.50, 0.00), (10.47, 2.23), (39.50, 23.67), (41.39, 26.23), (17.50, 46.00),
    (0.00, 42.23), (12.00, 51.23), (17.50, 66.38), (18.78, 50.23), (20.50, 48.27),
    (46.50, 33.73), (48.00, 35.23), (58.33, 71.23), (60.00, 71.23), (61.50, 64.73),
    (64.94, 21.23), (81.50, 7.36), (84.50, 3.73), (84.78, 1.23), (77.42, 3.23),
    (60.50, 13.20),
]
JET_W, JET_H = 84.78, 71.23

# Contrail, in the jet's own units so the whole mark scales as one piece.
ATTACH = (8.0, 58.0)    # just off the tail, where the artwork's contrail runs out
C_LEN, C_DROP, C_WIDTH = 59.15, 41.13, 10.70
C_TIP_ANG, C_END_ANG = 42.0, 15.0   # degrees below horizontal: steep at the jet, flat at the tail
C_BOW = 0.44            # control-point reach, as a fraction of the chord
C_CHISEL = 62.0         # rake of the end cut


def fmt(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


# ---------------------------------------------------------------------------- geometry
def jet_points(s, ox, oy):
    return [(ox + s * x, oy + s * y) for x, y in JET]


def mark(s, cx, cy):
    """Jet polygon and contrail cubics for a mark of scale `s` centred on (cx, cy)."""
    import math

    ox, oy = cx - s * JET_W / 2, cy - s * JET_H / 2
    tip = (ox + s * ATTACH[0], oy + s * ATTACH[1])

    ta, ea = math.radians(C_TIP_ANG), math.radians(C_END_ANG)
    p0 = tip
    p3 = (tip[0] - s * C_LEN, tip[1] + s * C_DROP)
    d = C_BOW * math.hypot(s * C_LEN, s * C_DROP)
    p1 = (p0[0] - d * math.cos(ta), p0[1] + d * math.sin(ta))
    p2 = (p3[0] + d * math.cos(ea), p3[1] - d * math.sin(ea))

    def left_normal(v):
        n = math.hypot(*v) or 1.0
        return (v[1] / n, -v[0] / n)

    h = s * C_WIDTH / 2
    n1 = left_normal((p1[0] - p0[0], p1[1] - p0[1]))
    n2 = left_normal((p3[0] - p2[0], p3[1] - p2[1]))
    n3 = (math.sin(math.radians(C_CHISEL)), -math.cos(math.radians(C_CHISEL)))

    def edge(sign):
        # offset each control point by the half-width at its own parameter, so the
        # ribbon opens evenly instead of hinging on a shared control point
        return (
            (p1[0] + sign * n1[0] * h / 3, p1[1] + sign * n1[1] * h / 3),
            (p2[0] + sign * n2[0] * h * 2 / 3, p2[1] + sign * n2[1] * h * 2 / 3),
            (p3[0] + sign * n3[0] * h, p3[1] + sign * n3[1] * h),
        )

    return jet_points(s, ox, oy), (p0, edge(+1), edge(-1))


def contrail_d(cubics):
    p0, (u1, u2, u3), (l1, l2, l3) = cubics
    return (
        f"M{fmt(p0[0])} {fmt(p0[1])}"
        f"C{fmt(u1[0])} {fmt(u1[1])} {fmt(u2[0])} {fmt(u2[1])} {fmt(u3[0])} {fmt(u3[1])}"
        f"L{fmt(l3[0])} {fmt(l3[1])}"
        f"C{fmt(l2[0])} {fmt(l2[1])} {fmt(l1[0])} {fmt(l1[1])} {fmt(p0[0])} {fmt(p0[1])}Z"
    )


def contrail_polygon(cubics, steps=48):
    """The same ribbon flattened, for the Pillow rasteriser."""
    def bez(a, b, c, d, n):
        return [
            (
                (1 - t) ** 3 * a[0] + 3 * (1 - t) ** 2 * t * b[0] + 3 * (1 - t) * t * t * c[0] + t ** 3 * d[0],
                (1 - t) ** 3 * a[1] + 3 * (1 - t) ** 2 * t * b[1] + 3 * (1 - t) * t * t * c[1] + t ** 3 * d[1],
            )
            for t in (i / n for i in range(n + 1))
        ]

    p0, (u1, u2, u3), (l1, l2, l3) = cubics
    return bez(p0, u1, u2, u3, steps) + bez(l3, l2, l1, p0, steps)


def jet_d(pts):
    return "M" + "L".join(f"{fmt(x)} {fmt(y)}" for x, y in pts) + "Z"


# ---------------------------------------------------------------------------- SVG
def placement(safe):
    """Scale and centre of the mark.

    `safe` is the maskable one: scaled down to sit inside the 80%-diameter safe
    circle (radius 204.8 here) that a launcher is allowed to crop to. The other is
    for surfaces that only ever lose the corners -- the favicon tile, and the iOS
    home screen, whose superellipse mask is far shallower than that circle.
    """
    return (3.05, (256.0, 248.0)) if safe else (3.55, (262.0, 237.0))


def icon_svg(rounded):
    """`rounded` draws the favicon tile; the maskable one is square and full bleed."""
    s, c = placement(safe=not rounded)
    pts, cubics = mark(s, *c)
    tile = (
        f'<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="url(#g)"/>'
        if rounded else f'<rect width="{SIZE}" height="{SIZE}" fill="url(#g)"/>'
    )
    # The contrail runs off the lower-left on purpose, so the rounded tile has to hold
    # it to the corner radius; the maskable one is full bleed and needs no clip.
    clip = (
        f'<clipPath id="t"><rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}"/></clipPath>'
        if rounded else ""
    )
    open_g, close_g = ('<g clip-path="url(#t)">', "</g>") if rounded else ("", "")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">'
        f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="#{NAVY[0]:02x}{NAVY[1]:02x}{NAVY[2]:02x}"/>'
        f'<stop offset="1" stop-color="#{SKY[0]:02x}{SKY[1]:02x}{SKY[2]:02x}"/>'
        f"</linearGradient>{clip}</defs>"
        f"{tile}{open_g}"
        f'<path d="{contrail_d(cubics)}" fill="#fff"/>'
        f'<path d="{jet_d(pts)}" fill="#fff"/>'
        f"{close_g}</svg>"
    )


# ---------------------------------------------------------------------------- PNG
def diagonal_gradient(w, h, c0, c1):
    """Matches SVG's objectBoundingBox x1,y1=0,0 -> x2,y2=1,1: t is the normalised
    projection of each pixel onto the box diagonal."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    t = (x * w + y * h) / float(w * w + h * h)
    np.clip(t, 0.0, 1.0, out=t)
    out = np.empty((h, w, 3), dtype=np.uint8)
    for i in range(3):
        out[..., i] = np.rint(c0[i] + (c1[i] - c0[i]) * t).astype(np.uint8)
    return Image.fromarray(out, "RGB")


def icon_png(size):
    """The apple-touch icon: the favicon's composition, rasterised full bleed so iOS
    can lay its own superellipse mask over the corners."""
    w = size * SS
    base = diagonal_gradient(w, w, NAVY, SKY)
    k = w / SIZE
    s, (cx, cy) = placement(safe=False)
    pts, cubics = mark(s, cx, cy)
    layer = Image.new("L", (w, w), 0)
    d = ImageDraw.Draw(layer)
    d.polygon([(x * k, y * k) for x, y in contrail_polygon(cubics)], fill=255)
    d.polygon([(x * k, y * k) for x, y in pts], fill=255)
    base.paste(Image.new("RGB", (w, w), (255, 255, 255)), (0, 0), layer)
    return base.resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------------------- main
def main():
    root = Path(__file__).resolve().parents[2]
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "apps/web/public"
    icons = out / "icons"
    icons.mkdir(parents=True, exist_ok=True)

    for name, doc in (("icon.svg", icon_svg(True)), ("maskable.svg", icon_svg(False))):
        (icons / name).write_text(doc, encoding="utf-8")
        print(f"{icons / name}  {len(doc)} B")

    apple = icons / "apple-touch-icon.png"
    icon_png(180).save(apple, optimize=True)
    print(f"{apple}  180x180  {apple.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
