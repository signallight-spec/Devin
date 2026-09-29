import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { CharacterCollection } from "../components/Character";
import { StatusMessage } from "../components/StatusMessage";
import { currentMonth, shortDate, yen } from "../format";
import type { Achievement, CalendarData } from "../types";

function monthCells(month: string): Array<string | null> {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= dayCount; day += 1) {
    cells.push(`${month}-${String(day).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  return cells;
}

export function CalendarScreen() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<CalendarData | null>(null);
  const [selected, setSelected] = useState<Achievement | null>(null);
  const [message, setMessage] = useState("");
  const achievementByDate = useMemo(
    () => new Map(data?.achievements.map((item) => [item.localDate, item]) ?? []),
    [data]
  );

  useEffect(() => {
    let active = true;
    setMessage("");
    api.calendar(month)
      .then((result) => {
        if (active) {
          setData(result);
          setSelected(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setData(null);
          setSelected(null);
          setMessage(error instanceof Error ? error.message : "読み込みに失敗しました。");
        }
      });
    return () => {
      active = false;
    };
  }, [month]);

  return (
    <div className="stack">
      <section className="summary-grid">
        <div className="summary-card">
          <span>連続</span>
          <strong>{data?.currentStreakDays ?? 0}日</strong>
        </div>
        <div className="summary-card">
          <span>今週</span>
          <strong>{data?.weeklyAchievementCount ?? 0}日</strong>
        </div>
        <div className="summary-card">
          <span>未払い目安</span>
          <strong>{yen(data?.unpaidBalanceYen ?? 0)}</strong>
        </div>
      </section>
      <section className="card calendar-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">スタンプ帳</p>
            <h2>学習カレンダー</h2>
          </div>
          <input
            aria-label="表示する月"
            className="month-input"
            onChange={(event) => setMonth(event.target.value)}
            type="month"
            value={month}
          />
        </div>
        <StatusMessage message={message} />
        <div className="weekday-row" aria-hidden="true">
          {["月", "火", "水", "木", "金", "土", "日"].map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="calendar-grid">
          {monthCells(month).map((date, index) => {
            if (!date) {
              return <div className="calendar-day empty" key={`empty-${index}`} />;
            }
            const achievement = achievementByDate.get(date);
            return (
              <button
                aria-label={`${shortDate(date)}${achievement ? " 達成" : " 記録なし"}`}
                className={achievement ? "calendar-day stamped" : "calendar-day"}
                key={date}
                onClick={() => setSelected(achievement ?? null)}
                type="button"
              >
                <span>{Number(date.slice(-2))}</span>
                {achievement && <b aria-hidden="true">★</b>}
              </button>
            );
          })}
        </div>
      </section>
      {selected && (
        <section className="card selected-day">
          <div>
            <p className="eyebrow">{shortDate(selected.localDate)}</p>
            <h2>{selected.subject || "学習を記録"}</h2>
            <p>{selected.note || "一言メモはありません。"}</p>
          </div>
          <div className="selected-reward">
            <strong>{yen(selected.totalAmountYen)}</strong>
            <span>{selected.streakDays}日連続</span>
          </div>
        </section>
      )}
      {data && <CharacterCollection character={data.character} />}
      <p className="quiet-note">今週の獲得目安：{yen(data?.weeklyEarnedYen ?? 0)}</p>
    </div>
  );
}
