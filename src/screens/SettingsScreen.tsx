import { useEffect, useState } from "react";
import { api } from "../api";
import { StatusMessage } from "../components/StatusMessage";

export function SettingsScreen({ onFamilyKeyReset }: { onFamilyKeyReset: () => void }) {
  const [goalMinutes, setGoalMinutes] = useState(25);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"error" | "success">("success");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.today()
      .then((today) => setGoalMinutes(today.goalMinutes))
      .catch((error: unknown) => {
        setTone("error");
        setMessage(error instanceof Error ? error.message : "読み込みに失敗しました。");
      });
  }, []);

  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.updateGoal(goalMinutes);
      setTone("success");
      setMessage("目標時間を保存しました。");
    } catch (error) {
      setTone("error");
      setMessage(error instanceof Error ? error.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card settings-card">
        <p className="eyebrow">毎日の目安</p>
        <h2>目標時間</h2>
        <p>無理なく続けられる時間を選びます。変更後の達成から使われます。</p>
        <div className="goal-picker">
          <button
            aria-label="5分減らす"
            disabled={goalMinutes <= 5}
            onClick={() => setGoalMinutes((value) => value - 5)}
            type="button"
          >
            −
          </button>
          <strong>{goalMinutes}<span>分</span></strong>
          <button
            aria-label="5分増やす"
            disabled={goalMinutes >= 180}
            onClick={() => setGoalMinutes((value) => value + 5)}
            type="button"
          >
            ＋
          </button>
        </div>
        <StatusMessage message={message} tone={tone} />
        <button className="primary-button" disabled={busy} onClick={save} type="button">
          {busy ? "保存中…" : "目標時間を保存"}
        </button>
      </section>
      <section className="card muted-card">
        <h2>この端末の家族キー</h2>
        <p>キーを入れ直す場合だけ使用してください。</p>
        <button className="text-button danger" onClick={onFamilyKeyReset} type="button">
          家族キーを削除
        </button>
      </section>
    </div>
  );
}
