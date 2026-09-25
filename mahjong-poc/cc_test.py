"""v4: count tiles via connected components of colored top edges in hand ROI."""
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

ROI_NEAR_HAND = (150, 520, 1230, 710)  # x0,y0,x1,y1

for path in sys.argv[1:]:
    img = cv2.imread(path)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    cm = colored_mask(hsv).astype(np.uint8) * 255
    x0, y0, x1, y1 = ROI_NEAR_HAND
    roi = cm[y0:y1, x0:x1]
    # close small holes, open noise
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    roi2 = cv2.morphologyEx(roi, cv2.MORPH_CLOSE, k, iterations=1)
    roi2 = cv2.morphologyEx(roi2, cv2.MORPH_OPEN, k, iterations=1)
    n, lbl, stats, cent = cv2.connectedComponentsWithStats(roi2, 8)
    comps = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if 60 <= a and w >= 8 and h >= 6 and h <= 40 and w <= 120:
            comps.append((x0 + x, y0 + y, w, h, a))
    comps.sort()
    print(f"{path}: {len(comps)} tile-top components")
    for c in comps:
        print("   ", c)
    vis = img.copy()
    for (x, y, w, h, a) in comps:
        cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 0, 255), 2)
    cv2.imwrite(path.replace(".png", "_cc.png"), vis)
