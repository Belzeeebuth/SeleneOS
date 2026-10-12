"""Finish wallpapers, Python half (driven by tools/gen-finish-wallpapers.mjs; usable alone).

  python3 -I tools/gen-finish-wallpapers.py prisme <out_dir> [nocturne-dark ...]   render the Prisme pictures
  python3 -I tools/gen-finish-wallpapers.py encode <in.png> <out.jpg>                dither + encode one picture

Prisme = aurora veils / gradient-mesh skies with a small moon or eclipse, ported from the mockup generator
(docs/design/mockups-mix/prisme/build/wallpapers.py) to 2560x1440, with a light and a dark variant per style.
Every picture is written as a progressive JPEG (quality 88, stepped down only if needed to stay under
MAX_BYTES), after a fine Gaussian dither so no gradient bands. Deterministic: every random draw is seeded.
"""
import io
import sys

import numpy as np
from PIL import Image

W, H = 2560, 1440
ASPECT = W / H
MAX_BYTES = 700 * 1024
X, Y = np.meshgrid(np.linspace(0, 1, W, dtype=np.float32), np.linspace(0, 1, H, dtype=np.float32))


# ------------------------------------------------------------------------------------------- encoding
def box_blur(a, r):
    """Box blur of radius r along both axes (float32, edges clamped); three passes approximate a Gaussian."""
    for axis in (0, 1):
        n = a.shape[axis]
        pad = [(0, 0)] * a.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(a, pad, mode='edge'), axis=axis, dtype=np.float64)
        a = ((np.take(c, range(2 * r + 1, 2 * r + 1 + n), axis=axis) - np.take(c, range(0, n), axis=axis)) / (2 * r + 1)).astype(np.float32)
    return a


def deband(a):
    """8-bit input (a rasterised SVG): where the picture is a smooth gradient (within ~1.5 LSB of its local mean),
    replace the 8-bit staircase by the local mean, which carries the sub-LSB slope; edges and details are kept."""
    b = a
    for _ in range(3):
        b = box_blur(b, 5)
    diff = np.abs(a - b).max(axis=2)
    m = np.clip(1 - (diff - 1.2 / 255) / (1.6 / 255), 0, 1)[..., None]
    return a * (1 - m) + b * m


def save_jpeg(img, path, grain=0.0, seed=0):
    """img: float (H, W, 3) in 0..1, or uint8 (debanded first). Adds `grain` (texture) + a ~1 LSB dither, writes a
    progressive JPEG."""
    r = np.random.default_rng(1000 + seed)
    a = deband(img.astype(np.float32) / 255.0) if img.dtype == np.uint8 else img.astype(np.float32)
    sigma = grain + 0.9 / 255
    a = a + r.normal(0, sigma, a.shape).astype(np.float32)
    px = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
    for q in (88, 86, 84, 82, 80, 78):
        buf = io.BytesIO()
        px.save(buf, 'JPEG', quality=q, progressive=True, optimize=True, subsampling='4:2:0')
        if buf.tell() <= MAX_BYTES:
            break
    with open(path, 'wb') as f:
        f.write(buf.getvalue())
    print(f'wrote {path}  {W}x{H}  q{q}  {buf.tell() // 1024} KB')


# ------------------------------------------------------------------------------------------- helpers
def hexrgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], dtype=np.float32)


def lerp_cols(stops, t):
    t = np.clip(t, 0, 1)
    pos = np.array([s[0] for s in stops])
    cols = np.array([hexrgb(s[1]) for s in stops])
    out = np.zeros(t.shape + (3,), dtype=np.float32)
    for c in range(3):
        out[..., c] = np.interp(t, pos, cols[:, c])
    return out


def smooth_noise_1d(x, seed, octaves=((3, 1.0), (7, 0.5), (17, 0.25), (41, 0.18), (97, 0.12))):
    r = np.random.default_rng(seed)
    v = np.zeros_like(x)
    tot = 0
    for f, a in octaves:
        v += a * np.sin(2 * np.pi * f * x + r.uniform(0, 6.28))
        tot += a
    return v / tot


