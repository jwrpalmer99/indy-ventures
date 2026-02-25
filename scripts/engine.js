import { DICE_STEPS, MODULE_ID, SETTINGS, TEMPLATE_PATHS } from "./constants.js";
import {
  getFacilityConfig,
  getFacilityState,
  parseBoonsFromConfig,
  updateFacilityVenture
} from "./config.js";
import {
  buildBoonGroupKey,
  buildBoonKey,
  boonPurchaseWhenAllows,
  parseBoonPerTurnLimit,
  parseBoonPurchaseWhen,
  resolveRewardDocumentSync,
  shiftDie
} from "./utils.js";
import { moduleLog } from "./logger.js";

const SOCKET_NAMESPACE = `module.${MODULE_ID}`;
const COVERAGE_TIMEOUT_MS = 60_000;
const pendingCoverageRequests = new Map();
const VENTURE_MODIFIER_FLAG = `flags.${MODULE_ID}.ventureModifier`;
const VENTURE_MODIFIER_CHANGE_PREFIX = `${VENTURE_MODIFIER_FLAG}.`;
const BASTION_DURATION_FLAG = `flags.${MODULE_ID}.bastionDuration`;
const BASTION_DURATION_CHANGE_PREFIX = `${BASTION_DURATION_FLAG}.`;
const CURRENCY_IN_CP = {
  pp: 1000,
  gp: 100,
  ep: 50,
  sp: 10,
  cp: 1
};
const CURRENCY_ORDER = ["pp", "gp", "ep", "sp", "cp"];

function getRenderTemplate() {
  return foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
}

async function requestUserRoll({ formula, actor, facilityName, rollLabel }) {
  const title = game.i18n.localize("INDYVENTURES.RollPrompt.Title");
  const content = game.i18n.format("INDYVENTURES.RollPrompt.Content", {
    rollLabel,
    formula,
    facility: facilityName
  });
  const rollButton = game.i18n.localize("INDYVENTURES.RollPrompt.Roll");
  const flavor = game.i18n.format("INDYVENTURES.RollPrompt.Flavor", {
    rollLabel,
    facility: facilityName
  });

  const doRoll = async () => {
    const roll = await Roll.create(formula).evaluate({ allowInteractive: true });
    await roll.toMessage({
      speaker: getSpeaker(actor),
      flavor
    });
    return roll;
  };

  if (foundry.applications?.api?.DialogV2?.prompt) {
    return foundry.applications.api.DialogV2.prompt({
      window: { title, resizable: true },
      content,
      rejectClose: true,
      ok: {
        label: rollButton,
        callback: async () => doRoll()
      }
    });
  }

  if (foundry.applications?.api?.Dialog?.prompt) {
    return foundry.applications.api.Dialog.prompt({
      window: { title, resizable: true },
      content,
      ok: {
        label: rollButton,
        callback: async () => doRoll()
      }
    });
  }

  return doRoll();
}

function parseEffectNumber(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEffectBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
    return fallback;
  }
  return Boolean(value);
}

function parseEffectDie(value) {
  const die = String(value ?? "").trim().toLowerCase();
  return DICE_STEPS.includes(die) ? die : null;
}

function parseCurrencyValue(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(parsed, 0);
}

function gpToCp(gp) {
  return Math.max(Math.round((Number(gp) || 0) * 100), 0);
}

function cpToGp(cp) {
  return Math.max((Number(cp) || 0) / 100, 0);
}

function formatGpAmount(value) {
  const amount = Number(value) || 0;
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/\.?0+$/, "");
}

function createCoverageWallet(actor) {
  const wallet = {
    currency: {},
    dirty: false
  };
  for (const key of CURRENCY_ORDER) {
    wallet.currency[key] = parseCurrencyValue(actor?.system?.currency?.[key] ?? 0);
  }
  return wallet;
}

function getWalletCurrency(wallet, key) {
  return parseCurrencyValue(wallet?.currency?.[key] ?? 0);
}

function getWalletTotalCp(wallet) {
  return CURRENCY_ORDER.reduce((total, key) => total + (getWalletCurrency(wallet, key) * CURRENCY_IN_CP[key]), 0);
}

function getWalletTotalGp(wallet) {
  return cpToGp(getWalletTotalCp(wallet));
}

function canCoverFromInventory(wallet, gpAmount) {
  return getWalletTotalCp(wallet) >= gpToCp(gpAmount);
}

function spendFromGp(wallet, gpAmount) {
  const amount = Math.max(Number(gpAmount) || 0, 0);
  if (amount <= 0) return true;
  const gp = getWalletCurrency(wallet, "gp");
  if (gp < amount) return false;
  wallet.currency.gp = gp - amount;
  wallet.dirty = true;
  return true;
}

function spendFromInventory(wallet, gpAmount) {
  const requiredCp = gpToCp(gpAmount);
  if (requiredCp <= 0) return true;
  const totalCp = getWalletTotalCp(wallet);
  if (totalCp < requiredCp) return false;

  let remainingCp = totalCp - requiredCp;
  for (const key of CURRENCY_ORDER) {
    const unit = CURRENCY_IN_CP[key];
    wallet.currency[key] = Math.floor(remainingCp / unit);
    remainingCp %= unit;
  }
  wallet.dirty = true;
  return true;
}

function buildWalletUpdateData(wallet) {
  const update = {};
  for (const key of CURRENCY_ORDER) {
    update[`system.currency.${key}`] = getWalletCurrency(wallet, key);
  }
  return update;
}

