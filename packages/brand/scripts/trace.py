"""Trace a flat single-colour PNG silhouette into a compact SVG path.

The mark is a hard-edged geometric shape, so the pixel mask's "crack" boundary
(the polyline running between inside and outside pixels) IS the true outline,
staircased only where an edge is diagonal. Ramer-Douglas-Peucker then collapses
those staircases back into the straight segments they came from.
"""
import sys
from PIL import Image

def mask_of(path, thresh=128):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    a = im.getchannel("A").load()
    return w, h, [[a[x, y] >= thresh for x in range(w)] for y in range(h)]

def loops(w, h, m):
    """Collect boundary cracks as directed unit edges, then link into loops.

    Direction convention keeps the inside on the left, so outer contours come out
    counter-clockwise and holes clockwise -- which evenodd fill then renders right.
    """
    nxt = {}
    def inside(x, y):
        return 0 <= x < w and 0 <= y < h and m[y][x]
    for y in range(h):
        for x in range(w):
            if not inside(x, y):
                continue
            if not inside(x, y - 1): nxt.setdefault((x, y), []).append((x + 1, y))          # top
            if not inside(x + 1, y): nxt.setdefault((x + 1, y), []).append((x + 1, y + 1))  # right
            if not inside(x, y + 1): nxt.setdefault((x + 1, y + 1), []).append((x, y + 1))  # bottom
            if not inside(x - 1, y): nxt.setdefault((x, y + 1), []).append((x, y))          # left
    out = []
    while nxt:
        start = next(iter(nxt))
        loop, cur = [start], start
        while True:
            succ = nxt.get(cur)
            if not succ:
                break
            nb = succ.pop()
            if not succ:
                del nxt[cur]
            loop.append(nb)
            cur = nb
            if cur == start:
                break
        if len(loop) > 3:
            out.append(loop)
    return out

def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    n = (dx * dx + dy * dy) ** 0.5
    worst, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = (abs(dy * px - dx * py + x2 * y1 - y2 * x1) / n) if n else ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5
        if d > worst:
            worst, idx = d, i
    if worst > eps:
        return rdp(pts[: idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]

def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s if s else "0"

def main(src, dst, eps):
    """Emit JSON {w, h, d} so callers can wrap the path in whatever SVG they need."""
    import json
    w, h, m = mask_of(src)
    parts = []
    for loop in loops(w, h, m):
        simp = rdp(loop[:-1] + [loop[0]], eps)   # closed: RDP over the full cycle
        if len(simp) < 4:
            continue
        pts = simp[:-1]
        parts.append("M" + " ".join(f"{fmt(x)},{fmt(y)}" for x, y in pts) + "Z")
    d = "".join(parts)
    json.dump({"w": w, "h": h, "d": d}, open(dst, "w"))
    print(f"traced {len(parts)} contour(s), {d.count(',')} points, {len(d)} bytes of path data")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], float(sys.argv[3]))
