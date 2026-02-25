import { MODULE_ID, TEMPLATE_PATHS } from "./constants.js";
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
  parseBoonPurchaseWhen
} from "./utils.js";

function getRenderTemplate() {
  return foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
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
  if (rewardUuid && (!rewardName || !rewardImg) && globalThis.fromUuidSync) {
    const doc = fromUuidSync(rewardUuid, { strict: false });
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

function getBoonPurchasesThisTurn(state, boonIndex) {
  return Math.max(Number(state?.boonPurchases?.[String(boonIndex)] ?? 0) || 0, 0);
}

function withBoonAvailability(boon, state, boonIndex, turnNet = null) {
  const reward = resolveRewardDisplayFromBoon(boon);
  const perTurnLimit = parseBoonPerTurnLimit(boon?.perTurnLimit, 1);
  const purchaseWhen = parseBoonPurchaseWhen(boon?.purchaseWhen, "default");
  const purchasedThisTurn = getBoonPurchasesThisTurn(state, boonIndex);
  const affordable = state.treasury >= boon.cost;
  const underTurnLimit = (perTurnLimit === null) || (purchasedThisTurn < perTurnLimit);
  const net = Number(turnNet ?? state?.lastTurnNet ?? 0) || 0;
  const purchaseWhenAllowed = boonPurchaseWhenAllows(purchaseWhen, net);
  return {
    ...boon,
    perTurnLimit,
    purchaseWhen,
    purchaseWhenAllowed,
    purchaseWhenLabel: getBoonPurchaseWhenLabel(purchaseWhen),
    blockedByWindow: !purchaseWhenAllowed,
    rewardName: reward.rewardName,
    rewardImg: reward.rewardImg,
    purchasedThisTurn,
    remainingPurchases: perTurnLimit === null ? null : Math.max(perTurnLimit - purchasedThisTurn, 0),
    affordable,
    purchasable: affordable && underTurnLimit && purchaseWhenAllowed
  };
}

function cloneDocumentSource(document) {
  const source = document.toObject();
  delete source._id;
  return source;
}

async function prepareActiveEffectRewardData(effectData, facility) {
  const modifierPath = `flags.${MODULE_ID}.ventureModifier`;
  if (!foundry.utils.hasProperty(effectData, modifierPath)) return effectData;

  const modifier = foundry.utils.deepClone(foundry.utils.getProperty(effectData, modifierPath) ?? {});
  if (!modifier || (typeof modifier !== "object")) return effectData;

  if (!modifier.applyToAllVentures && !modifier.facilityId && !modifier.facilityUuid) {
    modifier.facilityId = facility.id;
  }

  const hasRemainingTurns = (modifier.remainingTurns !== undefined)
    && (modifier.remainingTurns !== null)
    && (String(modifier.remainingTurns).trim() !== "");
  const durationFormula = String(modifier.durationFormula ?? "").trim();
  if (!hasRemainingTurns && durationFormula) {
    let durationRoll;
    try {
      durationRoll = await Roll.create(durationFormula).evaluate({ allowInteractive: false });
    } catch (error) {
      throw new Error(game.i18n.format("INDYVENTURES.Errors.BoonDurationFormulaInvalid", {
        formula: durationFormula
      }));
    }

    const turns = Math.max(Number.parseInt(durationRoll.total, 10) || 0, 1);
    modifier.remainingTurns = turns;
  }

  foundry.utils.setProperty(effectData, modifierPath, modifier);
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
    return rewardDoc.name;
  }

  if (rewardDoc.documentName === "ActiveEffect") {
    const effectData = await prepareActiveEffectRewardData(cloneDocumentSource(rewardDoc), facility);
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
    return rewardDoc.name;
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

  const boonIndex = Number(button.dataset.boonIndex);
  if (!Number.isFinite(boonIndex)) return;

  const config = getFacilityConfig(facility);
  const state = getFacilityState(facility, config);
  const boons = parseBoonsFromConfig(config);
  const boon = boons[boonIndex];
  if (!boon) return;
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
      : (purchaseState.affordable ? "INDYVENTURES.Errors.BoonTurnLimitReached" : "INDYVENTURES.Errors.NotEnoughTreasury");
    ui.notifications.warn(game.i18n.format(key, {
      boon: boon.name,
      limit: purchaseState.perTurnLimit ?? game.i18n.localize("INDYVENTURES.Chat.Unlimited"),
      purchased: purchaseState.purchasedThisTurn,
      mode: purchaseState.purchaseWhenLabel
    }));
    return;
  }

  const boonKey = String(boonIndex);
  const previousPurchaseCount = getBoonPurchasesThisTurn(state, boonIndex);
  const previousTreasury = state.treasury;
  state.treasury -= boon.cost;
  state.boonPurchases = {
    ...(state.boonPurchases ?? {}),
    [boonKey]: previousPurchaseCount + 1
  };
  await updateFacilityVenture(facility, config, state);

  let rewardName = null;
  if (boon.rewardUuid) {
    try {
      rewardName = await grantBoonReward(actor, facility, boon);
    } catch (error) {
      state.treasury = previousTreasury;
      if (previousPurchaseCount > 0) {
        state.boonPurchases[boonKey] = previousPurchaseCount;
      } else {
        delete state.boonPurchases[boonKey];
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
    await rerenderSummaryMessage(message, actorUuid, results);
  }
}

export function registerChatHooks() {
  Hooks.on("dnd5e.renderChatMessage", (message, html) => {
    const type = message.getFlag(MODULE_ID, "type");
    if (type !== "ventureSummary") return;

    html.addEventListener("click", event => {
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
