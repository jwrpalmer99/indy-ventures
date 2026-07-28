import { MODULE_ID } from "./constants.js";
import { grantBoonReward } from "./chat.js";
import { canManageActorVentures, isIndyVentureFacility, isSharedBastionActor, isSharedBastionSheetInEditMode, withFacilityVentureLock } from "./shared-bastion.js";
import { activeBoonStarts, asInt, assignedBoonHirelings, boonClaimCount, buildBoonLine, limit, parseBoons, rewardReferenceText, spendCurrencyGp } from "./standard-boons-data.js";
import { getActorGp, resolveRewardDocumentSync } from "./utils.js";

const FLAG = "standardBoons";
const SOCKET_NAMESPACE = `module.${MODULE_ID}`;
const pendingStandardBoonActionRequests = new Map();
let standardBoonSocketRegistered = false;

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

function getPrimaryGmUser() {
  return game.users
    .filter(user => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

function shouldDelegateSharedBoonAction(facility) {
  if (!isSharedBastionActor(facility?.actor)) return false;
  const primaryGm = getPrimaryGmUser();
  if (!primaryGm) return !game.user?.isGM;
  return primaryGm.id !== game.user.id;
}

async function requestSharedBoonAction(action, facility, buttonData = {}) {
  const primaryGm = getPrimaryGmUser();
  if (!primaryGm) return actionResult(false, "warn", "INDYVENTURES.SharedBastion.GMUnavailable");

  const requestId = foundry.utils.randomID();
  const response = await new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingStandardBoonActionRequests.delete(requestId);
      resolve({ ok: false, timedOut: true });
    }, 60_000);

    pendingStandardBoonActionRequests.set(requestId, { resolve, timeout });
    game.socket?.emit(SOCKET_NAMESPACE, {
      type: "standardBoonActionRequest",
      requestId,
      gmUserId: primaryGm.id,
      userId: game.user.id,
      action,
      facilityUuid: facility.uuid,
      buttonData
    });
  });

  if (response?.timedOut) return actionResult(false, "warn", "INDYVENTURES.SharedBastion.ActionTimedOut");
  if (response?.message) {
    const level = response.level ?? (response.ok ? "info" : "warn");
    const method = ui.notifications?.[level] ?? ui.notifications?.info;
    method?.call(ui.notifications, response.message);
  }
  return response;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function resolveHtmlRoot(sheet, html) {
  if (html instanceof HTMLElement) return html;
  if (Array.isArray(html) && (html[0] instanceof HTMLElement)) return html[0];
  if (html?.jquery && (html[0] instanceof HTMLElement)) return html[0];
  if (sheet?.element instanceof HTMLElement) return sheet.element;
  return null;
}

function resolveDroppedUuid(data) {
  if (data?.uuid) return data.uuid;
  const id = data?.id ?? data?._id;
  if (data?.pack && id) return `Compendium.${data.pack}.${id}`;
  return "";
}

function buildUuidLink(data) {
  const uuid = resolveDroppedUuid(data);
  if (!uuid) return "";
  const label = String(data?.name ?? data?.data?.name ?? uuid).replace(/[{}]/g, "").trim() || uuid;
  return `@UUID[${uuid}]{${label}}`;
}

function serializeBoonRows(root) {
  return Array.from(root.querySelectorAll("[data-standard-boon-row]"))
    .map(row => buildBoonLine({
      name: row.querySelector("[data-standard-boon-name]")?.value,
      turns: row.querySelector("[data-standard-boon-turns]")?.value,
      costGp: row.querySelector("[data-standard-boon-cost]")?.value,
      rewardGp: row.querySelector("[data-standard-boon-gold-reward]")?.value,
      description: row.querySelector("[data-standard-boon-description]")?.value,
      reward: row.querySelector("[data-standard-boon-reward]")?.value,
      hirelingsRequired: row.querySelector("[data-standard-boon-hirelings]")?.value,
      rewardsAvailable: row.querySelector("[data-standard-boon-rewards-available]")?.value,
      restrictToOnePerPlayer: row.querySelector("[data-standard-boon-restrict-player]")?.checked !== false
    }))
    .filter(Boolean)
    .join("\n");
}

function getActorData(actor) {
  const raw = actor?.getFlag?.(MODULE_ID, FLAG) ?? {};
  return {
    totalPerTurn: limit(raw.totalPerTurn, 1),
    turnId: String(raw.turnId ?? ""),
    startedThisTurn: Math.max(asInt(raw.startedThisTurn, 0), 0)
  };
}

