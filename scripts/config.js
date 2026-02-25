import { DICE_STEPS, MODULE_ID, VENTURE_PRESETS } from "./constants.js";
import {
  asBoolean,
  asInteger,
  clamp,
  normalizeDie,
  parseBoonPerTurnLimit,
  parseBoonPurchaseWhen,
  parseBoonsText
} from "./utils.js";

const FLAG_CONFIG = `flags.${MODULE_ID}.config`;
const FLAG_STATE = `flags.${MODULE_ID}.state`;

function getPresetValues(preset) {
  return VENTURE_PRESETS[preset] ?? VENTURE_PRESETS.custom;
}

export function getInitialConfig(facility) {
  const defaultPreset = facility?.system?.type?.subtype === "pub" ? "tavern" : "custom";
  const config = {
    preset: defaultPreset,
    ventureName: facility?.name ?? ""
  };
  if (defaultPreset !== "custom") {
    const presetValues = getPresetValues(defaultPreset);
    config.profitDie = presetValues.profitDie;
    config.lossDie = presetValues.lossDie;
    config.successThreshold = presetValues.successThreshold;
    config.boonsText = presetValues.boonsText;
  }
  return sanitizeConfig(config, facility);
}

export function getInitialState(config) {
  return {
    currentProfitDie: normalizeDie(config?.profitDie, "d6"),
    streak: 0,
    treasury: 0,
    failed: false,
    lastTurnNet: 0,
    turnId: "",
    boonPurchases: {}
  };
}

export function sanitizeConfig(raw = {}, facility = null) {
  const base = {
    enabled: false,
    preset: "custom",
    ventureName: facility?.name ?? "",
    profitDie: "d6",
    lossDie: "d6",
    lossModifier: 0,
    autoCoverLoss: false,
    successThreshold: 3,
    boonsText: ""
  };

  const merged = foundry.utils.mergeObject(base, raw, { inplace: false, recursive: false, insertKeys: true });
  const preset = Object.hasOwn(VENTURE_PRESETS, merged.preset) ? merged.preset : "custom";
  if (preset !== "custom") {
    const presetValues = getPresetValues(preset);
    if ((raw.profitDie === undefined) || (raw.profitDie === null)) {
      merged.profitDie = presetValues.profitDie;
    }
    if ((raw.lossDie === undefined) || (raw.lossDie === null)) {
      merged.lossDie = presetValues.lossDie;
    }
    if ((raw.successThreshold === undefined) || (raw.successThreshold === null)) {
      merged.successThreshold = presetValues.successThreshold;
    }
    if ((raw.boonsText === undefined) || (raw.boonsText === null)) {
      merged.boonsText = presetValues.boonsText;
    }
  }

  merged.enabled = asBoolean(merged.enabled, false);
  merged.preset = preset;
  merged.ventureName = String(merged.ventureName ?? "").trim();
  merged.profitDie = normalizeDie(merged.profitDie, "d6");
  merged.lossDie = normalizeDie(merged.lossDie, "d6");
  merged.lossModifier = clamp(asInteger(merged.lossModifier, 0), -4, 4);
  merged.autoCoverLoss = asBoolean(merged.autoCoverLoss, false);
  merged.successThreshold = clamp(asInteger(merged.successThreshold, 3), 1, 12);
  merged.boonsText = String(merged.boonsText ?? "");
  return merged;
}

export function sanitizeState(raw = {}, config = null) {
  const base = getInitialState(config);
  const merged = foundry.utils.mergeObject(base, raw, { inplace: false, recursive: false, insertKeys: true });
  merged.currentProfitDie = normalizeDie(merged.currentProfitDie, config?.profitDie ?? "d6");
  merged.streak = Math.max(asInteger(merged.streak, 0), 0);
  merged.treasury = Math.max(asInteger(merged.treasury, 0), 0);
  merged.failed = asBoolean(merged.failed, false);
  merged.lastTurnNet = asInteger(merged.lastTurnNet, 0);
  merged.turnId = String(merged.turnId ?? "");
  const boonPurchases = {};
  if (merged.boonPurchases && (typeof merged.boonPurchases === "object")) {
    for (const [key, value] of Object.entries(merged.boonPurchases)) {
      const count = Math.max(asInteger(value, 0), 0);
      if (count > 0) boonPurchases[String(key)] = count;
    }
  }
  merged.boonPurchases = boonPurchases;
  return merged;
}

export function getFacilityConfig(facility) {
  const raw = facility.getFlag(MODULE_ID, "config") ?? {};
  return sanitizeConfig(raw, facility);
}

