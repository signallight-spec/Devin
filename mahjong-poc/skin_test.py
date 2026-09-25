"""Check skin segmentation + hand blob tracking feasibility."""
import cv2
import numpy as np
import sys

def skin_mask_ycrcb(img):
    ycrcb = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
    # common skin range in YCrCb
    lower = np.array([0, 133, 77], np.uint8)
    upper = np.array([255, 173, 127], np.uint8)
    m = cv2.inRange(ycrcb, lower, upper)
    return m

for path in sys.argv[1:]:
    img = cv2.imread(path)
    m = skin_mask_ycrcb(img)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    m2 = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    m2 = cv2.morphologyEx(m2, cv2.MORPH_OPEN, k, iterations=1)
    n, lbl, stats, cent = cv2.connectedComponentsWithStats(m2, 8)
    vis = img.copy()
    vis[m2 > 0] = (0, 0, 255)
    blobs = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a > 500:
            blobs.append((x, y, w, h, a))
            cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 255, 0), 2)
            cv2.putText(vis, str(a), (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
    print(path, "blobs:", blobs)
    cv2.imwrite(path.replace(".png", "_skin.png"), vis)
