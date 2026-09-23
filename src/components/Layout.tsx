import type { ReactNode } from "react";

export type Page = "home" | "calendar" | "settings" | "parent";

const items: Array<{ page: Page; label: string; mark: string }> = [
  { page: "home", label: "ホーム", mark: "●" },
  { page: "calendar", label: "カレンダー", mark: "▦" },
  { page: "settings", label: "設定", mark: "⌁" },
  { page: "parent", label: "親ページ", mark: "◇" }
];

export function Layout({
  page,
  onNavigate,
  children
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">毎日少しずつで大丈夫</p>
          <h1>まいにち学習スタンプ</h1>
        </div>
        <div className="brand-star" aria-hidden="true">★</div>
      </header>
      <main className="main-content">{children}</main>
      <nav className="bottom-nav" aria-label="メインメニュー">
        {items.map((item) => (
          <button
            className={page === item.page ? "nav-item active" : "nav-item"}
            key={item.page}
            onClick={() => onNavigate(item.page)}
            type="button"
          >
            <span aria-hidden="true">{item.mark}</span>
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
