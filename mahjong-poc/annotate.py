"""Render annotated video: discards are shown on a logical 6x3 pond table
(the layout real discards use), not overlaid on physical positions.
Cell fill order = discard order. Red = tedashi, cyan = tsumogiri."""
import cv2
import numpy as np
import json, sys

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "videos/sample1_x264.mp4"
OUT = "annotated.mp4"
R_POND = (600, 390, 990, 500)
R_HAND = (170, 545, 1240, 660)
CELL_W, CELL_H = 46, 40

LEGEND = {"tedashi": (0, 0, 255), "tsumogiri": (255, 200, 0), "tsumogiri?": (200, 200, 0)}


def draw_table(img, cells, ox, oy, title):
    """Draw one 6x3 discard table at (ox, oy). cells = list of labels."""
    W = 6 * CELL_W + 2
    H = 3 * CELL_H + 26
    sub = img[oy:oy + H, ox:ox + W]
    img[oy:oy + H, ox:ox + W] = cv2.addWeighted(sub, 0.4, np.zeros_like(sub), 0.6, 0)
    cv2.rectangle(img, (ox, oy), (ox + W, oy + H), (140, 140, 140), 1)
    cv2.putText(img, title, (ox + 4, oy + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    for r in range(3):
        for c in range(6):
            x0 = ox + 1 + c * CELL_W
            y0 = oy + 24 + r * CELL_H
            cv2.rectangle(img, (x0, y0), (x0 + CELL_W, y0 + CELL_H), (90, 90, 90), 1)
    for i, label in enumerate(cells):
        r, c = divmod(i, 6)
        if r > 2:
            break
        x0 = ox + 1 + c * CELL_W
        y0 = oy + 24 + r * CELL_H
        color = LEGEND.get(label, (128, 128, 128))
        cv2.rectangle(img, (x0 + 2, y0 + 2), (x0 + CELL_W - 2, y0 + CELL_H - 2), color, -1)
        letter = "T" if label == "tedashi" else ("M" if label == "tsumogiri" else "M?")
        cv2.putText(img, letter, (x0 + 10, y0 + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                    (255, 255, 255), 2)


def main():
    events = json.load(open("events.json"))
    marks = []  # (t_shown, label) — table cells fill in discard order
    for i, ev in enumerate(events):
        if ev["label"] in ("noisy", "uncertain"):
            continue
        marks.append({"t": ev["ta"], "label": ev["label"]})
    print(f"{len(marks)} cells")

    # sweep intervals = long merged skin-in-pond episodes (deal/transition)
    log = json.load(open("log3.json"))
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
    SWEEPS = [m for m in merged if m[1] - m[0] > 6]
    print("sweep intervals:", [[round(a, 1), round(b, 1)] for a, b in SWEEPS])

    cap = cv2.VideoCapture(VIDEO)
    fps = cap.get(cv2.CAP_PROP_FPS) or 60
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    out = cv2.VideoWriter(OUT, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
    placed = []
    next_i = 0
    idx = 0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        t = idx / fps
        idx += 1
        while next_i < len(marks) and marks[next_i]["t"] <= t:
            placed.append(marks[next_i]); next_i += 1
        # clear the table inside deal/sweep gaps (long hand-in-pond episodes)
        if any(a - 1 <= t <= b + 1 for a, b in SWEEPS):
            placed = []
        cv2.rectangle(img, (R_POND[0], R_POND[1]), (R_POND[2], R_POND[3]), (80, 80, 80), 1)
        draw_table(img, [m["label"] for m in placed], 15, H - 165, "near player")
        nt = sum(1 for m in placed if m["label"] == "tedashi")
        nm = sum(1 for m in placed if m["label"].startswith("tsumogiri"))
        cv2.putText(img, f"tedashi={nt}  tsumogiri={nm}", (300, H - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        out.write(img)
    out.release()
    cap.release()
    json.dump(marks, open("markers.json", "w"), indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
