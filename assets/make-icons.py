"""Draws the browzat logo: assets/logo.svg and the extension icons extension/icons/icon-{16,32,48,128}.png.

Run from the repository root:  python assets/make-icons.py   (needs Pillow)
The PNGs are drawn at 8x and scaled down, so edges stay smooth. 16 px uses a simpler mark (only the prompt),
because the window outline would blur at that size.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG, BORDER, GREEN, WHITE = "#0d1117", "#30363d", "#3fb950", "#e6edf3"

# Geometry on a 128 x 128 canvas.
FULL = {
    "radius": 28,
    "window": (18, 24, 110, 104), "window_r": 12, "stroke": 8,
    "bar_y": 46, "dots": [(30, 35), (42, 35), (54, 35)], "dot_r": 3.5,
    "chevron": [(36, 62), (54, 75), (36, 88)], "underscore": ((62, 88), (90, 88)), "glyph": 9,
}
SMALL = {
    "radius": 28,
    "chevron": [(26, 34), (58, 64), (26, 94)], "underscore": ((66, 94), (102, 94)), "glyph": 18,
}


def svg(g):
    x0, y0, x1, y1 = g["window"]
    (ux0, uy), (ux1, _) = g["underscore"]
    chev = " ".join(f"{x},{y}" for x, y in g["chevron"])
    dots = "".join(f'<circle cx="{x}" cy="{y}" r="{g["dot_r"]}" fill="{GREEN}"/>' for x, y in g["dots"])
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="browzat">
  <rect x="1" y="1" width="126" height="126" rx="{g['radius']}" fill="{BG}" stroke="{BORDER}" stroke-width="2"/>
  <rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{g['window_r']}" fill="none" stroke="{GREEN}" stroke-width="{g['stroke']}"/>
  <line x1="{x0}" y1="{g['bar_y']}" x2="{x1}" y2="{g['bar_y']}" stroke="{GREEN}" stroke-width="{g['stroke'] - 2}"/>
  {dots}
  <polyline points="{chev}" fill="none" stroke="{GREEN}" stroke-width="{g['glyph']}" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="{ux0}" y1="{uy}" x2="{ux1}" y2="{uy}" stroke="{WHITE}" stroke-width="{g['glyph']}" stroke-linecap="round"/>
</svg>
"""


def png(g, size):
    k = 8 * size / 128  # draw at 8x the target size
    S = lambda v: v * k
    img = Image.new("RGBA", (size * 8, size * 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((S(1), S(1), S(127), S(127)), radius=S(g["radius"]), fill=BG, outline=BORDER, width=max(1, round(S(2))))
    if "window" in g:
        x0, y0, x1, y1 = g["window"]
        d.rounded_rectangle((S(x0), S(y0), S(x1), S(y1)), radius=S(g["window_r"]), outline=GREEN, width=round(S(g["stroke"])))
        d.line((S(x0), S(g["bar_y"]), S(x1), S(g["bar_y"])), fill=GREEN, width=round(S(g["stroke"] - 2)))
        for x, y in g["dots"]:
            r = g["dot_r"]
            d.ellipse((S(x - r), S(y - r), S(x + r), S(y + r)), fill=GREEN)
    w = round(S(g["glyph"]))
    pts = [(S(x), S(y)) for x, y in g["chevron"]]
    d.line(pts, fill=GREEN, width=w, joint="curve")
    for x, y in (pts[0], pts[-1]):
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=GREEN)
    (ux0, uy), (ux1, _) = g["underscore"]
    d.line((S(ux0), S(uy), S(ux1), S(uy)), fill=WHITE, width=w)
    for x in (ux0, ux1):
        d.ellipse((S(x) - w / 2, S(uy) - w / 2, S(x) + w / 2, S(uy) + w / 2), fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(os.path.join(ROOT, "extension", "icons"), exist_ok=True)
    with open(os.path.join(ROOT, "assets", "logo.svg"), "w", encoding="utf-8", newline="\n") as f:
        f.write(svg(FULL))
    for size in (16, 32, 48, 128):
        png(SMALL if size == 16 else FULL, size).save(os.path.join(ROOT, "extension", "icons", f"icon-{size}.png"))
    png(FULL, 256).save(os.path.join(ROOT, "assets", "logo-256.png"))
    print("wrote assets/logo.svg, assets/logo-256.png, extension/icons/icon-{16,32,48,128}.png")


if __name__ == "__main__":
    main()
