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
const pendingCoverageRequests = new Map();
const pendingRollRequests = new Map();
const processedBastionMessages = new Set();
const processedActorTurnKeys = new Set();
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

function clampTimeoutSeconds(value, fallbackSeconds = 180) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallbackSeconds;
  return Math.min(Math.max(parsed, 30), 600);
}

function getCoverageTimeoutMs() {
  const seconds = clampTimeoutSeconds(
    game.settings?.get(MODULE_ID, SETTINGS.coveragePromptTimeoutSeconds),
    180
  );
  return seconds * 1000;
}

function getRollTimeoutMs() {
  const seconds = clampTimeoutSeconds(
    game.settings?.get(MODULE_ID, SETTINGS.rollPromptTimeoutSeconds),
    180
  );
  return seconds * 1000;
}

function buildBastionDedupKey(message, bastionData) {
  const stableTurnId = String(
    bastionData?.turnId
    ?? bastionData?.turn?.id
    ?? bastionData?.id
    ?? ""
  ).trim();
  if (stableTurnId) return `turn:${stableTurnId}`;
  return "";
}

async function requestLocalUserRoll({ formula, actor, facilityName, rollLabel }) {
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

async function requestRollFromOwner({
  targetUser,
  actor,
  facilityName,
  formula,
  rollLabel
}) {
  const requestId = foundry.utils.randomID();
  const timeoutMs = getRollTimeoutMs();
  const response = await new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingRollRequests.delete(requestId);
      resolve({ timedOut: true });
    }, timeoutMs);

    pendingRollRequests.set(requestId, { resolve, timeout });
    emitSocket({
      type: "rollPrompt",
      requestId,
      gmUserId: game.user.id,
      targetUserId: targetUser.id,
      actorUuid: actor?.uuid ?? "",
      facilityName,
      formula,
      rollLabel
    });
  });

  return response;
}

