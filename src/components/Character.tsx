import type { CSSProperties } from "react";
import {
  CHARACTER_META,
  CHARACTER_SPECIES,
  CHARACTER_STAGE,
  DECORATION_LABEL,
  nextGrowthMessage
} from "../characters";
import type {
  CharacterSpecies,
  CharacterStage,
  CharacterState,
  StreakDecoration
} from "../types";

function spriteStyle(
  species: CharacterSpecies,
  stage: CharacterStage
): CSSProperties {
  return {
    backgroundPosition: `${CHARACTER_STAGE[stage].column * 25}% ${CHARACTER_META[species].row * 25}%`
  };
}

function CharacterSprite({
  species,
  stage,
  decoration = "none",
  muted = false
}: {
  species: CharacterSpecies;
  stage: CharacterStage;
  decoration?: StreakDecoration;
  muted?: boolean;
}) {
  const decorationMark =
    decoration === "aura"
      ? "✦"
      : decoration === "crown"
        ? "♛"
        : decoration === "stars"
          ? "★"
          : "";
  return (
    <div
      aria-label={`${CHARACTER_META[species].name}・${CHARACTER_STAGE[stage].name}`}
      className={`character-sprite${muted ? " muted" : ""} decoration-${decoration}`}
      role="img"
      style={spriteStyle(species, stage)}
    >
      {decorationMark && (
        <span aria-hidden="true" className="character-decoration">
          {decorationMark}
        </span>
      )}
    </div>
  );
}

export function CharacterCard({ character }: { character: CharacterState }) {
  const revealed = character.stage === "hatchling" ||
    character.stage === "juvenile" ||
    character.stage === "adult";
  const meta = CHARACTER_META[character.species];
  return (
    <section className="card character-card">
      <div className="character-visual">
        <CharacterSprite
          decoration={character.streakDecoration}
          species={character.species}
          stage={character.stage}
        />
      </div>
      <div className="character-copy">
        <p className="eyebrow">育てている仲間</p>
        <h2>
          {revealed ? meta.name : "どんな子が生まれるかな"}
        </h2>
        <p>
          {revealed
            ? meta.description
            : "今日の学習を積み重ねると、卵が少しずつ育ちます。"}
        </p>
        <div
          aria-label={`成長 ${character.cycleProgressDays} / ${character.cycleGoalDays}`}
          className="growth-progress"
        >
          <span
            style={{
              width: `${Math.max(
                3,
                character.cycleProgressDays / character.cycleGoalDays * 100
              )}%`
            }}
          />
        </div>
        <div className="growth-meta">
          <strong>{character.cycleProgressDays} / {character.cycleGoalDays}日</strong>
          <span>
            {nextGrowthMessage(
              character.cycleProgressDays,
              character.nextStageAt
            )}
          </span>
        </div>
        {character.streakDecoration !== "none" && (
          <p className="decoration-copy">
            {DECORATION_LABEL[character.streakDecoration]}をまとっています。
          </p>
        )}
      </div>
    </section>
  );
}

export function CharacterCollection({
  character
}: {
  character: CharacterState;
}) {
  return (
    <section className="card collection-card">
      <p className="eyebrow">育った仲間</p>
      <h2>なかま図鑑</h2>
      <div className="character-collection">
        {CHARACTER_SPECIES.map((species) => {
          const grownCount =
            character.collection.find((item) => item.species === species)
              ?.grownCount ?? 0;
          return (
            <div className="collection-entry" key={species}>
              <CharacterSprite
                muted={grownCount === 0}
                species={species}
                stage="adult"
              />
              <strong>
                {grownCount > 0 ? CHARACTER_META[species].name : "？？？"}
              </strong>
              <span>{grownCount > 1 ? `${grownCount}体` : grownCount ? "仲間になった" : "未発見"}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
