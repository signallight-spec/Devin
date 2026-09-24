import { localDateInTokyo, localTimeInTokyo } from "../shared/domain";

export function notificationDue(
  enabled: boolean,
  notificationTime: string,
  now: Date
): { due: boolean; localDate: string } {
  return {
    due: enabled && localTimeInTokyo(now) >= notificationTime,
    localDate: localDateInTokyo(now)
  };
}