def ribbon(cy, amp, freq, phase, w_up, w_down, streak=0.35, seed=0, tilt=0.0, env=(0.0, 1.0)):
    """Aurora curtain: sharp lower edge, long fade upward, vertical striations that follow the curve."""
    yc = cy + tilt * (X - 0.5) + amp * np.sin(2 * np.pi * freq * X + phase) + 0.35 * amp * np.sin(2 * np.pi * freq * 2.3 * X + phase * 1.7)
    d = Y - yc
    a = np.abs(np.minimum(d, 0))
    up = 0.5 * np.exp(-a / w_up) + 0.5 * np.exp(-a / (w_up * 0.22))
    down = np.exp(-(np.maximum(d, 0) / w_down) ** 2)
    prof = np.where(d < 0, up, down)
    s = smooth_noise_1d(X + 0.02 * np.sin(Y * 9 + seed), seed)
    stri = 1 - streak + streak * (0.5 + 0.5 * s) ** 1.5
    e0, e1 = env
    envx = np.clip((X - e0) / 0.18, 0, 1) * np.clip((e1 - X) / 0.18, 0, 1)
    envx = envx * envx * (3 - 2 * envx)
    envx *= 0.75 + 0.25 * smooth_noise_1d(X, seed + 5, ((1.3, 1), (2.7, 0.6)))
    return (prof * stri * envx).astype(np.float32), d


def glow(cx, cy, r, sharp=2.0):
    d = np.sqrt(((X - cx) * ASPECT) ** 2 + (Y - cy) ** 2)
    return np.exp(-(d / r) ** sharp).astype(np.float32)


def disc(cx, cy, r, soft=0.0012):
    d = np.sqrt(((X - cx) * ASPECT) ** 2 + (Y - cy) ** 2)
    return np.clip((r - d) / soft + 0.5, 0, 1).astype(np.float32), d


def sparkle_mask(cx, cy, size):
    dx = (X - cx) * ASPECT
    dy = Y - cy
    core = np.exp(-(dx ** 2 + dy ** 2) / (2 * (size * 0.12) ** 2))
    arm_h = np.exp(-(dy / (size * 0.018)) ** 2) * np.exp(-np.abs(dx) / (size * 0.9))
    arm_v = np.exp(-(dx / (size * 0.018)) ** 2) * np.exp(-np.abs(dy) / (size * 0.9))
    return (core + 0.6 * (arm_h + arm_v)).astype(np.float32)


def sparkle(img, cx, cy, size, col, strength=1.0):
    img += (sparkle_mask(cx, cy, size) * strength)[..., None] * col


def stars(img, n, seed, maxy=1.0, bright=0.8, col=None):
    r = np.random.default_rng(seed)
    n = int(n * (W * H) / (1920 * 1080))
    xs = r.integers(0, W, n)
    ys = np.clip((r.random(n) ** 1.6 * maxy * H).astype(int), 0, H - 1)
    b = r.random(n) ** 3 * bright
    c = np.ones(3, dtype=np.float32) if col is None else col
    for x, y, v in zip(xs, ys, b):
        img[y, x] += v * c
        if v > 0.3:
            for ddx, ddy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + ddy, x + ddx
                if 0 <= yy < H and 0 <= xx < W:
                    img[yy, xx] += v * 0.35 * c


def tonemap(acc, k=1.0):
    return 1 - np.exp(-k * acc)


def screen(a, b):
    return 1 - (1 - a) * (1 - b)


def over(img, col, a):
    """Paint `col` (rgb or image) over img with coverage `a` (H, W)."""
    a = np.clip(a, 0, 1)[..., None]
    return img * (1 - a) + col * a


def vignette(k, cx=0.5, cy=0.45, sx=1.3, sy=1.1):
    return (1 - k * (((X - cx) * sx) ** 2 + ((Y - cy) * sy) ** 2))[..., None]


