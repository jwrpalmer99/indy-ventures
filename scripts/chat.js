import { MODULE_ID, SETTINGS, TEMPLATE_PATHS } from "./constants.js";
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
import {
  canManageFacilityVenture,
  canViewFacilityVenture,
  isSharedBastionActor,
  withFacilityVentureLock
} from "./shared-bastion.js";

const BASTION_DURATION_FLAG = `flags.${MODULE_ID}.bastionDuration`;
const BASTION_DURATION_CHANGE_PREFIX = `${BASTION_DURATION_FLAG}.`;
const BOON_REWARD_SOURCE_FLAG = `flags.${MODULE_ID}.boonRewardSource`;
const BOON_REWARD_TEMPLATE_ID_FLAG = `flags.${MODULE_ID}.boonRewardTemplateId`;
const SOCKET_NAMESPACE = `module.${MODULE_ID}`;
const pendingVentureActionRequests = new Map();
const pendingVentureRollRequests = new Map();
let ventureActionSocketRegistered = false;

function getRenderTemplate() {
  return foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
}

function resolveMessageHtmlRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (Array.isArray(html) && (html[0] instanceof HTMLElement)) return html[0];
  if (html?.jquery && (html[0] instanceof HTMLElement)) return html[0];
  return null;
}

function emitSocket(payload) {
  game.socket?.emit(SOCKET_NAMESPACE, payload);
}

function getPrimaryGmUser() {
  return game.users
    .filter(user => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

function isPrimaryGmUser(user = game.user) {
  const primaryGm = getPrimaryGmUser();
  return Boolean(user?.isGM && primaryGm && (primaryGm.id === user.id));
}

function clampTimeoutSeconds(value, fallbackSeconds = 180) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallbackSeconds;
  return Math.min(Math.max(parsed, 30), 600);
}

function getRollTimeoutMs() {
  const seconds = clampTimeoutSeconds(
    game.settings?.get(MODULE_ID, SETTINGS.rollPromptTimeoutSeconds),
    180
  );
  return seconds * 1000;
}

function getActionTimeoutMs() {
  return 60_000;
}

function formatMessage(key, data = {}) {
  return data && Object.keys(data).length
    ? game.i18n.format(key, data)
    : game.i18n.localize(key);
}

function actionResult(ok, level, key, data = {}, notify = true) {
  const message = key ? formatMessage(key, data) : "";
  if (notify && message) {
    const method = ui.notifications?.[level] ?? ui.notifications?.info;
    method?.call(ui.notifications, message);
  }
  return { ok, level, message };
}

function okResult(key, data = {}, notify = true) {
  return actionResult(true, "info", key, data, notify);
}

function warnResult(key, data = {}, notify = true) {
  return actionResult(false, "warn", key, data, notify);
}

function errorResult(message, notify = true) {
  if (notify && message) ui.notifications.error(message);
  return { ok: false, level: "error", message };
}

function resolveDocumentSync(uuid) {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  if (globalThis.fromUuidSync) {
    try {
      return fromUuidSync(value, { strict: false });
    } catch (error) {
      moduleLog("Unable to synchronously resolve document UUID", {
        uuid: value,
        error: String(error?.message ?? error)
      });
    }
  }
  if (value.startsWith("Actor.")) {
    const id = value.slice("Actor.".length).split(".")[0];
    return game.actors.get(id) ?? null;
  }
  if (value.startsWith("ChatMessage.")) {
    const id = value.slice("ChatMessage.".length).split(".")[0];
    return game.messages.get(id) ?? null;
  }
  return null;
}

async function resolveDocument(uuid, fallbackCollection = null) {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    const resolved = await fromUuid(value);
    if (resolved) return resolved;
  } catch (error) {
    moduleLog("Unable to resolve document UUID", {
      uuid: value,
      error: String(error?.message ?? error)
    });
  }
  const parts = value.split(".");
  return fallbackCollection?.get?.(parts[parts.length - 1]) ?? resolveDocumentSync(value);
}

async function withFacilityActionLock(facilityUuid, work) {
  return withFacilityVentureLock(facilityUuid, work);
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
        if (!modifierAppliesToFacility(modifier, facility, source)) continue;
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

function getBastionTurnData(message) {
  const legacyBastionData = message?.getFlag?.("dnd5e", "bastion");
  if (legacyBastionData && Array.isArray(legacyBastionData.orders)) {
    return legacyBastionData;
  }

  const messageType = String(message?.type ?? "").trim();
  const typedBastionData = message?.system;
  if ((messageType === "bastionTurn") && Array.isArray(typedBastionData?.orders)) {
    return typedBastionData;
  }

  return null;
}

function appendBastionModifierSection(message, html) {
  const bastionData = getBastionTurnData(message);
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

async function requestRollFromUser({
  targetUser,
  actor,
  facilityName,
  formula,
  rollLabel
}) {
  const requestId = foundry.utils.randomID();
  const timeoutMs = getRollTimeoutMs();
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingVentureRollRequests.delete(requestId);
      resolve({ timedOut: true, total: null, userId: targetUser.id });
    }, timeoutMs);

    pendingVentureRollRequests.set(requestId, { resolve, timeout });
    emitSocket({
      type: "ventureRollPrompt",
      requestId,
      targetUserId: targetUser.id,
      actorUuid: actor?.uuid ?? "",
      facilityName,
      formula,
      rollLabel
    });
  });
}

