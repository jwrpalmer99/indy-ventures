import { MODULE_ID, SETTINGS } from "./constants.js";

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.integrateBastion, {
    name: "INDYVENTURES.Settings.IntegrateBastion.Name",
    hint: "INDYVENTURES.Settings.IntegrateBastion.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.postChatSummary, {
    name: "INDYVENTURES.Settings.PostChatSummary.Name",
    hint: "INDYVENTURES.Settings.PostChatSummary.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.hideVentureHirelings, {
    name: "INDYVENTURES.Settings.HideVentureHirelings.Name",
    hint: "INDYVENTURES.Settings.HideVentureHirelings.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.debugLogging, {
    name: "INDYVENTURES.Settings.DebugLogging.Name",
    hint: "INDYVENTURES.Settings.DebugLogging.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}