function summarizeModifierEffect(modifier) {
  const parts = [];
  if (modifier.profitDieStep) parts.push(`profit die step ${modifier.profitDieStep > 0 ? "+" : ""}${modifier.profitDieStep}`);
  if (modifier.profitDieOverride) parts.push(`profit die ${modifier.profitDieOverride}`);
  if (modifier.minProfitDie) parts.push(`minimum profit die ${modifier.minProfitDie}`);
  if (modifier.lossDieStep) parts.push(`loss die step ${modifier.lossDieStep > 0 ? "+" : ""}${modifier.lossDieStep}`);
  if (modifier.lossDieOverride) parts.push(`loss die ${modifier.lossDieOverride}`);
  if (modifier.maxLossDie) parts.push(`maximum loss die ${modifier.maxLossDie}`);
  if (modifier.successThresholdOverride) parts.push(`successes to grow ${modifier.successThresholdOverride}`);
  if (modifier.profitRollBonus) parts.push(`profit bonus ${modifier.profitRollBonus > 0 ? "+" : ""}${modifier.profitRollBonus}`);
  if (modifier.bastionDurationType === "nextBastionTurn") {
    parts.push("duration: 1 bastion turn");
  }
  return parts.join(", ");
}

function dieIndex(die) {
  return DICE_STEPS.indexOf(parseEffectDie(die) ?? "");
}

function maxDie(first, second) {
  const firstIndex = dieIndex(first);
  const secondIndex = dieIndex(second);
  if (firstIndex === -1) return second;
  if (secondIndex === -1) return first;
  return secondIndex > firstIndex ? second : first;
}

function minDie(first, second) {
  const firstIndex = dieIndex(first);
  const secondIndex = dieIndex(second);
  if (firstIndex === -1) return second;
  if (secondIndex === -1) return first;
  return secondIndex < firstIndex ? second : first;
}

function applyMinimumDie(die, minimumDie) {
  if (!minimumDie) return die;
  return maxDie(die, minimumDie);
}

function applyMaximumDie(die, maximumDie) {
  if (!maximumDie) return die;
  return minDie(die, maximumDie);
}