export function getFacilityState(facility, config = null) {
  const safeConfig = config ?? getFacilityConfig(facility);
  const raw = facility.getFlag(MODULE_ID, "state") ?? {};
  return sanitizeState(raw, safeConfig);
}

export function parseBoonsFromConfig(config) {
  return parseBoonsText(config?.boonsText ?? "");
}

export async function updateFacilityVenture(facility, config, state) {
  const update = {
    [FLAG_CONFIG]: sanitizeConfig(config, facility),
    [FLAG_STATE]: sanitizeState(state, config)
  };
  return facility.update(update);
}

export function prepareFacilitySheetContext(facility) {
  const config = getFacilityConfig(facility);
  const state = getFacilityState(facility, config);
  const boons = parseBoonsFromConfig(config).map((boon, index) => {
    const perTurnLimit = parseBoonPerTurnLimit(boon.perTurnLimit, 1);
    const purchaseWhen = parseBoonPurchaseWhen(boon.purchaseWhen, "default");
    const rewardUuid = String(boon.rewardUuid ?? "").trim();

    let rewardName = String(boon.rewardLabel ?? boon.rewardUuid ?? "").trim();
    let rewardImg = "";
    if (rewardUuid && globalThis.fromUuidSync) {
      const doc = fromUuidSync(rewardUuid, { strict: false });
      if (doc?.name) rewardName = doc.name;
      if (doc?.img) rewardImg = doc.img;
    }
    if (!rewardName) rewardName = "-";

    let purchaseWhenIcon = "fa-solid fa-circle-half-stroke";
    let purchaseWhenLabel = game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Default");
    if (purchaseWhen === "loss") {
      purchaseWhenIcon = "fa-solid fa-arrow-trend-down";
      purchaseWhenLabel = game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Loss");
    } else if (purchaseWhen === "profit") {
      purchaseWhenIcon = "fa-solid fa-arrow-trend-up";
      purchaseWhenLabel = game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Profit");
    }

    return {
      index,
      name: boon.name,
      description: String(boon.description ?? "").trim(),
      cost: boon.cost,
      rewardUuid,
      rewardName,
      rewardImg,
      countDisplay: perTurnLimit === null ? "∞" : String(perTurnLimit),
      purchaseWhenIcon,
      purchaseWhenLabel
    };
  });

  return {
    config,
    state,
    diceOptions: DICE_STEPS.map(value => ({ value, label: value })),
    presetOptions: [
      { value: "custom", label: game.i18n.localize("INDYVENTURES.Preset.Custom") },
      { value: "tavern", label: game.i18n.localize("INDYVENTURES.Preset.Tavern") },
      { value: "cult", label: game.i18n.localize("INDYVENTURES.Preset.Cult") }
    ],
    boonCount: boons.length,
    boons
  };
}

export function sanitizeConfigPatchForUpdate(facility, change) {
  const patch = foundry.utils.getProperty(change, FLAG_CONFIG);
  if (!patch) return;
  const current = getFacilityConfig(facility);
  const merged = foundry.utils.mergeObject(current, patch, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });

  const nextPreset = Object.hasOwn(VENTURE_PRESETS, merged.preset) ? merged.preset : "custom";
  const presetChanged = Object.hasOwn(patch, "preset") && (nextPreset !== current.preset);
  if (presetChanged && (nextPreset !== "custom")) {
    const presetValues = getPresetValues(nextPreset);
    if (!Object.hasOwn(patch, "profitDie")) merged.profitDie = presetValues.profitDie;
    if (!Object.hasOwn(patch, "lossDie")) merged.lossDie = presetValues.lossDie;
    if (!Object.hasOwn(patch, "successThreshold")) merged.successThreshold = presetValues.successThreshold;
    if (!Object.hasOwn(patch, "boonsText")) merged.boonsText = presetValues.boonsText;
  }

  foundry.utils.setProperty(change, FLAG_CONFIG, sanitizeConfig(merged, facility));
}

export function sanitizeStatePatchForUpdate(facility, change) {
  const patch = foundry.utils.getProperty(change, FLAG_STATE);
  if (!patch) return;

  const configPatch = foundry.utils.getProperty(change, FLAG_CONFIG) ?? {};
  const nextConfig = sanitizeConfig(foundry.utils.mergeObject(getFacilityConfig(facility), configPatch, {
    inplace: false,
    recursive: true,
    insertKeys: true
  }), facility);

  const current = getFacilityState(facility, nextConfig);
  const merged = foundry.utils.mergeObject(current, patch, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  foundry.utils.setProperty(change, FLAG_STATE, sanitizeState(merged, nextConfig));
}
