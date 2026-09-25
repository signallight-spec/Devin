"""v2 pipeline — pass 1: detect near-player discard events via pond occupancy + skin in hand band."""
import cv2
import numpy as np
import sys, json

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "videos/sample1_x264.mp4"
FPS = 8

R_POND = (600, 390, 990, 500)   # near player's discard rows in center pond
R_HAND = (170, 545, 1240, 700)

def skin_frac(img, box):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    m = (h >= 2) & (h <= 24) & (s >= 45) & (s <= 165) & (v >= 110)
    x0, y0, x1, y1 = box
    return m[y0:y1, x0:x1].mean()

def pond_area(img):
    x0, y0, x1, y1 = R_POND
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    m = ((v > 150) & (s < 70)).astype(np.uint8)
    return int(m[y0:y1, x0:x1].sum())

def main():
    cap = cv2.VideoCapture(VIDEO)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 60
    step = max(1, int(round(src_fps / FPS)))
    log = []
    idx = 0
    while True:
        ok = cap.grab()
        if not ok: break
        idx += 1
        if idx % step != 0: continue
        ok, img = cap.retrieve()
        if not ok: break
        t = idx / src_fps
        pa = pond_area(img)
        sf = skin_frac(img, R_HAND)
        sp = skin_frac(img, R_POND)
        log.append({"t": round(t, 2), "pond_area": pa, "skin_hand": round(float(sf), 4), "skin_pond": round(float(sp), 4)})
    cap.release()
    json.dump(log, open("log2.json", "w"))

    # event detection: pond_area jumps > 1200 px and stays elevated ~1s
    events = []
    n = len(log)
    i = 1
    while i < n - 8:
        d = log[i]["pond_area"] - log[i - 1]["pond_area"]
        if d > 1200:
            j = i
            while j < min(i + 8, n) and log[j]["pond_area"] > log[i - 1]["pond_area"] + 600:
                j += 1
            if j - i >= 4:  # sustained
                events.append((log[i]["t"], log[i]["pond_area"] - log[i - 1]["pond_area"]))
                i = j
                continue
        i += 1
    print("candidate events:", len(events))
    for t, d in events:
        print(f"  t={t:.1f} +{d}px")

if __name__ == "__main__":
    main()
