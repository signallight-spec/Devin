"""Mahjong tedashi/tsumogiri detection pipeline.

Method:
  1. Detect discard events = skin-in-pond episodes + pond white-area growth.
  2. Attribute each event to a seat: the skin component touching the pond is
     followed to the frame edge it exits through (the near player's arm hangs
     to the bottom / low-right edge, the right seat's arm enters horizontally
     at mid height, the across player's arm comes over the top).
  3. For the near player's events only: align & diff clean hand-band crops
     before/after and classify by where the row lost a tile:
       no change          -> TSUMOGIRI (tile went straight from draw to pond)
       interior loss      -> TEDASHI
       right-end loss     -> TSUMOGIRI (drawn tile conventionally at right end)
     Opponent rows are outside the hand band, so opponent events are kept
     as unclassifiable 'opp' marks rather than risking a false label.
Outputs land under results/<video-stem>/: log3.json, log3.meta.json,
events.json, markers.json, events3/*.png (several videos' results coexist);
annotate.py renders the visualization video.
"""
import cv2
import numpy as np
import json, os, sys, statistics

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "videos/sample1_x264.mp4"
FPS = 8

# Per-video geometry profiles. Keys match against the video basename.
# 'default' = over-shoulder single-table view; 'sample2' = split screen
# with a top-down whole-table panel on the left and the near player's
# face-up hand inset at bottom right.
PROFILES = {
    "sample2": dict(
        R_POND=(180, 250, 500, 640),   # inner table area of the left panel
        R_HAND=(660, 480, 1280, 710),  # near player's face-up hand inset
        SKIN_POND_TH=0.035,            # a hand is a small % of the big region
        MIN_DELTA=300,                 # one top-down tile ~= 700 bright px
        ATTRIB="sector",               # discard lands in discarder's sector
        # centroid anchors of each seat's discard cluster (frame coords)
        ANCHORS={"across": (335, 295), "right": (420, 380),
                 "left": (230, 380), "self": (340, 485)},
        PANEL=(8, 80, 650, 710),       # left panel bounds for edge fallback
        # wall strips (frame coords): an automatic table swallows all tiles
        # between hands, so all walls read empty at once = round transition
        WALLS=[(150, 120, 540, 190), (55, 200, 115, 560),
               (560, 200, 650, 560)],
    ),
}

_name = os.path.basename(VIDEO)
_prof = next((p for k, p in PROFILES.items() if k in _name), {})
PROF_KEY = next((k for k in PROFILES if k in _name), "default")

R_POND = _prof.get("R_POND", (600, 390, 990, 500))
R_HAND = _prof.get("R_HAND", (170, 545, 1240, 660))  # standing row + melds
ROW_STRIP = 35                    # top rows of band = standing hand; meld changes ignored
MIN_DELTA = _prof.get("MIN_DELTA", 900)  # pond growth px for one tile
SKIN_POND_TH = _prof.get("SKIN_POND_TH", 0.25)  # skin fraction = hand in pond
ATTRIB = _prof.get("ATTRIB", "edges")
ANCHORS = _prof.get("ANCHORS")
PANEL = _prof.get("PANEL")
WALLS = _prof.get("WALLS")        # wall strips; all-empty => round transition
EP_GAP = 1.5
SKIN = (2, 24, 45, 165, 110)     # h_lo, h_hi, s_lo, s_hi, v_lo for skin_mask
POND_T = (150, 70)               # v_min, s_max for pond_area white tiles
WALL_TH = 0.01                   # yellow fraction below which a wall is empty
SWEEP_MIN = 5                    # seconds of empty walls = a transition

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

