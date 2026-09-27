import { useCallback, useEffect, useState } from "react";
import {
  clearFamilyKey,
  clearPendingSetupKey,
  getFamilyKey,
  getPendingSetupKey
} from "./api";
import { Layout, type Page } from "./components/Layout";
import { CalendarScreen } from "./screens/CalendarScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ParentScreen } from "./screens/ParentScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SetupScreen } from "./screens/SetupScreen";
import { disconnectPushBeforeFamilyKeyRemoval } from "./push";
import { useTimer } from "./hooks/useTimer";

function pageFromHash(): Page {
  const value = window.location.hash.slice(1);
  if (value === "calendar" || value === "settings" || value === "parent") {
    return value;
  }
  return "home";
}

function AuthenticatedApp({
  onFamilyKeyReset
}: {
  onFamilyKeyReset: () => Promise<void>;
}) {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [timerGoalMinutes, setTimerGoalMinutes] = useState(25);
  const timer = useTimer(timerGoalMinutes);

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = (nextPage: Page) => {
    window.location.hash = nextPage;
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <Layout onNavigate={navigate} page={page}>
      {page === "home" && (
        <HomeScreen
          onGoalMinutesLoaded={setTimerGoalMinutes}
          onInvalidKey={onFamilyKeyReset}
          timer={timer}
        />
      )}
      {page === "calendar" && <CalendarScreen />}
      {page === "settings" && (
        <SettingsScreen
          onFamilyKeyReset={onFamilyKeyReset}
        />
      )}
      {page === "parent" && <ParentScreen />}
    </Layout>
  );
}

export default function App() {
  const [hasFamilyKey, setHasFamilyKey] = useState(Boolean(getFamilyKey()));
  const [hasPendingSetupKey, setHasPendingSetupKey] = useState(
    Boolean(getPendingSetupKey())
  );

  const resetFamilyKey = useCallback(async () => {
    try {
      await disconnectPushBeforeFamilyKeyRemoval();
    } catch (error) {
      throw new Error(
        "通知の解除に失敗したため、家族キーは削除していません。通信状態を確認して、もう一度お試しください。",
        { cause: error }
      );
    }
    clearFamilyKey();
    setHasFamilyKey(false);
    setHasPendingSetupKey(false);
  }, []);

  if (!hasFamilyKey || hasPendingSetupKey) {
    return (
      <SetupScreen
        onReady={() => {
          clearPendingSetupKey();
          setHasPendingSetupKey(false);
          setHasFamilyKey(true);
        }}
      />
    );
  }

  return <AuthenticatedApp onFamilyKeyReset={resetFamilyKey} />;
}