# ------------------------------------------------------------------------------------------- Nocturne
def nocturne_dark():
    img = lerp_cols([(0, '#050A24'), (0.55, '#0A1440'), (1, '#0B0E2E')], Y)
    img += 0.10 * glow(0.15, 1.05, 0.7)[..., None] * hexrgb('#2A3FBF')
    stars(img, 900, 3, maxy=0.75, bright=0.9)
    acc = np.zeros((H, W, 3), dtype=np.float32)
    m, d = ribbon(0.62, 0.075, 0.9, 0.6, 0.20, 0.022, streak=0.55, seed=1, tilt=-0.18, env=(-0.1, 1.1))
    col = lerp_cols([(0, '#18E0FF'), (0.45, '#2F8BFF'), (0.8, '#7B4DFF'), (1, '#B04CFF')], X)
    top = lerp_cols([(0, '#4A5BFF'), (1, '#C04BFF')], X)
    mix = np.clip(-d / 0.22, 0, 1)[..., None]
    acc += (m[..., None] * (col * (1 - mix) + top * mix)) * 2.6
    m2, _ = ribbon(0.40, 0.06, 1.3, 2.4, 0.13, 0.016, streak=0.6, seed=2, tilt=0.12, env=(0.18, 1.05))
    acc += m2[..., None] * lerp_cols([(0, '#29F0D8'), (0.5, '#3A7BFF'), (1, '#9A5BFF')], X) * 1.6
    m3, _ = ribbon(0.82, 0.04, 0.7, 4.0, 0.16, 0.05, streak=0.4, seed=4, tilt=0.05, env=(-0.3, 0.95))
    acc += m3[..., None] * lerp_cols([(0, '#19E3C5'), (1, '#2A6BFF')], X) * 0.9
    img = img + tonemap(acc, 1.35) * 0.98
    md, _ = disc(0.835, 0.17, 0.034)
    img += glow(0.835, 0.17, 0.11, 1.4)[..., None] * hexrgb('#8FB8FF') * 0.35
    shade = np.clip(1 - 0.5 * np.clip(((X - 0.835) * ASPECT + 0.018) / 0.05, 0, 1), 0.5, 1)
    img = over(img, hexrgb('#F4F8FF') * (0.88 + 0.12 * shade[..., None]), md)
    sparkle(img, 0.23, 0.14, 0.05, hexrgb('#CFE8FF'), 0.9)
    sparkle(img, 0.70, 0.30, 0.03, hexrgb('#E2D6FF'), 0.7)
    return img * vignette(0.35), 0.010


def nocturne_light():
    # The same aurora at first light: an ice-blue sky, the veils painted in saturated cyan / blue / violet.
    img = lerp_cols([(0, '#A9BBFF'), (0.45, '#D3DCFF'), (1, '#E9ECFF')], Y)
    img = over(img, hexrgb('#C9B8FF'), glow(0.92, 0.10, 0.55) * 0.55)
    img = over(img, hexrgb('#BFEFFF'), glow(0.10, 0.95, 0.6) * 0.5)
    m, d = ribbon(0.62, 0.075, 0.9, 0.6, 0.20, 0.022, streak=0.55, seed=1, tilt=-0.18, env=(-0.1, 1.1))
    col = lerp_cols([(0, '#12C6EE'), (0.45, '#3478FF'), (0.8, '#6A4DF5'), (1, '#9C4DF0')], X)
    top = lerp_cols([(0, '#6E86FF'), (1, '#B77BFF')], X)
    mix = np.clip(-d / 0.22, 0, 1)[..., None]
    img = over(img, col * (1 - mix) + top * mix, tonemap(m, 3.2) * 0.92)
    m2, _ = ribbon(0.40, 0.06, 1.3, 2.4, 0.13, 0.016, streak=0.6, seed=2, tilt=0.12, env=(0.18, 1.05))
    img = over(img, lerp_cols([(0, '#22D8C4'), (0.5, '#4F86FF'), (1, '#9A6BFF')], X), tonemap(m2, 2.4) * 0.72)
    m3, _ = ribbon(0.82, 0.04, 0.7, 4.0, 0.16, 0.05, streak=0.4, seed=4, tilt=0.05, env=(-0.3, 0.95))
    img = over(img, lerp_cols([(0, '#2FD8C0'), (1, '#4C7DFF')], X), tonemap(m3, 1.2) * 0.42)
    # bright cores of the curtains (the light edge of an aurora)
    img = screen(img, np.clip(m[..., None] ** 3 * hexrgb('#FFFFFF') * 0.2, 0, 1))
    md, _ = disc(0.835, 0.17, 0.034)
    img = screen(img, glow(0.835, 0.17, 0.11, 1.4)[..., None] * hexrgb('#FFFFFF') * 0.55)
    rim, _ = disc(0.835, 0.17, 0.0365)
    img = over(img, hexrgb('#9FB2F2'), rim * 0.55)
    img = over(img, hexrgb('#FFFFFF'), md)
    img = screen(img, np.clip(sparkle_mask(0.23, 0.14, 0.05)[..., None] * hexrgb('#FFFFFF') * 0.8, 0, 1))
    img = screen(img, np.clip(sparkle_mask(0.70, 0.30, 0.03)[..., None] * hexrgb('#FFFFFF') * 0.6, 0, 1))
    return img, 0.008


