import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { CharacterCard } from "../components/Character";
import { StatusMessage } from "../components/StatusMessage";
import { timerText, yen } from "../format";
import { useTimer } from "../hooks/useTimer";
import type { Today } from "../types";

function RecordForm({
  method,
  onCancel,
  onRecorded
}: {
  method: "timer" | "self_report";
  onCancel: () => void;
  onRecorded: (today: Today) => void;
}) {
  const [subject, setSubject] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.createAchievement({
        method,
        subject: subject.trim() || null,
        note: note.trim() || null
      });
      onRecorded(await api.today());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "記録に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card record-card">
      <p className="eyebrow">{method === "timer" ? "タイマー完走" : "自己申告"}</p>
      <h2>今日の学習を記録</h2>
      <label>
        科目（任意）
        <input
          maxLength={20}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="例：数学"
          value={subject}
        />
      </label>
      <label>
        一言メモ（任意）
        <textarea
          maxLength={120}
          onChange={(event) => setNote(event.target.value)}
          placeholder="できたことを一言"
          rows={3}
          value={note}
        />
      </label>
      <StatusMessage message={message} />
      <div className="button-row">
        <button className="primary-button" disabled={busy} onClick={submit} type="button">
          {busy ? "記録中…" : "今日のスタンプをもらう"}
        </button>
        <button className="text-button" onClick={onCancel} type="button">戻る</button>
      </div>
    </section>
  );
}

export function HomeScreen({ onInvalidKey }: { onInvalidKey: () => void }) {
  const [today, setToday] = useState<Today | null>(null);
  const [recordMethod, setRecordMethod] = useState<"timer" | "self_report" | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const timer = useTimer(today?.goalMinutes ?? 25);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      setToday(await api.today());
    } catch (error) {
      if (error instanceof Error) {
        setMessage(error.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (timer.completed && !today?.achievement) {
      setRecordMethod("timer");
    }
  }, [timer.completed, today?.achievement]);

  if (loading) {
    return <div className="loading-card">今日の状態を読み込み中…</div>;
  }
  if (!today) {
    return (
      <section className="card">
        <StatusMessage message={message || "読み込めませんでした。"} />
        <div className="button-row">
          <button className="secondary-button" onClick={load} type="button">再試行</button>
          <button className="text-button" onClick={onInvalidKey} type="button">家族キーを変更</button>
        </div>
      </section>
    );
  }

  if (today.achievement) {
    return (
      <div className="stack">
        <CharacterCard character={today.character} />
        <section className="hero-card completed-card">
          <div className="stamp" aria-hidden="true">できた</div>
          <p className="eyebrow">今日のスタンプ</p>
          <h2>今日も積み重ねました</h2>
          <p className="celebration-copy">
            {today.achievement.streakDays}日目の記録です。明日も少しずつ。
          </p>
          <div className="reward-line">
            <span>今日の目安</span>
            <strong>{yen(today.achievement.totalAmountYen)}</strong>
          </div>
        </section>
        <section className="card detail-list">
          <div><span>記録方法</span><strong>{today.achievement.method === "timer" ? "タイマー" : "自己申告"}</strong></div>
          <div><span>科目</span><strong>{today.achievement.subject || "未入力"}</strong></div>
          <div><span>一言メモ</span><strong>{today.achievement.note || "未入力"}</strong></div>
        </section>
      </div>
    );
  }

  if (recordMethod) {
    return (
      <RecordForm
        method={recordMethod}
        onCancel={() => {
          if (recordMethod === "timer") {
            timer.reset();
          }
          setRecordMethod(null);
        }}
        onRecorded={(nextToday) => {
          timer.reset();
          setToday(nextToday);
          setRecordMethod(null);
        }}
      />
    );
  }

  return (
    <div className="stack">
      <CharacterCard character={today.character} />
      <section className="hero-card">
        <div className="streak-chip">連続 {today.currentStreakDays} 日</div>
        <p className="eyebrow">今日の目標</p>
        <h2>{today.goalMinutes}分、机に向かってみよう</h2>
        <div className={timer.active ? "timer active" : "timer"}>
          {timerText(timer.remainingSeconds)}
        </div>
        {!timer.active ? (
          <button className="primary-button big" onClick={timer.start} type="button">
            タイマーを始める
          </button>
        ) : (
          <button className="secondary-button" onClick={timer.reset} type="button">
            タイマーをやめる
          </button>
        )}
      </section>
      <section className="card self-report-card">
        <div>
          <p className="eyebrow">タイマーを使わなかった日</p>
          <h2>学習したことを記録する</h2>
        </div>
        <button
          className="secondary-button"
          disabled={timer.active}
          onClick={() => setRecordMethod("self_report")}
          type="button"
        >
          今日やった
        </button>
      </section>
      <p className="quiet-note">
        {today.allowanceRule.bonusIntervalDays}日ごとの達成日に{" "}
        {yen(today.allowanceRule.bonusAmountYen)} の連続ボーナス。
      </p>
    </div>
  );
}
