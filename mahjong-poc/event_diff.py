"""For each hand-in-pond episode, grab clean before/after hand-band crops and diff."""
import cv2
import numpy as np
import json, os, sys

VIDEO = "videos/sample1_x264.mp4"
R_HAND = (170, 545, 1240, 700)

log = json.load(open("log2.json"))

def clean_frames(t0, t1):
    return [e["t"] for e in log if t0 <= e["t"] <= t1 and e["skin_hand"] < 0.03]

def frame_at(cap, src_fps, t):
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * src_fps)))
    ok, img = cap.read()
    return img if ok else None

events = [float(x) for x in sys.argv[1:]]
cap = cv2.VideoCapture(VIDEO)
src_fps = cap.get(cv2.CAP_PROP_FPS)
x0, y0, x1, y1 = R_HAND
os.makedirs("events", exist_ok=True)

for ev in events:
    befores = clean_frames(ev - 4, ev - 0.2)
    afters = clean_frames(ev + 0.4, ev + 4)
    if not befores or not afters:
        print(f"t={ev}: no clean frames (b={len(befores)} a={len(afters)})"); continue
    tb, ta = befores[-1], afters[0]
    ib, ia = frame_at(cap, src_fps, tb), frame_at(cap, src_fps, ta)
    if ib is None or ia is None:
        continue
    bb = cv2.cvtColor(ib, cv2.COLOR_BGR2GRAY)[y0:y1, x0:x1]
    aa = cv2.cvtColor(ia, cv2.COLOR_BGR2GRAY)[y0:y1, x0:x1]
    best, bs = None, 0
    for sh in range(-50, 51, 2):
        if sh >= 0:
            d = np.abs(bb[:, :bb.shape[1] - sh].astype(int) - aa[:, sh:].astype(int)).mean()
        else:
            d = np.abs(bb[:, -sh:].astype(int) - aa[:, :aa.shape[1] + sh].astype(int)).mean()
        if best is None or d < best:
            best, bs = d, sh
    if bs >= 0:
        dimg = np.abs(bb[:, :bb.shape[1] - bs].astype(int) - aa[:, bs:].astype(int))
    else:
        dimg = np.abs(bb[:, -bs:].astype(int) - aa[:, :aa.shape[1] + bs].astype(int))
    colchg = (dimg > 45).mean(axis=0)
    vis = np.vstack([bb, aa])
    cv2.imwrite(f"events/ev_{ev}_b{tb}_a{ta}_sh{bs}.png", vis)
    runs = []
    on = colchg > 0.15
    for i, v in enumerate(on):
        if v and (not runs or i - runs[-1][1] > 15):
            runs.append([i, i])
        elif v:
            runs[-1][1] = i
    print(f"t={ev} before={tb} after={ta} shift={bs} changedcols={[(x0 + r[0], x0 + r[1]) for r in runs]}")
cap.release()
