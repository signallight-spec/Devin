"""Mahjong tedashi/tsumogiri detection pipeline (near player).

Method:
  1. Detect discard events = skin-in-pond episodes + pond white-area growth.
  2. For each event: align & diff clean hand-band crops before/after.
  3. Classify by where the row lost a tile:
       no change          -> TSUMOGIRI (tile went straight from draw to pond)
       interior loss      -> TEDASHI
       right-end loss     -> TSUMOGIRI (drawn tile conventionally at right end)
Outputs: events.json, annotated video, before/after contact images.
"""
import cv2
import numpy as np
import json, os, sys

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "videos/sample1_x264.mp4"
FPS = 8
R_POND = (600, 390, 990, 500)
R_HAND = (170, 545, 1240, 660)   # band incl. standing row (top ~45px) + melds below
ROW_STRIP = 35                    # top rows of band = standing hand; meld changes ignored
MIN_DELTA = 900                  # pond growth px for one tile
EP_GAP = 1.5

def skin_mask(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h >= 2) & (h <= 24) & (s >= 45) & (s <= 165) & (v >= 110)

def pond_area(img):
    x0, y0, x1, y1 = R_POND
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    m = (v > 150) & (s < 70)
    return int(m[y0:y1, x0:x1].sum())

def band(img):
    x0, y0, x1, y1 = R_HAND
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)[y0:y1, x0:x1]

def band_skin(img):
    x0, y0, x1, y1 = R_HAND
    return skin_mask(img)[y0:y1, x0:x1]

def band_extent(b):
    """Locate the standing tile row in the band. Returns (x0, x1, y0, y1).

    The row's y-position drifts between rounds, so first find the 45px
    y-window with the strongest vertical-seam (|dI/dx|) energy, then chain
    the blocks of high-gradient columns inside it (occlusions split the row
    into several blocks; merge blocks closer than 150px)."""
    g = np.abs(np.diff(b.astype(np.float32), axis=1))
    H = g.shape[0]
    win = 45
    if H <= win:
        return None
    ey = np.array([g[i:i + win, :].mean() for i in range(H - win)])
    mx = ey.max()
    if mx < 3.0:
        return None
    y = int(np.where(ey > 0.65 * mx)[0].min())
    gx = g[y:y + win, :].mean(axis=0)
    xs = np.where(gx > 6.0)[0]
    if len(xs) < 50:
        return None
    blocks, cur = [], [xs[0], xs[0]]
    for x in xs[1:]:
        if x - cur[1] <= 15:
            cur[1] = x
        else:
            blocks.append(cur); cur = [x, x]
    blocks.append(cur)
    blocks = [bl for bl in blocks if bl[1] - bl[0] >= 40]
    if not blocks:
        return None
    groups, cur = [], [blocks[0][0], blocks[0][1]]
    for bl in blocks[1:]:
        if bl[0] - cur[1] <= 150:
            cur[1] = bl[1]
        else:
            groups.append(cur); cur = [bl[0], bl[1]]
    groups.append(cur)
    best = max(groups, key=lambda gr: gr[1] - gr[0])
    if best[1] - best[0] < 140:
        return None
    return int(best[0]), int(best[1]), y, y + win

def align_diff(bb, aa):
    best, bs = None, 0
    H, W = bb.shape
    for sh in range(-60, 61, 2):
        if sh >= 0:
            d = np.abs(bb[:, :W - sh].astype(int) - aa[:, sh:].astype(int)).mean()
        else:
            d = np.abs(bb[:, -sh:].astype(int) - aa[:, :W + sh].astype(int)).mean()
        if best is None or d < best:
            best, bs = d, sh
    if bs >= 0:
        dimg = np.abs(bb[:, :W - bs].astype(int) - aa[:, bs:].astype(int)), bs
    else:
        dimg = np.abs(bb[:, -bs:].astype(int) - aa[:, :W + bs].astype(int)), bs
    return dimg