function getFacilityData(facility) {
  const raw = facility?.getFlag?.(MODULE_ID, FLAG) ?? {};
  const active = Array.isArray(raw.active) ? raw.active : [];
  return {
    boonsText: String(raw.boonsText ?? ""),
    roomPerTurnConfigured: raw.roomPerTurnConfigured === true,
    roomPerTurn: raw.roomPerTurnConfigured === true ? limit(raw.roomPerTurn, 0) : null,
    turnId: String(raw.turnId ?? ""),
    startedThisTurn: Math.max(asInt(raw.startedThisTurn, 0), 0),
    active: active
      .filter(entry => entry && !entry.collected)
      .map(entry => ({
        id: String(entry.id ?? foundry.utils.randomID()),
        index: Math.max(asInt(entry.index, 0), 0),
        key: String(entry.key ?? ""),
        name: String(entry.name ?? ""),
        description: String(entry.description ?? ""),
        rewardUuid: String(entry.rewardUuid ?? ""),
        rewardLabel: String(entry.rewardLabel ?? ""),
        costGp: Math.max(asInt(entry.costGp, 0), 0),
        rewardGp: Math.max(asInt(entry.rewardGp, 0), 0),
        rewardsAvailable: Math.max(asInt(entry.rewardsAvailable, 1), 1),
        claimedUserIds: Array.isArray(entry.claimedUserIds) ? entry.claimedUserIds.map(String).filter(Boolean) : [],
        remainingTurns: Math.max(asInt(entry.remainingTurns, 0), 0),
        totalTurns: Math.max(asInt(entry.totalTurns, entry.remainingTurns ?? 1), 1),
        hirelingsRequired: Math.max(asInt(entry.hirelingsRequired, 0), 0),
        restrictToOnePerPlayer: entry.restrictToOnePerPlayer !== false,
        complete: Boolean(entry.complete)
      }))
  };
}

function getHirelingCount(facility) {
  const value = facility?.system?.hirelings?.value ?? facility?.system?.hirelings;
  if (Array.isArray(value)) return value.filter(Boolean).length;
  if (typeof value === "number") return Math.max(value, 0);
  if (!value || (typeof value !== "object")) return 0;
  if (Array.isArray(value.assigned)) return value.assigned.filter(Boolean).length;
  if (Array.isArray(value.value)) return value.value.filter(Boolean).length;
  if (typeof value.value === "number") return Math.max(value.value, 0);
  if (typeof value.count === "number") return Math.max(value.count, 0);
  return 0;
}

function canUseStandardBoons(actor, user = game.user) {
  return canManageActorVentures(actor, user);
}

function actorActiveBoonStarts(actor) {
  return (actor.itemTypes?.facility ?? []).reduce((total, facility) => (
    total + activeBoonStarts(getFacilityData(facility).active)
  ), 0);
}

function gpUpdate(actor, nextGp) {
  return actor.update({ "system.currency.gp": Math.max(asInt(nextGp, 0), 0) });
}

function getBoonCostActor(actor, requestingUser = game.user) {
  if (!isSharedBastionActor(actor)) return actor;
  const character = requestingUser?.character;
  return character?.documentName === "Actor" && character.type === "character" ? character : null;
}

function getBoonRewardActor(actor, requestingUser = game.user) {
  if (!isSharedBastionActor(actor)) return actor;
  const character = requestingUser?.character;
  return character?.documentName === "Actor" && character.type === "character" ? character : null;
}

function currentCounts(actor, facility) {
  const actorData = getActorData(actor);
  const facilityData = getFacilityData(facility);
  const roomStarted = actorData.turnId && (facilityData.turnId !== actorData.turnId) ? 0 : facilityData.startedThisTurn;
  return {
    actorData,
    facilityData,
    totalStarted: Math.min(actorData.startedThisTurn, actorActiveBoonStarts(actor)),
    roomStarted: Math.min(roomStarted, activeBoonStarts(facilityData.active))
  };
}

function resolveBoon(boons, index, key = "") {
  const requested = boons[index];
  if (requested && (!key || requested.key === key)) return { boon: requested, index };
  const matchedIndex = boons.findIndex(boon => boon.key === key);
  return matchedIndex >= 0 ? { boon: boons[matchedIndex], index: matchedIndex } : { boon: null, index };
}

async function saveActorTotal(actor, value) {
  const current = getActorData(actor);
  await actor.setFlag(MODULE_ID, FLAG, {
    ...current,
    totalPerTurn: limit(value, 1)
  });
  actor.sheet?.render(false);
}

async function saveRoomConfig(facility, root) {
  const current = getFacilityData(facility);
  await facility.setFlag(MODULE_ID, FLAG, {
    ...current,
    roomPerTurn: limit(root.querySelector("[data-standard-boon-room-limit]")?.value, 0),
    roomPerTurnConfigured: true,
    boonsText: serializeBoonRows(root)
  });
  facility.actor?.sheet?.render(false);
}

