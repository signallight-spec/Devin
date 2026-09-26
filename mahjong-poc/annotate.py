"""Render annotated video: each seat's discards fill a logical 6x3 pond
table (the layout real discards use), not physical positions.
Cell fill order = discard order. Red = tedashi, cyan = tsumogiri,
gray ? = opponent discard (their row isn't visible, so unclassifiable)."""
import cv2
import numpy as np
import json, os, sys

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "videos/sample1_x264.mp4"
STEM = os.path.splitext(os.path.basename(VIDEO))[0]
OUTDIR = os.path.join("results", STEM)
OUT = os.path.join(OUTDIR, "annotated.mp4")
F_LOG = os.path.join(OUTDIR, "log3.json")
F_META = os.path.join(OUTDIR, "log3.meta.json")
F_EVENTS = os.path.join(OUTDIR, "events.json")
F_MARKS = os.path.join(OUTDIR, "markers.json")

# Per-video layouts. 'default': tables stacked on the left margin.
# 'sample2' (split screen): tables sit over the face-cam quadrant in a
# diamond matching the seats — across top, left/right seats at the sides,
# self at the bottom — so they never cover the top-down table panel.
PROFILES = {
    "sample2": dict(
        R_POND=(180, 250, 500, 640),
        CELL_H=34,
        TABLE_POS={"across": (825, 80), "left": (665, 215),
                   "right": (990, 215), "self": (825, 330),
                   "unknown": (665, 350)},
        # same wall strips as pipeline3 — empty walls = round transition
        WALLS=[(150, 120, 540, 190), (55, 200, 115, 560),
               (560, 200, 650, 560)],
    ),
}
_name = os.path.basename(VIDEO)
_prof = next((p for k, p in PROFILES.items() if k in _name), {})

R_POND = _prof.get("R_POND", (600, 390, 990, 500))
R_HAND = _prof.get("R_HAND", (170, 545, 1240, 660))
CELL_W = 46
CELL_H = _prof.get("CELL_H", 40)
TABLE_POS = _prof.get("TABLE_POS")
WALLS = _prof.get("WALLS")
WALL_TH = 0.01
SWEEP_MIN = 5

LEGEND = {"tedashi": (0, 0, 255), "tsumogiri": (255, 200, 0), "tsumogiri?": (200, 200, 0)}
# display order mirrors the table: across seat at top, self at bottom.
# 'unknown' gets its own table — borrowing a seat's table would consume a
# cell position and shift that seat's real discards (cells ARE order)
PLAYERS = ([("across", "across"), ("left", "left"), ("right", "right"),
            ("self", "near player"), ("unknown", "unknown")]
           if TABLE_POS else
           [("across", "across"), ("right", "right"),
            ("self", "near player"), ("unknown", "unknown")])


