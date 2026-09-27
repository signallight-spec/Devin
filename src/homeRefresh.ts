import {
  localDateInTokyo,
  millisecondsUntilNextTokyoDay
} from "../shared/domain";

const DATE_REFRESH_RETRY_MS = 30_000;

export function nextHomeRefreshDelay(
  now: Date,
  displayedLocalDate: string,
  refreshSucceeded: boolean
): number | null {
  if (localDateInTokyo(now) !== displayedLocalDate) {
    return refreshSucceeded ? null : DATE_REFRESH_RETRY_MS;
  }
  return millisecondsUntilNextTokyoDay(now) + 100;
}