# ------------------------------------------------------------------------------------------- Eclipse
def eclipse_corona(img, cx, cy, r, ring_col, corona_col, disc_col, ring_k=1.4, corona_k=0.55, additive=True):
    md, dd = disc(cx, cy, r)
    ring = np.exp(-((dd - r) / 0.0045) ** 2)
    corona = np.exp(-np.maximum(dd - r, 0) / 0.05) * (dd > r)
    ang = np.arctan2(Y - cy, (X - cx) * ASPECT)
    rays = 0.75 + 0.25 * np.sin(ang * 23 + 0.4) * np.sin(ang * 7)
    if additive:
        img = img + (ring * ring_k)[..., None] * ring_col + (corona * rays * corona_k)[..., None] * corona_col
    else:
        img = over(img, corona_col, corona * rays * corona_k)
        img = over(img, ring_col, ring * ring_k)
    return over(img, disc_col, md)


def eclipse_dark():
    img = lerp_cols([(0, '#07050A'), (1, '#0B0608')], Y)
    stars(img, 380, 9, maxy=1.0, bright=0.5)
    acc = np.zeros((H, W, 3), dtype=np.float32)
    m, _ = ribbon(0.70, 0.10, 0.6, 1.1, 0.26, 0.09, streak=0.25, seed=11, tilt=-0.35, env=(-0.2, 1.2))
    acc += m[..., None] * lerp_cols([(0, '#FFC24A'), (0.4, '#FF7A2E'), (0.75, '#E0306E'), (1, '#B0249A')], X) * 2.3
    m2, _ = ribbon(0.50, 0.09, 0.8, 3.3, 0.12, 0.03, streak=0.35, seed=12, tilt=-0.25, env=(0.0, 1.0))
    acc += m2[..., None] * lerp_cols([(0, '#FFD36A'), (0.6, '#FF9440'), (1, '#FF4F7A')], X) * 1.5
    m3, _ = ribbon(0.88, 0.05, 1.1, 5.0, 0.10, 0.05, streak=0.3, seed=13, tilt=-0.1, env=(0.35, 1.25))
    acc += m3[..., None] * hexrgb('#D0237E') * 1.0
    img = img + tonemap(acc, 1.15) * 0.97
    cx, cy, r = 0.20, 0.20, 0.065
    img = eclipse_corona(img, cx, cy, r, hexrgb('#FFE2A0'), hexrgb('#FFAA44'), hexrgb('#050307'))
    ga = 2.35
    sparkle(img, cx + np.cos(ga) * r / ASPECT, cy + np.sin(ga) * r, 0.045, hexrgb('#FFF1CF'), 1.4)
    sparkle(img, 0.86, 0.14, 0.025, hexrgb('#FFD9A8'), 0.6)
    return img * vignette(0.40, cy=0.5, sx=1.25), 0.010


