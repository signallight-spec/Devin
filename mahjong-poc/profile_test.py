"""Debug: dump column profiles of the hand strip for threshold tuning."""
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

def row_groups(mask_frac, thresh, gap):
    rows = np.where(mask_frac > thresh)[0]
    if len(rows) == 0:
        return []
    return np.split(rows, np.where(np.diff(rows) > gap)[0] + 1)

img_path = sys.argv[1]
img = cv2.imread(img_path)
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
cm = colored_mask(hsv)
H, W = img.shape[:2]
y_lo, y_hi = H - 300, H - 20
sub = cm[y_lo:y_hi]
row_frac = sub.mean(axis=1)
groups = row_groups(row_frac, 0.05, 12)
# widest group
best = max(groups, key=lambda g: g[-1] - g[0])
band = (y_lo + best[0], y_lo + best[-1])
print("band:", band)
# x extent of colored in band
col_frac = cm[band[0]:band[1]].mean(axis=0)
on = col_frac > 0.15
xs = np.where(on)[0]
print("extent:", xs.min(), xs.max())
# dump the col_frac profile in coarse bins
prof = (col_frac * 20).astype(int)
line = "".join(str(min(9, p)) for p in prof)
for i in range(0, len(line), 128):
    print(f"x={i:4d} {line[i:i+128]}")
# also darkness profile in strip mid
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
strip = gray[band[0]:band[1]]
dark = 255 - strip.mean(axis=0)
dprof = (dark / 25.5).astype(int)
dline = "".join(str(min(9, p)) for p in dprof)
print("dark:")
for i in range(0, len(dline), 128):
    print(f"x={i:4d} {dline[i:i+128]}")
