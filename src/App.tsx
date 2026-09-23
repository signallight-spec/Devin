import { useEffect, useState } from "react";
import { clearFamilyKey, getFamilyKey } from "./api";
import { Layout, type Page } from "./components/Layout";
import { CalendarScreen } from "./screens/CalendarScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ParentScreen } from "./screens/ParentScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SetupScreen } from "./screens/SetupScreen";

function pageFromHash(): Page {
  const value = window.location.hash.slice(1);
  if (value === "calendar" || value === "settings" || value === "parent") {
    return value;
  }
  return "home";
}

export default function App() {
  const [hasFamilyKey, setHasFamilyKey] = useState(Boolean(getFamilyKey()));
  const [page, setPage] = useState<Page>(pageFromHash);

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

  if (!hasFamilyKey) {
    return <SetupScreen onReady={() => setHasFamilyKey(true)} />;
  }

  return (
    <Layout onNavigate={navigate} page={page}>
      {page === "home" && (
        <HomeScreen
          onInvalidKey={() => {
            clearFamilyKey();
            setHasFamilyKey(false);
          }}
        />
      )}
      {page === "calendar" && <CalendarScreen />}
      {page === "settings" && (
        <SettingsScreen
          onFamilyKeyReset={() => {
            if (window.confirm("この端末から家族キーを削除しますか？")) {
              clearFamilyKey();
              setHasFamilyKey(false);
            }
          }}
        />
      )}
      {page === "parent" && <ParentScreen />}
    </Layout>
  );
}