function getEffectModifierData(effect) {
  const rawFlagData = effect.getFlag(MODULE_ID, "ventureModifier");
  const fromFlags = (rawFlagData && (typeof rawFlagData === "object")) ? rawFlagData : {};
  const sourceHasFlag = Object.keys(fromFlags).length > 0;
  const fromChanges = {};
  for (const change of effect.changes ?? []) {
    const key = String(change?.key ?? "");
    if (!key.startsWith(VENTURE_MODIFIER_CHANGE_PREFIX)) continue;
    const subKey = key.slice(VENTURE_MODIFIER_CHANGE_PREFIX.length);
    foundry.utils.setProperty(fromChanges, subKey, change?.value);
  }

  // Flags are the runtime source of truth; changes are a display/compatibility mirror.
  const raw = foundry.utils.mergeObject(fromChanges, fromFlags, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  const facilityId = String(raw.facilityId ?? raw.facilityUuid ?? "").trim();
  const bastionDurationType = String(raw.bastionDurationType ?? "").trim();
  const remainingTurnsRaw = raw.remainingTurns;
  let remainingTurns = ((remainingTurnsRaw === undefined) || (remainingTurnsRaw === null) || (remainingTurnsRaw === ""))
    ? null
    : Math.max(parseEffectNumber(remainingTurnsRaw, 0), 0);
  if ((bastionDurationType === "nextBastionTurn") && (remainingTurns === null)) {
    remainingTurns = 1;
  }
  const successThresholdRaw = parseEffectNumber(raw.successThresholdOverride, 0);
  const successThresholdOverride = successThresholdRaw > 0 ? successThresholdRaw : null;

  return {
    effectId: effect.id,
    enabled: parseEffectBoolean(raw.enabled, true),
    applyToAllVentures: parseEffectBoolean(raw.applyToAllVentures, false),
    facilityId,
    profitDieStep: parseEffectNumber(raw.profitDieStep, 0),
    profitDieOverride: parseEffectDie(raw.profitDieOverride),
    minProfitDie: parseEffectDie(raw.minProfitDie),
    lossDieStep: parseEffectNumber(raw.lossDieStep, 0),
    lossDieOverride: parseEffectDie(raw.lossDieOverride),
    maxLossDie: parseEffectDie(raw.maxLossDie),
    successThresholdOverride,
    profitRollBonus: parseEffectNumber(raw.profitRollBonus, 0),
    bastionDurationType,
    remainingTurns,
    consumePerTurn: parseEffectBoolean(raw.consumePerTurn, true),
    sourceHasFlag
  };
}

function effectHasVentureModifierDefinition(effect) {
  const rawFlagData = effect.getFlag(MODULE_ID, "ventureModifier");
  const hasFlagData = rawFlagData && (typeof rawFlagData === "object") && (Object.keys(rawFlagData).length > 0);
  if (hasFlagData) return true;
  return (effect.changes ?? []).some(change => {
    const key = String(change?.key ?? "");
    return key.startsWith(VENTURE_MODIFIER_CHANGE_PREFIX);
  });
}

function getBastionDurationData(effect) {
  if (!effect) return null;
  const rawFlagData = effect.getFlag(MODULE_ID, "bastionDuration");
  const fromFlags = (rawFlagData && (typeof rawFlagData === "object")) ? rawFlagData : {};
  const fromChanges = {};
  for (const change of effect.changes ?? []) {
    const key = String(change?.key ?? "");
    if (!key.startsWith(BASTION_DURATION_CHANGE_PREFIX)) continue;
    const subKey = key.slice(BASTION_DURATION_CHANGE_PREFIX.length);
    foundry.utils.setProperty(fromChanges, subKey, change?.value);
  }

  const raw = foundry.utils.mergeObject(fromChanges, fromFlags, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  const expireNextTurn = parseEffectBoolean(raw.expireNextTurn, false);
  const durationFormula = String(raw.durationFormula ?? "").trim();
  const remainingTurnsRaw = raw.remainingTurns;
  let remainingTurns = ((remainingTurnsRaw === undefined) || (remainingTurnsRaw === null) || (String(remainingTurnsRaw).trim() === ""))
    ? null
    : Math.max(parseEffectNumber(remainingTurnsRaw, 0), 0);
  if (expireNextTurn && (remainingTurns === null)) remainingTurns = 1;
  const consumePerTurn = parseEffectBoolean(raw.consumePerTurn, true);

  if (!expireNextTurn && (remainingTurns === null) && !durationFormula) return null;
  return { expireNextTurn, remainingTurns, durationFormula, consumePerTurn };
}

function modifierAppliesToFacility(modifier, facility) {
  if (modifier.applyToAllVentures) return true;
  const target = modifier.facilityId;
  if (!target || (target === "*") || (target.toLowerCase() === "all")) return true;
  return [facility.id, facility.uuid, facility.name].includes(target);
}

function getModifierEffectSources(actor, facility) {
  const sources = [];
  if (actor?.effects) {
    sources.push({
      owner: actor,
      ownerType: "actor",
      effects: actor.effects
    });
  }
  if (facility?.effects) {
    sources.push({
      owner: facility,
      ownerType: "facility",
      effects: facility.effects
    });
  }
  return sources;
}

function isFacilityModifierActiveInstance(effect, ownerType) {
  if (ownerType !== "facility") return true;
  return effect.getFlag(MODULE_ID, "ventureModifierTemplate") === false;
}

function collectActiveVentureModifiers(actor, facility) {
  const aggregate = {
    profitDieStep: 0,
    profitDieOverride: null,
    minProfitDie: null,
    lossDieStep: 0,
    lossDieOverride: null,
    maxLossDie: null,
    successThresholdOverride: null,
    profitRollBonus: 0
  };
  const trackedEffects = [];
  const growConsumableEffects = [];
  const debugEffects = [];

  const sources = getModifierEffectSources(actor, facility);
  for (const source of sources) {
    for (const effect of source.effects ?? []) {
      if (!effect) continue;
      if (!isFacilityModifierActiveInstance(effect, source.ownerType)) {
        debugEffects.push({
          id: effect.id,
          name: effect.name,
          ownerType: source.ownerType,
          ownerName: source.owner?.name ?? source.owner?.id ?? "",
          ownerUuid: source.owner?.uuid ?? null,
          skipped: true,
          reason: "template"
        });
        continue;
      }
      const hasDefinition = effectHasVentureModifierDefinition(effect);
      if (!hasDefinition) continue;
      if (effect.disabled || effect.isSuppressed) {
        debugEffects.push({
          id: effect.id,
          name: effect.name,
          ownerType: source.ownerType,
          ownerName: source.owner?.name ?? source.owner?.id ?? "",
          ownerUuid: source.owner?.uuid ?? null,
          disabled: Boolean(effect.disabled),
          suppressed: Boolean(effect.isSuppressed),
          skipped: true,
          reason: effect.disabled ? "disabled" : "suppressed"
        });
        continue;
      }
      const modifier = getEffectModifierData(effect);
      const appliesToFacility = modifierAppliesToFacility(modifier, facility);
      const hasDuration = modifier.remainingTurns !== null;
      const activeDuration = !hasDuration || (modifier.remainingTurns > 0);
      if (!modifier.enabled || !appliesToFacility || !activeDuration) {
        debugEffects.push({
          id: effect.id,
          name: effect.name,
          ownerType: source.ownerType,
          ownerName: source.owner?.name ?? source.owner?.id ?? "",
          ownerUuid: source.owner?.uuid ?? null,
          enabled: modifier.enabled,
          appliesToFacility,
          bastionDurationType: modifier.bastionDurationType,
          remainingTurns: modifier.remainingTurns,
          skipped: true
        });
        continue;
      }

      aggregate.profitDieStep += modifier.profitDieStep;
      aggregate.lossDieStep += modifier.lossDieStep;
      aggregate.profitRollBonus += modifier.profitRollBonus;
      if (modifier.profitDieOverride) aggregate.profitDieOverride = modifier.profitDieOverride;
      if (modifier.lossDieOverride) aggregate.lossDieOverride = modifier.lossDieOverride;
      if (modifier.maxLossDie) {
        aggregate.maxLossDie = aggregate.maxLossDie
          ? minDie(aggregate.maxLossDie, modifier.maxLossDie)
          : modifier.maxLossDie;
      }
      if (modifier.successThresholdOverride) {
        aggregate.successThresholdOverride = aggregate.successThresholdOverride
          ? Math.max(aggregate.successThresholdOverride, modifier.successThresholdOverride)
          : modifier.successThresholdOverride;
      }
      if (modifier.minProfitDie) {
        aggregate.minProfitDie = aggregate.minProfitDie
          ? maxDie(aggregate.minProfitDie, modifier.minProfitDie)
          : modifier.minProfitDie;
      }

      if (modifier.consumePerTurn && (modifier.remainingTurns !== null)) {
        trackedEffects.push({
          effectId: modifier.effectId,
          remainingTurns: modifier.remainingTurns,
          durationPath: `${VENTURE_MODIFIER_FLAG}.remainingTurns`,
          ownerType: source.ownerType,
          ownerName: source.owner?.name ?? source.owner?.id ?? "",
          ownerUuid: source.owner?.uuid ?? "",
          effectName: effect.name
        });
      }

      if (modifier.successThresholdOverride) {
        growConsumableEffects.push({
          effectId: modifier.effectId,
          ownerType: source.ownerType,
          ownerName: source.owner?.name ?? source.owner?.id ?? "",
          ownerUuid: source.owner?.uuid ?? "",
          effectName: effect.name
        });
      }

      debugEffects.push({
        id: effect.id,
        name: effect.name,
        ownerType: source.ownerType,
        ownerName: source.owner?.name ?? source.owner?.id ?? "",
        ownerUuid: source.owner?.uuid ?? null,
        enabled: modifier.enabled,
        appliesToFacility,
        remainingTurns: modifier.remainingTurns,
        consumePerTurn: modifier.consumePerTurn,
        applyToAllVentures: modifier.applyToAllVentures,
        facilityId: modifier.facilityId,
        bastionDurationType: modifier.bastionDurationType,
        profitDieStep: modifier.profitDieStep,
        profitDieOverride: modifier.profitDieOverride,
        minProfitDie: modifier.minProfitDie,
        lossDieStep: modifier.lossDieStep,
        lossDieOverride: modifier.lossDieOverride,
        maxLossDie: modifier.maxLossDie,
        successThresholdOverride: modifier.successThresholdOverride,
        profitRollBonus: modifier.profitRollBonus,
        skipped: false
      });
    }
  }

  moduleLog("Venture modifiers: effect scan summary", {
    actor: actor.name,
    facility: facility.name,
    actorEffects: actor.effects?.size ?? 0,
    facilityEffects: facility.effects?.size ?? 0,
    modifierEffectsFound: debugEffects.length,
    modifierEffectsApplied: debugEffects.filter(effect => !effect.skipped).length
  });

  return { aggregate, trackedEffects, growConsumableEffects, debugEffects };
}

function collectActiveBastionDurationEffects(actor) {
  const trackedEffects = [];
  for (const effect of actor?.effects ?? []) {
    if (!effect || effect.disabled || effect.isSuppressed) continue;
    if (effectHasVentureModifierDefinition(effect)) continue;
    const duration = getBastionDurationData(effect);
    if (!duration?.consumePerTurn) continue;
    if (duration.remainingTurns === null) continue;
    trackedEffects.push({
      effectId: effect.id,
      remainingTurns: duration.remainingTurns,
      durationPath: `${BASTION_DURATION_FLAG}.remainingTurns`,
      ownerType: "actor",
      ownerName: actor.name ?? actor.id ?? "",
      ownerUuid: actor.uuid ?? "",
      effectName: effect.name
    });
  }
  return trackedEffects;
}

function queueModifierDurationUsage(usageMap, trackedEffects) {
  for (const tracked of trackedEffects) {
    if (!tracked?.effectId || !tracked?.ownerUuid) continue;
    const key = `${tracked.ownerUuid}::${tracked.effectId}`;
    if (usageMap.has(key)) continue;
    usageMap.set(key, tracked);
  }
}

function markModifiersForDeletion(usageMap, trackedEffects, reason = "") {
  for (const tracked of trackedEffects) {
    if (!tracked?.effectId || !tracked?.ownerUuid) continue;
    const key = `${tracked.ownerUuid}::${tracked.effectId}`;
    const existing = usageMap.get(key) ?? tracked;
    usageMap.set(key, {
      ...existing,
      ...tracked,
      forceDelete: true,
      deleteReason: reason || existing.deleteReason || "unspecified"
    });
  }
}

async function decrementModifierDurations(usageMap) {
  if (!usageMap?.size) return;

  const byOwner = new Map();
  for (const tracked of usageMap.values()) {
    if (tracked.forceDelete) {
      const ownerKey = tracked.ownerUuid;
      const ownerEntry = byOwner.get(ownerKey) ?? { updates: [], deletes: [], debug: [] };
      ownerEntry.debug.push({
        id: tracked.effectId,
        ownerType: tracked.ownerType,
        ownerName: tracked.ownerName,
        action: "force-delete",
        reason: tracked.deleteReason ?? "unspecified"
      });
      ownerEntry.deletes.push(tracked.effectId);
      byOwner.set(ownerKey, ownerEntry);
      continue;
    }

    const currentRemaining = Math.max(parseEffectNumber(tracked.remainingTurns, 0), 0);
    if (currentRemaining <= 0) continue;
    const nextRemaining = Math.max(currentRemaining - 1, 0);
    const ownerKey = tracked.ownerUuid;
    const ownerEntry = byOwner.get(ownerKey) ?? { updates: [], deletes: [], debug: [] };
    ownerEntry.debug.push({
      id: tracked.effectId,
      ownerType: tracked.ownerType,
      ownerName: tracked.ownerName,
      remainingTurnsBefore: currentRemaining,
      remainingTurnsAfter: nextRemaining,
      action: nextRemaining <= 0 ? "delete" : "update"
    });
    if (nextRemaining <= 0) {
      ownerEntry.deletes.push(tracked.effectId);
    } else {
      ownerEntry.updates.push({
        _id: tracked.effectId,
        [tracked.durationPath || `${VENTURE_MODIFIER_FLAG}.remainingTurns`]: nextRemaining
      });
    }
    byOwner.set(ownerKey, ownerEntry);
  }

  if (!byOwner.size) return;

  for (const [ownerUuid, entry] of byOwner.entries()) {
    const owner = await fromUuid(ownerUuid);
    if (!owner?.updateEmbeddedDocuments) {
      moduleLog("Venture modifiers: unable to decrement durations for owner", { ownerUuid, entry });
      continue;
    }
    moduleLog("Venture modifiers: decrement durations", {
      owner: owner.name ?? ownerUuid,
      ownerUuid,
      effects: entry.debug
    });
    if (entry.updates.length) {
      await owner.updateEmbeddedDocuments("ActiveEffect", entry.updates);
    }
    if (entry.deletes.length && owner.deleteEmbeddedDocuments) {
      await owner.deleteEmbeddedDocuments("ActiveEffect", entry.deletes);
    }
  }
}

function isFacilityEligibleForVenture(facility, config, state) {
  if (!config.enabled || state.failed) return false;
  if (facility.system?.type?.value !== "special") return false;
  if (facility.system?.disabled) return false;
  return true;
}

function getSpeaker(actor) {
  if (ChatMessage.getSpeaker) return ChatMessage.getSpeaker({ actor });
  return ChatMessage.implementation.getSpeaker({ actor });
}

function resolveRewardDisplayData(boon) {
  const rewardUuid = String(boon?.rewardUuid ?? "").trim();
  let rewardName = String(boon?.rewardLabel ?? boon?.rewardUuid ?? "").trim();
  let rewardImg = "";
  if (rewardUuid) {
    const doc = resolveRewardDocumentSync(rewardUuid);
    if (doc?.name) rewardName = doc.name;
    if (doc?.img) rewardImg = doc.img;
  }
  if (!rewardName) rewardName = rewardUuid;
  return { rewardName, rewardImg };
}

function getBoonPurchaseWhenLabel(mode) {
  const parsed = parseBoonPurchaseWhen(mode, "default");
  if (parsed === "loss") return game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Loss");
  if (parsed === "profit") return game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Profit");
  return game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Default");
}

function emitSocket(payload) {
  game.socket?.emit(SOCKET_NAMESPACE, payload);
}

function getBoonPurchasesThisTurn(state, boonIndex, boonKey = "") {
  const key = String(boonKey ?? "").trim();
  if (key) {
    const fromKey = Number(state?.boonPurchases?.[key] ?? 0);
    return Math.max(Number.isFinite(fromKey) ? fromKey : 0, 0);
  }
  return Math.max(Number(state?.boonPurchases?.[String(boonIndex)] ?? 0) || 0, 0);
}

function getPreferredCoverageUser(actor) {
  const activeOwners = game.users
    .filter(user => user.active && actor.testUserPermission(user, "OWNER"));
  return activeOwners.find(user => !user.isGM) ?? activeOwners[0] ?? null;
}

async function promptCoverageChoice({
  actorName,
  ventureName,
  deficit,
  treasuryCover,
  characterCover,
  availableGp,
  availableInventoryGp,
  canCoverWithGp,
  canCoverWithInventory,
  deciderName
}) {
  const title = game.i18n.localize("INDYVENTURES.Prompt.Title");
  const content = game.i18n.format("INDYVENTURES.Prompt.Content", {
    actor: actorName,
    venture: ventureName,
    deficit,
    treasuryCover,
    characterCover,
    availableGp,
    availableInventoryGp,
    decider: deciderName
  });
  const coverFromGpLabel = game.i18n.localize("INDYVENTURES.Prompt.CoverFromGp");
  const coverFromInventoryLabel = game.i18n.localize("INDYVENTURES.Prompt.CoverFromInventory");
  const declineLabel = game.i18n.localize("INDYVENTURES.Prompt.Decline");

  return new Promise(resolve => {
    const buttons = {};
    if (canCoverWithGp) {
      buttons.coverGp = {
        label: coverFromGpLabel,
        callback: () => resolve("gp")
      };
    }
    if (canCoverWithInventory) {
      buttons.coverInventory = {
        label: coverFromInventoryLabel,
        callback: () => resolve("inventory")
      };
    }
    buttons.decline = {
      label: declineLabel,
      callback: () => resolve("decline")
    };

    const defaultButton = canCoverWithGp
      ? "coverGp"
      : (canCoverWithInventory ? "coverInventory" : "decline");
    new Dialog({
      title,
      content,
      buttons,
      default: defaultButton,
      close: () => resolve("decline")
    }).render(true);
  });
}

async function requestCoverageDecisionFromOwner({
  targetUser,
  actor,
  facility,
  deficit,
  treasuryCover,
  characterCover,
  availableGp,
  availableInventoryGp,
  canCoverWithGp,
  canCoverWithInventory
}) {
  const requestId = foundry.utils.randomID();
  const response = await new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingCoverageRequests.delete(requestId);
      resolve({ choice: "decline", timedOut: true, userId: targetUser.id });
    }, COVERAGE_TIMEOUT_MS);

    pendingCoverageRequests.set(requestId, { resolve, timeout });
    emitSocket({
      type: "coveragePrompt",
      requestId,
      gmUserId: game.user.id,
      targetUserId: targetUser.id,
      actorUuid: actor.uuid,
      facilityUuid: facility.uuid,
      actorName: actor.name,
      ventureName: facility.name,
      deficit,
      treasuryCover,
      characterCover,
      availableGp,
      availableInventoryGp,
      canCoverWithGp,
      canCoverWithInventory
    });
  });

  return response;
}

