# -*- coding: utf-8 -*-
"""CSS shorthand filter functions, per the Filter Effects spec.

WHY THIS EXISTS. Dino Park's mutations are CSS filters, so the only way to
check one off-line -- in a build, in a test -- is to compute what the
browser would draw. This is that computation, and it is not a guess: every
function here was validated against Chromium's own Canvas2D `ctx.filter` by
pushing six colours through all eight mutation filters and comparing. The
worst channel disagreed by 3/255.

Two details earn their keep, both found by that comparison:

  sRGB, NOT LINEAR RGB. SVG filter primitives default to linearRGB; the CSS
  shorthand functions specify sRGB. Getting this wrong is not subtle.

  QUANTISED BETWEEN PRIMITIVES. The browser chains filters through an 8-bit
  surface, so intermediate values round. Carrying full precision through the
  chain puts `golden` 3/255 off; clamping only at the end puts it 93 off,
  because sepia(1) followed by brightness(1.3) overflows and has to be
  clipped before the saturate that follows can see it.
"""
import numpy as np, math, re

SEPIA = np.array([[0.393,0.769,0.189],[0.349,0.686,0.168],[0.272,0.534,0.131]])
LUM = (0.213, 0.715, 0.072)

def _saturate(s):
    r,g,b = LUM
    return np.array([
        [r+(1-r)*s, g-g*s,     b-b*s],
        [r-r*s,     g+(1-g)*s, b-b*s],
        [r-r*s,     g-g*s,     b+(1-b)*s]])

def _hue(deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([
        [0.213+c*0.787-s*0.213, 0.715-c*0.715-s*0.715, 0.072-c*0.072+s*0.928],
        [0.213-c*0.213+s*0.143, 0.715+c*0.285+s*0.140, 0.072-c*0.072-s*0.283],
        [0.213-c*0.213-s*0.787, 0.715-c*0.715+s*0.715, 0.072+c*0.928+s*0.072]])

def apply_filter(rgba, spec):
    """rgba: float array (...,4) in 0..1. Returns a new array."""
    out = rgba.copy()
    for fn, arg in re.findall(r'([a-z-]+)\(([^)]*)\)', spec):
        v = arg.strip()
        num = float(v[:-3]) if v.endswith('deg') else (float(v[:-1])/100 if v.endswith('%') else float(v or 1))
        c = out[..., :3]
        if fn == 'brightness':
            c = c * num
        elif fn == 'contrast':
            c = c * num + (0.5 - 0.5*num)
        elif fn == 'opacity':
            out[..., 3] = np.rint(np.clip(out[..., 3] * num, 0, 1) * 255) / 255.0
            continue
        elif fn == 'saturate':
            c = c @ _saturate(num).T
        elif fn == 'hue-rotate':
            c = c @ _hue(num).T
        elif fn == 'sepia':
            m = (1-num)*np.eye(3) + num*SEPIA
            c = c @ m.T
        else:
            raise ValueError('unhandled filter: ' + fn)
        # Quantised to 8 bits between primitives, because the browser
        # chains them through an 8-bit surface and the difference shows:
        # without this, golden lands 3/255 off.
        out[..., :3] = np.rint(np.clip(c, 0, 1) * 255) / 255.0
    return out
