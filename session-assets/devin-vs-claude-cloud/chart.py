import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager

for f in ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
          "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"]:
    try:
        font_manager.fontManager.addfont(f)
    except Exception:
        pass
plt.rcParams["font.family"] = "Noto Sans CJK JP"
plt.rcParams["axes.unicode_minus"] = False

benchmarks = ["FrontierCode 1.1", "DeepSWE 1.1", "Terminal-Bench 2.1", "Terminal-Bench 4"]
swe2 = [50.0, 73.0, 92.8, 27.3]
fable = [50.9, 67.4, 91.4, 55.8]
gpt56 = [47.5, 72.7, 88.8, 37.3]

x = np.arange(len(benchmarks))
w = 0.26
fig, ax = plt.subplots(figsize=(9.4, 4.6), dpi=200)
b1 = ax.bar(x - w, swe2, w, label="SWE-2 (Devin)", color="#4F46E5")
b2 = ax.bar(x, fable, w, label="Fable 5.1 (Claude)", color="#D97706")
b3 = ax.bar(x + w, gpt56, w, label="GPT-5.6 Sol", color="#6B7280")
for bars in (b1, b2, b3):
    for r in bars:
        ax.annotate(f"{r.get_height():.0f}", (r.get_x() + r.get_width()/2, r.get_height()),
                    ha="center", va="bottom", fontsize=8, color="#374151")
ax.set_ylabel("スコア (%)", fontsize=11)
ax.set_xticks(x)
ax.set_xticklabels(benchmarks, fontsize=10)
ax.set_ylim(0, 105)
ax.spines[["top", "right"]].set_visible(False)
ax.grid(axis="y", alpha=0.25)
ax.legend(fontsize=9, loc="upper right", framealpha=0.9)
ax.set_title("コーディングベンチマーク比較（Cognition公表値, 2026-09）", fontsize=12, pad=12)
plt.tight_layout()
plt.savefig("/home/ubuntu/deck/benchmark.png", transparent=False, facecolor="white")
print("chart saved")