async function maybeCoverCharacterDeficit({
  actor,
  facility,
  deficit,
  treasuryCover,
  characterCover,
  wallet,
  autoCoverLoss
}) {
  const result = {
    coveredCharacter: false,
    autoCovered: false,
    manualCovered: false,
    coveredByInventory: false,
    promptDeclined: false,
    promptTimedOut: false,
    promptUserName: null,
    insufficientFunds: false,
    characterCovered: 0
  };

  if (characterCover <= 0) {
    result.coveredCharacter = true;
    return result;
  }

  const canCoverWithGp = getWalletCurrency(wallet, "gp") >= characterCover;
  const canCoverWithInventory = canCoverFromInventory(wallet, characterCover);
  result.insufficientFunds = !canCoverWithGp && !canCoverWithInventory;
  if (result.insufficientFunds) return result;

  if (autoCoverLoss) {
    result.insufficientFunds = !canCoverWithGp;
    if (!spendFromGp(wallet, characterCover)) return result;
    result.coveredCharacter = true;
    result.autoCovered = true;
    result.characterCovered = characterCover;
    return result;
  }

  const preferredUser = getPreferredCoverageUser(actor);
  if (!preferredUser || (preferredUser.id === game.user.id)) {
    const choice = await promptCoverageChoice({
      actorName: actor.name,
      ventureName: facility.name,
      deficit,
      treasuryCover,
      characterCover,
      availableGp: formatGpAmount(getWalletCurrency(wallet, "gp")),
      availableInventoryGp: formatGpAmount(getWalletTotalGp(wallet)),
      canCoverWithGp,
      canCoverWithInventory,
      deciderName: game.user.name
    });

    result.promptUserName = game.user.name;
    if (choice === "gp") {
      if (!spendFromGp(wallet, characterCover)) return result;
      result.coveredCharacter = true;
      result.manualCovered = true;
      result.characterCovered = characterCover;
    } else if (choice === "inventory") {
      if (!spendFromInventory(wallet, characterCover)) return result;
      result.coveredCharacter = true;
      result.manualCovered = true;
      result.coveredByInventory = true;
      result.characterCovered = characterCover;
    } else {
      result.promptDeclined = true;
    }
    return result;
  }

  const decision = await requestCoverageDecisionFromOwner({
    targetUser: preferredUser,
    actor,
    facility,
    deficit,
    treasuryCover,
    characterCover,
    availableGp: formatGpAmount(getWalletCurrency(wallet, "gp")),
    availableInventoryGp: formatGpAmount(getWalletTotalGp(wallet)),
    canCoverWithGp,
    canCoverWithInventory
  });

  result.promptUserName = preferredUser.name;
  result.promptTimedOut = Boolean(decision?.timedOut);
  if (decision?.choice === "gp") {
    if (!spendFromGp(wallet, characterCover)) return result;
    result.coveredCharacter = true;
    result.manualCovered = true;
    result.characterCovered = characterCover;
  } else if (decision?.choice === "inventory") {
    if (!spendFromInventory(wallet, characterCover)) return result;
    result.coveredCharacter = true;
    result.manualCovered = true;
    result.coveredByInventory = true;
    result.characterCovered = characterCover;
  } else {
    result.promptDeclined = !result.promptTimedOut;
  }
  return result;
}

