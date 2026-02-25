import { MODULE_ID, TEMPLATE_PATHS } from "./constants.js";
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
  getActorGp,
  parseBoonPerTurnLimit,
  parseBoonPurchaseWhen,
  resolveRewardDocumentSync
} from "./utils.js";
import { moduleLog } from "./logger.js";

const BASTION_DURATION_FLAG = `flags.${MODULE_ID}.bastionDuration`;
const BASTION_DURATION_CHANGE_PREFIX = `${BASTION_DURATION_FLAG}.`;

function getRenderTemplate() {
  return foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
}

function resolveMessageHtmlRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (Array.isArray(html) && (html[0] instanceof HTMLElement)) return html[0];
  if (html?.jquery && (html[0] instanceof HTMLElement)) return html[0];
  return null;
}

function parseModifierNumber(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseModifierBoolean(value, fallback = false) {
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

function getVentureModifierFromEffect(effect) {
  const rawFlagData = effect.getFlag(MODULE_ID, "ventureModifier");
  const fromFlags = (rawFlagData && (typeof rawFlagData === "object")) ? rawFlagData : {};
  const fromChanges = {};
  for (const change of effect.changes ?? []) {
    const key = String(change?.key ?? "");
    if (!key.startsWith(`flags.${MODULE_ID}.ventureModifier.`)) continue;
    const subKey = key.slice(`flags.${MODULE_ID}.ventureModifier.`.length);
    foundry.utils.setProperty(fromChanges, subKey, change?.value);
  }
  const raw = foundry.utils.mergeObject(fromChanges, fromFlags, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  if (!raw || (typeof raw !== "object") || (Object.keys(raw).length === 0)) return null;
  const remainingTurnsRaw = raw.remainingTurns;
  let remainingTurns = ((remainingTurnsRaw === undefined) || (remainingTurnsRaw === null) || (remainingTurnsRaw === ""))
    ? null
    : Math.max(parseModifierNumber(remainingTurnsRaw, 0), 0);
  if ((String(raw.bastionDurationType ?? "").trim() === "nextBastionTurn") && (remainingTurns === null)) {
    remainingTurns = 1;
  }
  return {
    applyToAllVentures: parseModifierBoolean(raw.applyToAllVentures, false),
    facilityId: String(raw.facilityId ?? raw.facilityUuid ?? "").trim(),
    profitDieStep: parseModifierNumber(raw.profitDieStep, 0),
    profitDieOverride: String(raw.profitDieOverride ?? "").trim(),
    minProfitDie: String(raw.minProfitDie ?? "").trim(),
    lossDieStep: parseModifierNumber(raw.lossDieStep, 0),
    lossDieOverride: String(raw.lossDieOverride ?? "").trim(),
    maxLossDie: String(raw.maxLossDie ?? "").trim(),
    successThresholdOverride: Math.max(parseModifierNumber(raw.successThresholdOverride, 0), 0),
    profitRollBonus: parseModifierNumber(raw.profitRollBonus, 0),
    remainingTurns,
    consumePerTurn: parseModifierBoolean(raw.consumePerTurn, true),
    bastionDurationType: String(raw.bastionDurationType ?? "").trim()
  };
}

function modifierAppliesToFacility(modifier, facility) {
  if (modifier.applyToAllVentures) return true;
  const target = modifier.facilityId;
  if (!target || (target === "*") || (target.toLowerCase() === "all")) return true;
  return [facility.id, facility.uuid, facility.name].includes(target);
}

function summarizeModifier(modifier) {
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
    parts.push(game.i18n.localize("INDYVENTURES.EffectSummary.BastionDurationNextTurn"));
  }
  return parts.join(", ");
}

function collectBastionCardModifiers(actor) {
  const facilities = actor.itemTypes?.facility ?? [];
  const rows = [];
  for (const facility of facilities) {
    const config = getFacilityConfig(facility);
    if (!config.enabled) continue;
    const sources = [
      { ownerType: "facility", effects: facility.effects ?? [] },
      { ownerType: "actor", effects: actor.effects ?? [] }
    ];
    for (const source of sources) {
      for (const effect of source.effects) {
        if (!effect || effect.disabled || effect.isSuppressed) continue;
        if ((source.ownerType === "facility") && (effect.getFlag(MODULE_ID, "ventureModifierTemplate") === true)) continue;
        const modifier = getVentureModifierFromEffect(effect);
        if (!modifier) continue;
        if (!modifierAppliesToFacility(modifier, facility)) continue;
        if ((modifier.remainingTurns !== null) && (modifier.remainingTurns <= 0)) continue;
        rows.push({
          facilityName: config.ventureName || facility.name,
          effectName: effect.name,
          summary: summarizeModifier(modifier),
          remainingTurns: modifier.remainingTurns
        });
      }
    }
  }
  return rows;
}

function appendBastionModifierSection(message, html) {
  const bastionData = message.getFlag("dnd5e", "bastion");
  if (!bastionData || !Array.isArray(bastionData.orders)) return;

  const actor = message.getAssociatedActor?.() ?? game.actors.get(message.speaker?.actor);
  if (!actor || actor.type !== "character") return;

  const rows = collectBastionCardModifiers(actor);
  if (!rows.length) return;

  const htmlRoot = resolveMessageHtmlRoot(html);
  if (!htmlRoot) return;
  const root = htmlRoot.querySelector(".message-content") ?? htmlRoot;
  if (!root || root.querySelector(".indy-bastion-modifiers")) return;

  const section = document.createElement("section");
  section.classList.add("indy-bastion-modifiers");
  const title = document.createElement("h4");
  title.textContent = game.i18n.localize("INDYVENTURES.Chat.BastionEffectsTitle");
  section.append(title);

  for (const row of rows) {
    const line = document.createElement("p");
    line.classList.add("hint");
    const detail = row.summary || game.i18n.localize("INDYVENTURES.EffectSummary.NoChanges");
    const turns = (row.remainingTurns === null)
      ? game.i18n.localize("INDYVENTURES.Chat.BastionEffectsNoTurnLimit")
      : game.i18n.format("INDYVENTURES.Chat.BastionEffectsTurnsRemaining", { turns: row.remainingTurns });
    line.textContent = `${row.facilityName} - ${row.effectName}: ${detail} (${turns})`;
    section.append(line);
  }

  root.append(section);
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
      speaker: ChatMessage.getSpeaker?.({ actor }) ?? ChatMessage.implementation.getSpeaker({ actor }),
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

async function rerenderSummaryMessage(message, actorUuid, results) {
  const renderTemplate = getRenderTemplate();
  const actor = (await fromUuid(actorUuid)) ?? { name: game.i18n.localize("Unknown") };
  const content = await renderTemplate(TEMPLATE_PATHS.chatSummary, {
    actor,
    results,
    moduleId: MODULE_ID
  });
  return message.update({
    content,
    [`flags.${MODULE_ID}.results`]: results
  });
}

function canManageVenture(actor) {
  return Boolean(game.user.isGM || actor?.isOwner);
}

function resolveRewardDisplayFromBoon(boon) {
  const rewardUuid = String(boon?.rewardUuid ?? "").trim();
  let rewardName = String(boon?.rewardName ?? boon?.rewardLabel ?? boon?.rewardUuid ?? "").trim();
  let rewardImg = String(boon?.rewardImg ?? "").trim();
  if (rewardUuid && (!rewardName || !rewardImg)) {
    const doc = resolveRewardDocumentSync(rewardUuid);
    if (doc?.name && !rewardName) rewardName = doc.name;
    if (doc?.img && !rewardImg) rewardImg = doc.img;
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

function getBoonPurchasesThisTurn(state, boonIndex, boonKey = "") {
  const key = String(boonKey ?? "").trim();
  if (key) {
    const fromKey = Number(state?.boonPurchases?.[key] ?? 0);
    return Math.max(Number.isFinite(fromKey) ? fromKey : 0, 0);
  }
  return Math.max(Number(state?.boonPurchases?.[String(boonIndex)] ?? 0) || 0, 0);
}

function resolveBoonByIndexOrKey(boons, requestedIndex, requestedKey = "") {
  let index = requestedIndex;
  let boon = boons[index];
  const key = String(requestedKey ?? "").trim();
  if (!key) return { boon, index, matchedByKey: false };

  const currentKey = boon ? buildBoonKey(boon) : "";
  if (boon && (currentKey === key)) return { boon, index, matchedByKey: false };

  const matchedIndex = boons.findIndex(candidate => buildBoonKey(candidate) === key);
  if (matchedIndex >= 0) {
    index = matchedIndex;
    boon = boons[index];
    return { boon, index, matchedByKey: true };
  }

  return { boon: null, index: requestedIndex, matchedByKey: false };
}

function withBoonAvailability(boon, state, boonIndex, turnNet = null) {
  const reward = resolveRewardDisplayFromBoon(boon);
  const boonKey = String(boon?.key ?? buildBoonKey(boon));
  const group = String(boon?.group ?? "").trim();
  const groupKey = String(boon?.groupKey ?? buildBoonGroupKey(boon));
  const groupPerTurnLimit = parseBoonPerTurnLimit(boon?.groupPerTurnLimit, null);
  const perTurnLimit = parseBoonPerTurnLimit(boon?.perTurnLimit, 1);
  const purchaseWhen = parseBoonPurchaseWhen(boon?.purchaseWhen, "default");
  const purchasedThisTurn = getBoonPurchasesThisTurn(state, boonIndex, boonKey);
  const purchasedInGroupThisTurn = groupKey ? getBoonPurchasesThisTurn(state, boonIndex, groupKey) : 0;
  const affordable = state.treasury >= boon.cost;
  const underTurnLimit = (perTurnLimit === null) || (purchasedThisTurn < perTurnLimit);
  const underGroupTurnLimit = !groupKey || (groupPerTurnLimit === null) || (purchasedInGroupThisTurn < groupPerTurnLimit);
  const net = Number(turnNet ?? state?.lastTurnNet ?? 0) || 0;
  const purchaseWhenAllowed = boonPurchaseWhenAllows(purchaseWhen, net);
  return {
    ...boon,
    group,
    groupKey,
    groupPerTurnLimit,
    purchasedInGroupThisTurn,
    remainingGroupPurchases: groupPerTurnLimit === null ? null : Math.max(groupPerTurnLimit - purchasedInGroupThisTurn, 0),
    key: boonKey,
    perTurnLimit,
    purchaseWhen,
    purchaseWhenAllowed,
    purchaseWhenLabel: getBoonPurchaseWhenLabel(purchaseWhen),
    blockedByGroupLimit: !underGroupTurnLimit,
    blockedByWindow: !purchaseWhenAllowed,
    rewardName: reward.rewardName,
    rewardImg: reward.rewardImg,
    purchasedThisTurn,
    remainingPurchases: perTurnLimit === null ? null : Math.max(perTurnLimit - purchasedThisTurn, 0),
    affordable,
    purchasable: affordable && underTurnLimit && underGroupTurnLimit && purchaseWhenAllowed
  };
}

function cloneDocumentSource(document) {
  const source = document.toObject();
  delete source._id;
  return source;
}

function buildModifierChangeRows(modifier) {
  const mode = CONST?.ACTIVE_EFFECT_MODES?.OVERRIDE ?? 5;
  const priority = 20;
  const changeKeys = new Set([
    "enabled",
    "applyToAllVentures",
    "facilityId",
    "profitDieStep",
    "profitDieOverride",
    "minProfitDie",
    "lossDieStep",
    "lossDieOverride",
    "maxLossDie",
    "successThresholdOverride",
    "profitRollBonus",
    "durationFormula",
    "consumePerTurn",
    "bastionDurationType"
  ]);
  const entries = Object.entries(modifier ?? {}).filter(([key, value]) => {
    if (!changeKeys.has(key)) return false;
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim() !== "";
    return true;
  });
  return entries.map(([key, value]) => ({
    key: `flags.${MODULE_ID}.ventureModifier.${key}`,
    mode,
    value: String(value),
    priority
  }));
}

function getBastionDurationFromEffectData(effectData) {
  const fromFlags = foundry.utils.deepClone(foundry.utils.getProperty(effectData, BASTION_DURATION_FLAG) ?? {});
  const fromChanges = {};
  for (const change of effectData.changes ?? []) {
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
  const expireNextTurn = parseModifierBoolean(raw.expireNextTurn, false);
  const durationFormula = String(raw.durationFormula ?? "").trim();
  const remainingTurnsRaw = raw.remainingTurns;
  let remainingTurns = ((remainingTurnsRaw === undefined) || (remainingTurnsRaw === null) || (String(remainingTurnsRaw).trim() === ""))
    ? null
    : Math.max(parseModifierNumber(remainingTurnsRaw, 0), 0);
  const consumePerTurn = parseModifierBoolean(raw.consumePerTurn, true);

  if (expireNextTurn && (remainingTurns === null)) remainingTurns = 1;
  if (!expireNextTurn && (remainingTurns === null) && !durationFormula) return null;

  return { expireNextTurn, remainingTurns, durationFormula, consumePerTurn };
}

async function prepareBastionDurationRewardData(effectData, facility, actor) {
  const duration = getBastionDurationFromEffectData(effectData);
  if (!duration) return null;

  if (duration.expireNextTurn) {
    duration.expireNextTurn = true;
    duration.remainingTurns = 1;
    duration.consumePerTurn = true;
    duration.durationFormula = "";
  }

  const hasRemainingTurns = (duration.remainingTurns !== null);
  if (!hasRemainingTurns && duration.durationFormula) {
    let durationRoll;
    try {
      durationRoll = await requestUserRoll({
        formula: duration.durationFormula,
        actor,
        facilityName: facility.name,
        rollLabel: game.i18n.localize("INDYVENTURES.RollPrompt.Duration")
      });
    } catch (error) {
      throw new Error(game.i18n.format("INDYVENTURES.Errors.BoonDurationFormulaInvalid", {
        formula: duration.durationFormula
      }));
    }

    const turns = Math.max(Number.parseInt(durationRoll.total, 10) || 0, 1);
    duration.remainingTurns = turns;
    moduleLog("Boon reward effect: rolled bastion duration", {
      facility: facility.name,
      formula: duration.durationFormula,
      total: durationRoll.total,
      appliedTurns: turns
    });
  }

  foundry.utils.setProperty(effectData, BASTION_DURATION_FLAG, duration);
  const existingChanges = Array.isArray(effectData.changes) ? effectData.changes : [];
  effectData.changes = existingChanges.filter(change => {
    const key = String(change?.key ?? "");
    if (key.startsWith(BASTION_DURATION_CHANGE_PREFIX)) return false;
    return true;
  });

  moduleLog("Boon reward effect: prepared bastion duration", {
    facility: facility.name,
    effectName: effectData.name ?? null,
    duration
  });
  return duration;
}

async function prepareActiveEffectRewardData(effectData, facility, actor) {
  await prepareBastionDurationRewardData(effectData, facility, actor);

  const modifierPath = `flags.${MODULE_ID}.ventureModifier`;
  if (!foundry.utils.hasProperty(effectData, modifierPath)) return effectData;

  const modifier = foundry.utils.deepClone(foundry.utils.getProperty(effectData, modifierPath) ?? {});
  if (!modifier || (typeof modifier !== "object")) return effectData;

  if (!modifier.applyToAllVentures && !modifier.facilityId && !modifier.facilityUuid) {
    modifier.facilityId = facility.id;
  }

  const bastionDurationType = String(modifier.bastionDurationType ?? "").trim();
  if (bastionDurationType === "nextBastionTurn") {
    modifier.remainingTurns = 1;
    modifier.consumePerTurn = true;
    delete modifier.durationFormula;
  }

  const hasRemainingTurns = (modifier.remainingTurns !== undefined)
    && (modifier.remainingTurns !== null)
    && (String(modifier.remainingTurns).trim() !== "");
  const durationFormula = String(modifier.durationFormula ?? "").trim();
  if (!hasRemainingTurns && durationFormula) {
    let durationRoll;
    try {
      durationRoll = await requestUserRoll({
        formula: durationFormula,
        actor,
        facilityName: facility.name,
        rollLabel: game.i18n.localize("INDYVENTURES.RollPrompt.Duration")
      });
    } catch (error) {
      throw new Error(game.i18n.format("INDYVENTURES.Errors.BoonDurationFormulaInvalid", {
        formula: durationFormula
      }));
    }

    const turns = Math.max(Number.parseInt(durationRoll.total, 10) || 0, 1);
    modifier.remainingTurns = turns;
    moduleLog("Boon reward effect: rolled duration", {
      facility: facility.name,
      formula: durationFormula,
      total: durationRoll.total,
      appliedTurns: turns
    });
  }

  foundry.utils.setProperty(effectData, modifierPath, modifier);
  foundry.utils.setProperty(effectData, `flags.${MODULE_ID}.ventureModifierTemplate`, false);
  effectData.disabled = false;
  const existingChanges = Array.isArray(effectData.changes) ? effectData.changes : [];
  const nonModifierChanges = existingChanges.filter(change => {
    const key = String(change?.key ?? "");
    return !key.startsWith(`flags.${MODULE_ID}.ventureModifier.`);
  });
  effectData.changes = [...nonModifierChanges, ...buildModifierChangeRows(modifier)];
  moduleLog("Boon reward effect: prepared venture modifier", {
    facility: facility.name,
    modifier
  });
  return effectData;
}

async function grantBoonReward(actor, facility, boon) {
  if (!boon.rewardUuid) return null;

  const rewardDoc = await fromUuid(boon.rewardUuid);
  if (!rewardDoc) {
    throw new Error(game.i18n.format("INDYVENTURES.Errors.BoonRewardMissing", {
      reward: boon.rewardLabel || boon.rewardUuid
    }));
  }

  if (rewardDoc.documentName === "Item") {
    await actor.createEmbeddedDocuments("Item", [cloneDocumentSource(rewardDoc)]);
    moduleLog("Boon reward granted: item", {
      actor: actor.name,
      facility: facility.name,
      rewardUuid: boon.rewardUuid,
      reward: rewardDoc.name
    });
    return rewardDoc.name;
  }

  if (rewardDoc.documentName === "ActiveEffect") {
    const effectData = await prepareActiveEffectRewardData(cloneDocumentSource(rewardDoc), facility, actor);
    const hasVentureModifier = foundry.utils.hasProperty(effectData, `flags.${MODULE_ID}.ventureModifier`);
    const targetDocument = hasVentureModifier && facility?.createEmbeddedDocuments
      ? facility
      : actor;
    const created = await targetDocument.createEmbeddedDocuments("ActiveEffect", [effectData]);
    const createdEffect = created?.[0];
    moduleLog("Boon reward granted: active effect", {
      actor: actor.name,
      facility: facility.name,
      target: targetDocument?.documentName ?? "Actor",
      rewardUuid: boon.rewardUuid,
      sourceEffect: rewardDoc.name,
      createdEffectId: createdEffect?.id ?? null,
      createdEffectName: createdEffect?.name ?? rewardDoc.name,
      ventureModifier: createdEffect?.getFlag(MODULE_ID, "ventureModifier")
        ?? foundry.utils.getProperty(effectData, `flags.${MODULE_ID}.ventureModifier`)
        ?? null
    });
    return createdEffect?.name ?? rewardDoc.name;
  }

  throw new Error(game.i18n.format("INDYVENTURES.Errors.BoonRewardUnsupported", {
    type: rewardDoc.documentName,
    reward: rewardDoc.name || boon.rewardUuid
  }));
}

async function promptClaimAmount(maxAmount, ventureName) {
  const title = game.i18n.localize("INDYVENTURES.Prompt.ClaimTitle");
  const content = game.i18n.format("INDYVENTURES.Prompt.ClaimContent", {
    venture: ventureName,
    maxAmount
  });
  const confirmLabel = game.i18n.localize("INDYVENTURES.Prompt.ClaimConfirm");
  const parseAmount = form => {
    if (!form) return null;
    const value = new FormData(form).get("amount");
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  if (foundry.applications?.api?.DialogV2?.prompt) {
    return foundry.applications.api.DialogV2.prompt({
      window: { title },
      content,
      rejectClose: false,
      ok: {
        label: confirmLabel,
        callback: (event, button) => parseAmount(button?.form)
      }
    });
  }

  if (foundry.applications?.api?.Dialog?.prompt) {
    return foundry.applications.api.Dialog.prompt({
      window: { title },
      content,
      ok: {
        label: confirmLabel,
        callback: (event, button) => parseAmount(button?.form)
      }
    });
  }

  return Dialog.prompt({
    title,
    content,
    callback: html => {
      const value = html.find("input[name='amount']").val();
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
  });
}

async function onPurchaseBoon(message, button) {
  const facility = await fromUuid(button.dataset.facilityUuid);
  if (!facility || facility.documentName !== "Item") return;
  const actor = facility.actor;
  if (!canManageVenture(actor)) {
    ui.notifications.warn("INDYVENTURES.Errors.NotOwner", { localize: true });
    return;
  }

  const requestedIndex = Number(button.dataset.boonIndex);
  if (!Number.isFinite(requestedIndex)) return;
  const requestedKey = String(button.dataset.boonKey ?? "").trim();

  const config = getFacilityConfig(facility);
  const state = getFacilityState(facility, config);
  const boons = parseBoonsFromConfig(config);
  const resolved = resolveBoonByIndexOrKey(boons, requestedIndex, requestedKey);
  const boonIndex = resolved.index;
  const boon = resolved.boon;
  if (!boon) {
    moduleLog("Boon purchase blocked: boon entry no longer matches chat summary", {
      actor: actor.name,
      facility: facility.name,
      requestedIndex,
      requestedKey
    });
    ui.notifications.warn("INDYVENTURES.Errors.StaleVentureSummary", { localize: true });
    return;
  }
  if (resolved.matchedByKey) {
    moduleLog("Boon purchase: resolved index mismatch by key", {
      actor: actor.name,
      facility: facility.name,
      requestedIndex,
      resolvedIndex: boonIndex,
      requestedKey
    });
  }
  const actorUuid = message.getFlag(MODULE_ID, "actorUuid");
  const results = foundry.utils.deepClone(message.getFlag(MODULE_ID, "results")) ?? [];
  const summary = results.find(r => r.facilityUuid === facility.uuid);
  const turnNet = Number(summary?.net ?? state.lastTurnNet ?? 0) || 0;

  const turnId = message.getFlag(MODULE_ID, "sourceMessageUuid") ?? "";
  if (!state.turnId && turnId) {
    state.turnId = turnId;
    state.boonPurchases = {};
  } else if (turnId && state.turnId && (state.turnId !== turnId)) {
    ui.notifications.warn("INDYVENTURES.Errors.StaleVentureSummary", { localize: true });
    return;
  }
  const purchaseState = withBoonAvailability(boon, state, boonIndex, turnNet);
  if (!purchaseState.purchasable) {
    const key = purchaseState.blockedByWindow
      ? "INDYVENTURES.Errors.BoonPurchaseWindowBlocked"
      : (purchaseState.blockedByGroupLimit
          ? "INDYVENTURES.Errors.BoonGroupTurnLimitReached"
          : (purchaseState.affordable ? "INDYVENTURES.Errors.BoonTurnLimitReached" : "INDYVENTURES.Errors.NotEnoughTreasury"));
    moduleLog("Boon purchase blocked", {
      actor: actor.name,
      facility: facility.name,
      boon: boon.name,
      boonIndex,
      requestedIndex,
      requestedKey,
      stateTurnId: state.turnId,
      messageTurnId: turnId,
      affordable: purchaseState.affordable,
      purchasedThisTurn: purchaseState.purchasedThisTurn,
      perTurnLimit: purchaseState.perTurnLimit,
      group: purchaseState.group,
      groupPerTurnLimit: purchaseState.groupPerTurnLimit,
      purchasedInGroupThisTurn: purchaseState.purchasedInGroupThisTurn,
      purchaseWhen: purchaseState.purchaseWhen,
      purchaseWhenAllowed: purchaseState.purchaseWhenAllowed
    });
    ui.notifications.warn(game.i18n.format(key, {
      boon: boon.name,
      limit: purchaseState.blockedByGroupLimit
        ? (purchaseState.groupPerTurnLimit ?? game.i18n.localize("INDYVENTURES.Chat.Unlimited"))
        : (purchaseState.perTurnLimit ?? game.i18n.localize("INDYVENTURES.Chat.Unlimited")),
      purchased: purchaseState.blockedByGroupLimit
        ? purchaseState.purchasedInGroupThisTurn
        : purchaseState.purchasedThisTurn,
      mode: purchaseState.purchaseWhenLabel,
      group: purchaseState.group || "-"
    }));
    return;
  }

  const boonKey = String(purchaseState.key ?? buildBoonKey(boon));
  const groupKey = String(purchaseState.groupKey ?? "");
  const previousPurchaseCount = getBoonPurchasesThisTurn(state, boonIndex, boonKey);
  const previousGroupPurchaseCount = groupKey ? getBoonPurchasesThisTurn(state, boonIndex, groupKey) : 0;
  const previousTreasury = state.treasury;
  state.treasury -= boon.cost;
  state.boonPurchases = {
    ...(state.boonPurchases ?? {}),
    [boonKey]: previousPurchaseCount + 1,
    [String(boonIndex)]: previousPurchaseCount + 1
  };
  if (groupKey) state.boonPurchases[groupKey] = previousGroupPurchaseCount + 1;
  await updateFacilityVenture(facility, config, state);
  moduleLog("Boon purchase: funds reserved", {
    actor: actor.name,
    facility: facility.name,
    boon: boon.name,
    cost: boon.cost,
    treasuryBefore: previousTreasury,
    treasuryAfter: state.treasury,
    purchasedThisTurnBefore: previousPurchaseCount,
    purchasedThisTurnAfter: state.boonPurchases[boonKey],
    rewardUuid: boon.rewardUuid || null
  });

  let rewardName = null;
  if (boon.rewardUuid) {
    try {
      rewardName = await grantBoonReward(actor, facility, boon);
    } catch (error) {
      state.treasury = previousTreasury;
      if (previousPurchaseCount > 0) {
        state.boonPurchases[boonKey] = previousPurchaseCount;
        state.boonPurchases[String(boonIndex)] = previousPurchaseCount;
      } else {
        delete state.boonPurchases[boonKey];
        delete state.boonPurchases[String(boonIndex)];
      }
      if (groupKey) {
        if (previousGroupPurchaseCount > 0) state.boonPurchases[groupKey] = previousGroupPurchaseCount;
        else delete state.boonPurchases[groupKey];
      }
      await updateFacilityVenture(facility, config, state);
      ui.notifications.error(error.message);
      return;
    }
  }

  const notificationKey = rewardName
    ? "INDYVENTURES.Notifications.BoonPurchasedReward"
    : "INDYVENTURES.Notifications.BoonPurchased";
  ui.notifications.info(game.i18n.format(notificationKey, {
    boon: boon.name,
    venture: config.ventureName || facility.name,
    reward: rewardName
  }));

  if (summary) {
    summary.treasury = state.treasury;
    summary.lastTurnNet = turnNet;
    summary.boons = summary.boons.map((entry, index) => {
      return withBoonAvailability(entry, state, index, turnNet);
    });
    summary.hasPurchasableBoons = summary.boons.some(entry => entry.purchasable);
    await rerenderSummaryMessage(message, actorUuid, results);
  }
}

async function onClaimTreasury(message, button) {
  const facility = await fromUuid(button.dataset.facilityUuid);
  if (!facility || facility.documentName !== "Item") return;
  const actor = facility.actor;
  if (!canManageVenture(actor)) {
    ui.notifications.warn("INDYVENTURES.Errors.NotOwner", { localize: true });
    return;
  }

  const config = getFacilityConfig(facility);
  const state = getFacilityState(facility, config);
  if (!state.treasury) {
    ui.notifications.warn("INDYVENTURES.Errors.NoTreasury", { localize: true });
    return;
  }

  const maxClaim = state.treasury;
  const amount = await promptClaimAmount(maxClaim, config.ventureName || facility.name);
  if (amount === null) return;
  if (!Number.isFinite(amount) || (amount < 1) || (amount > maxClaim)) {
    ui.notifications.warn(game.i18n.format("INDYVENTURES.Errors.InvalidClaimAmount", { maxAmount: maxClaim }));
    return;
  }

  state.treasury = maxClaim - amount;
  await updateFacilityVenture(facility, config, state);
  await actor.update({ "system.currency.gp": getActorGp(actor) + amount });

  ui.notifications.info(game.i18n.format("INDYVENTURES.Notifications.ClaimedTreasury", {
    amount,
    venture: config.ventureName || facility.name,
    actor: actor.name
  }));

  const actorUuid = message.getFlag(MODULE_ID, "actorUuid");
  const results = foundry.utils.deepClone(message.getFlag(MODULE_ID, "results")) ?? [];
  const summary = results.find(r => r.facilityUuid === facility.uuid);
  if (summary) {
    const turnNet = Number(summary?.net ?? state.lastTurnNet ?? 0) || 0;
    summary.treasury = state.treasury;
    summary.boons = summary.boons.map((entry, index) => {
      return withBoonAvailability(entry, state, index, turnNet);
    });
    summary.hasPurchasableBoons = summary.boons.some(entry => entry.purchasable);
    await rerenderSummaryMessage(message, actorUuid, results);
  }
}

export function registerChatHooks() {
  Hooks.on("dnd5e.renderChatMessage", (message, html) => {
    const htmlRoot = resolveMessageHtmlRoot(html);
    if (!htmlRoot) return;
    appendBastionModifierSection(message, htmlRoot);

    const type = message.getFlag(MODULE_ID, "type");
    if (type !== "ventureSummary") return;

    htmlRoot.addEventListener("click", event => {
      const link = event.target.closest(".content-link[data-uuid]");
      if (link) {
        event.preventDefault();
        event.stopPropagation();
        const uuid = String(link.dataset.uuid ?? "").trim();
        if (!uuid) return;
        fromUuid(uuid).then(doc => doc?.sheet?.render(true));
        return;
      }

      const button = event.target.closest("button[data-action]");
      if (!button) return;
      event.preventDefault();
      if (button.dataset.action === "purchaseBoon") onPurchaseBoon(message, button);
      if (button.dataset.action === "claimTreasury") onClaimTreasury(message, button);
    });
  });
}
