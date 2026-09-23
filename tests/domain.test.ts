import { describe, expect, it } from "vitest";
import {
  calculateCharacterState,
  calculateReward,
  calculateStreak,
  characterSpeciesForCycle,
  displayedStreak,
  localDateInTokyo,
  mondayWeekRange
} from "../shared/domain";
import { shortDate } from "../src/format";

describe("学習記録の計算", () => {
  it("日本時間の日付を実行環境のタイムゾーンに左右されず表示する", () => {
    expect(shortDate("2026-09-23")).toBe("9/23(水)");
  });

  it("日本時間の日付をUTC境界から計算する", () => {
    expect(localDateInTokyo(new Date("2026-09-22T14:59:59Z"))).toBe("2026-09-22");
    expect(localDateInTokyo(new Date("2026-09-22T15:00:00Z"))).toBe("2026-09-23");
  });

  it("前日に達成していれば連続日数を増やす", () => {
    expect(calculateStreak("2026-09-22", 6, "2026-09-23")).toBe(7);
  });

  it("1日空いたら連続日数を1へ戻す", () => {
    expect(calculateStreak("2026-09-21", 6, "2026-09-23")).toBe(1);
  });

  it("7日ごとの達成日だけボーナスを加算する", () => {
    expect(calculateReward(6, 100, 7, 300)).toEqual({
      baseAmountYen: 100,
      bonusAmountYen: 0,
      totalAmountYen: 100
    });
    expect(calculateReward(7, 100, 7, 300)).toEqual({
      baseAmountYen: 100,
      bonusAmountYen: 300,
      totalAmountYen: 400
    });
    expect(calculateReward(14, 100, 7, 300).totalAmountYen).toBe(400);
  });

  it("最後の達成が昨日より前なら表示上の連続日数を0にする", () => {
    expect(displayedStreak("2026-09-21", 12, "2026-09-23")).toBe(0);
    expect(displayedStreak("2026-09-22", 12, "2026-09-23")).toBe(12);
  });

  it("週を月曜日から日曜日として集計する", () => {
    expect(mondayWeekRange("2026-09-23")).toEqual({
      start: "2026-09-21",
      end: "2026-09-27"
    });
  });

  it("累計達成日数から卵・孵化・成獣の段階を計算する", () => {
    expect(calculateCharacterState(0, 0, 123).stage).toBe("egg");
    expect(calculateCharacterState(3, 3, 123).stage).toBe("cracked");
    expect(calculateCharacterState(7, 7, 123).stage).toBe("hatchling");
    expect(calculateCharacterState(14, 14, 123).stage).toBe("juvenile");
    expect(calculateCharacterState(30, 30, 123)).toMatchObject({
      stage: "adult",
      cycleProgressDays: 30,
      nextStageAt: null
    });
    expect(calculateCharacterState(31, 1, 123)).toMatchObject({
      stage: "egg",
      cycleProgressDays: 1
    });
  });

  it("5種類が揃うまで成獣を重複させない", () => {
    const firstCollection = Array.from(
      { length: 5 },
      (_, index) => characterSpeciesForCycle(98765, index)
    );
    expect(new Set(firstCollection).size).toBe(5);
  });

  it("連続日数を一時的な育成演出へ変換する", () => {
    expect(calculateCharacterState(10, 2, 123).streakDecoration).toBe("none");
    expect(calculateCharacterState(10, 3, 123).streakDecoration).toBe("stars");
    expect(calculateCharacterState(10, 7, 123).streakDecoration).toBe("crown");
    expect(calculateCharacterState(10, 14, 123).streakDecoration).toBe("aura");
  });
});