async function rollDie(formula, actor, facilityName, rollLabel) {
  return requestUserRoll({ formula, actor, facilityName, rollLabel });
}

async function processSingleVenture(facility, actor, wallet, turnId, modifierDurationUsage) {
  const config = getFacilityConfig(facility);
  const state = getFacilityState(facility, config);
  if (!isFacilityEligibleForVenture(facility, config, state)) return null;

  if (turnId && (state.turnId !== turnId)) {
    state.turnId = turnId;
    state.boonPurchases = {};
  }

  const effectModifiers = collectActiveVentureModifiers(actor, facility);
  queueModifierDurationUsage(modifierDurationUsage, effectModifiers.trackedEffects);
  moduleLog("Venture modifiers: collected", {
    actor: actor.name,
    facility: facility.name,
    aggregate: effectModifiers.aggregate,
    effects: effectModifiers.debugEffects
  });

  const stateBefore = {
    currentProfitDie: state.currentProfitDie,
    streak: state.streak,
    treasury: state.treasury,
    failed: state.failed
  };
  let rolledProfitDie = shiftDie(state.currentProfitDie, effectModifiers.aggregate.profitDieStep);
  if (effectModifiers.aggregate.profitDieOverride) {
    rolledProfitDie = effectModifiers.aggregate.profitDieOverride;
  }
  rolledProfitDie = applyMinimumDie(rolledProfitDie, effectModifiers.aggregate.minProfitDie);

  let lossDie = shiftDie(config.lossDie, config.lossModifier + effectModifiers.aggregate.lossDieStep);
  if (effectModifiers.aggregate.lossDieOverride) {
    lossDie = effectModifiers.aggregate.lossDieOverride;
  }
  lossDie = applyMaximumDie(lossDie, effectModifiers.aggregate.maxLossDie);

  const effectiveSuccessThreshold = Math.max(
    Number(effectModifiers.aggregate.successThresholdOverride ?? config.successThreshold) || config.successThreshold,
    1
  );

  const profitRoll = await rollDie(
    rolledProfitDie,
    actor,
    config.ventureName || facility.name,
    game.i18n.localize("INDYVENTURES.RollPrompt.Profit")
  );
  const lossRoll = await rollDie(
    lossDie,
    actor,
    config.ventureName || facility.name,
    game.i18n.localize("INDYVENTURES.RollPrompt.Loss")
  );

  const rawProfitRollTotal = Number(profitRoll.total);
  const profitRollBonus = effectModifiers.aggregate.profitRollBonus;
  const profitRollTotal = Math.max(rawProfitRollTotal + profitRollBonus, 0);
  const gpPerPoint = Math.max(Number(config.gpPerPoint ?? 100) || 0, 0);
  const income = profitRollTotal * gpPerPoint;
  const outgoings = Number(lossRoll.total) * gpPerPoint;
  const net = income - outgoings;
  state.lastTurnNet = net;

  let coveredDeficit = false;
  let autoCovered = false;
  let manualCovered = false;
  let coveredByInventory = false;
  let promptDeclined = false;
  let promptTimedOut = false;
  let promptUserName = null;
  let insufficientFunds = false;
  let treasuryCovered = 0;
  let characterCovered = 0;
  let uncoveredDeficit = 0;
  let hasCoverageSources = false;
  let grew = false;
  let degraded = false;
  let failed = false;
  let deficit = 0;

  if (net >= 0) {
    state.treasury += net;
    state.streak += 1;
    if (state.streak >= effectiveSuccessThreshold) {
      state.currentProfitDie = shiftDie(state.currentProfitDie, 1);
      state.streak = 0;
      grew = true;
      markModifiersForDeletion(modifierDurationUsage, effectModifiers.growConsumableEffects, "grown");
    }
  } else {
    deficit = Math.abs(net);
    state.streak = 0;

    // Optionally apply venture treasury first; character funds handle any remainder.
    if (config.autoUseTreasuryLoss) {
      treasuryCovered = Math.min(state.treasury, deficit);
      state.treasury -= treasuryCovered;
    } else {
      treasuryCovered = 0;
    }
    const characterDeficit = Math.max(deficit - treasuryCovered, 0);

    const coverage = await maybeCoverCharacterDeficit({
      actor,
      facility,
      deficit,
      treasuryCover: treasuryCovered,
      characterCover: characterDeficit,
      wallet,
      autoCoverLoss: config.autoCoverLoss
    });
    characterCovered = coverage.characterCovered;
    coveredDeficit = (treasuryCovered + characterCovered) >= deficit;
    autoCovered = coverage.autoCovered;
    manualCovered = coverage.manualCovered;
    coveredByInventory = coverage.coveredByInventory;
    promptDeclined = coverage.promptDeclined;
    promptTimedOut = coverage.promptTimedOut;
    promptUserName = coverage.promptUserName;
    insufficientFunds = coverage.insufficientFunds;
    uncoveredDeficit = Math.max(deficit - treasuryCovered - characterCovered, 0);
    hasCoverageSources = (treasuryCovered > 0) || (characterCovered > 0);

    if (!coveredDeficit && (state.currentProfitDie === "d4")) {
      state.failed = true;
      config.enabled = false;
      failed = true;
    } else if (!coveredDeficit) {
      const previousDie = state.currentProfitDie;
      const downgraded = shiftDie(state.currentProfitDie, -1);
      state.currentProfitDie = applyMinimumDie(downgraded, effectModifiers.aggregate.minProfitDie);
      degraded = dieIndex(state.currentProfitDie) < dieIndex(previousDie);
    }
  }

  const boons = parseBoonsFromConfig(config).map((boon, index) => {
    const reward = resolveRewardDisplayData(boon);
    const boonKey = buildBoonKey(boon);
    const group = String(boon.group ?? "").trim();
    const groupKey = buildBoonGroupKey(boon);
    const groupPerTurnLimit = parseBoonPerTurnLimit(boon.groupPerTurnLimit, null);
    const purchasedThisTurn = getBoonPurchasesThisTurn(state, index, boonKey);
    const purchasedInGroupThisTurn = groupKey ? getBoonPurchasesThisTurn(state, index, groupKey) : 0;
    const perTurnLimit = parseBoonPerTurnLimit(boon.perTurnLimit, 1);
    const purchaseWhen = parseBoonPurchaseWhen(boon.purchaseWhen, "default");
    const purchaseWhenAllowed = boonPurchaseWhenAllows(purchaseWhen, net);
    const underTurnLimit = (perTurnLimit === null) || (purchasedThisTurn < perTurnLimit);
    const underGroupLimit = !groupKey || (groupPerTurnLimit === null) || (purchasedInGroupThisTurn < groupPerTurnLimit);
    return {
      ...boon,
      index,
      key: boonKey,
      group,
      groupKey,
      groupPerTurnLimit,
      purchasedInGroupThisTurn,
      remainingGroupPurchases: groupPerTurnLimit === null ? null : Math.max(groupPerTurnLimit - purchasedInGroupThisTurn, 0),
      perTurnLimit,
      purchaseWhen,
      purchaseWhenLabel: getBoonPurchaseWhenLabel(purchaseWhen),
      purchaseWhenAllowed,
      blockedByGroupLimit: !underGroupLimit,
      blockedByWindow: !purchaseWhenAllowed,
      purchasedThisTurn,
      remainingPurchases: perTurnLimit === null ? null : Math.max(perTurnLimit - purchasedThisTurn, 0),
      affordable: state.treasury >= boon.cost,
      purchasable: (state.treasury >= boon.cost) && underTurnLimit && underGroupLimit && purchaseWhenAllowed,
      rewardName: reward.rewardName,
      rewardImg: reward.rewardImg
    };
  });

  const modifierEffects = effectModifiers.debugEffects
    .filter(effect => !effect.skipped)
    .map(effect => {
      const hasDuration = (effect.remainingTurns !== null) && (effect.remainingTurns !== undefined);
      const remainingBefore = hasDuration ? Math.max(parseEffectNumber(effect.remainingTurns, 0), 0) : null;
      const remainingAfter = (hasDuration && effect.consumePerTurn)
        ? Math.max(remainingBefore - 1, 0)
        : remainingBefore;
      return {
        name: effect.name,
        summary: summarizeModifierEffect(effect),
        hasDuration,
        remainingBefore,
        remainingAfter,
        consumePerTurn: Boolean(effect.consumePerTurn)
      };
    });
  const consumedOnGrowEffects = grew
    ? effectModifiers.growConsumableEffects.map(effect => effect.effectName).filter(Boolean)
    : [];

  moduleLog("Venture turn resolved", {
    actor: actor.name,
    facility: facility.name,
    config: {
      ventureName: config.ventureName,
      baseProfitDie: config.profitDie,
      baseLossDie: config.lossDie,
      lossModifier: config.lossModifier,
      gpPerPoint: config.gpPerPoint,
      successThreshold: config.successThreshold,
      effectiveSuccessThreshold,
      autoCoverLoss: config.autoCoverLoss,
      autoUseTreasuryLoss: config.autoUseTreasuryLoss
    },
    stateBefore,
    rolls: {
      profitDieRolled: rolledProfitDie,
      lossDieRolled: lossDie,
      rawProfitRollTotal,
      profitRollBonus,
      profitRollTotal,
      lossRollTotal: Number(lossRoll.total),
      income,
      outgoings,
      net
    },
    coverage: {
      deficit,
      treasuryCovered,
      characterCovered,
      uncoveredDeficit,
      coveredDeficit,
      autoCovered,
      manualCovered,
      coveredByInventory,
      promptDeclined,
      promptTimedOut,
      promptUserName,
      insufficientFunds
    },
    stateAfter: {
      currentProfitDie: state.currentProfitDie,
      streak: state.streak,
      treasury: state.treasury,
      failed: state.failed
    },
    modifierEffects,
    consumedOnGrowEffects
  });

  await updateFacilityVenture(facility, config, state);

  return {
    facilityId: facility.id,
    facilityUuid: facility.uuid,
    facilityName: facility.name,
    ventureName: config.ventureName || facility.name,
    previousProfitDie: stateBefore.currentProfitDie,
    profitDie: rolledProfitDie,
    nextProfitDie: state.currentProfitDie,
    profitDieChangeClass: grew ? "is-increase" : (degraded ? "is-decrease" : ""),
    lossDie,
    rawProfitRollTotal,
    profitRollBonus,
    profitRollTotal,
    lossRollTotal: Number(lossRoll.total),
    gpPerPoint,
    income,
    outgoings,
    net,
    netClass: net > 0 ? "is-positive" : (net < 0 ? "is-negative" : "is-neutral"),
    deficit,
    coveredDeficit,
    autoCovered,
    manualCovered,
    coveredByInventory,
    treasuryCovered,
    characterCovered,
    uncoveredDeficit,
    hasCoverageSources,
    promptDeclined,
    promptTimedOut,
    promptUserName,
    insufficientFunds,
    streak: state.streak,
    treasury: state.treasury,
    grew,
    degraded,
    failed,
    boons,
    modifierEffects
  };
}

