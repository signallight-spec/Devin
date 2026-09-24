import { useState } from "react";
import {
  api,
  generateFamilyKey,
  getFamilyKey,
  setFamilyKey
} from "../api";
import { StatusMessage } from "../components/StatusMessage";

export function SetupScreen({ onReady }: { onReady: () => void }) {
  const [familyKeyInput, setFamilyKeyInput] = useState("");
  const [showInitialSetup, setShowInitialSetup] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [pin, setPin] = useState("");
  const [generatedKey, setGeneratedKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copyMessage, setCopyMessage] = useState("");

  const saveExistingKey = async () => {
    const value = familyKeyInput.trim();
    if (!value) {
      setMessage("家族キーを入力してください。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await api.validateFamilyKey(value);
      setFamilyKey(value);
      onReady();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "家族キーを確認できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const copyGeneratedKey = async () => {
    setCopyMessage("");
    try {
      await navigator.clipboard.writeText(generatedKey);
      setCopyMessage("コピーしました。");
    } catch {
      setCopyMessage("コピーできませんでした。キー欄を選択してコピーしてください。");
    }
  };

  const setup = async () => {
    setBusy(true);
    setMessage("");
    const familyKey = getFamilyKey() || generateFamilyKey();
    setFamilyKey(familyKey);
    try {
      const result = await api.setupRecoverable({
        bootstrapToken,
        familyKey,
        pin,
        goalMinutes: 25,
        baseAmountYen: 100,
        bonusAmountYen: 300
      });
      setFamilyKey(result.familyKey);
      setGeneratedKey(result.familyKey);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "初期設定に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  if (generatedKey) {
    return (
      <main className="setup-page">
        <section className="setup-card">
          <div className="setup-mark" aria-hidden="true">★</div>
          <p className="eyebrow">初期設定完了</p>
          <h1>家族キーを保存してください</h1>
          <p className="lead">
            親の端末を設定するときに使います。この画面を閉じると再表示できません。
          </p>
          <div className="one-time-key">
            <input
              aria-label="家族キー"
              className="family-key-output"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              spellCheck={false}
              value={generatedKey}
            />
            <button
              className="text-button"
              onClick={() => void copyGeneratedKey()}
              type="button"
            >
              {copyMessage === "コピーしました。" ? "コピー済み" : "コピー"}
            </button>
          </div>
          <StatusMessage
            message={copyMessage}
            tone={copyMessage === "コピーしました。" ? "success" : "error"}
          />
          <button className="primary-button" onClick={onReady} type="button">
            保存したので始める
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <section className="setup-card">
        <div className="setup-mark" aria-hidden="true">★</div>
        <p className="eyebrow">家庭専用</p>
        <h1>まいにち学習スタンプ</h1>
        <p className="lead">
          最初に、この端末へ家族キーを登録します。
        </p>
        <label>
          家族キー
          <input
            autoComplete="off"
            onChange={(event) => setFamilyKeyInput(event.target.value)}
            placeholder="家族キーを貼り付け"
            value={familyKeyInput}
          />
        </label>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => void saveExistingKey()}
          type="button"
        >
          {busy ? "確認中…" : "この端末で使う"}
        </button>
        <StatusMessage message={message} />
        <button
          className="text-button"
          onClick={() => {
            setMessage("");
            setShowInitialSetup((value) => !value);
          }}
          type="button"
        >
          {showInitialSetup ? "初期設定を閉じる" : "初めての1台を設定する"}
        </button>
        {showInitialSetup && (
          <div className="initial-setup">
            <p>デプロイ時に設定した初期設定トークンと、親用PINを入力します。</p>
            <label>
              初期設定トークン
              <input
                autoComplete="off"
                onChange={(event) => setBootstrapToken(event.target.value)}
                type="password"
                value={bootstrapToken}
              />
            </label>
            <label>
              親用PIN（4桁）
              <input
                autoComplete="new-password"
                inputMode="numeric"
                maxLength={4}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                type="password"
                value={pin}
              />
            </label>
            <button
              className="secondary-button"
              disabled={busy || !bootstrapToken || pin.length !== 4}
              onClick={setup}
              type="button"
            >
              {busy ? "設定中…" : "初期設定して始める"}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
