import type {
  CharacterSpecies,
  CharacterStage,
  StreakDecoration
} from "./types";

export const CHARACTER_SPECIES: CharacterSpecies[] = [
  "dragon",
  "fox",
  "owl",
  "rabbit",
  "bear"
];

export const CHARACTER_META: Record<
  CharacterSpecies,
  { name: string; description: string; row: number }
> = {
  dragon: {
    name: "そらドラゴン",
    description: "小さな翼で、新しい挑戦へ飛び立つ仲間",
    row: 0
  },
  fox: {
    name: "このはキツネ",
    description: "好奇心いっぱいで、学びを見つける仲間",
    row: 1
  },
  owl: {
    name: "つきフクロウ",
    description: "落ち着いて考えることが得意な仲間",
    row: 2
  },
  rabbit: {
    name: "ほしウサギ",
    description: "小さな一歩を軽やかに重ねる仲間",
    row: 3
  },
  bear: {
    name: "めばえグマ",
    description: "ゆっくりでも着実に育っていく仲間",
    row: 4
  }
};

export const CHARACTER_STAGE: Record<
  CharacterStage,
  { name: string; column: number }
> = {
  egg: { name: "卵", column: 0 },
  cracked: { name: "ひびの入った卵", column: 1 },
  hatchling: { name: "生まれたて", column: 2 },
  juvenile: { name: "幼獣", column: 3 },
  adult: { name: "成獣", column: 4 }
};

export const DECORATION_LABEL: Record<StreakDecoration, string> = {
  none: "",
  stars: "連続達成の星",
  crown: "7日連続の冠",
  aura: "14日連続のオーラ"
};

export function nextGrowthMessage(
  progressDays: number,
  nextStageAt: number | null
): string {
  if (nextStageAt === null) {
    return "成獣になりました。次の達成から新しい卵を育てます。";
  }
  const remaining = nextStageAt - progressDays;
  const event =
    nextStageAt === 3
      ? "卵にひびが入ります"
      : nextStageAt === 7
        ? "仲間が生まれます"
        : nextStageAt === 14
          ? "幼獣に育ちます"
          : "成獣になります";
  return `あと${remaining}回の達成で${event}。`;
}
