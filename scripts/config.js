import { DICE_STEPS, MODULE_ID } from "./constants.js";
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
const VENTURE_MODIFIER_CHANGE_PREFIX = `flags.${MODULE_ID}.ventureModifier.`;

export function getInitialConfig(facility) {
  const config = {
    ventureName: facility?.name ?? ""
  };
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
    ventureName: facility?.name ?? "",
    profitDie: "d6",
    lossDie: "d6",
    lossModifier: 0,
    gpPerPoint: 100,
    autoCoverLoss: false,
    successThreshold: 3,
    boonsText: ""
  };

  const merged = foundry.utils.mergeObject(base, raw, { inplace: false, recursive: false, insertKeys: true });

  merged.enabled = asBoolean(merged.enabled, false);
  merged.ventureName = String(merged.ventureName ?? "").trim();
  merged.profitDie = normalizeDie(merged.profitDie, "d6");
  merged.lossDie = normalizeDie(merged.lossDie, "d6");
  merged.lossModifier = clamp(asInteger(merged.lossModifier, 0), -4, 4);
  merged.gpPerPoint = Math.max(asInteger(merged.gpPerPoint, 100), 0);
  merged.autoCoverLoss = asBoolean(merged.autoCoverLoss, false);
  merged.successThreshold = clamp(asInteger(merged.successThreshold, 3), 1, 12);
  merged.boonsText = String(merged.boonsText ?? "");
  delete merged.preset;
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

function getVentureModifierFromEffect(effect) {
  if (!effect) return null;
  const rawFlagData = effect.getFlag(MODULE_ID, "ventureModifier");
  const fromFlags = (rawFlagData && (typeof rawFlagData === "object")) ? foundry.utils.deepClone(rawFlagData) : {};
  const fromChanges = {};
  for (const change of effect.changes ?? []) {
    const key = String(change?.key ?? "");
    if (!key.startsWith(VENTURE_MODIFIER_CHANGE_PREFIX)) continue;
    const subKey = key.slice(VENTURE_MODIFIER_CHANGE_PREFIX.length);
    foundry.utils.setProperty(fromChanges, subKey, change?.value);
  }
  const merged = foundry.utils.mergeObject(fromChanges, fromFlags, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  if (!merged || (typeof merged !== "object") || (Object.keys(merged).length === 0)) return null;
  return merged;
}

function parseModifierNumber(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function summarizeVentureModifier(modifier) {
  if (!modifier) return "";
  const parts = [];
  const profitDieStep = parseModifierNumber(modifier.profitDieStep, 0);
  const lossDieStep = parseModifierNumber(modifier.lossDieStep, 0);
  const profitRollBonus = parseModifierNumber(modifier.profitRollBonus, 0);
  if (profitDieStep) parts.push(`profit die step ${profitDieStep > 0 ? "+" : ""}${profitDieStep}`);
  if (modifier.profitDieOverride) parts.push(`profit die ${modifier.profitDieOverride}`);
  if (modifier.minProfitDie) parts.push(`minimum profit die ${modifier.minProfitDie}`);
  if (lossDieStep) parts.push(`loss die step ${lossDieStep > 0 ? "+" : ""}${lossDieStep}`);
  if (modifier.lossDieOverride) parts.push(`loss die ${modifier.lossDieOverride}`);
  if (modifier.maxLossDie) parts.push(`maximum loss die ${modifier.maxLossDie}`);
  const successThresholdOverride = parseModifierNumber(modifier.successThresholdOverride, 0);
  if (successThresholdOverride > 0) parts.push(`successes to grow ${successThresholdOverride}`);
  if (profitRollBonus) parts.push(`profit bonus ${profitRollBonus > 0 ? "+" : ""}${profitRollBonus}`);
  if (String(modifier.bastionDurationType ?? "").trim() === "nextBastionTurn") {
    parts.push(game.i18n.localize("INDYVENTURES.EffectSummary.BastionDurationNextTurn"));
  }
  return parts.join(", ");
}

function getEffectRemainingTurns(modifier) {
  const raw = modifier?.remainingTurns;
  let remaining = ((raw === undefined) || (raw === null) || (String(raw).trim() === ""))
    ? null
    : Math.max(parseModifierNumber(raw, 0), 0);
  if ((String(modifier?.bastionDurationType ?? "").trim() === "nextBastionTurn") && (remaining === null)) {
    remaining = 1;
  }
  return remaining;
}

function getFacilityVentureEffects(facility) {
  const list = [];
  for (const effect of facility.effects ?? []) {
    const modifier = getVentureModifierFromEffect(effect);
    if (!modifier) continue;
    const isTemplate = effect.getFlag(MODULE_ID, "ventureModifierTemplate") === true;
    if (isTemplate) continue;
    const remainingTurns = getEffectRemainingTurns(modifier);
    list.push({
      id: effect.id,
      uuid: effect.uuid,
      name: effect.name,
      disabled: Boolean(effect.disabled),
      isTemplate,
      summary: summarizeVentureModifier(modifier),
      remainingTurnsDisplay: remainingTurns === null
        ? game.i18n.localize("INDYVENTURES.Chat.BastionEffectsNoTurnLimit")
        : game.i18n.format("INDYVENTURES.Chat.BastionEffectsTurnsRemaining", { turns: remainingTurns }),
      statusLabel: isTemplate
        ? game.i18n.localize("INDYVENTURES.Sheet.ActiveEffectsTemplate")
        : game.i18n.localize("INDYVENTURES.Sheet.ActiveEffectsApplied")
    });
  }
  return list;
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
    activeEffects: getFacilityVentureEffects(facility),
    diceOptions: DICE_STEPS.map(value => ({ value, label: value })),
    boonCount: boons.length,
    boons
  };
}

export function sanitizeConfigPatchForUpdate(facility, change) {
  const patch = foundry.utils.getProperty(change, FLAG_CONFIG);
  if (!patch) return;
  const merged = foundry.utils.mergeObject(getFacilityConfig(facility), patch, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
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