def eclipse_light():
    # Golden hour: cream and apricot sky, the silk veils in saturated gold / copper / magenta, an eclipse with a
    # bright ring (a plum disc, not black, so it sits in a light sky).
    img = lerp_cols([(0, '#FBE3C4'), (0.5, '#FDEFDC'), (1, '#F9DCCF')], Y)
    img = over(img, hexrgb('#FFD08A'), glow(0.18, 0.18, 0.45) * 0.45)
    img = over(img, hexrgb('#F7B8D2'), glow(0.95, 0.95, 0.55) * 0.45)
    m, _ = ribbon(0.70, 0.10, 0.6, 1.1, 0.26, 0.09, streak=0.25, seed=11, tilt=-0.35, env=(-0.2, 1.2))
    img = over(img, lerp_cols([(0, '#F7A928'), (0.4, '#F26A21'), (0.75, '#D92B6A'), (1, '#A8279A')], X), tonemap(m, 2.6) * 0.88)
    m2, _ = ribbon(0.50, 0.09, 0.8, 3.3, 0.12, 0.03, streak=0.35, seed=12, tilt=-0.25, env=(0.0, 1.0))
    img = over(img, lerp_cols([(0, '#FFC23D'), (0.6, '#FF8A33'), (1, '#F2456F')], X), tonemap(m2, 1.6) * 0.62)
    m3, _ = ribbon(0.88, 0.05, 1.1, 5.0, 0.10, 0.05, streak=0.3, seed=13, tilt=-0.1, env=(0.35, 1.25))
    img = over(img, hexrgb('#CF2A7E'), tonemap(m3, 1.0) * 0.45)
    img = screen(img, np.clip(m[..., None] ** 3 * hexrgb('#FFF4D6') * 0.4, 0, 1))
    cx, cy, r = 0.20, 0.20, 0.065
    img = eclipse_corona(img, cx, cy, r, hexrgb('#FFFBEA'), hexrgb('#F59E2E'), hexrgb('#3A2030'), ring_k=1.0, corona_k=0.55, additive=False)
    ga = 2.35
    img = screen(img, np.clip(sparkle_mask(cx + np.cos(ga) * r / ASPECT, cy + np.sin(ga) * r, 0.045)[..., None] * hexrgb('#FFFFFF') * 1.2, 0, 1))
    img = screen(img, np.clip(sparkle_mask(0.86, 0.14, 0.025)[..., None] * hexrgb('#FFFFFF') * 0.6, 0, 1))
    return img, 0.008


# ------------------------------------------------------------------------------------------- Clair de lune
def clairdelune_light():
    img = lerp_cols([(0, '#B9A2FA'), (0.45, '#F7B3D8'), (0.8, '#FFC9AE'), (1, '#FFDCC0')], Y)
    for cx, cy, r, c, a in [(0.12, 0.25, 0.45, '#9C7BFF', 0.65), (0.85, 0.10, 0.40, '#9FB0FF', 0.45), (0.60, 0.70, 0.50, '#FF8DBE', 0.65),
                            (0.20, 0.90, 0.45, '#FFAA85', 0.65), (0.95, 0.85, 0.35, '#FFC6A8', 0.45)]:
        img = over(img, hexrgb(c), glow(cx, cy, r) * a)
    m, _ = ribbon(0.58, 0.08, 0.7, 0.3, 0.22, 0.05, streak=0.3, seed=21, tilt=-0.22, env=(-0.2, 1.2))
    img = screen(img, np.clip(m[..., None] * lerp_cols([(0, '#FF8FB8'), (0.5, '#E59BFF'), (1, '#FFB48A')], X) * 0.9, 0, 1))
    m2, _ = ribbon(0.36, 0.06, 1.0, 2.0, 0.12, 0.02, streak=0.45, seed=22, tilt=0.15, env=(0.1, 1.1))
    img = screen(img, np.clip(m2[..., None] * hexrgb('#FFF4FB') * 0.7, 0, 1))
    m3, _ = ribbon(0.80, 0.05, 0.9, 4.2, 0.10, 0.04, streak=0.35, seed=23, tilt=-0.1, env=(-0.1, 0.8))
    img = screen(img, np.clip(m3[..., None] * hexrgb('#FFD0B0') * 0.6, 0, 1))
    md, _ = disc(0.80, 0.18, 0.040)
    cut, _ = disc(0.812, 0.170, 0.036)
    img = screen(img, glow(0.80, 0.18, 0.12, 1.5)[..., None] * hexrgb('#FFFFFF') * 0.35)
    img = over(img, hexrgb('#FFFDF8'), np.clip(md - cut, 0, 1) * 0.92)
    sparkle(img, 0.30, 0.12, 0.035, hexrgb('#FFFFFF'), 0.55)
    sparkle(img, 0.66, 0.08, 0.022, hexrgb('#FFFFFF'), 0.45)
    return img, 0.009


