"""Mahjong tedashi/tsumogiri detection pipeline (near player).

Method:
  1. Detect discard events = skin-in-pond episodes + pond white-area growth.
  2. For each event: align & diff clean hand-band crops before/after.
  3. Classify by where the row lost a tile:
       no change          -> TSUMOGIRI (tile went straight from draw to pond)
       interior loss      -> TEDASHI
       right-end loss     -> TSUMOGIRI (drawn tile conventionally at right end)
Outputs: events.json and before/after contact images in events3/;
annotate.py renders the visualization video.
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
SKIN = (2, 24, 45, 165, 110)     # h_lo, h_hi, s_lo, s_hi, v_lo for skin_mask
POND_T = (150, 70)               # v_min, s_max for pond_area white tiles

def skin_mask(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h >= SKIN[0]) & (h <= SKIN[1]) & (s >= SKIN[2]) & (s <= SKIN[3]) & (v >= SKIN[4])

def pond_area(img):
    x0, y0, x1, y1 = R_POND
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    m = (v > POND_T[0]) & (s < POND_T[1])
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
    # cache identity covers every input that changes the feature log: the
    # video, the sampled regions/rate, and the detector thresholds
    ident = {"video": VIDEO, "size": _st.st_size, "mtime": _st.st_mtime_ns,
             "cfg": f"{R_POND}|{R_HAND}|{FPS}|skin={SKIN}|pond={POND_T}"}
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
    for mi, (a, b) in enumerate(merged):
        if b - a > 8:  # deal/transition phase, skip
            continue
        pre = max(area_near(a - 3), area_near(a - 2), area_near(a - 1))
        post = max(area_near(b + 1), area_near(b + 2), area_near(b + 3))
        # growth attributable to this episode alone ends where the next
        # hand-in-pond episode begins; growth seen only after that is
        # ambiguous (it may belong to the later discard). Sample the log
        # directly here — area_near's lookahead could read past nxt
        nxt = merged[mi + 1][0] if mi + 1 < len(merged) else b + 4
        own = max((e["pond"] for e in log if b + 0.4 <= e["t"] < nxt
                   and e["t"] <= b + 3), default=0)
        if own - pre > MIN_DELTA:
            events.append({"t": (a + b) / 2, "t0": a, "t1": b,
                           "delta": own - pre, "sure": True})
        elif post - pre > MIN_DELTA:
            events.append({"t": (a + b) / 2, "t0": a, "t1": b,
                           "delta": post - pre, "sure": False})
    print(f"{len(events)} discard events")

    # pass 2: classify each event via band diff
    cap = cv2.VideoCapture(VIDEO)
    os.makedirs("events3", exist_ok=True)
    for _f in os.listdir("events3"):  # drop stale evidence from earlier runs
        os.remove(os.path.join("events3", _f))
    # clear stale labels up front: if this run is interrupted mid-classify,
    # annotate must not pair them with freshly-written log metadata
    if _os.path.exists("events.json"):
        _os.remove("events.json")
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

    # the row's bounds reset at every deal/transition (long skin episode):
    # an extent inherited across that boundary belongs to the previous round
    sweep_ends = [b for a, b in merged if b - a > 8]
    for ev in events:
        ev["round"] = bisect.bisect_right(sweep_ends, ev["t0"])

    results = []
    last_ext = None
    cur_round = -1
    for i, ev in enumerate(events):
        if ev["round"] != cur_round:
            cur_round = ev["round"]
            last_ext = None
        mid = ev["t"]
        # compare frames inside this event's neighbourhood only: an
        # after-frame past the NEXT discard would diff in that discard's row
        # change; a before-frame before the PREVIOUS discard's placement
        # likewise. Other players' pond episodes don't touch the hand band,
        # so the bound is the neighbouring event, not the neighbouring episode
        prev_ev_t1 = events[i - 1]["t1"] if i > 0 else 0
        next_ev_t0 = events[i + 1]["t0"] if i + 1 < len(events) else mid + 5
        befs = clean(max(mid - 5, prev_ev_t1 + 0.5), ev["t0"] - 0.1)
        afts = clean(ev["t1"] + 0.4, min(mid + 5, next_ev_t0))
        if not befs or not afts:
            results.append({**ev, "label": "noisy"}); continue
        tb, ta = befs[-1], afts[0]
        fb, fa = frame(tb), frame(ta)
        bb, aa = band(fb), band(fa)
        det = band_extent(bb)
        det_src = "b"
        if det is None:
            det = band_extent(aa)
            det_src = "a" if det else None
        ext = det or (last_ext[0] if last_ext else None)
        # x-extent coords live in the frame they were detected on; remember
        # which frame ('b'/'a') so classify can map them into diff coords.
        # An inherited extent is only an estimate of the current row's spot —
        # its old 'a'/'b' label belongs to a different event's alignment, so
        # treat it as measured on this event's before frame instead
        ext_src = det_src if det else "b"
        if ext:
            last_ext = (ext, ext_src)
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
        # fraction of the ROW occluded by skin — an empty diff is evidence
        # for tsumogiri only where the row itself was visible. Measure it
        # over the extent's columns (mapped into diff coords), not the
        # whole 1070px band, else a small covered row looks observable
        adj = (-sh if (ext_src == "a" and sh > 0) else (sh if sh < 0 else 0))
        cx0 = int(max(0, min(sk.shape[1], ext[0] + adj))) if ext else 0
        cx1 = int(max(0, min(sk.shape[1], ext[1] + adj))) if ext else sk.shape[1]
        region = sk[sy0:sy1, cx0:cx1] if cx1 > cx0 else sk[sy0:sy1, :]
        skfrac = float(region.mean()) if region.size else 0.0
        results.append({**ev, "tb": tb, "ta": ta,
                        "runs": runs, "shift": sh, "ext": ext,
                        "det": det is not None, "ext_src": ext_src,
                        "full": full, "skfrac": skfrac,
                        "bb": bb, "aa": aa, "fname": None})
    cap.release()

    # classify in a second pass: fill missing extents from the nearest detected
    known = [r["ext"] for r in results if r.get("ext")]
    def classify(r):
        if r["full"]:
            return "uncertain", None
        ext, src = r["ext"], r.get("ext_src")
        if ext is None and known:
            # nearest detected extent in event order, same round only
            j = results.index(r)
            cand = [(abs(k - j), (e["ext"], e["ext_src"])) for k, e in enumerate(results)
                    if e.get("ext") and e.get("round") == r.get("round")]
            ext, src = min(cand, key=lambda c: c[0])[1] if cand else (None, None)
        if not r["runs"]:
            # an empty diff is tsumogiri only when this event actually saw the
            # row; heavy occlusion or no detection makes 'no change' unobservable
            if not r.get("det"):
                return "uncertain", ext
            return ("uncertain" if r.get("skfrac", 0.0) > 0.35 else "tsumogiri"), ext
        if ext is None:
            return "uncertain", None
        rx0, rx1 = ext[0], ext[1]
        # run coords live in the aligned diff image. Map the extent into that
        # frame: a 'b' extent loses its left columns when shift<0; an 'a'
        # extent is pulled left by sh when shift>0 (aa col j -> diff col j-sh)
        if src == "a":
            adj = -r["shift"] if r["shift"] > 0 else 0
        else:
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
    # an ambiguous event (growth only seen once the next episode started)
    # survives only when the hand-band diff proved an interior tile loss —
    # otherwise the growth most likely belongs to the later discard
    results = [r for r in results
               if r.get("sure", True) or r["label"] == "tedashi"]
    json.dump(results, open("events.json", "w"), indent=1)
    for r in results:
        print(f"  t={r['t']:6.1f}  {r['label']:10s} runs={r.get('runs')} img={r.get('img','-')}")

if __name__ == "__main__":
    main()