async function postVentureSummary(actor, results, sourceMessage) {
  const renderTemplate = getRenderTemplate();
  const content = await renderTemplate(TEMPLATE_PATHS.chatSummary, {
    actor,
    results,
    moduleId: MODULE_ID
  });

  return ChatMessage.implementation.create({
    content,
    speaker: getSpeaker(actor),
    flags: {
      [MODULE_ID]: {
        type: "ventureSummary",
        actorUuid: actor.uuid,
        sourceMessageUuid: sourceMessage.uuid,
        results
      }
    }
  });
}

export async function processActorVenturesFromBastionMessage(message) {
  if (!game.user.isGM) return;
  if (!game.settings.get(MODULE_ID, SETTINGS.integrateBastion)) return;
  const primaryGmId = game.users
    .filter(user => user.active && user.isGM)
    .map(user => user.id)
    .sort()[0];
  if (game.user.id !== primaryGmId) return;

  const bastionData = message.getFlag("dnd5e", "bastion");
  if (!bastionData || !Array.isArray(bastionData.orders)) return;

  const actor = message.getAssociatedActor?.() ?? game.actors.get(message.speaker?.actor);
  if (!actor || actor.type !== "character") return;

  const wallet = {
    ...createCoverageWallet(actor)
  };

  const facilities = actor.itemTypes?.facility ?? [];
  moduleLog("Bastion venture processing start", {
    actor: actor.name,
    actorUuid: actor.uuid,
    turnId: message.uuid,
    facilities: facilities.length
  });
  const results = [];
  const turnId = message.uuid;
  const modifierDurationUsage = new Map();
  const bastionDurationEffects = collectActiveBastionDurationEffects(actor);
  queueModifierDurationUsage(modifierDurationUsage, bastionDurationEffects);
  for (const facility of facilities) {
    const result = await processSingleVenture(facility, actor, wallet, turnId, modifierDurationUsage);
    if (result) results.push(result);
  }

  if (wallet.dirty) {
    await actor.update(buildWalletUpdateData(wallet));
  }

  await decrementModifierDurations(modifierDurationUsage);
  if (!results.length) {
    moduleLog("Bastion venture processing complete", {
      actor: actor.name,
      facilitiesProcessed: 0,
      gpAfter: getWalletCurrency(wallet, "gp"),
      bastionDurationsProcessed: bastionDurationEffects.length
    });
    return;
  }
  moduleLog("Bastion venture processing complete", {
    actor: actor.name,
    facilitiesProcessed: results.length,
    gpAfter: getWalletCurrency(wallet, "gp"),
    bastionDurationsProcessed: bastionDurationEffects.length
  });

  if (game.settings.get(MODULE_ID, SETTINGS.postChatSummary)) {
    await postVentureSummary(actor, results, message);
  }
}