async function startBoon(facility, index, key, requestingUser = game.user, { delegate = true, notify = true } = {}) {
  if (delegate && shouldDelegateSharedBoonAction(facility)) {
    return requestSharedBoonAction("startStandardBoon", facility, { boonIndex: index, boonKey: key });
  }
  const actor = facility.actor;
  if (!canUseStandardBoons(actor, requestingUser)) {
    return actionResult(false, "warn", "INDYVENTURES.StandardBoons.NotOwner", {}, notify);
  }
  return withFacilityVentureLock(facility.uuid, async () => {
    const actorData = getActorData(actor);
    const facilityData = getFacilityData(facility);
    const boons = parseBoons(facilityData.boonsText);
    const resolved = resolveBoon(boons, index, key);
    const boon = resolved.boon;
    if (!boon) return actionResult(false, "warn", "INDYVENTURES.StandardBoons.MissingBoon", {}, notify);

    const turnId = actorData.turnId || facilityData.turnId || "";
    const totalStarted = Math.min(actorData.startedThisTurn, actorActiveBoonStarts(actor));
    const roomStarted = Math.min(
      actorData.turnId && (facilityData.turnId !== actorData.turnId) ? 0 : facilityData.startedThisTurn,
      activeBoonStarts(facilityData.active)
    );
    if ((actorData.totalPerTurn !== null) && (totalStarted >= actorData.totalPerTurn)) {
      return actionResult(false, "warn", "INDYVENTURES.StandardBoons.TotalLimitReached", {}, notify);
    }
    if ((facilityData.roomPerTurn !== null) && (roomStarted >= facilityData.roomPerTurn)) {
      return actionResult(false, "warn", "INDYVENTURES.StandardBoons.RoomLimitReached", {}, notify);
    }
    const hirelings = getHirelingCount(facility);
    const assignedHirelings = assignedBoonHirelings(facilityData.active);
    if ((assignedHirelings + boon.hirelingsRequired) > hirelings) {
      return actionResult(false, "warn", "INDYVENTURES.StandardBoons.HirelingsCommitted", {
        required: boon.hirelingsRequired
      }, notify);
    }
    const costActor = getBoonCostActor(actor, requestingUser);
    if (boon.costGp && !costActor) {
      return actionResult(false, "warn", "INDYVENTURES.StandardBoons.NoStartingCharacter", {}, notify);
    }
    const costUpdate = boon.costGp ? spendCurrencyGp(costActor?.system?.currency, boon.costGp) : {};
    if (!costUpdate) {
      return actionResult(false, "warn", "INDYVENTURES.StandardBoons.NotEnoughGold", {
        cost: boon.costGp,
        actor: costActor?.name ?? actor.name
      }, notify);
    }

    const active = [
      ...facilityData.active,
      {
        id: foundry.utils.randomID(),
        index: resolved.index,
        key: boon.key,
        name: boon.name,
        description: boon.description,
        rewardUuid: boon.rewardUuid,
        rewardLabel: boon.rewardLabel,
        costGp: boon.costGp,
        rewardGp: boon.rewardGp,
        rewardsAvailable: boon.rewardsAvailable,
        claimedUserIds: [],
        startedTurnId: turnId,
        remainingTurns: boon.turns,
        totalTurns: boon.turns,
        hirelingsRequired: boon.hirelingsRequired,
        restrictToOnePerPlayer: boon.restrictToOnePerPlayer !== false,
        complete: false
      }
    ];
    await actor.setFlag(MODULE_ID, FLAG, {
      ...actorData,
      turnId,
      startedThisTurn: totalStarted + 1
    });
    await facility.setFlag(MODULE_ID, FLAG, {
      ...facilityData,
      turnId,
      startedThisTurn: roomStarted + 1,
      active
    });
    if (boon.costGp) await costActor.update(costUpdate);
    const result = actionResult(true, "info", "INDYVENTURES.StandardBoons.Started", {
      boon: boon.name,
      room: facility.name
    }, notify);
    actor.sheet?.render(false);
    if (costActor && costActor !== actor) costActor.sheet?.render(false);
    return result;
  });
}

