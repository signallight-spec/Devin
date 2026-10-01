"""MediaPipe hand-landmark test on action frames."""
import cv2
import numpy as np
import sys
import mediapipe as mp
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core import base_options
import urllib.request, os

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hand_landmarker.task")
if not os.path.exists(MODEL):
    urllib.request.urlretrieve(
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        MODEL)

opts = vision.HandLandmarkerOptions(
    base_options=base_options.BaseOptions(model_asset_path=MODEL),
    running_mode=vision.RunningMode.IMAGE,
    num_hands=4, min_hand_detection_confidence=0.3,
    min_hand_presence_confidence=0.3, min_tracking_confidence=0.3)
det = vision.HandLandmarker.create_from_options(opts)

for path in sys.argv[1:]:
    img = cv2.imread(path)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mpimg = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    res = det.detect(mpimg)
    vis = img.copy()
    print(path, len(res.hand_landmarks), "hands")
    for lm in res.hand_landmarks:
        pts = [(int(p.x * img.shape[1]), int(p.y * img.shape[0])) for p in lm]
        for x, y in pts:
            cv2.circle(vis, (x, y), 3, (0, 255, 0), -1)
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        cv2.rectangle(vis, (min(xs), min(ys)), (max(xs), max(ys)), (0, 0, 255), 1)
        # index fingertip = landmark 8
        cv2.circle(vis, pts[8], 6, (255, 0, 255), -1)
    cv2.imwrite(path.replace(".png", "_mp.png"), vis)