async function requestUserRoll({ formula, actor, facilityName, rollLabel }) {
  const targetUser = getPreferredCoverageUser(actor);
  const canDelegate = Boolean(
    game.user?.isGM
    && targetUser
    && targetUser.active
    && (targetUser.id !== game.user.id)
  );

  if (!canDelegate) {
    return requestLocalUserRoll({ formula, actor, facilityName, rollLabel });
  }

  const delegated = await requestRollFromOwner({
    targetUser,
    actor,
    facilityName,
    formula,
    rollLabel
  });

  const total = Number(delegated?.total);
  if (Number.isFinite(total)) {
    moduleLog("Delegated venture roll result received", {
      actor: actor?.name ?? null,
      facility: facilityName,
      rollLabel,
      formula,
      total,
      roller: delegated?.userId ?? targetUser.id
    });
    return { total };
  }

  moduleLog("Delegated venture roll unavailable; falling back to GM roll", {
    actor: actor?.name ?? null,
    facility: facilityName,
    rollLabel,
    formula,
    targetUser: targetUser.name,
    timedOut: Boolean(delegated?.timedOut)
  });
  return requestLocalUserRoll({ formula, actor, facilityName, rollLabel });
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

function formatSignedNumber(value) {
  const amount = Number(value) || 0;
  return `${amount > 0 ? "+" : ""}${amount}`;
}

function buildModifierImpactLines(modifier, context) {
  const lines = [];
  if (modifier.profitDieStep) {
    lines.push(game.i18n.format("INDYVENTURES.Chat.ModifierImpactProfitStep", {
      step: formatSignedNumber(modifier.profitDieStep),
      from: context.baseProfitDie,
      to: context.steppedProfitDie
    }));
  }
  if (modifier.profitDieOverride) {
    lines.push(game.i18n.format("INDYVENTURES.Chat.ModifierImpactProfitOverride", {
      override: modifier.profitDieOverride,
      final: context.rolledProfitDie
    }));
  }
  if (modifier.minProfitDie) {
    lines.push(game.i18n.format("INDYVENTURES.Chat.ModifierImpactMinProfit", {
      minimum: modifier.minProfitDie,
      final: context.rolledProfitDie
    }));
  }
  if (modifier.lossDieStep) {
    lines.push(game.i18n.format("INDYVENTURES.Chat.ModifierImpactLossStep", {
      step: formatSignedNumber(modifier.lossDieStep),
      from: context.baseLossDie,
      to: context.steppedLossDie
    }));
  }
  if (modifier.lossDieOverride) {
    lines.push(game.i18n.format("INDYVENTURES.Chat.ModifierImpactLossOverride", {
      override: modifier.lossDieOverride,
      final: context.lossDie
    }));
  }
  if (modifier.maxLossDie) {
    lines.push(game.i18n.format("INDYVENTURES.Chat.ModifierImpactMaxLoss", {
      maximum: modifier.maxLossDie,
      final: context.lossDie
    }));
  }
  if (modifier.successThresholdOverride) {
    lines.push(game.i18n.format("INDYVENTURES.Chat.ModifierImpactSuccessThreshold", {
      base: context.baseSuccessThreshold,
      effective: context.effectiveSuccessThreshold
    }));
  }
  if (modifier.profitRollBonus) {
    lines.push(game.i18n.format("INDYVENTURES.Chat.ModifierImpactProfitBonus", {
      bonus: formatSignedNumber(modifier.profitRollBonus),
      raw: context.rawProfitRollTotal,
      aggregateBonus: formatSignedNumber(context.aggregateProfitRollBonus),
      total: context.profitRollTotal
    }));
  }
  return lines;
}

function buildModifierEffectsTooltip(modifierEffects = [], modifierOutcome = null) {
  const outcomeLines = [];
  const effectBlocks = [];

  if (modifierOutcome?.showProfitDie) {
    outcomeLines.push(game.i18n.format("INDYVENTURES.Chat.ModifierOutcomeProfitDie", {
      base: modifierOutcome.profitDieBase,
      final: modifierOutcome.profitDieFinal
    }));
  }
  if (modifierOutcome?.showLossDie) {
    outcomeLines.push(game.i18n.format("INDYVENTURES.Chat.ModifierOutcomeLossDie", {
      base: modifierOutcome.lossDieBase,
      final: modifierOutcome.lossDieFinal
    }));
  }
  if (modifierOutcome?.showSuccessThreshold) {
    outcomeLines.push(game.i18n.format("INDYVENTURES.Chat.ModifierOutcomeSuccessThreshold", {
      base: modifierOutcome.successThresholdBase,
      final: modifierOutcome.successThresholdFinal
    }));
  }
  if (modifierOutcome?.showProfitBonus) {
    outcomeLines.push(game.i18n.format("INDYVENTURES.Chat.ModifierOutcomeProfitRoll", {
      raw: modifierOutcome.rawProfitRollTotal,
      bonus: modifierOutcome.profitRollBonus,
      total: modifierOutcome.profitRollTotal
    }));
  }

  for (const effect of modifierEffects) {
    if (!effect) continue;
    const name = String(effect.name ?? "").trim() || "-";
    const summary = String(effect.summary ?? "").trim();
    const lines = [name];
    if (summary) lines.push(`  ${summary}`);

    if (effect.hasDuration) {
      const durationText = effect.consumePerTurn
        ? game.i18n.format("INDYVENTURES.Chat.ModifierTurnsTick", {
          before: effect.remainingBefore,
          after: effect.remainingAfter
        })
        : game.i18n.format("INDYVENTURES.Chat.ModifierTurnsStatic", {
          remaining: effect.remainingBefore
        });
      lines.push(`  ${durationText}`);
    }

    if (Array.isArray(effect.impactLines) && effect.impactLines.length) {
      for (const impact of effect.impactLines) {
        lines.push(`  ${impact}`);
      }
    }

    effectBlocks.push(lines.join("\n"));
  }

  return [...outcomeLines, ...effectBlocks].join("\n\n");
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

function modifierAppliesToFacility(modifier, facility, source = null) {
  if ((source?.ownerType === "facility") && source?.owner) {
    const sourceFacility = source.owner;
    if ((sourceFacility.id === facility.id) || (sourceFacility.uuid === facility.uuid)) {
      return true;
    }
  }
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
  return effect.getFlag(MODULE_ID, "ventureModifierTemplate") !== true;
}

function getEffectDebugIdentity(effect, source) {
  return {
    id: effect?.id ?? null,
    name: effect?.name ?? "",
    ownerType: source?.ownerType ?? "",
    ownerName: source?.owner?.name ?? source?.owner?.id ?? "",
    ownerUuid: source?.owner?.uuid ?? null
  };
}

function getEffectModifierChangeRows(effect) {
  return (effect?.changes ?? [])
    .filter(change => String(change?.key ?? "").startsWith(VENTURE_MODIFIER_CHANGE_PREFIX))
    .map(change => ({
      key: change?.key,
      mode: change?.mode,
      value: change?.value
    }));
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
      const effectIdentity = getEffectDebugIdentity(effect, source);
      const templateFlag = effect.getFlag(MODULE_ID, "ventureModifierTemplate");
      const rawModifierFlag = foundry.utils.deepClone(effect.getFlag(MODULE_ID, "ventureModifier") ?? null);
      const modifierChangeRows = getEffectModifierChangeRows(effect);
      const hasDefinition = effectHasVentureModifierDefinition(effect);
      moduleLog("Venture modifiers: evaluating effect", {
        ...effectIdentity,
        templateFlag,
        disabled: Boolean(effect.disabled),
        suppressed: Boolean(effect.isSuppressed),
        hasDefinition,
        rawModifierFlag,
        modifierChangeRows
      });

      if (!hasDefinition) {
        debugEffects.push({
          ...effectIdentity,
          skipped: true,
          reason: "noDefinition"
        });
        moduleLog("Venture modifiers: skipped effect", {
          ...effectIdentity,
          reason: "noDefinition"
        });
        continue;
      }

      if (!isFacilityModifierActiveInstance(effect, source.ownerType)) {
        debugEffects.push({
          ...effectIdentity,
          skipped: true,
          reason: "template"
        });
        moduleLog("Venture modifiers: skipped effect", {
          ...effectIdentity,
          reason: "template",
          templateFlag
        });
        continue;
      }
      if (effect.disabled || effect.isSuppressed) {
        debugEffects.push({
          ...effectIdentity,
          disabled: Boolean(effect.disabled),
          suppressed: Boolean(effect.isSuppressed),
          skipped: true,
          reason: effect.disabled ? "disabled" : "suppressed"
        });
        moduleLog("Venture modifiers: skipped effect", {
          ...effectIdentity,
          reason: effect.disabled ? "disabled" : "suppressed"
        });
        continue;
      }
      const modifier = getEffectModifierData(effect);
      const appliesToFacility = modifierAppliesToFacility(modifier, facility, source);
      const hasDuration = modifier.remainingTurns !== null;
      const activeDuration = !hasDuration || (modifier.remainingTurns > 0);
      moduleLog("Venture modifiers: parsed modifier", {
        ...effectIdentity,
        modifier,
        appliesToFacility,
        facilityMatchCandidates: [facility.id, facility.uuid, facility.name],
        hasDuration,
        activeDuration
      });
      if (!modifier.enabled || !appliesToFacility || !activeDuration) {
        const reason = !modifier.enabled
          ? "disabledByFlag"
          : (!appliesToFacility ? "scopeMismatch" : "expired");
        debugEffects.push({
          ...effectIdentity,
          enabled: modifier.enabled,
          appliesToFacility,
          bastionDurationType: modifier.bastionDurationType,
          remainingTurns: modifier.remainingTurns,
          skipped: true,
          reason
        });
        moduleLog("Venture modifiers: skipped effect", {
          ...effectIdentity,
          reason,
          enabled: modifier.enabled,
          appliesToFacility,
          remainingTurns: modifier.remainingTurns
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
        ...effectIdentity,
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
      moduleLog("Venture modifiers: applied effect", {
        ...effectIdentity,
        modifier,
        aggregateAfter: foundry.utils.deepClone(aggregate)
      });
    }
  }

  const reasonCounts = debugEffects.reduce((counts, effect) => {
    const key = effect.skipped ? (String(effect.reason ?? "unknown")) : "applied";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  moduleLog("Venture modifiers: effect scan summary", {
    actor: actor.name,
    facility: facility.name,
    actorEffects: actor.effects?.size ?? 0,
    facilityEffects: facility.effects?.size ?? 0,
    modifierEffectsFound: debugEffects.length,
    modifierEffectsApplied: debugEffects.filter(effect => !effect.skipped).length,
    reasonCounts
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

function getBoonDisabledReason({
  purchasable = false,
  blockedByWindow = false,
  blockedByGroupLimit = false,
  affordable = true,
  purchaseWhenLabel = "",
  group = "",
  groupPerTurnLimit = null,
  purchasedInGroupThisTurn = 0,
  perTurnLimit = null,
  purchasedThisTurn = 0
} = {}) {
  if (purchasable) return "";
  const unlimited = game.i18n.localize("INDYVENTURES.Chat.Unlimited");
  if (blockedByWindow) {
    return game.i18n.format("INDYVENTURES.Errors.BoonPurchaseWindowBlocked", {
      mode: purchaseWhenLabel || getBoonPurchaseWhenLabel("default")
    });
  }
  if (blockedByGroupLimit) {
    return game.i18n.format("INDYVENTURES.Errors.BoonGroupTurnLimitReached", {
      group: group || "-",
      purchased: Math.max(Number(purchasedInGroupThisTurn) || 0, 0),
      limit: groupPerTurnLimit ?? unlimited
    });
  }
  if (!affordable) return game.i18n.localize("INDYVENTURES.Errors.NotEnoughTreasury");
  return game.i18n.format("INDYVENTURES.Errors.BoonTurnLimitReached", {
    purchased: Math.max(Number(purchasedThisTurn) || 0, 0),
    limit: perTurnLimit ?? unlimited
  });
}

function emitSocket(payload) {
  game.socket?.emit(SOCKET_NAMESPACE, payload);
}

function getBoonPurchasesThisTurn(state, boonIndex, boonKey = "") {
  const purchasesTurnId = String(state?.boonPurchasesTurnId ?? "");
  const stateTurnId = String(state?.turnId ?? "");
  if (!purchasesTurnId || !stateTurnId || (purchasesTurnId !== stateTurnId)) return 0;
  const fromIndex = Math.max(Number(state?.boonPurchases?.[String(boonIndex)] ?? 0) || 0, 0);
  const key = String(boonKey ?? "").trim();
  if (key) {
    const fromKey = Number(state?.boonPurchases?.[key] ?? 0);
    const safeFromKey = Math.max(Number.isFinite(fromKey) ? fromKey : 0, 0);
    // Keys can contain dots/UUID segments; fall back to index-based counter if key lookup fails.
    return Math.max(safeFromKey, fromIndex);
  }
  return fromIndex;
}

function buildGroupLimitMap(boons = []) {
  const map = new Map();
  for (const boon of boons) {
    const groupKey = buildBoonGroupKey(boon);
    if (!groupKey) continue;
    const limit = parseBoonPerTurnLimit(boon?.groupPerTurnLimit, null);
    if (limit === null) continue;
    const existing = map.get(groupKey);
    map.set(groupKey, existing === undefined ? limit : Math.min(existing, limit));
  }
  return map;
}

function buildGroupPurchaseCountMap(boons = [], state = {}) {
  const map = new Map();
  for (let index = 0; index < boons.length; index += 1) {
    const boon = boons[index];
    const groupKey = buildBoonGroupKey(boon);
    if (!groupKey) continue;
    const boonKey = buildBoonKey(boon);
    const purchased = getBoonPurchasesThisTurn(state, index, boonKey);
    map.set(groupKey, (map.get(groupKey) ?? 0) + purchased);
  }
  return map;
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
  currentTreasury,
  treasuryCover,
  characterCover,
  treasuryAvailable,
  actorNeededAfterTreasury,
  availableGp,
  availableInventoryGp,
  canCoverWithGp,
  canCoverWithInventory,
  canCoverWithTreasuryAndActor,
  canCoverWithActor,
  mode = "legacy",
  deciderName
}) {
  const title = game.i18n.localize("INDYVENTURES.Prompt.Title");
  const content = game.i18n.format("INDYVENTURES.Prompt.Content", {
    actor: actorName,
    venture: ventureName,
    deficit,
    currentTreasury: currentTreasury ?? treasuryAvailable ?? treasuryCover ?? 0,
    treasuryCover: treasuryCover ?? treasuryAvailable ?? 0,
    characterCover: characterCover ?? actorNeededAfterTreasury ?? 0,
    availableGp,
    availableInventoryGp,
    decider: deciderName
  });
  const coverFromTreasuryAndActorLabel = game.i18n.localize("INDYVENTURES.Prompt.CoverFromTreasuryAndActor");
  const coverFromTreasuryLabel = game.i18n.localize("INDYVENTURES.Prompt.CoverFromTreasury");
  const coverFromActorLabel = game.i18n.localize("INDYVENTURES.Prompt.CoverFromActor");
  const coverFromGpLabel = game.i18n.localize("INDYVENTURES.Prompt.CoverFromGp");
  const coverFromInventoryLabel = game.i18n.localize("INDYVENTURES.Prompt.CoverFromInventory");
  const declineLabel = game.i18n.localize("INDYVENTURES.Prompt.Decline");

  const buttonEntries = [];
  const addButton = (id, label, choice) => buttonEntries.push({ id, label, choice });

  if (mode === "treasuryActor") {
    if (canCoverWithTreasuryAndActor) {
      const requiresActorFunds = Math.max(Number(actorNeededAfterTreasury ?? characterCover ?? 0) || 0, 0) > 0;
      addButton(
        "coverTreasuryAndActor",
        requiresActorFunds ? coverFromTreasuryAndActorLabel : coverFromTreasuryLabel,
        "treasuryActor"
      );
    }
    if (canCoverWithActor) {
      addButton("coverActor", coverFromActorLabel, "actor");
    }
  } else {
    if (canCoverWithGp) {
      addButton("coverGp", coverFromGpLabel, "gp");
    }
    if (canCoverWithInventory) {
      addButton("coverInventory", coverFromInventoryLabel, "inventory");
    }
  }
  addButton("decline", declineLabel, "decline");

  let defaultButton = "decline";
  if (mode === "treasuryActor") {
    if (canCoverWithTreasuryAndActor) defaultButton = "coverTreasuryAndActor";
    else if (canCoverWithActor) defaultButton = "coverActor";
  } else if (canCoverWithGp) {
    defaultButton = "coverGp";
  } else if (canCoverWithInventory) {
    defaultButton = "coverInventory";
  }

  if (foundry.applications?.api?.DialogV2?.wait) {
    try {
      const result = await foundry.applications.api.DialogV2.wait({
        window: { title, resizable: true },
        content,
        rejectClose: false,
        close: () => "decline",
        buttons: buttonEntries.map(entry => ({
          action: entry.id,
          label: entry.label,
          default: entry.id === defaultButton,
          callback: () => entry.choice
        }))
      });
      return String(result ?? "decline");
    } catch (error) {
      moduleLog("Coverage prompt: DialogV2.wait failed, falling back", {
        error: String(error?.message ?? error)
      });
    }
  }

  return new Promise(resolve => {
    const buttons = Object.fromEntries(buttonEntries.map(entry => ([
      entry.id,
      { label: entry.label, callback: () => resolve(entry.choice) }
    ])));
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
  currentTreasury,
  treasuryCover,
  characterCover,
  treasuryAvailable,
  actorNeededAfterTreasury,
  availableGp,
  availableInventoryGp,
  canCoverWithGp,
  canCoverWithInventory,
  canCoverWithTreasuryAndActor,
  canCoverWithActor,
  mode = "legacy"
}) {
  const requestId = foundry.utils.randomID();
  const timeoutMs = getCoverageTimeoutMs();
  const response = await new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingCoverageRequests.delete(requestId);
      resolve({ choice: "decline", timedOut: true, userId: targetUser.id });
    }, timeoutMs);

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
      currentTreasury,
      treasuryCover,
      characterCover,
      treasuryAvailable,
      actorNeededAfterTreasury,
      availableGp,
      availableInventoryGp,
      canCoverWithGp,
      canCoverWithInventory,
      canCoverWithTreasuryAndActor,
      canCoverWithActor,
      mode
    });
  });

  return response;
}

async function maybeCoverDeficitTreasuryOrActor({
  actor,
  facility,
  deficit,
  state,
  wallet
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
    characterCovered: 0,
    treasuryCovered: 0
  };

  if (deficit <= 0) return result;

  const treasuryAvailable = Math.min(state.treasury, deficit);
  const actorNeededAfterTreasury = Math.max(deficit - treasuryAvailable, 0);
  const canCoverWithTreasuryAndActor = (treasuryAvailable > 0) && canCoverFromInventory(wallet, actorNeededAfterTreasury);
  const canCoverWithActor = canCoverFromInventory(wallet, deficit);
  result.insufficientFunds = !canCoverWithTreasuryAndActor && !canCoverWithActor;
  if (result.insufficientFunds) return result;

  const preferredUser = getPreferredCoverageUser(actor);
  let choice = "decline";
  if (!preferredUser || (preferredUser.id === game.user.id)) {
    choice = await promptCoverageChoice({
      actorName: actor.name,
      ventureName: facility.name,
      deficit,
      currentTreasury: state.treasury,
      treasuryAvailable,
      actorNeededAfterTreasury,
      availableGp: formatGpAmount(getWalletCurrency(wallet, "gp")),
      availableInventoryGp: formatGpAmount(getWalletTotalGp(wallet)),
      canCoverWithTreasuryAndActor,
      canCoverWithActor,
      mode: "treasuryActor",
      deciderName: game.user.name
    });
    result.promptUserName = game.user.name;
  } else {
    const decision = await requestCoverageDecisionFromOwner({
      targetUser: preferredUser,
      actor,
      facility,
      deficit,
      currentTreasury: state.treasury,
      treasuryAvailable,
      actorNeededAfterTreasury,
      availableGp: formatGpAmount(getWalletCurrency(wallet, "gp")),
      availableInventoryGp: formatGpAmount(getWalletTotalGp(wallet)),
      canCoverWithTreasuryAndActor,
      canCoverWithActor,
      mode: "treasuryActor"
    });
    choice = String(decision?.choice ?? "decline");
    result.promptUserName = preferredUser.name;
    result.promptTimedOut = Boolean(decision?.timedOut);
  }

  if (choice === "treasuryActor") {
    if (treasuryAvailable > 0) {
      state.treasury -= treasuryAvailable;
      result.treasuryCovered = treasuryAvailable;
    }
    if (actorNeededAfterTreasury > 0) {
      if (!spendFromInventory(wallet, actorNeededAfterTreasury)) return result;
      result.coveredByInventory = true;
      result.characterCovered = actorNeededAfterTreasury;
    }
    result.coveredCharacter = true;
    result.manualCovered = true;
    return result;
  }

  if (choice === "actor") {
    if (!spendFromInventory(wallet, deficit)) return result;
    result.coveredCharacter = true;
    result.manualCovered = true;
    result.coveredByInventory = true;
    result.characterCovered = deficit;
    return result;
  }

  result.promptDeclined = !result.promptTimedOut;
  return result;
}

async function maybeCoverCharacterDeficit({
  actor,
  facility,
  deficit,
  currentTreasury,
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
  const canCoverWithActor = canCoverFromInventory(wallet, characterCover);
  result.insufficientFunds = !canCoverWithGp && !canCoverWithActor;
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
      currentTreasury,
      treasuryCover,
      characterCover,
      availableGp: formatGpAmount(getWalletCurrency(wallet, "gp")),
      availableInventoryGp: formatGpAmount(getWalletTotalGp(wallet)),
      canCoverWithActor,
      mode: "treasuryActor",
      deciderName: game.user.name
    });

    result.promptUserName = game.user.name;
    if (choice === "actor") {
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
    currentTreasury,
    treasuryCover,
    characterCover,
    availableGp: formatGpAmount(getWalletCurrency(wallet, "gp")),
    availableInventoryGp: formatGpAmount(getWalletTotalGp(wallet)),
    canCoverWithActor,
    mode: "treasuryActor"
  });

  result.promptUserName = preferredUser.name;
  result.promptTimedOut = Boolean(decision?.timedOut);
  if (decision?.choice === "actor") {
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
    state.boonPurchasesTurnId = turnId;
    state.boonPurchases = {};
  } else if (state.turnId && (state.boonPurchasesTurnId !== state.turnId)) {
    state.boonPurchasesTurnId = state.turnId;
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
  const baseProfitDie = stateBefore.currentProfitDie;
  const baseSuccessThreshold = Math.max(Number(config.successThreshold) || 1, 1);
  let steppedProfitDie = shiftDie(baseProfitDie, effectModifiers.aggregate.profitDieStep);
  let rolledProfitDie = steppedProfitDie;
  if (effectModifiers.aggregate.profitDieOverride) {
    rolledProfitDie = effectModifiers.aggregate.profitDieOverride;
  }
  rolledProfitDie = applyMinimumDie(rolledProfitDie, effectModifiers.aggregate.minProfitDie);

  const baseLossDie = shiftDie(config.lossDie, config.lossModifier);
  let steppedLossDie = shiftDie(config.lossDie, config.lossModifier + effectModifiers.aggregate.lossDieStep);
  let lossDie = steppedLossDie;
  if (effectModifiers.aggregate.lossDieOverride) {
    lossDie = effectModifiers.aggregate.lossDieOverride;
  }
  lossDie = applyMaximumDie(lossDie, effectModifiers.aggregate.maxLossDie);

  const effectiveSuccessThreshold = Math.max(
    Number(effectModifiers.aggregate.successThresholdOverride ?? baseSuccessThreshold) || baseSuccessThreshold,
    1
  );
  moduleLog("Venture modifiers: computed dice before rolls", {
    actor: actor.name,
    facility: facility.name,
    baseProfitDie,
    steppedProfitDie,
    finalProfitDie: rolledProfitDie,
    baseLossDie,
    steppedLossDie,
    finalLossDie: lossDie,
    baseSuccessThreshold,
    effectiveSuccessThreshold,
    aggregate: foundry.utils.deepClone(effectModifiers.aggregate),
    appliedEffects: effectModifiers.debugEffects
      .filter(effect => !effect.skipped)
      .map(effect => ({
        id: effect.id,
        name: effect.name,
        ownerType: effect.ownerType,
        ownerName: effect.ownerName
      }))
  });

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
  const rolledNaturalOne = rawProfitRollTotal === 1;
  const naturalOnePenaltyApplies = Boolean(config.naturalOneDegradesProfitDie) && rolledNaturalOne;
  const modifierOutcome = {
    showProfitDie: baseProfitDie !== rolledProfitDie,
    profitDieBase: baseProfitDie,
    profitDieFinal: rolledProfitDie,
    showLossDie: baseLossDie !== lossDie,
    lossDieBase: baseLossDie,
    lossDieFinal: lossDie,
    showSuccessThreshold: baseSuccessThreshold !== effectiveSuccessThreshold,
    successThresholdBase: baseSuccessThreshold,
    successThresholdFinal: effectiveSuccessThreshold,
    showProfitBonus: profitRollBonus !== 0,
    rawProfitRollTotal,
    profitRollBonus,
    profitRollTotal
  };
  modifierOutcome.hasAny = modifierOutcome.showProfitDie
    || modifierOutcome.showLossDie
    || modifierOutcome.showSuccessThreshold
    || modifierOutcome.showProfitBonus;
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
  let naturalOneDegraded = false;
  let failed = false;
  let deficit = 0;

  if (net > 0) {
    state.treasury += net;
    if (!naturalOnePenaltyApplies) {
      state.streak += 1;
      if (state.streak >= effectiveSuccessThreshold) {
        const previousDie = state.currentProfitDie;
        state.currentProfitDie = shiftDie(state.currentProfitDie, 1);
        state.streak = 0;
        grew = dieIndex(state.currentProfitDie) > dieIndex(previousDie);
        if (grew) {
          markModifiersForDeletion(modifierDurationUsage, effectModifiers.growConsumableEffects, "grown");
        }
      }
    } else {
      state.streak = 0;
    }
  } else if (net === 0) {
    // Break-even does not advance streak.
  } else {
    deficit = Math.abs(net);
    state.streak = 0;

    // Optionally apply venture treasury first; character funds handle any remainder.
    if (config.autoUseTreasuryLoss) {
      treasuryCovered = Math.min(state.treasury, deficit);
      state.treasury -= treasuryCovered;
      const characterDeficit = Math.max(deficit - treasuryCovered, 0);
      const coverage = await maybeCoverCharacterDeficit({
        actor,
        facility,
        deficit,
        currentTreasury: state.treasury,
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
    } else if (config.autoCoverLoss) {
      treasuryCovered = 0;
      const coverage = await maybeCoverCharacterDeficit({
        actor,
        facility,
        deficit,
        currentTreasury: state.treasury,
        treasuryCover: 0,
        characterCover: deficit,
        wallet,
        autoCoverLoss: true
      });
      characterCovered = coverage.characterCovered;
      coveredDeficit = characterCovered >= deficit;
      autoCovered = coverage.autoCovered;
      manualCovered = coverage.manualCovered;
      coveredByInventory = coverage.coveredByInventory;
      promptDeclined = coverage.promptDeclined;
      promptTimedOut = coverage.promptTimedOut;
      promptUserName = coverage.promptUserName;
      insufficientFunds = coverage.insufficientFunds;
      uncoveredDeficit = Math.max(deficit - characterCovered, 0);
      hasCoverageSources = characterCovered > 0;
    } else {
      treasuryCovered = 0;
      const coverage = await maybeCoverDeficitTreasuryOrActor({
        actor,
        facility,
        deficit,
        state,
        wallet
      });
      treasuryCovered = coverage.treasuryCovered;
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
    }

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

  // A raw profit roll of 1 causes a one-step profit die downgrade (if possible).
  // This applies even if losses were fully covered.
  if (naturalOnePenaltyApplies && !failed && !degraded) {
    const previousDie = state.currentProfitDie;
    const downgraded = shiftDie(state.currentProfitDie, -1);
    state.currentProfitDie = applyMinimumDie(downgraded, effectModifiers.aggregate.minProfitDie);
    naturalOneDegraded = dieIndex(state.currentProfitDie) < dieIndex(previousDie);
    if (naturalOneDegraded) {
      degraded = true;
      grew = false;
    }
    state.streak = 0;
  }

  const parsedBoons = parseBoonsFromConfig(config);
  const groupLimitMap = buildGroupLimitMap(parsedBoons);
  const groupPurchaseCountMap = buildGroupPurchaseCountMap(parsedBoons, state);
  const boons = parsedBoons.map((boon, index) => {
    const reward = resolveRewardDisplayData(boon);
    const boonKey = buildBoonKey(boon);
    const group = String(boon.group ?? "").trim();
    const groupKey = buildBoonGroupKey(boon);
    const baseGroupPerTurnLimit = parseBoonPerTurnLimit(boon.groupPerTurnLimit, null);
    const mappedGroupPerTurnLimit = groupKey ? groupLimitMap.get(groupKey) : undefined;
    const groupPerTurnLimit = (mappedGroupPerTurnLimit === undefined) ? baseGroupPerTurnLimit : mappedGroupPerTurnLimit;
    const purchasedThisTurn = getBoonPurchasesThisTurn(state, index, boonKey);
    const purchasedInGroupThisTurn = groupKey
      ? Math.max(Number(groupPurchaseCountMap.get(groupKey) ?? 0) || 0, 0)
      : 0;
    const perTurnLimit = parseBoonPerTurnLimit(boon.perTurnLimit, 1);
    const purchaseWhen = parseBoonPurchaseWhen(boon.purchaseWhen, "default");
    const purchaseWhenAllowed = boonPurchaseWhenAllows(purchaseWhen, net);
    const underTurnLimit = (perTurnLimit === null) || (purchasedThisTurn < perTurnLimit);
    const underGroupLimit = !groupKey || (groupPerTurnLimit === null) || (purchasedInGroupThisTurn < groupPerTurnLimit);
    const affordable = state.treasury >= boon.cost;
    const blockedByGroupLimit = !underGroupLimit;
    const blockedByWindow = !purchaseWhenAllowed;
    const purchasable = affordable && underTurnLimit && underGroupLimit && purchaseWhenAllowed;
    const disabledReason = getBoonDisabledReason({
      purchasable,
      blockedByWindow,
      blockedByGroupLimit,
      affordable,
      purchaseWhenLabel: getBoonPurchaseWhenLabel(purchaseWhen),
      group,
      groupPerTurnLimit,
      purchasedInGroupThisTurn,
      perTurnLimit,
      purchasedThisTurn
    });
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
      blockedByGroupLimit,
      blockedByWindow,
      purchasedThisTurn,
      remainingPurchases: perTurnLimit === null ? null : Math.max(perTurnLimit - purchasedThisTurn, 0),
      affordable,
      purchasable,
      disabledReason,
      rewardName: reward.rewardName,
      rewardImg: reward.rewardImg
    };
  });

  const modifierImpactContext = {
    baseProfitDie,
    steppedProfitDie,
    rolledProfitDie,
    baseLossDie,
    steppedLossDie,
    lossDie,
    baseSuccessThreshold,
    effectiveSuccessThreshold,
    rawProfitRollTotal,
    aggregateProfitRollBonus: profitRollBonus,
    profitRollTotal
  };
  const modifierEffects = effectModifiers.debugEffects
    .filter(effect => !effect.skipped)
    .map(effect => {
      const hasDuration = (effect.remainingTurns !== null) && (effect.remainingTurns !== undefined);
      const remainingBefore = hasDuration ? Math.max(parseEffectNumber(effect.remainingTurns, 0), 0) : null;
      const remainingAfter = (hasDuration && effect.consumePerTurn)
        ? Math.max(remainingBefore - 1, 0)
        : remainingBefore;
      const impactLines = buildModifierImpactLines(effect, modifierImpactContext);
      return {
        name: effect.name,
        summary: summarizeModifierEffect(effect),
        impactLines,
        hasDuration,
        remainingBefore,
        remainingAfter,
        consumePerTurn: Boolean(effect.consumePerTurn)
      };
    });
  const hasModifierEffects = modifierEffects.length > 0;
  const modifierEffectsTooltip = hasModifierEffects
    ? buildModifierEffectsTooltip(modifierEffects, modifierOutcome)
    : "";
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
      naturalOneDegradesProfitDie: Boolean(config.naturalOneDegradesProfitDie),
      autoCoverLoss: config.autoCoverLoss,
      autoUseTreasuryLoss: config.autoUseTreasuryLoss
    },
    stateBefore,
    rolls: {
      profitDieRolled: rolledProfitDie,
      lossDieRolled: lossDie,
      rawProfitRollTotal,
      rolledNaturalOne,
      naturalOnePenaltyApplies,
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
    modifierOutcome,
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
    naturalOneDegraded,
    failed,
    boons,
    hasPurchasableBoons: boons.some(boon => boon.purchasable),
    hasModifierEffects,
    modifierEffectsTooltip,
    modifierOutcome,
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
  if (message?.isRoll || (Array.isArray(message?.rolls) && message.rolls.length > 0)) return;
  const messageKey = String(message?.uuid ?? message?.id ?? "");
  if (!messageKey) return;
  if (processedBastionMessages.has(messageKey)) {
    moduleLog("Bastion venture processing skipped (already processed in-session)", { messageKey });
    return;
  }
  if (message.getFlag?.(MODULE_ID, "processed")) {
    moduleLog("Bastion venture processing skipped (already flagged processed)", { messageKey });
    processedBastionMessages.add(messageKey);
    return;
  }
  const primaryGmId = game.users
    .filter(user => user.active && user.isGM)
    .map(user => user.id)
    .sort()[0];
  if (game.user.id !== primaryGmId) return;

  const bastionData = message.getFlag("dnd5e", "bastion");
  if (!bastionData || !Array.isArray(bastionData.orders)) return;

  const actor = message.getAssociatedActor?.() ?? game.actors.get(message.speaker?.actor);
  if (!actor || actor.type !== "character") return;

  const dedupKey = buildBastionDedupKey(message, bastionData);
  if (dedupKey) {
    const actorTurnKey = `${actor.uuid}::${dedupKey}`;
    if (processedActorTurnKeys.has(actorTurnKey)) {
      moduleLog("Bastion venture processing skipped (duplicate actor turn id detected)", {
        actor: actor.name,
        actorUuid: actor.uuid,
        dedupKey,
        incomingMessage: messageKey
      });
      return;
    }
    processedActorTurnKeys.add(actorTurnKey);
  }

  processedBastionMessages.add(messageKey);

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
    await message.setFlag(MODULE_ID, "processed", true);
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

  await message.setFlag(MODULE_ID, "processed", true);
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
    currentTreasury: payload.currentTreasury ?? payload.treasuryAvailable ?? payload.treasuryCover ?? 0,
    treasuryCover: payload.treasuryCover ?? 0,
    characterCover: payload.characterCover ?? 0,
    treasuryAvailable: payload.treasuryAvailable ?? 0,
    actorNeededAfterTreasury: payload.actorNeededAfterTreasury ?? 0,
    availableGp: payload.availableGp,
    availableInventoryGp: payload.availableInventoryGp ?? payload.availableGp,
    canCoverWithGp: payload.canCoverWithGp !== false,
    canCoverWithInventory: payload.canCoverWithInventory !== false,
    canCoverWithTreasuryAndActor: payload.canCoverWithTreasuryAndActor === true,
    canCoverWithActor: payload.canCoverWithActor === true,
    mode: String(payload.mode ?? "legacy"),
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

async function onRollPrompt(payload) {
  if (payload.targetUserId !== game.user.id) return;

  let actor = null;
  if (payload.actorUuid) {
    try {
      actor = await fromUuid(payload.actorUuid);
    } catch (error) {
      moduleLog("Roll prompt: failed to resolve actor for delegated roll", {
        actorUuid: payload.actorUuid,
        error: String(error?.message ?? error)
      });
    }
  }

  let total = null;
  try {
    const roll = await requestLocalUserRoll({
      formula: payload.formula,
      actor,
      facilityName: payload.facilityName,
      rollLabel: payload.rollLabel
    });
    const parsed = Number(roll?.total);
    total = Number.isFinite(parsed) ? parsed : null;
  } catch (error) {
    moduleLog("Roll prompt: delegated roll failed", {
      user: game.user.name,
      formula: payload.formula,
      rollLabel: payload.rollLabel,
      error: String(error?.message ?? error)
    });
  }

  emitSocket({
    type: "rollResponse",
    gmUserId: payload.gmUserId,
    requestId: payload.requestId,
    userId: game.user.id,
    total
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

function onRollResponse(payload) {
  if (!game.user.isGM) return;
  if (payload.gmUserId !== game.user.id) return;
  const pending = pendingRollRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.resolve({
    total: payload.total,
    userId: payload.userId,
    timedOut: false
  });
  pendingRollRequests.delete(payload.requestId);
}

export function registerCoveragePromptSocket() {
  if (socketRegistered || !game.socket) return;
  socketRegistered = true;
  game.socket.on(SOCKET_NAMESPACE, async payload => {
    if (!payload || (typeof payload !== "object")) return;
    if (payload.type === "coveragePrompt") await onCoveragePrompt(payload);
    else if (payload.type === "coverageResponse") onCoverageResponse(payload);
    else if (payload.type === "rollPrompt") await onRollPrompt(payload);
    else if (payload.type === "rollResponse") onRollResponse(payload);
  });
}
