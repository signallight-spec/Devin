"""Mahjong tedashi/tsumogiri PoC pipeline.

Per frame:
 - near-player hand row: tile count + right-end isolation (colored-top occupancy)
 - near-player pond: tile count (white blobs)
 - skin contact map over the hand row (who's touching where)
Events: draw (13->14), discard (pond+1 & hand 14->13).
Classification: extraction zone at pick = row interior -> tedashi,
                right end / no row contact -> tsumogiri.
"""
import cv2
import numpy as np
import sys, json

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "videos/sample1.mp4"
FPS = 8

# ---- ROIs (x0,y0,x1,y1) on 1280x720 ----
R_HAND = (170, 545, 1240, 700)   # near player's hand row band
R_POND = (520, 380, 1010, 545)   # near player's discard pond
WALL_Y = (80, 260)               # draw wall strip (top area)

def felt_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h > 75) & (h < 100) & (s > 60)

def skin_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h >= 2) & (h <= 24) & (s >= 45) & (s <= 165) & (v >= 110)

def colored_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (s > 80) & (v > 90) & ~felt_mask(hsv) & ~skin_mask(hsv)

def white_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (v > 150) & (s < 70)

def col_runs(profile, thresh, min_w=6):
    runs, start = [], None
    for x, on in enumerate(profile > thresh):
        if on and start is None:
            start = x
        elif not on and start is not None:
            runs.append([start, x]); start = None
    if start is not None:
        runs.append([start, len(profile)])
    return [r for r in runs if r[1] - r[0] >= min_w]

def merge_close(runs_, gap):
    out = []
    for r in runs_:
        if out and r[0] - out[-1][1] <= gap:
            out[-1][1] = r[1]
        else:
            out.append(r)
    return out

def hand_state(img, hsv):
    """Return (extent, n_tiles, isolated_gap_px) for near hand row, or None if occluded/absent."""
    x0, y0, x1, y1 = R_HAND
    tm = (white_mask(hsv) | colored_mask(hsv)).astype(np.uint8)
    roi = tm[y0:y1, x0:x1]
    row_frac = roi.mean(axis=1)
    rows = np.where(row_frac > 0.30)[0]
    if len(rows) == 0:
        return None
    groups = np.split(rows, np.where(np.diff(rows) > 10)[0] + 1)
    band = max(groups, key=lambda g: row_frac[g].max())
    b0, b1 = y0 + band[0], y0 + band[-1]
    bandm = tm[b0:b1 + 1, x0:x1]
    occ = bandm.mean(axis=0)
    runs_ = col_runs(occ, 0.45, min_w=8)
    runs_ = merge_close(runs_, 10)
    if not runs_:
        return None
    extent = (runs_[0][0], runs_[-1][1])
    # gaps between consecutive runs
    gaps = [(runs_[i][1], runs_[i+1][0]) for i in range(len(runs_) - 1)]
    return dict(band=(b0, b1), runs=runs_, extent=extent, gaps=gaps)

def pond_count(hsv):
    x0, y0, x1, y1 = R_POND
    wm = white_mask(hsv).astype(np.uint8)
    roi = wm[y0:y1, x0:x1]
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    roi = cv2.morphologyEx(roi, cv2.MORPH_OPEN, k)
    n, lbl, stats, cent = cv2.connectedComponentsWithStats(roi, 8)
    cnt = 0
    for i in range(1, n):
        w, h, a = stats[i][2], stats[i][3], stats[i][4]
        if a > 300 and 10 < w < 90 and 10 < h < 90:
            cnt += 1
    return cnt

def skin_cols(hsv):
    """skin occupancy per column inside hand band"""
    x0, y0, x1, y1 = R_HAND
    sm = skin_mask(hsv).astype(np.uint8)
    return sm[y0:y1, x0:x1].mean(axis=0), sm

def main():
    cap = cv2.VideoCapture(VIDEO)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 60
    step = max(1, int(round(src_fps / FPS)))
    pitch = 59.0  # px per tile, will self-calibrate
    log = []
    idx = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        idx += 1
        if idx % step != 0:
            continue
        ok, img = cap.retrieve()
        if not ok:
            break
        t = idx / src_fps
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        hs = hand_state(img, hsv)
        pc = pond_count(hsv)
        sc, _ = skin_cols(hsv)
        entry = {"t": round(t, 2), "pond": pc}
        if hs:
            n_runs = len(hs["runs"])
            entry.update({
                "extent": hs["extent"],
                "runs": [(r[0] + R_HAND[0], r[1] + R_HAND[0]) for r in hs["runs"]],
                "skin": [round(float(v), 2) for v in sc[::16]],
            })
        log.append(entry)
    cap.release()
    with open("log.json", "w") as f:
        json.dump(log, f)
    print("frames:", len(log))

if __name__ == "__main__":
    main()
