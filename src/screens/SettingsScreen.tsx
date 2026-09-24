import { useEffect, useState } from "react";
import { api } from "../api";
import { StatusMessage } from "../components/StatusMessage";
import {
  currentPushSubscription,
  disablePushNotifications,
  enablePushNotifications,
  pushSupported,
  syncPushSubscription
} from "../push";

export function SettingsScreen({
  onFamilyKeyReset
}: {
  onFamilyKeyReset: () => Promise<void>;
}) {
  const [goalMinutes, setGoalMinutes] = useState(25);
  const [notification, setNotification] = useState({
    enabled: true,
    time: "20:00",
    available: false,
    publicKey: null as string | null
  });
  const [subscribed, setSubscribed] = useState(false);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"error" | "success">("success");
  const [pushMessage, setPushMessage] = useState("");
  const [pushTone, setPushTone] = useState<"error" | "success">("success");
  const [busy, setBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    api.today()
      .then(async (today) => {
        setGoalMinutes(today.goalMinutes);
        setNotification(today.notification);
        try {
          const subscription = await currentPushSubscription();
          setSubscribed(Boolean(subscription));
          if (subscription) {
            await syncPushSubscription(subscription);
          }
        } catch (error) {
          setPushTone("error");
          setPushMessage(
            error instanceof Error ? error.message : "通知設定の読み込みに失敗しました。"
          );
        }
      })
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

  const togglePush = async () => {
    setPushBusy(true);
    setPushMessage("");
    try {
      if (subscribed) {
        await disablePushNotifications();
        setSubscribed(false);
        setPushTone("success");
        setPushMessage("この端末の通知を解除しました。");
      } else {
        if (!notification.publicKey) {
          throw new Error("通知用の設定がまだ完了していません。");
        }
        await enablePushNotifications(notification.publicKey);
        setSubscribed(true);
        setPushTone("success");
        setPushMessage("このAndroid端末で通知を受け取ります。");
      }
    } catch (error) {
      setPushTone("error");
      setPushMessage(
        error instanceof Error ? error.message : "通知設定に失敗しました。"
      );
    } finally {
      setPushBusy(false);
    }
  };

  const resetFamilyKey = async () => {
    if (!window.confirm("この端末から家族キーを削除しますか？")) {
      return;
    }
    setPushBusy(true);
    setPushMessage("");
    try {
      await onFamilyKeyReset();
    } catch (error) {
      setPushTone("error");
      setPushMessage(
        error instanceof Error
          ? error.message
          : "通知の解除に失敗したため、家族キーを保持しました。"
      );
    } finally {
      setPushBusy(false);
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
      <section className="card settings-card notification-device-card">
        <p className="eyebrow">Android端末</p>
        <h2>学習前の通知</h2>
        <p>
          {notification.enabled
            ? `毎日${notification.time}の時点で未達なら、この端末へ1回だけ通知します。`
            : "親ページで通知がOFFになっています。"}
        </p>
        {!pushSupported() ? (
          <p className="quiet-note">このブラウザはWeb Pushに対応していません。</p>
        ) : (
          <button
            className={subscribed ? "secondary-button" : "primary-button"}
            disabled={pushBusy || (!subscribed && !notification.available)}
            onClick={togglePush}
            type="button"
          >
            {pushBusy
              ? "設定中…"
              : subscribed
                ? "この端末の通知を解除"
                : "この端末で通知を受け取る"}
          </button>
        )}
        <StatusMessage message={pushMessage} tone={pushTone} />
        <p className="quiet-note">
          Chromeからホーム画面へ追加し、Androidの通知許可をONにしてください。
        </p>
      </section>
      <section className="card muted-card">
        <h2>この端末の家族キー</h2>
        <p>キーを入れ直す場合だけ使用してください。</p>
        <button
          className="text-button danger"
          disabled={pushBusy}
          onClick={resetFamilyKey}
          type="button"
        >
          家族キーを削除
        </button>
      </section>
    </div>
  );
}