def main():
    import os as _os
    _st = _os.stat(VIDEO)
    ident = {"video": VIDEO, "size": _st.st_size, "mtime": _st.st_mtime_ns}
    meta = None
    if _os.path.exists("log3.meta.json") and _os.path.exists("log3.json"):
        meta = json.load(open("log3.meta.json"))
    cached = meta is not None and all(meta.get(k) == v for k, v in ident.items())
    if cached:
        log = json.load(open("log3.json"))
        src_fps = meta["src_fps"]
    else:
        cap = cv2.VideoCapture(VIDEO)
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 60
        step = max(1, int(round(src_fps / FPS)))
        log, idx = [], 0
        while True:
            ok = cap.grab()
            if not ok: break
            idx += 1
            if idx % step != 0: continue
            ok, img = cap.retrieve()
            if not ok: break
            x0, y0, x1, y1 = R_HAND
            sm = skin_mask(img)
            log.append({"t": idx / src_fps,
                        "pond": pond_area(img),
                        "skin_hand": float(sm[y0:y1, x0:x1].mean()),
                        "skin_pond": float(sm[R_POND[1]:R_POND[3], R_POND[0]:R_POND[2]].mean())})
        cap.release()
        json.dump(log, open("log3.json", "w"))
        json.dump({**ident, "src_fps": src_fps}, open("log3.meta.json", "w"))
    ts = [e["t"] for e in log]

    # episodes of hand in pond
    eps, cur = [], None
    for e in log:
        if e["skin_pond"] > 0.25:
            if cur is None: cur = [e["t"], e["t"]]
            else: cur[1] = e["t"]
        else:
            if cur: eps.append(cur); cur = None
    if cur: eps.append(cur)
    merged = []
    for a, b in eps:
        if merged and a - merged[-1][1] < EP_GAP: merged[-1][1] = b
        else: merged.append([a, b])

    import bisect
    def area_near(t):
        i = bisect.bisect_left(ts, t)
        cands = [log[j]["pond"] for j in range(max(0, i-1), min(len(log), i+3))]
        return max(cands) if cands else 0

    events = []
    for a, b in merged:
        if b - a > 8:  # deal/transition phase, skip
            continue
        pre = max(area_near(a - 3), area_near(a - 2), area_near(a - 1))
        post = max(area_near(b + 1), area_near(b + 2), area_near(b + 3))
        if post - pre > MIN_DELTA:
            events.append({"t": (a + b) / 2, "t0": a, "t1": b, "delta": post - pre})
    print(f"{len(events)} discard events")

    # pass 2: classify each event via band diff
    cap = cv2.VideoCapture(VIDEO)
    os.makedirs("events3", exist_ok=True)
    def frame(t):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * src_fps)))
        ok, im = cap.read()
        return im if ok else None
    def clean(t0, t1):
        cand = [e for e in log if t0 <= e["t"] <= t1]
        ok = [e["t"] for e in cand if e["skin_hand"] < 0.08]
        if ok:
            return ok
        # fall back to least-occluded frame in the window
        return [min(cand, key=lambda e: e["skin_hand"])["t"]] if cand else []

    results = []
    last_ext = None
    for i, ev in enumerate(events):
        mid = ev["t"]
        befs = clean(mid - 5, ev["t0"] - 0.1)
        afts = clean(ev["t1"] + 0.4, mid + 5)
        if not befs or not afts:
            results.append({**ev, "label": "noisy"}); continue
        tb, ta = befs[-1], afts[0]
        fb, fa = frame(tb), frame(ta)
        bb, aa = band(fb), band(fa)
        det = band_extent(bb) or band_extent(aa)
        ext = det or last_ext
        if ext:
            last_ext = ext
        dimg, sh = align_diff(bb, aa)
        # zero out pixels that are skin in either frame (hands/arms passing)
        skb, ska = band_skin(fb), band_skin(fa)
        if sh >= 0:
            sk = skb[:, :skb.shape[1]-sh] | ska[:, sh:]
        else:
            sk = skb[:, -sh:] | ska[:, :ska.shape[1]+sh]
        dimg = dimg * (~sk).astype(int)
        # measure change inside this event's detected row band; without a
        # detection use the broad range where the row can sit (melds below)
        sy0, sy1 = (det[2], det[3]) if det else (0, 90)
        colchg = (dimg[sy0:sy1, :] > 45).mean(axis=0)
        # a broad fallback strip dilutes the row's share of rows -> lower bar
        thresh = 0.30 if det else 0.15
        on = colchg > thresh
        runs = []
        for i2, v in enumerate(on):
            if v and (not runs or i2 - runs[-1][1] > 20): runs.append([i2, i2])
            elif v: runs[-1][1] = i2
        # merge tiny runs, drop runs at extreme frame edge unrelated to row
        runs = [r for r in runs if r[1] - r[0] >= 25]
        W = bb.shape[1]
        full = any(r[0] < W * 0.05 and r[1] > W * 0.95 for r in runs)
        # fraction of the band strip occluded by skin — when large, an empty
        # diff is unobservable rather than evidence for tsumogiri
        region = sk[sy0:sy1, :]
        skfrac = float(region.mean()) if region.size else 0.0
        results.append({**ev, "tb": tb, "ta": ta,
                        "runs": runs, "shift": sh, "ext": ext, "full": full,
                        "skfrac": skfrac,
                        "bb": bb, "aa": aa, "fname": None})
    cap.release()

    # classify in a second pass: fill missing extents from the nearest detected
    known = [r["ext"] for r in results if r.get("ext")]
    def classify(r):
        if r["full"]:
            return "uncertain", None
        ext = r["ext"]
        if ext is None and known:
            # nearest detected extent in event order
            j = results.index(r)
            cand = [(abs(k - j), e["ext"]) for k, e in enumerate(results) if e.get("ext")]
            ext = min(cand, key=lambda c: c[0])[1] if cand else None
        if not r["runs"]:
            # an empty diff only means tsumogiri when the row was visible;
            # heavy occlusion makes 'no change' unobservable
            return ("uncertain" if r.get("skfrac", 0.0) > 0.35 else "tsumogiri"), ext
        if ext is None:
            return "uncertain", None
        rx0, rx1 = ext[0], ext[1]
        # run coords live in the aligned diff image; when shift<0 the left
        # columns were cropped away, so shift the extent into diff coords
        adj = r["shift"] if r["shift"] < 0 else 0
        rx0 += adj; rx1 += adj
        # a partially detected row (hand occludes part) can start inside the
        # real row; allow a ~1.5-tile margin left of rx0 but require overlap
        pitch = max(25.0, min(45.0, (rx1 - rx0) / 5.0))
        row_l = rx0 - int(1.5 * pitch)
        edge_zone = rx1 - int(1.4 * pitch)
        on_row = [x for x in r["runs"] if x[1] > row_l and x[0] < rx1 - 5]
        interior = [x for x in on_row if x[0] < edge_zone]
        edge_only = [x for x in on_row if x[0] >= edge_zone]
        if interior:
            return "tedashi", ext
        if edge_only:
            return "tsumogiri?", ext
        return "tsumogiri", ext

    for i, r in enumerate(results):
        if r.get("label") == "noisy":
            continue
        label, ext2 = classify(r)
        r["label"] = label
        r["ext_used"] = ext2
        mid = r["t"]
        fname = f"events3/ev{i:02d}_t{mid:.0f}_{label}_b{r['tb']:.0f}_a{r['ta']:.0f}.png"
        cv2.imwrite(fname, np.vstack([r.pop("bb"), r.pop("aa")]))
        r["img"] = fname
    json.dump(results, open("events.json", "w"), indent=1)
    for r in results:
        print(f"  t={r['t']:6.1f}  {r['label']:10s} runs={r.get('runs')} img={r.get('img','-')}")

if __name__ == "__main__":
    main()