async function collectBoon(facility, id, requestingUser = game.user, { delegate = true, notify = true } = {}) {
  if (delegate && shouldDelegateSharedBoonAction(facility)) {
    return requestSharedBoonAction("collectStandardBoon", facility, { boonId: id });
  }
  const actor = facility.actor;
  if (!canUseStandardBoons(actor, requestingUser)) {
    return actionResult(false, "warn", "INDYVENTURES.StandardBoons.NotOwner", {}, notify);
  }
  return withFacilityVentureLock(facility.uuid, async () => {
    const data = getFacilityData(facility);
    const boon = data.active.find(entry => entry.id === id);
    if (!boon || !boon.complete) return actionResult(false, "warn", "", {}, notify);
    const sharedBastion = isSharedBastionActor(actor);
    const claimedUserIds = Array.isArray(boon.claimedUserIds) ? boon.claimedUserIds.map(String).filter(Boolean) : [];
    const restrictToOnePerPlayer = boon.restrictToOnePerPlayer !== false;
    if (sharedBastion && restrictToOnePerPlayer && claimedUserIds.includes(requestingUser.id)) {
      return actionResult(false, "warn", "INDYVENTURES.StandardBoons.AlreadyCollected", {}, notify);
    }
    const claimCount = boonClaimCount(boon, sharedBastion);
    if (claimedUserIds.length >= boon.rewardsAvailable || claimCount <= 0) {
      return actionResult(false, "warn", "INDYVENTURES.StandardBoons.NoRewardsRemaining", {}, notify);
    }
    const rewardActor = getBoonRewardActor(actor, requestingUser);
    if (!rewardActor) {
      return actionResult(false, "warn", "INDYVENTURES.StandardBoons.NoCollectingCharacter", {}, notify);
    }
    let rewardName = null;
    if (boon.rewardUuid) {
      try {
        rewardName = await grantBoonReward(rewardActor, facility, boon, requestingUser, {
          allowVentureModifier: false,
          rollDurationFormula: false,
          quantity: claimCount
        });
      } catch (error) {
        const message = String(error?.message ?? error);
        if (notify && message) ui.notifications?.error?.(message);
        return { ok: false, level: "error", message };
      }
    }
    const gpReward = boon.rewardGp * claimCount;
    if (gpReward) await gpUpdate(rewardActor, getActorGp(rewardActor) + gpReward);
    const nextClaimedUserIds = sharedBastion
      ? (restrictToOnePerPlayer ? Array.from(new Set([...claimedUserIds, requestingUser.id])) : [...claimedUserIds, requestingUser.id])
      : [];
    const nextActive = !sharedBastion || nextClaimedUserIds.length >= boon.rewardsAvailable
      ? data.active.filter(entry => entry.id !== id)
      : data.active.map(entry => entry.id === id ? { ...entry, claimedUserIds: nextClaimedUserIds } : entry);
    await facility.setFlag(MODULE_ID, FLAG, {
      ...data,
      active: nextActive
    });
    const notificationKey = rewardName && boon.rewardGp
      ? "INDYVENTURES.StandardBoons.CollectedRewardGold"
      : (rewardName
          ? "INDYVENTURES.StandardBoons.CollectedReward"
          : (boon.rewardGp ? "INDYVENTURES.StandardBoons.CollectedGold" : "INDYVENTURES.StandardBoons.Collected"));
    const result = actionResult(true, "info", notificationKey, {
      boon: boon.name,
      reward: rewardName,
      gp: gpReward
    }, notify);
    actor.sheet?.render(false);
    if (rewardActor !== actor) rewardActor.sheet?.render(false);
    return result;
  });
}

async function confirmCancelBoon(boonName) {
  const title = game.i18n.localize("INDYVENTURES.StandardBoons.CancelTitle");
  const content = `<p>${escapeHtml(game.i18n.format("INDYVENTURES.StandardBoons.CancelContent", { boon: boonName }))}</p>`;
  if (foundry.applications?.api?.DialogV2?.confirm) {
    return foundry.applications.api.DialogV2.confirm({ window: { title }, content });
  }
  if (foundry.applications?.api?.Dialog?.confirm) {
    return foundry.applications.api.Dialog.confirm({ window: { title }, content });
  }
  return window.confirm(game.i18n.format("INDYVENTURES.StandardBoons.CancelContent", { boon: boonName }));
}

async function cancelBoon(facility, id, requestingUser = game.user, { delegate = true, notify = true } = {}) {
  if (delegate && shouldDelegateSharedBoonAction(facility)) {
    return requestSharedBoonAction("cancelStandardBoon", facility, { boonId: id });
  }
  const actor = facility.actor;
  if (!canUseStandardBoons(actor, requestingUser)) {
    return actionResult(false, "warn", "INDYVENTURES.StandardBoons.NotOwner", {}, notify);
  }
  return withFacilityVentureLock(facility.uuid, async () => {
    const data = getFacilityData(facility);
    const boon = data.active.find(entry => entry.id === id);
    if (!boon || boon.complete) return actionResult(false, "warn", "INDYVENTURES.StandardBoons.MissingBoon", {}, notify);
    await facility.setFlag(MODULE_ID, FLAG, {
      ...data,
      active: data.active.filter(entry => entry.id !== id)
    });
    const result = actionResult(true, "info", "INDYVENTURES.StandardBoons.Cancelled", { boon: boon.name }, notify);
    actor.sheet?.render(false);
    return result;
  });
}

function rewardLabel(boon) {
  const rewardUuid = String(boon.rewardUuid ?? "");
  if (!rewardUuid) return "";
  const doc = resolveRewardDocumentSync(rewardUuid);
  return doc?.name ?? boon.rewardLabel ?? rewardUuid;
}

function isEditState(value) {
  if (value === true) return true;
  if (value === 2) return true;
  if (value === false || value === 1 || value === null || value === undefined) return false;
  const text = String(value).trim().toLowerCase();
  if (text === "2") return true;
  if (text === "1") return false;
  return ["edit", "editing", "editmode", "edit-mode", "sheetedit", "sheet-edit", "unlocked"].includes(text);
}

