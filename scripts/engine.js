import { DICE_STEPS, MODULE_ID, SETTINGS, TEMPLATE_PATHS } from "./constants.js";
import {
  getFacilityConfig,
  getFacilityState,
  parseBoonsFromConfig,
  updateFacilityVenture
} from "./config.js";
import {
  boonPurchaseWhenAllows,
  getActorGp,
  parseBoonPerTurnLimit,
  parseBoonPurchaseWhen,
  shiftDie
} from "./utils.js";

const SOCKET_NAMESPACE = `module.${MODULE_ID}`;
const COVERAGE_TIMEOUT_MS = 60_000;
const pendingCoverageRequests = new Map();
const VENTURE_MODIFIER_FLAG = `flags.${MODULE_ID}.ventureModifier`;
const VENTURE_MODIFIER_CHANGE_PREFIX = `${VENTURE_MODIFIER_FLAG}.`;

function getRenderTemplate() {
  return foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
}

function parseEffectNumber(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEffectBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

function parseEffectDie(value) {
  const die = String(value ?? "").trim().toLowerCase();
  return DICE_STEPS.includes(die) ? die : null;
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

function applyMinimumDie(die, minimumDie) {
  if (!minimumDie) return die;
  return maxDie(die, minimumDie);
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

  const raw = foundry.utils.mergeObject(fromFlags, fromChanges, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  const facilityId = String(raw.facilityId ?? raw.facilityUuid ?? "").trim();
  const remainingTurnsRaw = raw.remainingTurns;
  const remainingTurns = ((remainingTurnsRaw === undefined) || (remainingTurnsRaw === null) || (remainingTurnsRaw === ""))
    ? null
    : Math.max(parseEffectNumber(remainingTurnsRaw, 0), 0);

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
    profitRollBonus: parseEffectNumber(raw.profitRollBonus, 0),
    remainingTurns,
    consumePerTurn: parseEffectBoolean(raw.consumePerTurn, true),
    sourceHasFlag
  };
}

function modifierAppliesToFacility(modifier, facility) {
  if (modifier.applyToAllVentures) return true;
  const target = modifier.facilityId;
  if (!target || (target === "*") || (target.toLowerCase() === "all")) return true;
  return [facility.id, facility.uuid, facility.name].includes(target);
}

function collectActiveVentureModifiers(actor, facility) {
  const aggregate = {
    profitDieStep: 0,
    profitDieOverride: null,
    minProfitDie: null,
    lossDieStep: 0,
    lossDieOverride: null,
    profitRollBonus: 0
  };
  const trackedEffects = [];

  for (const effect of actor.effects ?? []) {
    if (!effect || effect.disabled || effect.isSuppressed) continue;
    const modifier = getEffectModifierData(effect);
    if (!modifier.enabled) continue;
    if (!modifierAppliesToFacility(modifier, facility)) continue;
    if ((modifier.remainingTurns !== null) && (modifier.remainingTurns <= 0)) continue;

    aggregate.profitDieStep += modifier.profitDieStep;
    aggregate.lossDieStep += modifier.lossDieStep;
    aggregate.profitRollBonus += modifier.profitRollBonus;
    if (modifier.profitDieOverride) aggregate.profitDieOverride = modifier.profitDieOverride;
    if (modifier.lossDieOverride) aggregate.lossDieOverride = modifier.lossDieOverride;
    if (modifier.minProfitDie) {
      aggregate.minProfitDie = aggregate.minProfitDie
        ? maxDie(aggregate.minProfitDie, modifier.minProfitDie)
        : modifier.minProfitDie;
    }

    if (modifier.sourceHasFlag && modifier.consumePerTurn && (modifier.remainingTurns !== null)) {
      trackedEffects.push({
        effectId: modifier.effectId,
        remainingTurns: modifier.remainingTurns
      });
    }
  }

  return { aggregate, trackedEffects };
}

function queueModifierDurationUsage(usageMap, trackedEffects) {
  for (const tracked of trackedEffects) {
    if (!tracked?.effectId) continue;
    if (usageMap.has(tracked.effectId)) continue;
    usageMap.set(tracked.effectId, tracked.remainingTurns);
  }
}

async function decrementModifierDurations(actor, usageMap) {
  if (!usageMap?.size) return;

  const updates = [];
  for (const [effectId, remainingTurns] of usageMap.entries()) {
    const currentRemaining = Math.max(parseEffectNumber(remainingTurns, 0), 0);
    if (currentRemaining <= 0) continue;
    const nextRemaining = Math.max(currentRemaining - 1, 0);
    updates.push({
      _id: effectId,
      [VENTURE_MODIFIER_FLAG + ".remainingTurns"]: nextRemaining,
      disabled: nextRemaining <= 0
    });
  }

  if (!updates.length) return;
  await actor.updateEmbeddedDocuments("ActiveEffect", updates);
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
  if (rewardUuid && globalThis.fromUuidSync) {
    const doc = fromUuidSync(rewardUuid, { strict: false });
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

function getPreferredCoverageUser(actor) {
  const activeOwners = game.users
    .filter(user => user.active && actor.testUserPermission(user, "OWNER"));
  return activeOwners.find(user => !user.isGM) ?? activeOwners[0] ?? null;
}

async function confirmCoveragePrompt({
  actorName,
  ventureName,
  deficit,
  treasuryCover,
  characterCover,
  availableGp,
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
    decider: deciderName
  });

  if (foundry.applications?.api?.DialogV2?.confirm) {
    return foundry.applications.api.DialogV2.confirm({
      window: { title },
      content,
      rejectClose: false
    });
  }

  return Dialog.confirm({
    title,
    content
  });
}

async function requestCoverageDecisionFromOwner({
  targetUser,
  actor,
  facility,
  deficit,
  treasuryCover,
  characterCover,
  availableGp
}) {
  const requestId = foundry.utils.randomID();
  const response = await new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingCoverageRequests.delete(requestId);
      resolve({ approved: false, timedOut: true, userId: targetUser.id });
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
      availableGp
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
    promptDeclined: false,
    promptTimedOut: false,
    promptUserName: null,
    insufficientFunds: wallet.gp < characterCover,
    characterCovered: 0
  };

  if (characterCover <= 0) {
    result.coveredCharacter = true;
    return result;
  }

  if (wallet.gp < characterCover) return result;

  if (autoCoverLoss) {
    wallet.gp -= characterCover;
    wallet.dirty = true;
    result.coveredCharacter = true;
    result.autoCovered = true;
    result.characterCovered = characterCover;
    return result;
  }

  const preferredUser = getPreferredCoverageUser(actor);
  if (!preferredUser || (preferredUser.id === game.user.id)) {
    const approved = await confirmCoveragePrompt({
      actorName: actor.name,
      ventureName: facility.name,
      deficit,
      treasuryCover,
      characterCover,
      availableGp: wallet.gp,
      deciderName: game.user.name
    });

    result.promptUserName = game.user.name;
    if (approved) {
      wallet.gp -= characterCover;
      wallet.dirty = true;
      result.coveredCharacter = true;
      result.manualCovered = true;
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
    availableGp: wallet.gp
  });

  result.promptUserName = preferredUser.name;
  result.promptTimedOut = Boolean(decision?.timedOut);
  if (decision?.approved) {
    wallet.gp -= characterCover;
    wallet.dirty = true;
    result.coveredCharacter = true;
    result.manualCovered = true;
    result.characterCovered = characterCover;
  } else {
    result.promptDeclined = !result.promptTimedOut;
  }
  return result;
}

async function rollDie(formula) {
  return Roll.create(formula).evaluate({ allowInteractive: false });
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

  let rolledProfitDie = shiftDie(state.currentProfitDie, effectModifiers.aggregate.profitDieStep);
  if (effectModifiers.aggregate.profitDieOverride) {
    rolledProfitDie = effectModifiers.aggregate.profitDieOverride;
  }
  rolledProfitDie = applyMinimumDie(rolledProfitDie, effectModifiers.aggregate.minProfitDie);

  let lossDie = shiftDie(config.lossDie, config.lossModifier + effectModifiers.aggregate.lossDieStep);
  if (effectModifiers.aggregate.lossDieOverride) {
    lossDie = effectModifiers.aggregate.lossDieOverride;
  }

  const profitRoll = await rollDie(rolledProfitDie);
  const lossRoll = await rollDie(lossDie);

  const rawProfitRollTotal = Number(profitRoll.total);
  const profitRollBonus = effectModifiers.aggregate.profitRollBonus;
  const profitRollTotal = Math.max(rawProfitRollTotal + profitRollBonus, 0);
  const income = profitRollTotal * 100;
  const outgoings = Number(lossRoll.total) * 100;
  const net = income - outgoings;
  state.lastTurnNet = net;

  let coveredDeficit = false;
  let autoCovered = false;
  let manualCovered = false;
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
    if (state.streak >= config.successThreshold) {
      state.currentProfitDie = shiftDie(state.currentProfitDie, 1);
      state.streak = 0;
      grew = true;
    }
  } else {
    deficit = Math.abs(net);
    state.streak = 0;

    // Venture treasury always covers losses first; character GP handles any remainder.
    treasuryCovered = Math.min(state.treasury, deficit);
    state.treasury -= treasuryCovered;
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
    const purchasedThisTurn = Math.max(Number(state.boonPurchases?.[String(index)] ?? 0) || 0, 0);
    const perTurnLimit = parseBoonPerTurnLimit(boon.perTurnLimit, 1);
    const purchaseWhen = parseBoonPurchaseWhen(boon.purchaseWhen, "default");
    const purchaseWhenAllowed = boonPurchaseWhenAllows(purchaseWhen, net);
    const underTurnLimit = (perTurnLimit === null) || (purchasedThisTurn < perTurnLimit);
    return {
      ...boon,
      index,
      perTurnLimit,
      purchaseWhen,
      purchaseWhenLabel: getBoonPurchaseWhenLabel(purchaseWhen),
      purchaseWhenAllowed,
      blockedByWindow: !purchaseWhenAllowed,
      purchasedThisTurn,
      remainingPurchases: perTurnLimit === null ? null : Math.max(perTurnLimit - purchasedThisTurn, 0),
      affordable: state.treasury >= boon.cost,
      purchasable: (state.treasury >= boon.cost) && underTurnLimit && purchaseWhenAllowed,
      rewardName: reward.rewardName,
      rewardImg: reward.rewardImg
    };
  });

  await updateFacilityVenture(facility, config, state);

  return {
    facilityId: facility.id,
    facilityUuid: facility.uuid,
    facilityName: facility.name,
    ventureName: config.ventureName || facility.name,
    profitDie: rolledProfitDie,
    nextProfitDie: state.currentProfitDie,
    lossDie,
    rawProfitRollTotal,
    profitRollBonus,
    profitRollTotal,
    lossRollTotal: Number(lossRoll.total),
    income,
    outgoings,
    net,
    deficit,
    coveredDeficit,
    autoCovered,
    manualCovered,
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
    boons
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
    gp: getActorGp(actor),
    dirty: false
  };

  const facilities = actor.itemTypes?.facility ?? [];
  const results = [];
  const turnId = message.uuid;
  const modifierDurationUsage = new Map();
  for (const facility of facilities) {
    const result = await processSingleVenture(facility, actor, wallet, turnId, modifierDurationUsage);
    if (result) results.push(result);
  }

  if (!results.length) return;

  if (wallet.dirty) {
    await actor.update({ "system.currency.gp": wallet.gp });
  }

  await decrementModifierDurations(actor, modifierDurationUsage);

  if (game.settings.get(MODULE_ID, SETTINGS.postChatSummary)) {
    await postVentureSummary(actor, results, message);
  }
}

let socketRegistered = false;

async function onCoveragePrompt(payload) {
  if (payload.targetUserId !== game.user.id) return;
  const approved = await confirmCoveragePrompt({
    actorName: payload.actorName,
    ventureName: payload.ventureName,
    deficit: payload.deficit,
    treasuryCover: payload.treasuryCover ?? 0,
    characterCover: payload.characterCover ?? 0,
    availableGp: payload.availableGp,
    deciderName: game.user.name
  });

  emitSocket({
    type: "coverageResponse",
    gmUserId: payload.gmUserId,
    requestId: payload.requestId,
    userId: game.user.id,
    approved: Boolean(approved)
  });
}

function onCoverageResponse(payload) {
  if (!game.user.isGM) return;
  if (payload.gmUserId !== game.user.id) return;
  const pending = pendingCoverageRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.resolve({
    approved: Boolean(payload.approved),
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
