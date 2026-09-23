import { useCallback, useEffect, useState } from "react";
import {
  api,
  clearParentToken,
  generateFamilyKey,
  getFamilyKey,
  getParentToken,
  setFamilyKey
} from "../api";
import { StatusMessage } from "../components/StatusMessage";
import { dateTime, shortDate, yen } from "../format";
import type {
  Achievement,
  AllowanceRule,
  ParentDashboard,
  Payment
} from "../types";

function ParentLogin({ onLogin }: { onLogin: () => void }) {
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.startParentSession(pin);
      onLogin();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ログインに失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card parent-login">
      <div className="lock-mark" aria-hidden="true">◇</div>
      <p className="eyebrow">親ページ</p>
      <h2>4桁PINを入力</h2>
      <input
        aria-label="親用PIN"
        autoFocus
        className="pin-input"
        inputMode="numeric"
        maxLength={4}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && pin.length === 4) {
            void submit();
          }
        }}
        type="password"
        value={pin}
      />
      <StatusMessage message={message} />
      <button
        className="primary-button"
        disabled={busy || pin.length !== 4}
        onClick={submit}
        type="button"
      >
        {busy ? "確認中…" : "親ページを開く"}
      </button>
    </section>
  );
}

export function ParentScreen() {
  const [authenticated, setAuthenticated] = useState(Boolean(getParentToken()));
  const [dashboard, setDashboard] = useState<ParentDashboard | null>(null);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [rules, setRules] = useState<AllowanceRule[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"error" | "success" | "info">("info");
  const [busy, setBusy] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    baseAmountYen: 100,
    bonusIntervalDays: 7,
    bonusAmountYen: 300
  });
  const [newPin, setNewPin] = useState("");
  const [rotatedKey, setRotatedKey] = useState("");
  const [pendingFamilyKey, setPendingFamilyKey] = useState("");
  const [notificationForm, setNotificationForm] = useState({
    enabled: true,
    time: "20:00"
  });

  const load = useCallback(async (
    options: {
      preserveMessage?: boolean;
      refreshFailureMessage?: string;
    } = {}
  ) => {
    if (!options.preserveMessage) {
      setMessage("");
    }
    try {
      const [nextDashboard, achievementResult, ruleResult, paymentResult] =
        await Promise.all([
          api.parentDashboard(),
          api.parentAchievements(),
          api.rules(),
          api.payments()
        ]);
      setDashboard(nextDashboard);
      setAchievements(achievementResult.items);
      setRules(ruleResult.items);
      setPayments(paymentResult.items);
      setRuleForm({
        baseAmountYen: nextDashboard.currentAllowanceRule.baseAmountYen,
        bonusIntervalDays: nextDashboard.currentAllowanceRule.bonusIntervalDays,
        bonusAmountYen: nextDashboard.currentAllowanceRule.bonusAmountYen
      });
      setNotificationForm(nextDashboard.notificationSettings);
    } catch (error) {
      if (
        error instanceof Error &&
        ("status" in error && (error as { status: unknown }).status === 403)
      ) {
        clearParentToken();
        setAuthenticated(false);
      } else {
        setTone(options.refreshFailureMessage ? "info" : "error");
        setMessage(
          options.refreshFailureMessage ??
          (error instanceof Error ? error.message : "読み込みに失敗しました。")
        );
      }
    }
  }, []);

  useEffect(() => {
    if (authenticated) {
      void load();
    }
  }, [authenticated, load]);

  const settle = async () => {
    setBusy(true);
    setMessage("");
    let payment: Payment;
    try {
      payment = await api.settle();
    } catch (error) {
      setTone("error");
      setMessage(error instanceof Error ? error.message : "精算に失敗しました。");
      setBusy(false);
      return;
    }
    const successMessage = `${yen(payment.amountYen)}を支払い済みにしました。`;
    setDashboard((value) => value ? {
      ...value,
      unpaidBalanceYen: 0,
      unpaidAchievementCount: 0
    } : value);
    setAchievements((items) => items.map((item) => ({ ...item, paid: true })));
    setPayments((items) =>
      items.some((item) => item.id === payment.id) ? items : [payment, ...items]
    );
    setTone("success");
    setMessage(successMessage);
    await load({
      preserveMessage: true,
      refreshFailureMessage:
        `${successMessage} ただし表示の同期に失敗したため、画面を再読み込みしてください。`
    });
    setBusy(false);
  };

  const saveRule = async () => {
    setBusy(true);
    setMessage("");
    let rule: AllowanceRule;
    try {
      rule = await api.createRule(ruleForm);
    } catch (error) {
      setTone("error");
      setMessage(error instanceof Error ? error.message : "保存に失敗しました。");
      setBusy(false);
      return;
    }
    const successMessage =
      "新しい小遣いルールを保存しました。過去分は変わりません。";
    setDashboard((value) => value ? {
      ...value,
      currentAllowanceRule: rule
    } : value);
    setRules((items) =>
      items.some((item) => item.id === rule.id) ? items : [rule, ...items]
    );
    setTone("success");
    setMessage(successMessage);
    await load({
      preserveMessage: true,
      refreshFailureMessage:
        `${successMessage} ただし表示の同期に失敗したため、画面を再読み込みしてください。`
    });
    setBusy(false);
  };

  const saveNotificationSettings = async () => {
    setBusy(true);
    setMessage("");
    try {
      const settings = await api.updateNotificationSettings(notificationForm);
      setDashboard((value) => value ? {
        ...value,
        notificationSettings: settings
      } : value);
      setNotificationForm(settings);
      setTone("success");
      setMessage(
        settings.enabled
          ? `未達通知を毎日${settings.time}に設定しました。`
          : "未達通知をOFFにしました。"
      );
    } catch (error) {
      setTone("error");
      setMessage(error instanceof Error ? error.message : "通知設定に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const rotateKey = async () => {
    if (!window.confirm("新しい家族キーを発行します。保存後に古いキーを無効化しますか？")) {
      return;
    }
    setBusy(true);
    setMessage("");
    const currentFamilyKey = getFamilyKey();
    const newFamilyKey = generateFamilyKey();
    setFamilyKey(newFamilyKey);
    const showSuccess = (familyKey: string) => {
      setRotatedKey(familyKey);
      setPendingFamilyKey("");
      setTone("success");
      setMessage("家族キーを再発行しました。もう1台にも登録してください。");
    };
    try {
      const result = await api.rotateFamilyKey(newFamilyKey, currentFamilyKey);
      setFamilyKey(result.familyKey);
      await api.confirmFamilyKey(result.familyKey);
      showSuccess(result.familyKey);
    } catch (error) {
      let newKeyWorks = false;
      try {
        await api.validateFamilyKey(newFamilyKey);
        newKeyWorks = true;
        await api.confirmFamilyKey(newFamilyKey);
        showSuccess(newFamilyKey);
        return;
      } catch {
        if (!newKeyWorks) {
          setFamilyKey(currentFamilyKey);
          setTone("error");
          setMessage(error instanceof Error ? error.message : "再発行に失敗しました。");
          return;
        }
      }
      setTone("error");
      setRotatedKey(newFamilyKey);
      setPendingFamilyKey(newFamilyKey);
      setMessage(
        "新しい家族キーは保存されましたが、古いキーの無効化を確認できませんでした。通信を確認して再試行してください。"
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmRotatedKey = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.confirmFamilyKey(pendingFamilyKey);
      setPendingFamilyKey("");
      setTone("success");
      setMessage("古い家族キーを無効化しました。");
    } catch (error) {
      setTone("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "古い家族キーの無効化に失敗しました。"
      );
    } finally {
      setBusy(false);
    }
  };

  const updatePin = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.updatePin(newPin);
      clearParentToken();
      setAuthenticated(false);
      setNewPin("");
    } catch (error) {
      setTone("error");
      setMessage(error instanceof Error ? error.message : "PIN変更に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  if (!authenticated) {
    return <ParentLogin onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <div className="stack parent-stack">
      <StatusMessage message={message} tone={tone} />
      <section className="parent-summary">
        <div>
          <span>未払い残高</span>
          <strong>{yen(dashboard?.unpaidBalanceYen ?? 0)}</strong>
          <small>{dashboard?.unpaidAchievementCount ?? 0}件</small>
        </div>
        <button
          className="primary-button"
          disabled={busy || !dashboard?.unpaidAchievementCount}
          onClick={settle}
          type="button"
        >
          支払った
        </button>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">最近の記録</p>
            <h2>学習履歴</h2>
          </div>
          <button className="text-button" onClick={() => void api.exportCsv()} type="button">
            CSV保存
          </button>
        </div>
        <div className="history-list">
          {achievements.length === 0 && <p className="empty-copy">まだ記録がありません。</p>}
          {achievements.slice(0, 14).map((achievement) => (
            <div className="history-row" key={achievement.id}>
              <div>
                <strong>{shortDate(achievement.localDate)}</strong>
                <span>{achievement.subject || (achievement.method === "timer" ? "タイマー" : "自己申告")}</span>
              </div>
              <div>
                <strong>{yen(achievement.totalAmountYen)}</strong>
                <span>{achievement.paid ? "支払い済み" : "未払い"}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <p className="eyebrow">これからの達成に適用</p>
        <h2>小遣いルール</h2>
        <div className="form-grid">
          <label>
            1日の基本額
            <input
              min={0}
              onChange={(event) =>
                setRuleForm((value) => ({
                  ...value,
                  baseAmountYen: Number(event.target.value)
                }))
              }
              step={10}
              type="number"
              value={ruleForm.baseAmountYen}
            />
          </label>
          <label>
            ボーナス間隔（日）
            <input
              min={1}
              onChange={(event) =>
                setRuleForm((value) => ({
                  ...value,
                  bonusIntervalDays: Number(event.target.value)
                }))
              }
              type="number"
              value={ruleForm.bonusIntervalDays}
            />
          </label>
          <label>
            ボーナス額
            <input
              min={0}
              onChange={(event) =>
                setRuleForm((value) => ({
                  ...value,
                  bonusAmountYen: Number(event.target.value)
                }))
              }
              step={10}
              type="number"
              value={ruleForm.bonusAmountYen}
            />
          </label>
        </div>
        <button className="secondary-button" disabled={busy} onClick={saveRule} type="button">
          新しいルールを保存
        </button>
        <details className="compact-details">
          <summary>変更履歴（{rules.length}件）</summary>
          {rules.map((rule) => (
            <p key={rule.id}>
              {dateTime(rule.effectiveFrom)}：{yen(rule.baseAmountYen)} ＋
              {rule.bonusIntervalDays}日ごとに {yen(rule.bonusAmountYen)}
            </p>
          ))}
        </details>
      </section>

      <section className="card">
        <p className="eyebrow">支払い履歴</p>
        <h2>精算した記録</h2>
        {payments.length === 0 ? (
          <p className="empty-copy">まだ支払い記録がありません。</p>
        ) : (
          <div className="history-list">
            {payments.map((payment) => (
              <div className="history-row" key={payment.id}>
                <div>
                  <strong>{dateTime(payment.paidAt)}</strong>
                  <span>{payment.periodStartDate} 〜 {payment.periodEndDate}</span>
                </div>
                <div>
                  <strong>{yen(payment.amountYen)}</strong>
                  <span>{payment.achievementCount}件</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card notification-parent-card">
        <p className="eyebrow">娘のAndroid端末</p>
        <h2>未達通知</h2>
        <p>設定時刻の時点で今日の記録がなければ、登録済み端末へ1回通知します。</p>
        <label className="toggle-row">
          <input
            checked={notificationForm.enabled}
            onChange={(event) =>
              setNotificationForm((value) => ({
                ...value,
                enabled: event.target.checked
              }))
            }
            type="checkbox"
          />
          通知をONにする
        </label>
        <label>
          通知時刻（5分刻み）
          <input
            disabled={!notificationForm.enabled}
            onChange={(event) =>
              setNotificationForm((value) => ({
                ...value,
                time: event.target.value
              }))
            }
            step={300}
            type="time"
            value={notificationForm.time}
          />
        </label>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={saveNotificationSettings}
          type="button"
        >
          通知設定を保存
        </button>
      </section>

      <section className="card parent-security">
        <p className="eyebrow">端末と親ページ</p>
        <h2>家族キー・PIN</h2>
        {rotatedKey && (
          <div className="one-time-key">
            <strong>新しい家族キー（この画面で1回だけ）</strong>
            <code>{rotatedKey}</code>
            <button
              className="text-button"
              onClick={() => void navigator.clipboard.writeText(rotatedKey)}
              type="button"
            >
              コピー
            </button>
            {pendingFamilyKey && (
              <button
                className="text-button"
                disabled={busy}
                onClick={confirmRotatedKey}
                type="button"
              >
                古いキーの無効化を再試行
              </button>
            )}
          </div>
        )}
        <div className="button-row">
          <button className="secondary-button" disabled={busy} onClick={rotateKey} type="button">
            家族キーを再発行
          </button>
          <button
            className="text-button"
            onClick={() => {
              clearParentToken();
              setAuthenticated(false);
            }}
            type="button"
          >
            親ページを閉じる
          </button>
        </div>
        <div className="pin-change">
          <label>
            新しいPIN
            <input
              inputMode="numeric"
              maxLength={4}
              onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ""))}
              type="password"
              value={newPin}
            />
          </label>
          <button
            className="text-button"
            disabled={busy || newPin.length !== 4}
            onClick={updatePin}
            type="button"
          >
            PINを変更
          </button>
        </div>
      </section>
    </div>
  );
}