let socketRegistered = false;

async function onCoveragePrompt(payload) {
  if (payload.targetUserId !== game.user.id) return;
  const choice = await promptCoverageChoice({
    actorName: payload.actorName,
    ventureName: payload.ventureName,
    deficit: payload.deficit,
    treasuryCover: payload.treasuryCover ?? 0,
    characterCover: payload.characterCover ?? 0,
    availableGp: payload.availableGp,
    availableInventoryGp: payload.availableInventoryGp ?? payload.availableGp,
    canCoverWithGp: payload.canCoverWithGp !== false,
    canCoverWithInventory: payload.canCoverWithInventory !== false,
    deciderName: game.user.name
  });

  emitSocket({
    type: "coverageResponse",
    gmUserId: payload.gmUserId,
    requestId: payload.requestId,
    userId: game.user.id,
    choice
  });
}

function onCoverageResponse(payload) {
  if (!game.user.isGM) return;
  if (payload.gmUserId !== game.user.id) return;
  const pending = pendingCoverageRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.resolve({
    choice: String(payload.choice ?? "decline"),
    userId: payload.userId,
    timedOut: false
  });
  pendingCoverageRequests.delete(payload.requestId);
}

export function registerCoveragePromptSocket() {
  if (socketRegistered || !game.socket) return;
  socketRegistered = true;
  game.socket.on(SOCKET_NAMESPACE, async payload => {
    if (!payload || (typeof payload !== "object")) return;
    if (payload.type === "coveragePrompt") await onCoveragePrompt(payload);
    else if (payload.type === "coverageResponse") onCoverageResponse(payload);
  });
}