def draw_table(img, cells, ox, oy, title):
    """Draw a 6-wide discard table at (ox, oy): 3 rows, +1 on overflow.
    cells = list of labels ('noisy'/'uncertain' shown as neutral '?')."""
    nrows = 3 + (1 if len(cells) > 18 else 0)
    cap_cells = nrows * 6
    W = 6 * CELL_W + 2
    H = nrows * CELL_H + 26
    sub = img[oy:oy + H, ox:ox + W]
    img[oy:oy + H, ox:ox + W] = cv2.addWeighted(sub, 0.4, np.zeros_like(sub), 0.6, 0)
    cv2.rectangle(img, (ox, oy), (ox + W, oy + H), (140, 140, 140), 1)
    cv2.putText(img, title, (ox + 4, oy + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    for r in range(nrows):
        for c in range(6):
            x0 = ox + 1 + c * CELL_W
            y0 = oy + 24 + r * CELL_H
            cv2.rectangle(img, (x0, y0), (x0 + CELL_W, y0 + CELL_H), (90, 90, 90), 1)
    for i, label in enumerate(cells[:cap_cells]):
        r, c = divmod(i, 6)
        x0 = ox + 1 + c * CELL_W
        y0 = oy + 24 + r * CELL_H
        color = LEGEND.get(label, (128, 128, 128))
        cv2.rectangle(img, (x0 + 2, y0 + 2), (x0 + CELL_W - 2, y0 + CELL_H - 2), color, -1)
        letter = {"tedashi": "T", "tsumogiri": "M", "tsumogiri?": "M?"}.get(label, "?")
        cv2.putText(img, letter, (x0 + 10, y0 + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                    (255, 255, 255), 2)
    if len(cells) > cap_cells:
        cv2.putText(img, f"+{len(cells) - cap_cells}", (ox + W - 32, oy + H - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)


def main():
    # refuse to overlay results generated for a different video
    meta = json.load(open(F_META)) if os.path.exists(F_META) else None
    st = os.stat(VIDEO)
    if not (meta and meta.get("video") == VIDEO and meta.get("size") == st.st_size
            and meta.get("mtime") == st.st_mtime_ns):
        sys.exit(f"results were generated for another video; run pipeline3.py on {VIDEO} first")
    if meta.get("partial"):
        print("warning: feature log is from a truncated decode — sweep "
              "detection past the truncation point may be incomplete",
              file=sys.stderr)
    if not os.path.exists(F_EVENTS):
        sys.exit("events.json is missing or stale (pipeline3.py was interrupted); rerun it first")
    events = json.load(open(F_EVENTS))
    marks = []  # (t_shown, label, player) — table cells fill in discard order
    for i, ev in enumerate(events):
        # keep a placeholder for unclassified discards: a cell position IS
        # the discard index, so skipping would shift every later discard
        # display time = just after the discard lands (t1). ta is only
        # classification evidence and can fall past a sweep start, which
        # would hide the discard entirely
        marks.append({"t": ev["t1"] + 0.4, "label": ev["label"],
                      "player": ev.get("player", "self")})
    print(f"{len(marks)} cells")

    log = json.load(open(F_LOG))
    if WALLS:
        # overhead profile: transitions show as all wall strips empty
        spans, cur = [], None
        for e in log:
            if e.get("walls", 1.0) < WALL_TH:
                cur = [e["t"], e["t"]] if cur is None else [cur[0], e["t"]]
            else:
                if cur: spans.append(cur); cur = None
        if cur: spans.append(cur)
        SWEEPS = [s for s in spans if s[1] - s[0] > SWEEP_MIN]
    else:
        # sweep intervals = long merged skin-in-pond episodes (deal phases)
        eps, cur = [], None
        for e in log:
            if e["skin_pond"] > 0.25:
                if cur is None: cur = [e["t"], e["t"]]
                else: cur[1] = e["t"]
            else:
                if cur: eps.append(cur); cur = None
        if cur: eps.append(cur)
        # merge adjacent episodes first (same rule as pipeline3), then keep
        # intervals long enough to be deal/transition phases
        merged = []
        for a, b in eps:
            if merged and a - merged[-1][1] < 1.5: merged[-1][1] = b
            else: merged.append([a, b])
        # same transition gate as pipeline3 (>8s), else a 6-8s episode could
        # be emitted as an event yet cleared here as a transition
        SWEEPS = [m for m in merged if m[1] - m[0] > 8]
    print("sweep intervals:", [[round(a, 1), round(b, 1)] for a, b in SWEEPS])

    cap = cv2.VideoCapture(VIDEO)
    fps = cap.get(cv2.CAP_PROP_FPS) or 60
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    os.makedirs(OUTDIR, exist_ok=True)
    out = cv2.VideoWriter(OUT, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
    idx = 0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        t = idx / fps
        idx += 1
        in_sweep = any(a - 1 <= t <= b + 1 for a, b in SWEEPS)
        # rebuild the table each frame: cells are the discards since the end
        # of the last finished sweep (a mark inside a sweep never shows)
        sweep_end = max([b for a, b in SWEEPS if b + 1 <= t] or [-1])
        placed = [] if in_sweep else [m for m in marks
                                    if m["t"] <= t and m["t"] > sweep_end]
        cv2.rectangle(img, (R_POND[0], R_POND[1]), (R_POND[2], R_POND[3]), (80, 80, 80), 1)
        # one table per seat — stacked on the left margin, or at fixed
        # seat-mirroring positions when the profile defines them
        oy = 8
        for key, title in PLAYERS:
            cells = [m["label"] for m in placed if m["player"] == key]
            # the unknown table sits lowest and would dim the near player's
            # hand band even when empty — only draw it when it has cells
            if key == "unknown" and not cells:
                continue
            tx, ty = TABLE_POS[key] if TABLE_POS else (15, oy)
            draw_table(img, cells, tx, ty, title)
            oy += (4 if len(cells) > 18 else 3) * CELL_H + 26 + 8
            if key == "self":
                nt = sum(1 for c in cells if c == "tedashi")
                nm = sum(1 for c in cells if c.startswith("tsumogiri"))
                cx, cy = ((tx + 4, ty + (4 if len(cells) > 18 else 3) * CELL_H + 26 + 18)
                          if TABLE_POS else (15 + 6 * CELL_W + 12, oy - 14))
                cv2.putText(img, f"tedashi={nt}  tsumogiri={nm}",
                            (cx, cy),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        out.write(img)
    out.release()
    cap.release()
    json.dump(marks, open(F_MARKS, "w"), indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