function hasEditModeMarker(root) {
  if (!root) return false;
  if (root.classList?.contains("sheet-mode-edit") || root.classList?.contains("edit-mode")) return true;
  return Boolean(root.querySelector?.([
    ".sheet-mode-edit",
    ".edit-mode",
    "[data-mode='edit']",
    "[data-sheet-mode='edit']",
    "[data-edit-mode='true']",
    "[data-application-state='edit']"
  ].join(",")));
}

function isEditMode(root, sheet) {
  if (root?.classList?.contains("indy-shared-bastion-sheet") || root?.querySelector?.(".indy-shared-bastion-sheet")) {
    return isSharedBastionSheetInEditMode(sheet) || hasEditModeMarker(root);
  }
  if ([
    sheet?.isEditMode,
    sheet?.editMode,
    sheet?._editMode,
    sheet?.mode,
    sheet?._mode,
    sheet?.sheetMode,
    sheet?._sheetMode,
    sheet?.currentSheetMode,
    sheet?.options?.editMode,
    sheet?.options?.mode,
    sheet?.options?.sheetMode,
    sheet?.state?.editMode,
    sheet?.state?.mode,
    sheet?.state?.sheetMode
  ].some(isEditState)) return true;
  if (hasEditModeMarker(root)) return true;
  return false;
}

function renderBoonConfigRow(boon = {}, sharedBastion = false) {
  return `<div class="indy-standard-boon-config-row" data-standard-boon-row>
    <label>${game.i18n.localize("INDYVENTURES.StandardBoons.Name")}
      <input type="text" value="${escapeHtml(boon.name ?? "")}" data-standard-boon-name>
    </label>
    <label>${game.i18n.localize("INDYVENTURES.StandardBoons.TurnsLabel")}
      <input type="number" min="1" step="1" value="${Math.max(asInt(boon.turns, 1), 1)}" data-standard-boon-turns>
    </label>
    <label>${game.i18n.localize("INDYVENTURES.StandardBoons.CostLabel")}
      <input type="number" min="0" step="1" value="${Math.max(asInt(boon.costGp, 0), 0)}" data-standard-boon-cost>
    </label>
    <label>${game.i18n.localize("INDYVENTURES.StandardBoons.GoldRewardLabel")}
      <input type="number" min="0" step="1" value="${Math.max(asInt(boon.rewardGp, 0), 0)}" data-standard-boon-gold-reward>
    </label>
    <label>${game.i18n.localize("INDYVENTURES.StandardBoons.HirelingsLabel")}
      <input type="number" min="0" step="1" value="${Math.max(asInt(boon.hirelingsRequired, 0), 0)}" data-standard-boon-hirelings>
    </label>
    <label>${game.i18n.localize("INDYVENTURES.StandardBoons.RewardsAvailableLabel")}
      <input type="number" min="1" step="1" value="${Math.max(asInt(boon.rewardsAvailable, 1), 1)}" data-standard-boon-rewards-available>
    </label>
    ${sharedBastion ? `<label>
      <input type="checkbox" ${boon.restrictToOnePerPlayer === false ? "" : "checked"} data-standard-boon-restrict-player>
      ${game.i18n.localize("INDYVENTURES.StandardBoons.RestrictPlayerLabel")}
    </label>` : ""}
    <label class="wide">${game.i18n.localize("INDYVENTURES.StandardBoons.DescriptionLabel")}
      <input type="text" value="${escapeHtml(boon.description ?? "")}" data-standard-boon-description>
    </label>
    <label class="wide">${game.i18n.localize("INDYVENTURES.StandardBoons.RewardLabel")}
      <input type="text" value="${escapeHtml(rewardReferenceText(boon))}" placeholder="@UUID[...]" data-standard-boon-reward>
    </label>
    <button type="button" data-action="removeStandardBoonRow" data-tooltip="${game.i18n.localize("INDYVENTURES.StandardBoons.Remove")}" aria-label="${game.i18n.localize("INDYVENTURES.StandardBoons.Remove")}"><i class="fa-solid fa-trash"></i></button>
  </div>`;
}

