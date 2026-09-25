"""Render annotated video: each discard gets a persistent marker at the
pond position where the new tile landed. Red = tedashi, cyan = tsumogiri."""
import cv2
import numpy as np
import json, sys

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "videos/sample1_x264.mp4"
OUT = "annotated.mp4"
R_POND = (600, 390, 990, 500)
R_HAND = (170, 545, 1240, 660)

def tile_mask(img):
    """tile-ish pixels (white body or saturated orange set) inside R_POND."""
    x0, y0, x1, y1 = R_POND
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    white = (v > 150) & (s < 70)
    orange = (h >= 4) & (h <= 28) & (s > 140) & (v > 150)
    return (white | orange)[y0:y1, x0:x1]

def find_new_tile(img_b, img_a):
    """largest changed blob between before/after pond crops -> bbox."""
    mb, ma = tile_mask(img_b), tile_mask(img_a)
    new = ma.astype(np.uint8) & (~mb).astype(np.uint8)
    new = cv2.morphologyEx(new, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(new)
    if n < 2:
        return None
    i = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    x, y, w, h, a = stats[i]
    if a < 300:
        return None
    return int(x + w / 2) + R_POND[0], int(y + h / 2) + R_POND[1]

def main():
    events = json.load(open("events.json"))
    markers = []  # (t_placed, x, y, label)
    cap = cv2.VideoCapture(VIDEO)
    fps = cap.get(cv2.CAP_PROP_FPS) or 60
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    out = cv2.VideoWriter(OUT, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))

    for ev in events:
        if ev["label"] in ("noisy", "uncertain"):
            continue
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(ev["tb"] * fps))
        ok, fb = cap.read()
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(ev["ta"] * fps))
        ok2, fa = cap.read()
        if not (ok and ok2):
            continue
        pos = find_new_tile(fb, fa)
        if pos:
            markers.append({"t": ev["ta"], "x": pos[0], "y": pos[1], "label": ev["label"]})
        else:
            markers.append({"t": ev["ta"], "x": None, "y": None, "label": ev["label"]})
    print(f"{len(markers)} markers")

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
    print("sweep intervals:", [[round(a,1),round(b,1)] for a,b in SWEEPS])

    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    placed = []
    next_i = 0
    idx = 0
    legend = {"tedashi": (0, 0, 255), "tsumogiri": (255, 200, 0), "tsumogiri?": (200, 200, 0)}
    while True:
        ok, img = cap.read()
        if not ok:
            break
        t = idx / fps
        idx += 1
        while next_i < len(markers) and markers[next_i]["t"] <= t:
            placed.append(markers[next_i]); next_i += 1
        # clear markers inside deal/sweep gaps (long hand-in-pond episodes)
        if any(a - 1 <= t <= b + 1 for a, b in SWEEPS):
            placed = []
        cv2.rectangle(img, (R_POND[0], R_POND[1]), (R_POND[2], R_POND[3]), (80, 80, 80), 1)
        cv2.rectangle(img, (R_HAND[0], R_HAND[1]), (R_HAND[2], R_HAND[3]), (80, 80, 80), 1)
        ytxt = H - 20
        for m in placed:
            c = legend.get(m["label"], (128, 128, 128))
            if m["x"]:
                cv2.circle(img, (m["x"], m["y"]), 26, c, 3)
                cv2.putText(img, "T" if m["label"] == "tedashi" else "M",
                            (m["x"] - 8, m["y"] + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, c, 2)
        # status line: counts
        nt = sum(1 for m in placed if m["label"] == "tedashi")
        nm = sum(1 for m in placed if m["label"].startswith("tsumogiri"))
        cv2.putText(img, f"tedashi={nt}  tsumogiri={nm}", (20, ytxt),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        out.write(img)
    out.release()
    cap.release()
    json.dump(markers, open("markers.json", "w"), indent=1)
    print("wrote", OUT)

if __name__ == "__main__":
    main()
