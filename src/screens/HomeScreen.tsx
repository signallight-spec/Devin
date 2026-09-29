import { useCallback, useEffect, useState } from "react";
import {
  localDateInTokyo
} from "../../shared/domain";
import { api } from "../api";
import { CharacterCard } from "../components/Character";
import { StatusMessage } from "../components/StatusMessage";
import { timerText, yen } from "../format";
import { nextHomeRefreshDelay } from "../homeRefresh";
import type { StudyTimer } from "../hooks/useTimer";
import type { Achievement, CharacterState, Today } from "../types";

const DATE_REFRESH_RETRY_MS = 30_000;
const RECORDED_REFRESH_FAILURE_MESSAGE =
  "学習は記録済みですが、表示の同期に失敗しました。再読み込みしてください。";

function RecordForm({
  goalMinutes,
  method,
  onCancel,
  onRecorded,
  targetMinutes
}: {
  goalMinutes: number;
  method: "timer" | "self_report";
  onCancel: () => void;
  onRecorded: (result: {
    achievement: Achievement;
    character: CharacterState;
  }) => void;
  targetMinutes?: number;
}) {
  const [subject, setSubject] = useState("");
  const [note, setNote] = useState("");
  const [effortMinutes, setEffortMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await api.createAchievement({
        method,
        subject: subject.trim() || null,
        note: note.trim() || null,
        ...(method === "timer"
          ? { targetMinutes }
          : effortMinutes !== ""
            ? { targetMinutes: Number(effortMinutes) }
            : {})
      });
      onRecorded(result);
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
      {method === "self_report" && (
        <label>
          がんばった分数（任意）
          <input
            max={180}
            min={5}
            onChange={(event) => setEffortMinutes(event.target.value)}
            placeholder={`未入力なら ${goalMinutes}分`}
            step={5}
            type="number"
            value={effortMinutes}
          />
        </label>
      )}
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

export function HomeScreen({
  onGoalMinutesLoaded,
  onInvalidKey,
  timer
}: {
  onGoalMinutesLoaded: (goalMinutes: number) => void;
  onInvalidKey: () => Promise<void>;
  timer: StudyTimer;
}) {
  const [today, setToday] = useState<Today | null>(null);
  const [recordMethod, setRecordMethod] = useState<"timer" | "self_report" | null>(null);
  const [timerMessage, setTimerMessage] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [keyResetBusy, setKeyResetBusy] = useState(false);

  const load = useCallback(async (refreshFailureMessage?: string) => {
    setLoading(true);
    setMessage("");
    try {
      const nextToday = await api.today();
      setToday(nextToday);
      onGoalMinutesLoaded(nextToday.goalMinutes);
      return true;
    } catch (error) {
      if (error instanceof Error) {
        setMessage(refreshFailureMessage ?? error.message);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [onGoalMinutesLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const todayLocalDate = today?.localDate;
  useEffect(() => {
    if (!todayLocalDate) {
      return;
    }
    let timeoutId: number;
    let cancelled = false;
    const refreshIfDateChanged = () => {
      window.clearTimeout(timeoutId);
      if (localDateInTokyo(new Date()) !== todayLocalDate) {
        setRecordMethod(null);
        void load().then((loaded) => {
          const delay = nextHomeRefreshDelay(
            new Date(),
            todayLocalDate,
            loaded
          );
          if (!cancelled && delay !== null) {
            timeoutId = window.setTimeout(
              refreshIfDateChanged,
              delay
            );
          }
        });
        return;
      }
      timeoutId = window.setTimeout(
        refreshIfDateChanged,
        nextHomeRefreshDelay(new Date(), todayLocalDate, false) ??
          DATE_REFRESH_RETRY_MS
      );
    };
    timeoutId = window.setTimeout(
      refreshIfDateChanged,
      nextHomeRefreshDelay(new Date(), todayLocalDate, false) ??
        DATE_REFRESH_RETRY_MS
    );
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshIfDateChanged();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load, todayLocalDate]);

  const resetFamilyKey = async () => {
    setKeyResetBusy(true);
    try {
      await onInvalidKey();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "通知の解除に失敗したため、家族キーを保持しました。"
      );
    } finally {
      setKeyResetBusy(false);
    }
  };

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
          <button
            className="secondary-button"
            onClick={() => void load()}
            type="button"
          >
            再試行
          </button>
          <button
            className="text-button"
            disabled={keyResetBusy}
            onClick={resetFamilyKey}
            type="button"
          >
            家族キーを変更
          </button>
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
        <StatusMessage message={message} />
        {message && (
          <button
            className="secondary-button"
            onClick={() => void load(RECORDED_REFRESH_FAILURE_MESSAGE)}
            type="button"
          >
            表示を再読み込み
          </button>
        )}
      </div>
    );
  }

  if (recordMethod) {
    return (
      <RecordForm
        goalMinutes={today.goalMinutes}
        method={recordMethod}
        targetMinutes={recordMethod === "timer" ? timer.targetMinutes ?? undefined : undefined}
        onCancel={() => {
          setRecordMethod(null);
        }}
        onRecorded={(result) => {
          timer.reset();
          setToday((value) => value ? {
            ...value,
            achievement: result.achievement,
            character: result.character,
            currentStreakDays: result.achievement.streakDays
          } : value);
          setRecordMethod(null);
          void load(RECORDED_REFRESH_FAILURE_MESSAGE);
        }}
      />
    );
  }

  return (
    <div className="stack">
      <CharacterCard character={today.character} />
      <section className="card suggestion-card">
        <p className="eyebrow">
          {today.suggestion.parentSelected
            ? "おうちの人から・今日のおすすめ"
            : "今日のおすすめ"}
        </p>
        <h2>今日は{today.suggestion.subject}の学習をやってみよう</h2>
        <p>おすすめはヒントです。ほかの科目を選んでも大丈夫です。</p>
      </section>
      <section className="hero-card">
        <div className="streak-chip">連続 {today.currentStreakDays} 日</div>
        <p className="eyebrow">今日の目標</p>
        <h2>{today.goalMinutes}分、机に向かってみよう</h2>
        <div className={timer.active ? "timer active" : "timer"}>
          {timerText(timer.remainingSeconds)}
        </div>
        {timer.completed ? (
          <button
            className="primary-button big"
            onClick={() => setRecordMethod("timer")}
            type="button"
          >
            完了した学習を記録
          </button>
        ) : !timer.active ? (
          <button
            className="primary-button big"
            onClick={() => {
              if (timer.start()) {
                setTimerMessage("");
              } else {
                setTimerMessage(
                  "今日中に終わる時間が足りません。明日タイマーを使うか、「今日やった」から記録してください。"
                );
              }
            }}
            type="button"
          >
            タイマーを始める
          </button>
        ) : (
          <button className="secondary-button" onClick={timer.reset} type="button">
            タイマーをやめる
          </button>
        )}
        <StatusMessage message={timerMessage} />
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
        {today.allowanceRule.overGoalBonusEnabled && (
          <>
            {" "}さらに{today.allowanceRule.overGoalMinutes}分以上がんばると{" "}
            {yen(today.allowanceRule.overGoalAmountYen)} のボーナス。
          </>
        )}
      </p>
    </div>
  );
}