async function requestUserRoll({ formula, actor, facilityName, rollLabel, targetUser = game.user }) {
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

  const canDelegate = Boolean(
    game.user?.isGM
    && targetUser
    && targetUser.active
    && (targetUser.id !== game.user.id)
  );

  if (canDelegate) {
    const delegated = await requestRollFromUser({
      targetUser,
      actor,
      facilityName,
      formula,
      rollLabel
    });
    const total = Number(delegated?.total);
    if (Number.isFinite(total)) return { total };
  }

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

function canManageVenture(facility, user = game.user) {
  return canManageFacilityVenture(facility, user);
}

function resolveActorUuidSync(uuid) {
  const actorUuid = String(uuid ?? "").trim();
  if (!actorUuid) return null;
  if (actorUuid.startsWith("Actor.")) {
    const id = actorUuid.slice("Actor.".length).split(".")[0];
    return game.actors.get(id) ?? null;
  }
  if (globalThis.fromUuidSync) {
    try {
      return fromUuidSync(actorUuid, { strict: false });
    } catch (error) {
      moduleLog("Unable to synchronously resolve actor UUID", {
        uuid: actorUuid,
        error: String(error?.message ?? error)
      });
    }
  }
  return null;
}

function getMessageActorSync(message) {
  const actor = message.getAssociatedActor?.() ?? null;
  if (actor) return actor;
  const actorUuid = message.getFlag?.(MODULE_ID, "actorUuid") ?? "";
  return resolveActorUuidSync(actorUuid) ?? game.actors.get(message.speaker?.actor) ?? null;
}

function applyVentureSummaryPermissions(message, htmlRoot) {
  const actor = getMessageActorSync(message);
  if (!actor) return;

  const card = htmlRoot.querySelector(".indy-ventures-card");
  if (!card) return;

  const rows = Array.from(card.querySelectorAll(".indy-venture-row"));
  let visibleRows = 0;
  const readOnlyTooltip = game.i18n.localize("INDYVENTURES.SharedBastion.ReadOnlyTooltip");

  for (const row of rows) {
    const facility = resolveDocumentSync(row.dataset.facilityUuid)
      ?? actor.items?.get?.(row.dataset.facilityId);
    if (!facility || !canViewFacilityVenture(facility, game.user, "LIMITED")) {
      row.remove();
      continue;
    }

    visibleRows += 1;
    const canManage = canManageVenture(facility);
    if (row instanceof HTMLDetailsElement) row.open = canManage;
    if (canManage) continue;
    for (const button of row.querySelectorAll('button[data-action="claimTreasury"], button[data-action="purchaseBoon"]')) {
      button.disabled = true;
      button.classList.add("indy-venture-readonly-action");
      button.dataset.tooltip = readOnlyTooltip;
    }
  }

  if (!visibleRows) {
    card.innerHTML = `<p class="hint">${game.i18n.localize("INDYVENTURES.SharedBastion.NoViewPermission")}</p>`;
  }
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

function buildSummaryBoons(config, state, turnNet) {
  const boons = parseBoonsFromConfig(config);
  const groupLimitMap = buildGroupLimitMap(boons);
  const groupPurchaseCountMap = buildGroupPurchaseCountMap(boons, state);
  return boons.map((boon, index) => withBoonAvailability(
    boon,
    state,
    index,
    turnNet,
    groupLimitMap,
    groupPurchaseCountMap
  ));
}

function extractPurchaseMapFromSummary(state, boons, summaryBoons = []) {
  const extracted = {};
  if (Array.isArray(summaryBoons) && summaryBoons.length) {
    const byKey = new Map();
    for (const entry of summaryBoons) {
      const key = String(entry?.key ?? "").trim();
      if (!key) continue;
      byKey.set(key, Math.max(Number(entry?.purchasedThisTurn ?? 0) || 0, 0));
    }
    for (let index = 0; index < boons.length; index += 1) {
      const boon = boons[index];
      const boonKey = buildBoonKey(boon);
      const byKeyCount = byKey.get(boonKey);
      const byIndexCount = Math.max(Number(summaryBoons[index]?.purchasedThisTurn ?? 0) || 0, 0);
      const count = Math.max(byKeyCount ?? 0, byIndexCount);
      if (count > 0) extracted[String(index)] = count;
    }
    return extracted;
  }

  // Fallback when summary rows are unavailable.
  for (let index = 0; index < boons.length; index += 1) {
    const boon = boons[index];
    const boonKey = buildBoonKey(boon);
    const count = getBoonPurchasesThisTurn(state, index, boonKey);
    if (count > 0) extracted[String(index)] = count;
  }
  return extracted;
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

function withBoonAvailability(
  boon,
  state,
  boonIndex,
  turnNet = null,
  groupLimitMap = null,
  groupPurchaseCountMap = null
) {
  const reward = resolveRewardDisplayFromBoon(boon);
  const boonKey = String(boon?.key ?? buildBoonKey(boon));
  const group = String(boon?.group ?? "").trim();
  const groupKey = String(boon?.groupKey ?? buildBoonGroupKey(boon));
  const baseGroupPerTurnLimit = parseBoonPerTurnLimit(boon?.groupPerTurnLimit, null);
  const mappedGroupPerTurnLimit = groupKey && (groupLimitMap instanceof Map) ? groupLimitMap.get(groupKey) : undefined;
  const groupPerTurnLimit = (mappedGroupPerTurnLimit === undefined) ? baseGroupPerTurnLimit : mappedGroupPerTurnLimit;
  const perTurnLimit = parseBoonPerTurnLimit(boon?.perTurnLimit, 1);
  const purchaseWhen = parseBoonPurchaseWhen(boon?.purchaseWhen, "default");
  const purchasedThisTurn = getBoonPurchasesThisTurn(state, boonIndex, boonKey);
  const purchasedInGroupThisTurn = groupKey
    ? Math.max(Number(groupPurchaseCountMap instanceof Map ? groupPurchaseCountMap.get(groupKey) : 0) || 0, 0)
    : 0;
  const affordable = state.treasury >= boon.cost;
  const underTurnLimit = (perTurnLimit === null) || (purchasedThisTurn < perTurnLimit);
  const underGroupTurnLimit = !groupKey || (groupPerTurnLimit === null) || (purchasedInGroupThisTurn < groupPerTurnLimit);
  const net = Number(turnNet ?? state?.lastTurnNet ?? 0) || 0;
  const purchaseWhenAllowed = boonPurchaseWhenAllows(purchaseWhen, net);
  const blockedByGroupLimit = !underGroupTurnLimit;
  const blockedByWindow = !purchaseWhenAllowed;
  const purchasable = affordable && underTurnLimit && underGroupTurnLimit && purchaseWhenAllowed;
  const purchaseWhenLabel = getBoonPurchaseWhenLabel(purchaseWhen);
  const disabledReason = getBoonDisabledReason({
    purchasable,
    blockedByWindow,
    blockedByGroupLimit,
    affordable,
    purchaseWhenLabel,
    group,
    groupPerTurnLimit,
    purchasedInGroupThisTurn,
    perTurnLimit,
    purchasedThisTurn
  });
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
    purchaseWhenLabel,
    blockedByGroupLimit,
    blockedByWindow,
    rewardName: reward.rewardName,
    rewardImg: reward.rewardImg,
    purchasedThisTurn,
    remainingPurchases: perTurnLimit === null ? null : Math.max(perTurnLimit - purchasedThisTurn, 0),
    affordable,
    purchasable,
    disabledReason
  };
}

function cloneDocumentSource(document) {
  const source = document.toObject();
  delete source._id;
  return source;
}

function setItemRewardQuantity(itemData, quantity = 1) {
  const count = Math.max(Number.parseInt(quantity, 10) || 1, 1);
  if (count <= 1) return itemData;
  const current = Math.max(Number.parseInt(foundry.utils.getProperty(itemData, "system.quantity"), 10) || 1, 1);
  foundry.utils.setProperty(itemData, "system.quantity", current * count);
  return itemData;
}

async function prepareItemRewardData(itemData, facility, actor, boon, rewardDoc, requestingUser = game.user, options = {}) {
  setItemRewardQuantity(itemData, options.quantity);
  applyBoonRewardIdentity(itemData, boon, rewardDoc);
  for (const effectData of Array.isArray(itemData.effects) ? itemData.effects : []) {
    const duration = await prepareBastionDurationRewardData(effectData, facility, actor, requestingUser, options);
    if (duration?.remainingTurns !== null) foundry.utils.setProperty(itemData, BASTION_DURATION_FLAG, duration);
  }
  return itemData;
}

function getBoonRewardSourceKey(boon, rewardDoc) {
  const rewardUuid = String(boon?.rewardUuid ?? rewardDoc?.uuid ?? "").trim();
  if (rewardUuid) return rewardUuid;
  const rewardId = String(rewardDoc?.id ?? "").trim();
  return rewardId ? `id:${rewardId}` : "";
}

function applyBoonRewardIdentity(effectData, boon, rewardDoc) {
  const sourceKey = getBoonRewardSourceKey(boon, rewardDoc);
  if (sourceKey) foundry.utils.setProperty(effectData, BOON_REWARD_SOURCE_FLAG, sourceKey);

  const templateId = String(rewardDoc?.id ?? "").trim();
  if (templateId) foundry.utils.setProperty(effectData, BOON_REWARD_TEMPLATE_ID_FLAG, templateId);

  const sourceUuid = String(rewardDoc?.uuid ?? "").trim();
  if (sourceUuid) foundry.utils.setProperty(effectData, "flags.core.sourceId", sourceUuid);

  return { sourceKey, templateId, sourceUuid };
}

function findMatchingBoonRewardEffects(targetDocument, identity) {
  const sourceKey = String(identity?.sourceKey ?? "").trim();
  const templateId = String(identity?.templateId ?? "").trim();
  const sourceUuid = String(identity?.sourceUuid ?? "").trim();
  const matches = [];

  for (const effect of targetDocument?.effects ?? []) {
    if (!effect) continue;
    if (effect.getFlag(MODULE_ID, "ventureModifierTemplate") === true) continue;

    const effectSourceKey = String(effect.getFlag(MODULE_ID, "boonRewardSource") ?? "").trim();
    if (sourceKey && effectSourceKey && (effectSourceKey === sourceKey)) {
      matches.push(effect);
      continue;
    }

    const effectTemplateId = String(effect.getFlag(MODULE_ID, "boonRewardTemplateId") ?? "").trim();
    if (templateId && effectTemplateId && (effectTemplateId === templateId)) {
      matches.push(effect);
      continue;
    }

    const coreSourceId = String(foundry.utils.getProperty(effect, "flags.core.sourceId") ?? "").trim();
    if (sourceUuid && coreSourceId && (coreSourceId === sourceUuid)) {
      matches.push(effect);
      continue;
    }
  }

  return matches;
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

function stripEffectChanges(effectData, prefix) {
  const existingChanges = Array.isArray(effectData.changes) ? effectData.changes : [];
  effectData.changes = existingChanges.filter(change => !String(change?.key ?? "").startsWith(prefix));
}

function stripBastionDurationData(effectData) {
  delete effectData.flags?.[MODULE_ID]?.bastionDuration;
  stripEffectChanges(effectData, BASTION_DURATION_CHANGE_PREFIX);
}

function stripVentureModifierData(effectData) {
  delete effectData.flags?.[MODULE_ID]?.ventureModifier;
  delete effectData.flags?.[MODULE_ID]?.ventureModifierTemplate;
  stripEffectChanges(effectData, `flags.${MODULE_ID}.ventureModifier.`);
}

async function prepareBastionDurationRewardData(effectData, facility, actor, requestingUser = game.user, { rollDurationFormula = true } = {}) {
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
    if (!rollDurationFormula) {
      stripBastionDurationData(effectData);
      return null;
    }
    let durationRoll;
    try {
      durationRoll = await requestUserRoll({
        formula: duration.durationFormula,
        actor,
        facilityName: facility.name,
        rollLabel: game.i18n.localize("INDYVENTURES.RollPrompt.Duration"),
        targetUser: requestingUser
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

  if (duration.remainingTurns === null) {
    stripBastionDurationData(effectData);
    return null;
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

async function prepareActiveEffectRewardData(effectData, facility, actor, requestingUser = game.user, options = {}) {
  await prepareBastionDurationRewardData(effectData, facility, actor, requestingUser, options);

  const modifierPath = `flags.${MODULE_ID}.ventureModifier`;
  if (options.allowVentureModifier === false) {
    stripVentureModifierData(effectData);
    return effectData;
  }
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
        rollLabel: game.i18n.localize("INDYVENTURES.RollPrompt.Duration"),
        targetUser: requestingUser
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

export async function grantBoonReward(actor, facility, boon, requestingUser = game.user, options = {}) {
  if (!boon.rewardUuid) return null;

  const rewardDoc = await fromUuid(boon.rewardUuid);
  if (!rewardDoc) {
    throw new Error(game.i18n.format("INDYVENTURES.Errors.BoonRewardMissing", {
      reward: boon.rewardLabel || boon.rewardUuid
    }));
  }

  if (rewardDoc.documentName === "Item") {
    const itemData = await prepareItemRewardData(cloneDocumentSource(rewardDoc), facility, actor, boon, rewardDoc, requestingUser, options);
    await actor.createEmbeddedDocuments("Item", [itemData]);
    moduleLog("Boon reward granted: item", {
      actor: actor.name,
      facility: facility.name,
      rewardUuid: boon.rewardUuid,
      reward: rewardDoc.name,
      quantity: Math.max(Number.parseInt(options.quantity, 10) || 1, 1)
    });
    return rewardDoc.name;
  }

  if (rewardDoc.documentName === "ActiveEffect") {
    const effectData = await prepareActiveEffectRewardData(cloneDocumentSource(rewardDoc), facility, actor, requestingUser, options);
    const hasVentureModifier = foundry.utils.hasProperty(effectData, `flags.${MODULE_ID}.ventureModifier`);
    const targetDocument = hasVentureModifier && facility?.createEmbeddedDocuments
      ? facility
      : actor;
    const identity = applyBoonRewardIdentity(effectData, boon, rewardDoc);
    const existing = findMatchingBoonRewardEffects(targetDocument, identity);
    let createdEffect = null;

    if (existing.length && targetDocument.updateEmbeddedDocuments) {
      const [primary, ...duplicates] = existing;
      effectData._id = primary.id;
      const updated = await targetDocument.updateEmbeddedDocuments("ActiveEffect", [effectData]);
      createdEffect = updated?.[0] ?? targetDocument.effects?.get?.(primary.id) ?? primary;
      if (duplicates.length && targetDocument.deleteEmbeddedDocuments) {
        const duplicateIds = duplicates.map(effect => effect.id).filter(Boolean);
        if (duplicateIds.length) {
          await targetDocument.deleteEmbeddedDocuments("ActiveEffect", duplicateIds);
        }
      }
      moduleLog("Boon reward granted: active effect replaced existing", {
        actor: actor.name,
        facility: facility.name,
        target: targetDocument?.documentName ?? "Actor",
        rewardUuid: boon.rewardUuid,
        sourceEffect: rewardDoc.name,
        replacedEffectId: primary.id,
        removedDuplicateCount: Math.max(existing.length - 1, 0)
      });
    } else {
      if (identity.templateId && !targetDocument.effects?.get?.(identity.templateId)) {
        effectData._id = identity.templateId;
      }
      const created = await targetDocument.createEmbeddedDocuments("ActiveEffect", [effectData]);
      createdEffect = created?.[0];
    }

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

function shouldDelegateSharedVentureAction(facility) {
  if (!isSharedBastionActor(facility?.actor)) return false;
  const primaryGm = getPrimaryGmUser();
  if (!primaryGm) return !game.user?.isGM;
  return primaryGm.id !== game.user.id;
}

async function requestSharedVentureAction({
  action,
  message,
  facilityUuid,
  buttonData = {},
  amount = null
}) {
  const primaryGm = getPrimaryGmUser();
  if (!primaryGm) {
    return warnResult("INDYVENTURES.SharedBastion.GMUnavailable");
  }

  const requestId = foundry.utils.randomID();
  const response = await new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingVentureActionRequests.delete(requestId);
      resolve({ ok: false, timedOut: true });
    }, getActionTimeoutMs());

    pendingVentureActionRequests.set(requestId, { resolve, timeout });
    emitSocket({
      type: "ventureActionRequest",
      requestId,
      gmUserId: primaryGm.id,
      userId: game.user.id,
      action,
      messageUuid: message.uuid,
      messageId: message.id,
      facilityUuid,
      buttonData,
      amount
    });
  });

  if (response?.timedOut) {
    return warnResult("INDYVENTURES.SharedBastion.ActionTimedOut");
  }
  if (response?.message) {
    const level = response.level ?? (response.ok ? "info" : "warn");
    const method = ui.notifications?.[level] ?? ui.notifications?.info;
    method?.call(ui.notifications, response.message);
  } else if (!response?.ok) {
    warnResult("INDYVENTURES.SharedBastion.ActionFailed");
  }
  return response;
}

async function executePurchaseBoon({
  message,
  buttonData,
  requestingUser = game.user,
  notify = true
}) {
  const facilityUuid = String(buttonData?.facilityUuid ?? "").trim();
  if (!facilityUuid) return errorResult(formatMessage("INDYVENTURES.SharedBastion.ActionFailed"), notify);

  return withFacilityActionLock(facilityUuid, async () => {
    const facility = await fromUuid(facilityUuid);
    if (!facility || facility.documentName !== "Item") {
      return errorResult(formatMessage("INDYVENTURES.SharedBastion.ActionFailed"), notify);
    }
    const actor = facility.actor;
    if (!canManageVenture(facility, requestingUser)) {
      return warnResult("INDYVENTURES.SharedBastion.NoManagePermission", {}, notify);
    }

    const requestedIndex = Number(buttonData.boonIndex);
    if (!Number.isFinite(requestedIndex)) {
      return warnResult("INDYVENTURES.Errors.StaleVentureSummary", {}, notify);
    }
    const requestedKey = String(buttonData.boonKey ?? "").trim();

    const config = getFacilityConfig(facility);
    const state = getFacilityState(facility, config);
    const boons = parseBoonsFromConfig(config);
    const groupLimitMap = buildGroupLimitMap(boons);
    const resolved = resolveBoonByIndexOrKey(boons, requestedIndex, requestedKey);
    const boonIndex = resolved.index;
    const boon = resolved.boon;
    if (!boon) {
      moduleLog("Boon purchase blocked: boon entry no longer matches chat summary", {
        actor: actor.name,
        facility: facility.name,
        requestedIndex,
        requestedKey,
        requestingUser: requestingUser?.name ?? null
      });
      return warnResult("INDYVENTURES.Errors.StaleVentureSummary", {}, notify);
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
      state.boonPurchasesTurnId = turnId;
      state.boonPurchases = {};
    } else if (turnId && state.turnId && (state.turnId !== turnId)) {
      return warnResult("INDYVENTURES.Errors.StaleVentureSummary", {}, notify);
    } else if (state.turnId && (state.boonPurchasesTurnId !== state.turnId)) {
      state.boonPurchasesTurnId = state.turnId;
      state.boonPurchases = {};
    }
    const normalizedPurchases = extractPurchaseMapFromSummary(state, boons, summary?.boons ?? []);
    const purchasesChanged = JSON.stringify(state.boonPurchases ?? {}) !== JSON.stringify(normalizedPurchases);
    state.boonPurchases = normalizedPurchases;
    state.boonPurchasesTurnId = state.turnId || turnId || state.boonPurchasesTurnId || "";
    if (purchasesChanged) {
      await updateFacilityVenture(facility, config, state);
    }
    const groupPurchaseCountMap = buildGroupPurchaseCountMap(boons, state);
    const effectivePurchaseState = withBoonAvailability(
      boon,
      state,
      boonIndex,
      turnNet,
      groupLimitMap,
      groupPurchaseCountMap
    );
    if (!effectivePurchaseState.purchasable) {
      const key = effectivePurchaseState.blockedByWindow
        ? "INDYVENTURES.Errors.BoonPurchaseWindowBlocked"
        : (effectivePurchaseState.blockedByGroupLimit
            ? "INDYVENTURES.Errors.BoonGroupTurnLimitReached"
            : (effectivePurchaseState.affordable ? "INDYVENTURES.Errors.BoonTurnLimitReached" : "INDYVENTURES.Errors.NotEnoughTreasury"));
      moduleLog("Boon purchase blocked", {
        actor: actor.name,
        facility: facility.name,
        boon: boon.name,
        boonIndex,
        requestedIndex,
        requestedKey,
        stateTurnId: state.turnId,
        messageTurnId: turnId,
        affordable: effectivePurchaseState.affordable,
        purchasedThisTurn: effectivePurchaseState.purchasedThisTurn,
        perTurnLimit: effectivePurchaseState.perTurnLimit,
        group: effectivePurchaseState.group,
        groupPerTurnLimit: effectivePurchaseState.groupPerTurnLimit,
        purchasedInGroupThisTurn: effectivePurchaseState.purchasedInGroupThisTurn,
        boonPurchasesTurnId: state.boonPurchasesTurnId,
        boonPurchases: foundry.utils.deepClone(state.boonPurchases ?? {}),
        purchaseWhen: effectivePurchaseState.purchaseWhen,
        purchaseWhenAllowed: effectivePurchaseState.purchaseWhenAllowed
      });
      if (summary) {
        summary.treasury = state.treasury;
        summary.lastTurnNet = turnNet;
        summary.boons = buildSummaryBoons(config, state, turnNet);
        summary.hasPurchasableBoons = summary.boons.some(entry => entry.purchasable);
        await rerenderSummaryMessage(message, actorUuid, results);
      }
      return warnResult(key, {
        boon: boon.name,
        limit: effectivePurchaseState.blockedByGroupLimit
          ? (effectivePurchaseState.groupPerTurnLimit ?? game.i18n.localize("INDYVENTURES.Chat.Unlimited"))
          : (effectivePurchaseState.perTurnLimit ?? game.i18n.localize("INDYVENTURES.Chat.Unlimited")),
        purchased: effectivePurchaseState.blockedByGroupLimit
          ? effectivePurchaseState.purchasedInGroupThisTurn
          : effectivePurchaseState.purchasedThisTurn,
        mode: effectivePurchaseState.purchaseWhenLabel,
        group: effectivePurchaseState.group || "-"
      }, notify);
    }

    const boonKey = String(effectivePurchaseState.key ?? buildBoonKey(boon));
    const previousPurchaseCount = getBoonPurchasesThisTurn(state, boonIndex, boonKey);
    const previousTreasury = state.treasury;
    state.treasury -= boon.cost;
    state.boonPurchases = {
      ...(state.boonPurchases ?? {}),
      [String(boonIndex)]: previousPurchaseCount + 1
    };
    state.boonPurchasesTurnId = state.turnId || turnId || state.boonPurchasesTurnId || "";
    await updateFacilityVenture(facility, config, state);
    moduleLog("Boon purchase: funds reserved", {
      actor: actor.name,
      facility: facility.name,
      boon: boon.name,
      cost: boon.cost,
      treasuryBefore: previousTreasury,
      treasuryAfter: state.treasury,
      purchasedThisTurnBefore: previousPurchaseCount,
      purchasedThisTurnAfter: getBoonPurchasesThisTurn(state, boonIndex, boonKey),
      rewardUuid: boon.rewardUuid || null,
      requestingUser: requestingUser?.name ?? null
    });

    let rewardName = null;
    if (boon.rewardUuid) {
      try {
        rewardName = await grantBoonReward(actor, facility, boon, requestingUser);
      } catch (error) {
        state.treasury = previousTreasury;
        if (previousPurchaseCount > 0) {
          state.boonPurchases[String(boonIndex)] = previousPurchaseCount;
        } else {
          delete state.boonPurchases[String(boonIndex)];
        }
        await updateFacilityVenture(facility, config, state);
        return errorResult(error.message, notify);
      }
    }

    if (summary) {
      summary.treasury = state.treasury;
      summary.lastTurnNet = turnNet;
      summary.boons = buildSummaryBoons(config, state, turnNet);
      summary.hasPurchasableBoons = summary.boons.some(entry => entry.purchasable);
      await rerenderSummaryMessage(message, actorUuid, results);
    }

    const notificationKey = rewardName
      ? "INDYVENTURES.Notifications.BoonPurchasedReward"
      : "INDYVENTURES.Notifications.BoonPurchased";
    return okResult(notificationKey, {
      boon: boon.name,
      venture: config.ventureName || facility.name,
      reward: rewardName
    }, notify);
  });
}

async function executeClaimTreasury({
  message,
  facilityUuid,
  amount,
  requestingUser = game.user,
  notify = true
}) {
  const resolvedFacilityUuid = String(facilityUuid ?? "").trim();
  if (!resolvedFacilityUuid) return errorResult(formatMessage("INDYVENTURES.SharedBastion.ActionFailed"), notify);

  return withFacilityActionLock(resolvedFacilityUuid, async () => {
    const facility = await fromUuid(resolvedFacilityUuid);
    if (!facility || facility.documentName !== "Item") {
      return errorResult(formatMessage("INDYVENTURES.SharedBastion.ActionFailed"), notify);
    }
    const actor = facility.actor;
    if (!canManageVenture(facility, requestingUser)) {
      return warnResult("INDYVENTURES.SharedBastion.NoManagePermission", {}, notify);
    }

    const config = getFacilityConfig(facility);
    const state = getFacilityState(facility, config);
    if (!state.treasury) {
      return warnResult("INDYVENTURES.Errors.NoTreasury", {}, notify);
    }

    const maxClaim = state.treasury;
    const claimAmount = Number.parseInt(amount, 10);
    if (!Number.isFinite(claimAmount) || (claimAmount < 1) || (claimAmount > maxClaim)) {
      return warnResult("INDYVENTURES.Errors.InvalidClaimAmount", { maxAmount: maxClaim }, notify);
    }

    state.treasury = maxClaim - claimAmount;
    await updateFacilityVenture(facility, config, state);
    await actor.update({ "system.currency.gp": getActorGp(actor) + claimAmount });

    const actorUuid = message.getFlag(MODULE_ID, "actorUuid");
    const results = foundry.utils.deepClone(message.getFlag(MODULE_ID, "results")) ?? [];
    const summary = results.find(r => r.facilityUuid === facility.uuid);
    if (summary) {
      const turnNet = Number(summary?.net ?? state.lastTurnNet ?? 0) || 0;
      summary.treasury = state.treasury;
      summary.boons = buildSummaryBoons(config, state, turnNet);
      summary.hasPurchasableBoons = summary.boons.some(entry => entry.purchasable);
      await rerenderSummaryMessage(message, actorUuid, results);
    }

    return okResult("INDYVENTURES.Notifications.ClaimedTreasury", {
      amount: claimAmount,
      venture: config.ventureName || facility.name,
      actor: actor.name
    }, notify);
  });
}

async function onPurchaseBoon(message, button) {
  const buttonData = foundry.utils.deepClone(button?.dataset ?? {});
  const facilityUuid = String(buttonData.facilityUuid ?? "").trim();
  if (!facilityUuid) return;

  const facility = await fromUuid(facilityUuid);
  if (!facility || facility.documentName !== "Item") return;
  if (!canManageVenture(facility)) {
    warnResult("INDYVENTURES.SharedBastion.NoManagePermission");
    return;
  }

  if (shouldDelegateSharedVentureAction(facility)) {
    await requestSharedVentureAction({
      action: "purchaseBoon",
      message,
      facilityUuid,
      buttonData
    });
    return;
  }

  await executePurchaseBoon({ message, buttonData });
}

async function onClaimTreasury(message, button) {
  const facilityUuid = String(button.dataset.facilityUuid ?? "").trim();
  const facility = await fromUuid(facilityUuid);
  if (!facility || facility.documentName !== "Item") return;
  if (!canManageVenture(facility)) {
    warnResult("INDYVENTURES.SharedBastion.NoManagePermission");
    return;
  }

  const config = getFacilityConfig(facility);
  const state = getFacilityState(facility, config);
  if (!state.treasury) {
    warnResult("INDYVENTURES.Errors.NoTreasury");
    return;
  }

  const maxClaim = state.treasury;
  const amount = await promptClaimAmount(maxClaim, config.ventureName || facility.name);
  if (amount === null) return;

  if (shouldDelegateSharedVentureAction(facility)) {
    await requestSharedVentureAction({
      action: "claimTreasury",
      message,
      facilityUuid,
      amount
    });
    return;
  }

  await executeClaimTreasury({
    message,
    facilityUuid,
    amount
  });
}

function onToggleBoonDetails(button) {
  const boonRow = button.closest(".indy-venture-boon");
  if (!boonRow) return;
  const nowCollapsed = boonRow.classList.toggle("is-collapsed");
  const isExpanded = !nowCollapsed;
  button.setAttribute("aria-expanded", String(isExpanded));
  const tooltipKey = nowCollapsed
    ? "INDYVENTURES.Chat.ExpandBoonDetails"
    : "INDYVENTURES.Chat.CollapseBoonDetails";
  const tooltip = game.i18n.localize(tooltipKey);
  button.setAttribute("aria-label", tooltip);
  button.dataset.tooltip = tooltip;
}

async function onVentureActionRequest(payload) {
  if (!game.user?.isGM) return;
  if (payload.gmUserId !== game.user.id) return;
  if (!isPrimaryGmUser()) return;

  const requestUser = game.users.get(payload.userId);
  let result = null;
  try {
    const message = await resolveDocument(payload.messageUuid || payload.messageId, game.messages);
    const facility = await resolveDocument(payload.facilityUuid);
    if (!requestUser || !message || !facility || (facility.documentName !== "Item")) {
      result = errorResult(formatMessage("INDYVENTURES.SharedBastion.ActionFailed"), false);
    } else if (!canManageVenture(facility, requestUser)) {
      result = warnResult("INDYVENTURES.SharedBastion.NoManagePermission", {}, false);
    } else if (payload.action === "purchaseBoon") {
      const buttonData = foundry.utils.deepClone(payload.buttonData ?? {});
      buttonData.facilityUuid = facility.uuid;
      result = await executePurchaseBoon({
        message,
        buttonData,
        requestingUser: requestUser,
        notify: false
      });
    } else if (payload.action === "claimTreasury") {
      result = await executeClaimTreasury({
        message,
        facilityUuid: facility.uuid,
        amount: payload.amount,
        requestingUser: requestUser,
        notify: false
      });
    } else {
      result = errorResult(formatMessage("INDYVENTURES.SharedBastion.ActionFailed"), false);
    }
  } catch (error) {
    moduleLog("Shared venture action request failed", {
      action: payload.action,
      requestId: payload.requestId,
      userId: payload.userId,
      error: String(error?.message ?? error)
    });
    result = errorResult(String(error?.message ?? error), false);
  }

  emitSocket({
    type: "ventureActionResponse",
    requestId: payload.requestId,
    targetUserId: payload.userId,
    ok: Boolean(result?.ok),
    level: result?.level ?? (result?.ok ? "info" : "warn"),
    message: result?.message ?? ""
  });
}

function onVentureActionResponse(payload) {
  if (payload.targetUserId !== game.user.id) return;
  const pending = pendingVentureActionRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.resolve({
    ok: Boolean(payload.ok),
    level: payload.level,
    message: payload.message,
    timedOut: false
  });
  pendingVentureActionRequests.delete(payload.requestId);
}

async function onVentureRollPrompt(payload) {
  if (payload.targetUserId !== game.user.id) return;

  const actor = payload.actorUuid
    ? await resolveDocument(payload.actorUuid, game.actors)
    : null;
  let total = null;
  try {
    const roll = await requestUserRoll({
      formula: payload.formula,
      actor,
      facilityName: payload.facilityName,
      rollLabel: payload.rollLabel,
      targetUser: game.user
    });
    const parsed = Number(roll?.total);
    total = Number.isFinite(parsed) ? parsed : null;
  } catch (error) {
    moduleLog("Shared venture roll prompt failed", {
      user: game.user.name,
      formula: payload.formula,
      rollLabel: payload.rollLabel,
      error: String(error?.message ?? error)
    });
  }

  emitSocket({
    type: "ventureRollResponse",
    requestId: payload.requestId,
    userId: game.user.id,
    total
  });
}

function onVentureRollResponse(payload) {
  const pending = pendingVentureRollRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.resolve({
    total: payload.total,
    userId: payload.userId,
    timedOut: false
  });
  pendingVentureRollRequests.delete(payload.requestId);
}

function registerVentureActionSocket() {
  if (ventureActionSocketRegistered || !game.socket) return;
  ventureActionSocketRegistered = true;
  game.socket.on(SOCKET_NAMESPACE, async payload => {
    if (!payload || (typeof payload !== "object")) return;
    if (payload.type === "ventureActionRequest") await onVentureActionRequest(payload);
    else if (payload.type === "ventureActionResponse") onVentureActionResponse(payload);
    else if (payload.type === "ventureRollPrompt") await onVentureRollPrompt(payload);
    else if (payload.type === "ventureRollResponse") onVentureRollResponse(payload);
  });
}

export function registerChatHooks() {
  Hooks.once("ready", registerVentureActionSocket);

  Hooks.on("dnd5e.renderChatMessage", (message, html) => {
    const htmlRoot = resolveMessageHtmlRoot(html);
    if (!htmlRoot) return;
    appendBastionModifierSection(message, htmlRoot);

    const type = message.getFlag(MODULE_ID, "type");
    if (type !== "ventureSummary") return;
    applyVentureSummaryPermissions(message, htmlRoot);
    if (htmlRoot.dataset.indyVenturesBound === "1") return;
    htmlRoot.dataset.indyVenturesBound = "1";

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
      if (button.dataset.action === "toggleBoonDetails") {
        onToggleBoonDetails(button);
        return;
      }
      if (button.dataset.action === "purchaseBoon") onPurchaseBoon(message, button);
      if (button.dataset.action === "claimTreasury") onClaimTreasury(message, button);
    });
  });
}