function renderFacilityPanel(actor, facility, element, editMode = false) {
  const data = getFacilityData(facility);
  const boons = parseBoons(data.boonsText);
  const hirelings = getHirelingCount(facility);
  const assignedHirelings = assignedBoonHirelings(data.active);
  const canUse = canUseStandardBoons(actor);
  const sharedBastion = isSharedBastionActor(actor);
  const counts = currentCounts(actor, facility);
  const totalLeft = counts.actorData.totalPerTurn === null ? null : Math.max(counts.actorData.totalPerTurn - counts.totalStarted, 0);
  const roomLeft = data.roomPerTurn === null ? null : Math.max(data.roomPerTurn - counts.roomStarted, 0);
  const disabledByLimit = (totalLeft === 0) || (roomLeft === 0);
  const doc = element.ownerDocument;
  element.querySelector(".indy-standard-boons")?.remove();

  const panel = doc.createElement("div");
  panel.classList.add("indy-standard-boons");
  panel.dataset.standardFacilityId = facility.id;

  const activeHtml = data.active.length
    ? data.active.map(entry => {
        const done = Math.max(entry.totalTurns - entry.remainingTurns, 0);
        const status = entry.complete
          ? game.i18n.localize("INDYVENTURES.StandardBoons.Complete")
          : game.i18n.format("INDYVENTURES.StandardBoons.Progress", { done, total: entry.totalTurns });
        const hirelingStatus = !entry.complete && entry.hirelingsRequired
          ? game.i18n.format("INDYVENTURES.StandardBoons.Hirelings", { count: entry.hirelingsRequired })
          : "";
        const claimed = Array.isArray(entry.claimedUserIds) ? entry.claimedUserIds.length : 0;
        const claimsLeft = Math.max(entry.rewardsAvailable - claimed, 0);
        const userClaimed = sharedBastion && entry.restrictToOnePerPlayer !== false && entry.claimedUserIds?.includes?.(game.user.id) === true;
        const claimStatus = sharedBastion && entry.complete
          ? game.i18n.format("INDYVENTURES.StandardBoons.Claims", { claimed, total: entry.rewardsAvailable })
          : "";
        return `<div class="indy-standard-boon-active">
          <span><strong>${escapeHtml(entry.name)}</strong> ${escapeHtml(status)}</span>
          ${hirelingStatus ? `<span>${escapeHtml(hirelingStatus)}</span>` : ""}
          ${claimStatus ? `<span>${escapeHtml(claimStatus)}</span>` : ""}
          ${entry.complete && canUse && (!sharedBastion || claimsLeft > 0) && !userClaimed ? `<button type="button" data-action="collectStandardBoon" data-standard-boon-id="${escapeHtml(entry.id)}">${game.i18n.localize("INDYVENTURES.StandardBoons.Collect")}</button>` : ""}
          ${!entry.complete && canUse ? `<button type="button" data-action="cancelStandardBoon" data-standard-boon-id="${escapeHtml(entry.id)}" data-standard-boon-name="${escapeHtml(entry.name)}">${game.i18n.localize("INDYVENTURES.StandardBoons.Cancel")}</button>` : ""}
        </div>`;
      }).join("")
    : "";

  const availableHtml = boons.length
    ? boons.map((boon, index) => {
        const missingHirelings = (assignedHirelings + boon.hirelingsRequired) > hirelings;
        const disabled = !canUse || disabledByLimit || missingHirelings;
        const reward = rewardLabel(boon);
        const meta = [
          game.i18n.format("INDYVENTURES.StandardBoons.Turns", { turns: boon.turns }),
          boon.costGp ? game.i18n.format("INDYVENTURES.StandardBoons.Cost", { gp: boon.costGp }) : "",
          boon.rewardGp ? game.i18n.format("INDYVENTURES.StandardBoons.GoldReward", { gp: boon.rewardGp }) : "",
          boon.hirelingsRequired ? game.i18n.format("INDYVENTURES.StandardBoons.Hirelings", { count: boon.hirelingsRequired }) : "",
          boon.rewardsAvailable > 1 ? game.i18n.format("INDYVENTURES.StandardBoons.RewardsAvailable", { count: boon.rewardsAvailable }) : "",
          reward ? game.i18n.format("INDYVENTURES.StandardBoons.Reward", { reward }) : ""
        ].filter(Boolean).join(" | ");
        return `<div class="indy-standard-boon-option">
          <button type="button" data-action="startStandardBoon" data-boon-index="${index}" data-boon-key="${escapeHtml(boon.key)}" ${disabled ? "disabled" : ""}>${escapeHtml(boon.name)}</button>
          <span>${escapeHtml(meta)}</span>
        </div>`;
      }).join("")
    : `<p class="hint">${game.i18n.localize("INDYVENTURES.StandardBoons.None")}</p>`;

  panel.innerHTML = `
    <div class="indy-standard-boons-title">${game.i18n.localize("INDYVENTURES.StandardBoons.Title")}</div>
    ${hirelings || assignedHirelings ? `<div class="hint">${escapeHtml(game.i18n.format("INDYVENTURES.StandardBoons.HirelingsAssigned", { assigned: assignedHirelings, total: hirelings }))}</div>` : ""}
    ${activeHtml}
    <div class="indy-standard-boon-options">${availableHtml}</div>
    ${game.user?.isGM && editMode ? `<details class="indy-standard-boon-config">
      <summary>${game.i18n.localize("INDYVENTURES.StandardBoons.ConfigureRoom")}</summary>
      <label>${game.i18n.localize("INDYVENTURES.StandardBoons.RoomLimit")}
        <input type="number" min="0" step="1" value="${data.roomPerTurn ?? 0}" data-standard-boon-room-limit>
      </label>
      <div class="indy-standard-boon-config-rows" data-standard-boon-rows>
        ${(boons.length ? boons : [{}]).map(boon => renderBoonConfigRow(boon, sharedBastion)).join("")}
      </div>
      <button type="button" data-action="addStandardBoonRow">${game.i18n.localize("INDYVENTURES.StandardBoons.Add")}</button>
      <button type="button" data-action="saveStandardBoonRoom">${game.i18n.localize("INDYVENTURES.StandardBoons.Save")}</button>
    </details>` : ""}
  `;
  element.append(panel);
}