def clairdelune_dark():
    # The same dawn sky after dusk: deep violet to plum, the mesh glows kept as coloured light, the veils luminous.
    img = lerp_cols([(0, '#1C1340'), (0.45, '#2E1747'), (0.8, '#3D1B3E'), (1, '#45203A')], Y)
    for cx, cy, r, c, a in [(0.12, 0.25, 0.45, '#5B3FC4', 0.55), (0.85, 0.10, 0.40, '#3E4BB0', 0.40), (0.60, 0.70, 0.50, '#B0397A', 0.45),
                            (0.20, 0.90, 0.45, '#B55A45', 0.40), (0.95, 0.85, 0.35, '#9A4A5A', 0.35)]:
        img = over(img, hexrgb(c), glow(cx, cy, r) * a)
    stars(img, 700, 31, maxy=0.6, bright=0.7, col=hexrgb('#F4E9FF'))
    acc = np.zeros((H, W, 3), dtype=np.float32)
    m, _ = ribbon(0.58, 0.08, 0.7, 0.3, 0.22, 0.05, streak=0.3, seed=21, tilt=-0.22, env=(-0.2, 1.2))
    acc += m[..., None] * lerp_cols([(0, '#FF6FA8'), (0.5, '#C77BFF'), (1, '#FF9A6A')], X) * 1.9
    m2, _ = ribbon(0.36, 0.06, 1.0, 2.0, 0.12, 0.02, streak=0.45, seed=22, tilt=0.15, env=(0.1, 1.1))
    acc += m2[..., None] * hexrgb('#E8C8FF') * 0.9
    m3, _ = ribbon(0.80, 0.05, 0.9, 4.2, 0.10, 0.04, streak=0.35, seed=23, tilt=-0.1, env=(-0.1, 0.8))
    acc += m3[..., None] * hexrgb('#FFA27A') * 0.8
    img = img + tonemap(acc, 1.2) * 0.9
    md, _ = disc(0.80, 0.18, 0.040)
    cut, _ = disc(0.812, 0.170, 0.036)
    img += glow(0.80, 0.18, 0.12, 1.5)[..., None] * hexrgb('#E9D5FF') * 0.22
    img = over(img, hexrgb('#FFF3E6'), np.clip(md - cut, 0, 1) * 0.96)
    sparkle(img, 0.30, 0.12, 0.035, hexrgb('#FFE9F6'), 0.7)
    sparkle(img, 0.66, 0.08, 0.022, hexrgb('#F0E4FF'), 0.55)
    return img * vignette(0.25), 0.010


PRISME = {
    'nocturne-dark': nocturne_dark, 'nocturne-light': nocturne_light,
    'eclipse-dark': eclipse_dark, 'eclipse-light': eclipse_light,
    'clairdelune-dark': clairdelune_dark, 'clairdelune-light': clairdelune_light,
}

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'encode' and len(sys.argv) == 4:
        src = np.asarray(Image.open(sys.argv[2]).convert('RGB'))
        if src.shape[:2] != (H, W):
            sys.exit(f'{sys.argv[2]}: expected {W}x{H}, got {src.shape[1]}x{src.shape[0]}')
        save_jpeg(src, sys.argv[3], grain=0.007, seed=sum(map(ord, sys.argv[3])))
    elif cmd == 'prisme' and len(sys.argv) >= 3:
        out = sys.argv[2]
        for i, name in enumerate(sys.argv[3:] or list(PRISME)):
            img, grain = PRISME[name]()
            save_jpeg(img, f'{out}/prisme-{name}.jpg', grain=grain, seed=i)
    else:
        sys.exit(__doc__)
