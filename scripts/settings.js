import { MODULE_ID, SETTINGS } from "./constants.js";
import {
  SHARED_BASTION_DEFAULT_CONFIG,
  SharedBastionConfigApplication,
  applySharedBastionFacilitySlots,
  syncSharedBastionActorOwnership
} from "./shared-bastion.js";

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

  game.settings.register(MODULE_ID, SETTINGS.coveragePromptTimeoutSeconds, {
    name: "INDYVENTURES.Settings.CoveragePromptTimeoutSeconds.Name",
    hint: "INDYVENTURES.Settings.CoveragePromptTimeoutSeconds.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 180,
    range: {
      min: 30,
      max: 600,
      step: 10
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.rollPromptTimeoutSeconds, {
    name: "INDYVENTURES.Settings.RollPromptTimeoutSeconds.Name",
    hint: "INDYVENTURES.Settings.RollPromptTimeoutSeconds.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 180,
    range: {
      min: 30,
      max: 600,
      step: 10
    }
  });

  game.settings.registerMenu(MODULE_ID, SETTINGS.sharedBastion, {
    name: "INDYVENTURES.SharedBastion.MenuName",
    label: "INDYVENTURES.SharedBastion.MenuLabel",
    hint: "INDYVENTURES.SharedBastion.MenuHint",
    icon: "fas fa-chess-rook",
    type: SharedBastionConfigApplication,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTINGS.sharedBastion, {
    name: "INDYVENTURES.SharedBastion.SettingName",
    scope: "world",
    config: false,
    type: Object,
    default: SHARED_BASTION_DEFAULT_CONFIG,
    onChange: () => {
      if (!game.ready) return;
      applySharedBastionFacilitySlots();
      syncSharedBastionActorOwnership();
    }
  });
}
