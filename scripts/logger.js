import { MODULE_ID, SETTINGS } from "./constants.js";

function debugEnabled() {
  return Boolean(game?.settings?.get(MODULE_ID, SETTINGS.debugLogging));
}

function withPrefix(args) {
  return [`${MODULE_ID} |`, ...args];
}

export function moduleLog(...args) {
  if (!debugEnabled()) return;
  console.log(...withPrefix(args));
}

export function moduleWarn(...args) {
  if (!debugEnabled()) return;
  console.warn(...withPrefix(args));
}

export function moduleError(...args) {
  if (!debugEnabled()) return;
  console.error(...withPrefix(args));
}