def walls_frac(img):
    """Peak yellow-wall coverage across the wall strips — drops to ~0 only
    when the table has swallowed every wall between rounds."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    yel = (h > 10) & (h < 40) & (s > 80) & (v > 100)
    return max(float(yel[y0:y1, x0:x1].mean()) for x0, y0, x1, y1 in WALLS)

def wall_sweeps(log):
    """Round-transition intervals: contiguous runs where every wall strip
    reads empty."""
    spans, cur = [], None
    for e in log:
        if e.get("walls", 1.0) < WALL_TH:
            cur = [e["t"], e["t"]] if cur is None else [cur[0], e["t"]]
        else:
            if cur: spans.append(cur); cur = None
    if cur: spans.append(cur)
    return [s for s in spans if s[1] - s[0] > SWEEP_MIN]

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

def attribute_player(cap, ev, log, src_fps):
    """Vote which seat the discarding hand belongs to.

    'sector' (overhead camera): the discard lands in the discarder's own
    pond sector. Diff the pond between just before and just after the
    episode, keep bright components that newly appeared, and assign each
    to the nearest sector anchor — largest area wins.

    'edges' (over-shoulder camera): the skin component touching the pond
    is followed to the frame edge it exits through."""
    if ATTRIB == "sector":
        def fr2(t):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * src_fps)))
            ok, im = cap.read()
            return im if ok else None
        fb, fa = fr2(ev["t0"] - 0.4), fr2(ev["t1"] + 0.8)
        if fb is None or fa is None:
            return "unknown"
        x0, y0, x1, y1 = R_POND
        gb = cv2.cvtColor(fb, cv2.COLOR_BGR2GRAY)[y0:y1, x0:x1].astype(int)
        ga = cv2.cvtColor(fa, cv2.COLOR_BGR2GRAY)[y0:y1, x0:x1].astype(int)
        hsv = cv2.cvtColor(fa, cv2.COLOR_BGR2HSV)
        wa = ((hsv[:, :, 2] > POND_T[0]) & (hsv[:, :, 1] < POND_T[1]))[y0:y1, x0:x1]
        newt = ((np.abs(gb - ga) > 50) & wa).astype(np.uint8)
        newt = cv2.morphologyEx(newt, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n, lab, st, cen = cv2.connectedComponentsWithStats(newt)
        votes = {}
        for i in range(1, n):
            if st[i, 4] < 120:   # smaller than ~half a tile face: noise
                continue
            cx, cy = cen[i][0] + x0, cen[i][1] + y0
            seat = min(ANCHORS, key=lambda k: (cx - ANCHORS[k][0]) ** 2
                                              + (cy - ANCHORS[k][1]) ** 2)
            votes[seat] = votes.get(seat, 0) + int(st[i, 4])
        if votes:
            return max(votes, key=votes.get)
        # the tile may be hidden by the hovering hand: fall back to which
        # panel edge the pond-touching skin component exits through
        return _panel_edge_vote(cap, ev, log, src_fps)
    # 'edges' mode: the skin component overlapping R_POND is traced to the
    # frame edge it exits through:
    #   bottom edge, or right edge below y~400 -> 'self'   (near player: the
    #     arm hangs to the bottom-right corner / low right edge)
    #   right edge higher                      -> 'right'  (horizontal reach)
    #   top or left edge                       -> 'across'
    # Several hands can be in the pond at once (each component votes).
    kr = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    px0, py0, px1, py1 = R_POND
    votes = {"self": 0, "across": 0, "right": 0}
    for e in log:
        if not (ev["t0"] <= e["t"] <= ev["t1"] + 0.5):
            continue
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(e["t"] * src_fps)))
        ok, im = cap.read()
        if not ok:
            continue
        H, W = im.shape[:2]
        mask = cv2.dilate(skin_mask(im).astype(np.uint8), kr)
        n, lab = cv2.connectedComponents(mask)
        ids = np.unique(lab[py0:py1, px0:px1])
        for cid in ids[ids > 0]:
            ys, xs = np.where(lab == cid)
            if len(ys) < 800:
                continue
            if xs.max() >= W - 4:
                ymin = ys[xs >= W - 4].min()
                votes["self" if ymin >= 400 else "right"] += 1
            if ys.max() >= H - 4:
                votes["self"] += 1
            if ys.min() <= 3 or xs.min() <= 3:
                votes["across"] += 1
    if votes["self"] and votes["self"] >= max(votes["across"], votes["right"]):
        return "self"
    if votes["across"] and votes["across"] >= votes["right"]:
        return "across"
    if votes["right"]:
        return "right"
    return "unknown"


def _panel_edge_vote(cap, ev, log, src_fps):
    """Overhead-camera fallback: per sampled frame, only the skin component
    reaching DEEPEST into the pond votes for its nearest panel edge — the
    discarder's arm extends to the table's centre while other players'
    resting hands hug the rim, so they lose each frame they share. Edge
    contact alone can't be trusted (sleeves break the skin mask before
    the edge is reached); nearest-edge by bounding box is."""
    px0, py0, px1, py1 = PANEL
    kr = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    votes = {"across": 0, "self": 0, "left": 0, "right": 0}
    for e in log:
        if not (ev["t0"] <= e["t"] <= ev["t1"] + 0.5):
            continue
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(e["t"] * src_fps)))
        ok, im = cap.read()
        if not ok:
            continue
        mask = np.zeros(im.shape[:2], np.uint8)
        mask[py0:py1, px0:px1] = skin_mask(im)[py0:py1, px0:px1]
        mask = cv2.dilate(mask, kr)
        n, lab = cv2.connectedComponents(mask)
        ids = np.unique(lab[R_POND[1]:R_POND[3], R_POND[0]:R_POND[2]])
        best = None  # (inside, edge)
        for cid in ids[ids > 0]:
            ys, xs = np.where(lab == cid)
            if len(ys) < 800:
                continue
            inside = int(((ys >= R_POND[1]) & (ys < R_POND[3])
                          & (xs >= R_POND[0]) & (xs < R_POND[2])).sum())
            if inside < 400:
                continue
            gaps = {"across": ys.min() - py0, "self": py1 - ys.max(),
                    "left": xs.min() - px0, "right": px1 - xs.max()}
            edge = min(gaps, key=gaps.get)
            if best is None or inside > best[0]:
                best = (inside, edge)
        if best:
            # weight by penetration depth: the discarder's arm outmasses a
            # resting rim-hand only around the actual discard moment, so a
            # plain 1-vote-per-frame majority lets persistent hands win
            votes[best[1]] += best[0]
    return max(votes, key=votes.get) if any(votes.values()) else "unknown"

def main():
    import os as _os
    STEM = _os.path.splitext(_os.path.basename(VIDEO))[0]
    OUTDIR = _os.path.join("results", STEM)
    _os.makedirs(OUTDIR, exist_ok=True)
    F_LOG = _os.path.join(OUTDIR, "log3.json")
    F_META = _os.path.join(OUTDIR, "log3.meta.json")
    F_EVENTS = _os.path.join(OUTDIR, "events.json")
    D_EV = _os.path.join(OUTDIR, "events3")
    _st = _os.stat(VIDEO)
    # cache identity covers every input that changes the feature log: the
    # video, the sampled regions/rate, and the detector thresholds
    ident = {"video": VIDEO, "size": _st.st_size, "mtime": _st.st_mtime_ns,
             "cfg": f"{PROF_KEY}|{R_POND}|{R_HAND}|{FPS}|skin={SKIN}|pond={POND_T}"
             f"|skinpond={SKIN_POND_TH}|mindelta={MIN_DELTA}|walls={WALLS}"}
    meta = None
    if _os.path.exists(F_META) and _os.path.exists(F_LOG):
        meta = json.load(open(F_META))
    # a 'partial' meta means the decode stopped early: it pairs with the
    # events written that run so annotate can render them, but it never
    # serves as a cache — every rerun re-decodes until completion
    cached = (meta is not None and not meta.get("partial")
              and all(meta.get(k) == v for k, v in ident.items()))
    if cached:
        log = json.load(open(F_LOG))
        src_fps = meta["src_fps"]
    else:
        cap = cv2.VideoCapture(VIDEO)
        if not cap.isOpened():
            sys.exit(f"cannot open video: {VIDEO}")
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
            entry = {"t": idx / src_fps,
                     "pond": pond_area(img),
                     "skin_hand": float(sm[y0:y1, x0:x1].mean()),
                     "skin_pond": float(sm[R_POND[1]:R_POND[3], R_POND[0]:R_POND[2]].mean())}
            if WALLS:
                entry["walls"] = walls_frac(img)
            log.append(entry)
        expected = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        cap.release()
        if not log:
            # don't publish an empty log: it would cache a failed decode as
            # a complete pass and wipe good results from the previous run
            sys.exit(f"decoded no frames from {VIDEO}")
        # drop stale labels BEFORE publishing this video's metadata — a run
        # interrupted between here and classification must not leave an old
        # events.json beside a fresh log3.meta.json (annotate would accept it)
        if _os.path.exists(F_EVENTS):
            _os.remove(F_EVENTS)
        partial = expected > 0 and idx < 0.9 * expected
        if partial:
            print(f"warning: decoded only {idx}/{int(expected)} frames "
                  f"(decoder stopped early); results cover ~{idx / src_fps:.0f}s",
                  file=sys.stderr)
        json.dump(log, open(F_LOG, "w"))
        json.dump({**ident, "src_fps": src_fps, "partial": bool(partial)},
                  open(F_META, "w"))
    ts = [e["t"] for e in log]

    # episodes of hand in pond
    eps, cur = [], None
    for e in log:
        if e["skin_pond"] > SKIN_POND_TH:
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
        # display timestamp: the first own-window sample whose area proves
        # the tile landed; None when growth only appeared via the
        # ambiguous next-episode window (annotate clamps those before the
        # next sweep)
        tp = next((e["t"] for e in log
                   if b + 0.4 <= e["t"] < nxt and e["t"] <= b + 3
                   and e["pond"] >= pre + MIN_DELTA), None)
        # a landed tile stays in the pond; a spike that falls back within
        # the own window is something else (a broadcast overlay, a sleeve).
        # Compare the level AFTER first crossing: a real discard keeps the
        # median up, a transient spike lets it collapse back to baseline
        # (samples jitter around the threshold, so don't demand all hold)
        if tp is not None:
            after = [e["pond"] for e in log
                     if tp <= e["t"] < nxt and e["t"] <= b + 3]
            if after and statistics.median(after) < pre + MIN_DELTA * 0.4:
                continue
        if own - pre > MIN_DELTA:
            events.append({"t": (a + b) / 2, "t0": a, "t1": b,
                           "delta": own - pre, "sure": True, "tp": tp})
        elif post - pre > MIN_DELTA:
            events.append({"t": (a + b) / 2, "t0": a, "t1": b,
                           "delta": post - pre, "sure": False, "tp": tp})
    print(f"{len(events)} discard events")

    # pass 2: classify each event via band diff
    cap = cv2.VideoCapture(VIDEO)
    os.makedirs(D_EV, exist_ok=True)
    for _f in os.listdir(D_EV):  # drop stale evidence from earlier runs
        os.remove(os.path.join(D_EV, _f))
    # stale labels were already dropped before the metadata write; repeat
    # here so a run on a cached log can't be interrupted mid-classify with
    # the old file still on disk
    if _os.path.exists(F_EVENTS):
        _os.remove(F_EVENTS)
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

    # the row's bounds reset at every deal/transition. Overhead profiles
    # detect transitions by the walls emptying; shoulder-view profiles by
    # the long merged skin-in-pond episode of the sweep itself
    sweeps = wall_sweeps(log) if WALLS else [m for m in merged
                                           if m[1] - m[0] > 8]
    sweep_ends = [b for a, b in sweeps]
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
        ev["player"] = attribute_player(cap, ev, log, src_fps)
        if ev["player"] != "self":
            # not the near player's discard: opponents' tile rows sit outside
            # the hand band, so the band diff can't tell tedashi from
            # tsumogiri — and may fire on coincidental own-row changes
            # (a draw looks like an interior loss). Keep the event, but
            # leave it unclassified instead of guessing
            results.append({**ev, "label": "opp"})
            continue
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
        # a reread can fail near a decode-stopping truncation even though
        # the sequential pass got the frame — keep the other results
        if fb is None or fa is None:
            results.append({**ev, "label": "noisy"}); continue
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
        if r.get("label") in ("noisy", "opp"):
            continue
        label, ext2 = classify(r)
        r["label"] = label
        r["ext_used"] = ext2
        mid = r["t"]
        fname = (f"{D_EV}/ev{i:02d}_t{mid:.0f}_{label}"
                 f"_b{r['tb']:.0f}_a{r['ta']:.0f}.png")
        cv2.imwrite(fname, np.vstack([r.pop("bb"), r.pop("aa")]))
        r["img"] = fname
    # an ambiguous event (growth only seen once the next episode started)
    # survives only when the hand-band diff proved an interior tile loss —
    # otherwise the growth most likely belongs to the later discard
    results = [r for r in results
               if r.get("sure", True) or r["label"] == "tedashi"]
    kept = {r["img"] for r in results if r.get("img")}
    for _f in os.listdir(D_EV):  # evidence only for kept events
        if os.path.join(D_EV, _f) not in kept:
            os.remove(os.path.join(D_EV, _f))
    json.dump(results, open(F_EVENTS, "w"), indent=1)
    for r in results:
        print(f"  t={r['t']:6.1f}  {r['label']:10s} player={r.get('player','?'):7s} "
              f"runs={r.get('runs')} img={r.get('img','-')}")

if __name__ == "__main__":
    main()
