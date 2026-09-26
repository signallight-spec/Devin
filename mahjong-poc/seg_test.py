"""Tile-row segmentation v2: segment tiles via colored top strip."""
import cv2
import numpy as np
import sys

def felt_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h > 75) & (h < 100) & (s > 60)

def skin_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h < 30) & (s > 40) & (v > 80)

def colored_mask(hsv):
    """saturated colored pixels (tile backs/tops) that are not felt, not skin"""
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (s > 80) & (v > 90) & ~felt_mask(hsv) & ~skin_mask(hsv)

def runs(cols_bool):
    segs, start = [], None
    for x, on in enumerate(cols_bool):
        if on and start is None:
            start = x
        elif not on and start is not None:
            segs.append([start, x]); start = None
    if start is not None:
        segs.append([start, len(cols_bool)])
    return segs

def analyze(img, y_lo, y_hi, label=""):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    cm = colored_mask(hsv)
    sm = skin_mask(hsv)
    occ = sm[y_lo:y_hi].mean()

    # find colored-strip rows: rows with high colored density
    sub = cm[y_lo:y_hi]
    row_frac = sub.mean(axis=1)
    rows = np.where(row_frac > 0.08)[0]
    if len(rows) == 0:
        print(f"{label}: occ={occ:.3f} no strip")
        return None
    groups = np.split(rows, np.where(np.diff(rows) > 12)[0] + 1)
    # group containing the densest row
    peak = int(np.argmax(row_frac))
    band_grp = max(groups, key=lambda g: row_frac[g].max() if len(g) else 0)
    band = (y_lo + band_grp[0], y_lo + min(band_grp[-1] + 2, y_hi))

    band_m = cm[band[0]:band[1]]
    col_frac = band_m.mean(axis=0)
    # tile = run of columns with decent colored occupancy; seams break runs
    tiles = [r for r in runs(col_frac > 0.45) if r[1] - r[0] >= 8]
    # group tiles into segments by gap
    segs = []
    for t in tiles:
        if segs and t[0] - segs[-1][-1][1] <= 18:
            segs[-1].append(t)
        else:
            segs.append([t])
    seg_summary = [(g[0][0], g[-1][1], len(g)) for g in segs]
    print(f"{label}: occ={occ:.3f} band={band} tiles={len(tiles)}")
    for s in seg_summary:
        print(f"   seg x=[{s[0]},{s[1]}] tiles={s[2]}")

    vis = img.copy()
    cv2.rectangle(vis, (0, band[0]), (img.shape[1], band[1]), (0, 255, 0), 1)
    for g in segs:
        x0, x1 = g[0][0], g[-1][1]
        color = (0, 0, 255) if len(g) == 1 and len(segs) > 1 else (255, 0, 0)
        cv2.rectangle(vis, (x0, band[0]), (x1, band[1] + 60), color, 2)
        cv2.putText(vis, str(len(g)), (x0, band[0] - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    return vis

if __name__ == "__main__":
    for path in sys.argv[1:]:
        img = cv2.imread(path)
        if img is None:
            continue
        y_lo = max(0, img.shape[0] - 350)
        vis = analyze(img, y_lo, img.shape[0] - 30, label=path)
        if vis is not None:
            out = path.replace(".png", "_seg2.png")
            cv2.imwrite(out, vis)
            print("   ->", out)
