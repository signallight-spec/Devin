"""Tuned skin segmentation: HSV range excluding saturated reds and whites."""
import cv2
import numpy as np
import sys

def skin_mask_hsv(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    # skin: low hue (orange-ish), moderate saturation, bright
    m = (h >= 2) & (h <= 24) & (s >= 45) & (s <= 165) & (v >= 110)
    return m.astype(np.uint8) * 255

for path in sys.argv[1:]:
    img = cv2.imread(path)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m = skin_mask_hsv(hsv)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    m2 = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    m2 = cv2.morphologyEx(m2, cv2.MORPH_OPEN, k, iterations=1)
    n, lbl, stats, cent = cv2.connectedComponentsWithStats(m2, 8)
    vis = img.copy()
    vis[m2 > 0] = (0, 0, 255)
    blobs = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a > 800:
            blobs.append((int(x), int(y), int(w), int(h), int(a)))
            cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 255, 0), 2)
    print(path, "big blobs:", blobs)
    cv2.imwrite(path.replace(".png", "_sk2.png"), vis)
