#!/usr/bin/env python
"""Regenerate the JETPOOL brand PNGs from the supplied logo artwork.

    python -I scripts/brand/cutout-logo.py scripts/brand/source/jetpool-lockup-source.jpg

The source is the brand lockup rendered on a solid white background. The white is
keyed out ("누끼") by *unmultiplying* it rather than thresholding, so anti-aliased
edges keep their true colour and a real fractional alpha — a hard threshold leaves
white fringes as soon as the logo sits on the dark theme.

Compositing over white is  C = a*F + (1-a)*255, so the per-channel "ink" (255 - C)
is exactly a*(255 - F). The ink of the nearest solid core pixel gives (255 - F); a
local maximum filter finds it, alpha is the ratio, and F follows by dividing the
ink back out.

Four files are written: the wordmark (jet + JETPOOL) for the site header and the
full lockup (wordmark + "JETPOOL INTERNATIONAL Corp.") for the footer, each in a
light-theme and a dark-theme variant. The dark variants lift lightness in HLS so
the navy half of the gradient and the grey company line stay legible on #08121f.

Deliberately numpy + Pillow only, working in row chunks: this box runs at its
Windows commit-charge ceiling and a whole-image float pipeline cannot allocate.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageFilter, ImageOps

CORE_WINDOW = 13    # px; odd window used to find a stroke's solid core colour
INK_FLOOR = 3       # 0-255; ink below this is encoder noise, not artwork
DARK_BASE, DARK_SPAN = 0.40, 0.56   # dark-theme lightness ramp: L' = BASE + SPAN*L
DARK_SAT = 1.06                     # small saturation bump to offset the lift
CHUNK = 64          # rows per pass


def unmultiply_white(src: Path) -> np.ndarray:
    """Load an RGB-over-white image and return a straight-alpha uint8 RGBA array."""
    im = Image.open(src).convert("RGB")
    ink_r, ink_g, ink_b = ImageOps.invert(im).split()
    strongest = ImageChops.lighter(ImageChops.lighter(ink_r, ink_g), ink_b)
    core = strongest.filter(ImageFilter.MaxFilter(CORE_WINDOW))

    rgb = np.asarray(im, dtype=np.uint8)
    ink_max = np.asarray(strongest, dtype=np.uint8)
    ink_core = np.asarray(core, dtype=np.uint8)
    del im, ink_r, ink_g, ink_b, strongest, core

    out = np.empty(rgb.shape[:2] + (4,), dtype=np.uint8)
    for y in range(0, rgb.shape[0], CHUNK):
        sl = slice(y, y + CHUNK)
        strong = ink_max[sl].astype(np.float32)
        a = np.where(ink_core[sl] >= INK_FLOOR, strong / np.maximum(ink_core[sl], 1), 0.0)
        np.clip(a, 0.0, 1.0, out=a)
        a[strong < INK_FLOOR] = 0.0
        ink = 255.0 - rgb[sl].astype(np.float32)
        colour = 255.0 - ink / np.maximum(a, 1e-6)[..., None]
        np.clip(colour, 0.0, 255.0, out=colour)
        colour[a == 0.0] = 255.0
        out[sl, :, :3] = np.rint(colour).astype(np.uint8)
        out[sl, :, 3] = np.rint(a * 255.0).astype(np.uint8)
    return out


def _rgb_to_hls(r, g, b):
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    l = (mx + mn) / 2.0
    d = mx - mn
    s = np.where(d == 0, 0.0, d / np.where(l > 0.5, np.maximum(2.0 - mx - mn, 1e-6), np.maximum(mx + mn, 1e-6)))
    rc = np.where(d == 0, 0.0, (mx - r) / np.maximum(d, 1e-6))
    gc = np.where(d == 0, 0.0, (mx - g) / np.maximum(d, 1e-6))
    bc = np.where(d == 0, 0.0, (mx - b) / np.maximum(d, 1e-6))
    h = np.where(mx == r, bc - gc, np.where(mx == g, 2.0 + rc - bc, 4.0 + gc - rc)) / 6.0
    return np.mod(np.where(d == 0, 0.0, h), 1.0), l, s


def _hue_channel(m1, m2, h):
    h = np.mod(h, 1.0)
    return np.where(
        h < 1 / 6, m1 + (m2 - m1) * 6.0 * h,
        np.where(h < 0.5, m2, np.where(h < 2 / 3, m1 + (m2 - m1) * (2 / 3 - h) * 6.0, m1)),
    )


def lighten_for_dark_theme(rgba: np.ndarray) -> np.ndarray:
    out = rgba.copy()
    for y in range(0, rgba.shape[0], CHUNK):
        sl = slice(y, y + CHUNK)
        px = rgba[sl, :, :3].astype(np.float32) / 255.0
        h, l, s = _rgb_to_hls(px[..., 0], px[..., 1], px[..., 2])
        l = np.minimum(1.0, DARK_BASE + DARK_SPAN * l)
        s = np.minimum(1.0, s * DARK_SAT)
        m2 = np.where(l <= 0.5, l * (1.0 + s), l + s - l * s)
        m1 = 2.0 * l - m2
        lifted = np.dstack([_hue_channel(m1, m2, h + 1 / 3), _hue_channel(m1, m2, h), _hue_channel(m1, m2, h - 1 / 3)])
        lifted = np.where((s == 0)[..., None], l[..., None], lifted)
        out[sl, :, :3] = np.rint(np.clip(lifted, 0.0, 1.0) * 255.0).astype(np.uint8)
    out[..., :3][rgba[..., 3] == 0] = 255
    return out


def trim(rgba: np.ndarray) -> np.ndarray:
    rows = np.nonzero(rgba[..., 3].max(axis=1))[0]
    cols = np.nonzero(rgba[..., 3].max(axis=0))[0]
    return np.ascontiguousarray(rgba[rows.min(): rows.max() + 1, cols.min(): cols.max() + 1])


def save(rgba: np.ndarray, width: int, path: Path) -> None:
    """Resize on premultiplied alpha — straight-alpha resampling bleeds white in."""
    pre = rgba.astype(np.float32)
    pre[..., :3] *= pre[..., 3:4] / 255.0
    h = max(1, round(width * rgba.shape[0] / rgba.shape[1]))
    small = np.asarray(
        Image.fromarray(np.rint(pre).astype(np.uint8), "RGBA").resize((width, h), Image.LANCZOS), dtype=np.float32
    ).copy()
    del pre
    small[..., :3] /= np.maximum(small[..., 3:4] / 255.0, 1e-6)
    np.clip(small, 0.0, 255.0, out=small)
    img = Image.fromarray(np.rint(small).astype(np.uint8), "RGBA")
    img.save(path, optimize=True)
    print(f"{path}  {img.width}x{img.height}  {path.stat().st_size / 1024:.1f} KB")


def main() -> None:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "apps/web/public/brand")
    out.mkdir(parents=True, exist_ok=True)

    lockup = unmultiply_white(src)

    # The artwork has one all-white band between the wordmark and the company line;
    # the wordmark is everything above that band.
    filled = lockup[..., 3].max(axis=1) > 0
    rows = np.nonzero(filled)[0]
    gaps = [y for y in np.nonzero(~filled)[0] if rows.min() < y < rows.max()]
    split = gaps[len(gaps) // 2] if gaps else lockup.shape[0]

    for name, art, width in [("jetpool-wordmark", trim(lockup[:split]), 480), ("jetpool-logo", trim(lockup), 480)]:
        save(art, width, out / f"{name}.png")
        save(lighten_for_dark_theme(art), width, out / f"{name}-dark.png")


if __name__ == "__main__":
    main()
