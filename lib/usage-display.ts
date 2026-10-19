import { usageDisplay, type UsageSession } from "./usage.ts";

let live: { session: string; tokens: string; cost: string } | undefined;
export function setLiveUsage(value: UsageSession | undefined) {
  if (!value) {
    live = undefined;
    return;
  }
  live = {
    session: value.session,
    ...usageDisplay(value),
  };
}
export function liveUsage(session: string | undefined) {
  return live?.session === session ? live : undefined;
}
