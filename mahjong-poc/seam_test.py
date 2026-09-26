"""v3: detect tile seams via vertical gradient in a thin slice of the row."""
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
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (s > 80) & (v > 90) & ~felt_mask(hsv) & ~skin_mask(hsv)

def white_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (v > 150) & (s < 70)

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

def find_row_band(cm, y_lo, y_hi):
    sub = cm[y_lo:y_hi]
    row_frac = sub.mean(axis=1)
    rows = np.where(row_frac > 0.06)[0]
    if len(rows) == 0:
        return None
    groups = np.split(rows, np.where(np.diff(rows) > 12)[0] + 1)
    band_grp = max(groups, key=lambda g: row_frac[g].max() if len(g) else 0)
    return y_lo + band_grp[0], y_lo + band_grp[-1]

def analyze(img, y_lo, y_hi, label=""):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    cm, sm, wm = colored_mask(hsv), skin_mask(hsv), white_mask(hsv)
    occ = sm[y_lo:y_hi].mean()
    band = find_row_band(cm, y_lo, y_hi)
    if band is None:
        print(f"{label}: occ={occ:.3f} no band"); return None
    print(f"{label}: occ={occ:.3f} strip={band}")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # row extent: columns of the strip band with colored occupancy
    col_frac = cm[band[0]:band[1]].mean(axis=0)
    ext = runs(col_frac > 0.25)
    if not ext:
        return None
    rx0, rx1 = ext[0][0], ext[-1][1]
    # merge small internal gaps for extent
    merged = []
    for s in ext:
        if merged and s[0] - merged[-1][1] < 60:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    rx0, rx1 = merged[0][0], merged[-1][1]

    # seam slice: 15-45px below strip top (blank face region)
    sy0 = band[0] + 12
    sy1 = sy0 + 28
    sl = gray[sy0:sy1, rx0:rx1]
    gx = np.abs(cv2.Sobel(sl, cv2.CV_64F, 1, 0, ksize=3)).mean(axis=0)
    gx = cv2.GaussianBlur(gx.reshape(1, -1), (5, 1), 0).ravel()
    # seam peaks: local maxima above threshold
    thr = max(18.0, gx.max() * 0.25)
    peaks, i = [], 1
    while i < len(gx) - 1:
        if gx[i] > thr and gx[i] >= gx[i-1] and gx[i] >= gx[i+1]:
            j = i
            while j + 1 < len(gx) and gx[j+1] == gx[i]:
                j += 1
            peaks.append(rx0 + (i + j) // 2)
            i = j + 1
        else:
            i += 1
    # tiles = intervals between consecutive seams (+ends)
    edges = [rx0] + peaks + [rx1]
    tiles = [(edges[k], edges[k+1]) for k in range(len(edges)-1) if edges[k+1] - edges[k] >= 12]
    # segments by gap
    segs = []
    for t in tiles:
        if segs and t[0] - segs[-1][-1][1] <= 20:
            segs[-1].append(t)
        else:
            segs.append([t])
    print(f"   extent=[{rx0},{rx1}] tiles={len(tiles)} segs={[ (g[0][0], g[-1][1], len(g)) for g in segs]}")

    vis = img.copy()
    cv2.rectangle(vis, (0, band[0]), (img.shape[1], band[1]), (0, 255, 0), 1)
    cv2.rectangle(vis, (0, sy0), (img.shape[1], sy1), (255, 255, 0), 1)
    for p in peaks:
        cv2.line(vis, (p, sy0), (p, sy1 + 60), (0, 255, 255), 1)
    for g in segs:
        x0, x1 = g[0][0], g[-1][1]
        color = (0, 0, 255) if len(g) == 1 and len(segs) > 1 else (255, 0, 0)
        cv2.rectangle(vis, (x0, band[0]), (x1, band[1] + 70), color, 2)
        cv2.putText(vis, str(len(g)), (x0, band[0] - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    return vis

if __name__ == "__main__":
    for path in sys.argv[1:]:
        img = cv2.imread(path)
        if img is None:
            continue
        y_lo = max(0, img.shape[0] - 350)
        vis = analyze(img, y_lo, img.shape[0] - 20, label=path)
        if vis is not None:
            out = path.replace(".png", "_seg3.png")
            cv2.imwrite(out, vis)
            print("   ->", out)
