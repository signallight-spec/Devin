"""Dump occupancy profile in a fixed hand ROI to tune tile segmentation."""
import cv2
import numpy as np
import sys

def felt_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h > 75) & (h < 100) & (s > 60)

def skin_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h < 30) & (s > 40) & (v > 80)

def tile_mask(hsv):
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    white = (v > 150) & (s < 70)
    colored = (s > 80) & (v > 90) & ~felt_mask(hsv) & ~skin_mask(hsv)
    return white | colored

# ROI: (x0,y0,x1,y1) for near-player hand area, full 1280x720 frame
ROI_NEAR_HAND = (180, 530, 1220, 680)

for path in sys.argv[1:]:
    img = cv2.imread(path)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    tm = tile_mask(hsv)
    x0, y0, x1, y1 = ROI_NEAR_HAND
    roi = tm[y0:y1, x0:x1]
    occ = roi.mean(axis=0)
    line = "".join(str(min(9, int(f * 10))) for f in occ)
    print(path)
    for i in range(0, len(line), 128):
        print(f"  x={x0 + i:4d} {line[i:i+128]}")