function bindStandardBoonEvents(root, actor) {
  if (root.dataset.indyStandardBoonsBound === "1") return;
  root.dataset.indyStandardBoonsBound = "1";
  root.addEventListener("toggle", event => {
    const target = event.target;
    if (!target?.matches?.(".indy-standard-boon-config[open]")) return;
    for (const details of root.querySelectorAll(".indy-standard-boon-config[open]")) {
      if (details !== target) details.open = false;
    }
  }, true);
  root.addEventListener("dragover", event => {
    const rewardInput = event.target.closest("[data-standard-boon-reward]");
    if (!rewardInput) return;
    const data = TextEditor.getDragEventData(event);
    if (!["Item", "ActiveEffect"].includes(data?.type)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, true);
  root.addEventListener("drop", event => {
    const rewardInput = event.target.closest("[data-standard-boon-reward]");
    if (!rewardInput) return;
    const data = TextEditor.getDragEventData(event);
    if (!["Item", "ActiveEffect"].includes(data?.type)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const uuidLink = buildUuidLink(data);
    if (!uuidLink) {
      ui.notifications.warn("INDYVENTURES.Errors.BoonDropMissingUuid", { localize: true });
      return;
    }
    rewardInput.value = uuidLink;
    ui.notifications.info("INDYVENTURES.Notifications.BoonRewardUuidInserted", { localize: true });
  }, true);
  root.addEventListener("click", event => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (!action.startsWith("saveStandardBoon")
      && !action.startsWith("startStandardBoon")
      && !action.startsWith("collectStandardBoon")
      && !action.startsWith("cancelStandardBoon")
      && !action.startsWith("addStandardBoon")
      && !action.startsWith("removeStandardBoon")) return;
    const facilityRoot = target.closest(".indy-standard-boons");
    const facility = facilityRoot ? actor.items?.get?.(facilityRoot.dataset.standardFacilityId) : null;
    event.preventDefault();
    if (action === "saveStandardBoonTotal") return saveActorTotal(actor, root.querySelector("[data-standard-boon-total-limit]")?.value);
    if (!facility) return;
    if (action === "addStandardBoonRow") {
      facilityRoot.querySelector("[data-standard-boon-rows]")?.insertAdjacentHTML("beforeend", renderBoonConfigRow({}, isSharedBastionActor(actor)));
      return;
    }
    if (action === "removeStandardBoonRow") {
      const rows = facilityRoot.querySelectorAll("[data-standard-boon-row]");
      if (rows.length > 1) target.closest("[data-standard-boon-row]")?.remove();
      else {
        for (const input of target.closest("[data-standard-boon-row]")?.querySelectorAll("input") ?? []) input.value = "";
      }
      return;
    }
    if (action === "saveStandardBoonRoom") return saveRoomConfig(facility, facilityRoot);
    if (action === "startStandardBoon") return startBoon(facility, Number(target.dataset.boonIndex), target.dataset.boonKey);
    if (action === "collectStandardBoon") return collectBoon(facility, target.dataset.standardBoonId);
    if (action === "cancelStandardBoon") {
      return confirmCancelBoon(target.dataset.standardBoonName).then(confirmed => (
        confirmed ? cancelBoon(facility, target.dataset.standardBoonId) : null
      ));
    }
  });
}

function renderActorPanel(root, actor, editMode = false) {
  const bastion = root.querySelector(".tidy-tab.bastion.active, .tidy-tab.bastion, .tab[data-tab='bastion']");
  if (!bastion) return;
  bastion.querySelector(".indy-standard-boons-actor")?.remove();
  if (!game.user?.isGM || !editMode) return;
  const data = getActorData(actor);
  const panel = root.ownerDocument.createElement("div");
  panel.classList.add("indy-standard-boons-actor");
  panel.innerHTML = `
    <label>${game.i18n.localize("INDYVENTURES.StandardBoons.TotalLimit")}
      <input type="number" min="0" step="1" value="${data.totalPerTurn ?? 0}" data-standard-boon-total-limit>
    </label>
    <button type="button" data-action="saveStandardBoonTotal">${game.i18n.localize("INDYVENTURES.StandardBoons.Save")}</button>
  `;
  bastion.prepend(panel);
}

export function renderStandardBastionBoons(sheet, html) {
  const actor = sheet?.document ?? sheet?.actor;
  if (actor?.documentName !== "Actor" || actor.type !== "character") return;
  const root = resolveHtmlRoot(sheet, html);
  if (!root) return;
  const bastion = root.querySelector(".tidy-tab.bastion.active, .tidy-tab.bastion, .tab[data-tab='bastion']");
  if (!bastion) return;
  const editMode = isEditMode(root, sheet);

  renderActorPanel(root, actor, editMode);
  bindStandardBoonEvents(root, actor);
  for (const element of bastion.querySelectorAll(".facility[data-facility-id]")) {
    const facility = actor.items?.get?.(element.dataset.facilityId);
    if (!facility || facility.type !== "facility" || isIndyVentureFacility(facility)) continue;
    renderFacilityPanel(actor, facility, element, editMode);
  }
}

export async function processStandardBoonTurn(actor, turnId) {
  if (!game.user?.isGM || !actor || actor.type !== "character") return 0;
  let changed = 0;
  const actorData = getActorData(actor);
  await actor.setFlag(MODULE_ID, FLAG, {
    ...actorData,
    turnId,
    startedThisTurn: 0
  });
  for (const facility of actor.itemTypes?.facility ?? []) {
    const data = getFacilityData(facility);
    if (!data.active.length && !data.boonsText.trim()) continue;
    const active = data.active.map(entry => {
      if (entry.complete) return entry;
      const remainingTurns = Math.max(entry.remainingTurns - 1, 0);
      return {
        ...entry,
        remainingTurns,
        complete: remainingTurns <= 0
      };
    });
    await facility.setFlag(MODULE_ID, FLAG, {
      ...data,
      turnId,
      startedThisTurn: 0,
      active
    });
    changed += 1;
  }
  return changed;
}

async function onStandardBoonActionRequest(payload) {
  if (!game.user?.isGM || (payload.gmUserId !== game.user.id)) return;

  const requestingUser = game.users.get(payload.userId);
  let result = null;
  try {
    const facility = await fromUuid(String(payload.facilityUuid ?? ""));
    if (!requestingUser || !facility || (facility.documentName !== "Item")) {
      result = actionResult(false, "warn", "INDYVENTURES.SharedBastion.ActionFailed", {}, false);
    } else if (payload.action === "startStandardBoon") {
      result = await startBoon(
        facility,
        Number(payload.buttonData?.boonIndex),
        payload.buttonData?.boonKey,
        requestingUser,
        { delegate: false, notify: false }
      );
    } else if (payload.action === "collectStandardBoon") {
      result = await collectBoon(
        facility,
        payload.buttonData?.boonId,
        requestingUser,
        { delegate: false, notify: false }
      );
    } else if (payload.action === "cancelStandardBoon") {
      result = await cancelBoon(
        facility,
        payload.buttonData?.boonId,
        requestingUser,
        { delegate: false, notify: false }
      );
    } else {
      result = actionResult(false, "warn", "INDYVENTURES.SharedBastion.ActionFailed", {}, false);
    }
  } catch (error) {
    result = { ok: false, level: "error", message: String(error?.message ?? error) };
  }

  game.socket?.emit(SOCKET_NAMESPACE, {
    type: "standardBoonActionResponse",
    requestId: payload.requestId,
    targetUserId: payload.userId,
    ok: Boolean(result?.ok),
    level: result?.level ?? (result?.ok ? "info" : "warn"),
    message: result?.message ?? ""
  });
}

function onStandardBoonActionResponse(payload) {
  if (payload.targetUserId !== game.user.id) return;
  const pending = pendingStandardBoonActionRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.resolve({
    ok: Boolean(payload.ok),
    level: payload.level,
    message: payload.message,
    timedOut: false
  });
  pendingStandardBoonActionRequests.delete(payload.requestId);
}

function registerStandardBoonSocket() {
  if (standardBoonSocketRegistered || !game.socket) return;
  standardBoonSocketRegistered = true;
  game.socket.on(SOCKET_NAMESPACE, async payload => {
    if (!payload || (typeof payload !== "object")) return;
    if (payload.type === "standardBoonActionRequest") await onStandardBoonActionRequest(payload);
    else if (payload.type === "standardBoonActionResponse") onStandardBoonActionResponse(payload);
  });
}

export function registerStandardBoonHooks() {
  Hooks.once("ready", registerStandardBoonSocket);
  Hooks.on(`${MODULE_ID}.renderSharedBastionSheet`, renderStandardBastionBoons);
  Hooks.on("renderApplicationV2", renderStandardBastionBoons);
  Hooks.on("renderActorSheet", renderStandardBastionBoons);
  Hooks.on("renderActorSheet5e", renderStandardBastionBoons);
  Hooks.on("renderCharacterActorSheet", renderStandardBastionBoons);
  Hooks.on("dnd5e.renderActorSheet", renderStandardBastionBoons);
  Hooks.on("tidy5e-sheet.renderActorSheet", renderStandardBastionBoons);
}
