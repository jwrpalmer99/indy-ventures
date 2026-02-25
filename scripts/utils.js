import { DICE_STEPS } from "./constants.js";

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function normalizeDie(die, fallback = "d6") {
  return DICE_STEPS.includes(die) ? die : fallback;
}

export function shiftDie(die, steps = 0) {
  const index = DICE_STEPS.indexOf(normalizeDie(die));
  const shifted = clamp(index + Number(steps || 0), 0, DICE_STEPS.length - 1);
  return DICE_STEPS[shifted];
}

export function asBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return Boolean(value);
}

export function asInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseBoonPerTurnLimit(value, fallback = 1) {
  if (value === null) return null;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["*", "u", "unlimited", "infinite", "inf", "any"].includes(text)) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return null;
  return parsed;
}

export function parseBoonPurchaseWhen(value, fallback = "default") {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["default", "any", "all", "either", "both"].includes(text)) return "default";
  if (["loss", "loss-only", "loss only", "on loss", "onloss"].includes(text)) return "loss";
  if (["profit", "profit-only", "profit only", "on profit", "onprofit"].includes(text)) return "profit";
  return fallback;
}

export function boonPurchaseWhenAllows(mode, net) {
  const parsedMode = parseBoonPurchaseWhen(mode, "default");
  const total = Number(net ?? 0) || 0;
  if (parsedMode === "loss") return total <= 0;
  if (parsedMode === "profit") return total >= 0;
  return true;
}

export function parseBoonsText(boonsText = "") {
  const looksLikeRewardReference = value => {
    const text = String(value ?? "").trim();
    if (!text) return false;
    if (/^@UUID\[[^\]]+\](\{[^}]+\})?$/i.test(text)) return true;
    return /^(Compendium|Actor|Item|ActiveEffect)\./.test(text);
  };

  const looksLikePerTurnLimit = value => {
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) return false;
    if (["*", "u", "unlimited", "infinite", "inf", "any"].includes(text)) return true;
    return /^\d+$/.test(text);
  };

  const looksLikePurchaseWhen = value => {
    const text = String(value ?? "").trim().toLowerCase();
    return ["default", "loss", "profit", "loss-only", "loss only", "profit-only", "profit only"].includes(text);
  };

  const parseRewardReference = value => {
    const text = String(value ?? "").trim();
    if (!text) return { rewardUuid: "", rewardLabel: "" };
    const uuidLink = text.match(/^@UUID\[([^\]]+)](?:\{([^}]+)})?$/i);
    if (uuidLink) {
      return {
        rewardUuid: uuidLink[1]?.trim() ?? "",
        rewardLabel: uuidLink[2]?.trim() ?? ""
      };
    }
    return { rewardUuid: text, rewardLabel: "" };
  };

  if (!boonsText?.trim()) return [];
  return boonsText
    .split(/\r?\n/g)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [nameRaw = "", costRaw = "", ...tailParts] = line.split("|");
      const name = nameRaw.trim();
      const cost = asInteger(costRaw.replace(/[^\d-]/g, ""), 0);
      let description = "";
      let rewardRaw = "";
      let perTurnLimit = 1;
      let purchaseWhen = "default";
      if (tailParts.length) {
        const tail = tailParts.map(part => part.trim());
        let foundOptionalField = false;
        let keepParsing = true;
        while (tail.length && keepParsing) {
          const tailValue = tail[tail.length - 1];
          if (tailValue === "") {
            tail.pop();
            foundOptionalField = true;
            continue;
          }
          if (!rewardRaw && looksLikeRewardReference(tailValue)) {
            rewardRaw = tail.pop();
            foundOptionalField = true;
            continue;
          }
          if (looksLikePerTurnLimit(tailValue)) {
            perTurnLimit = parseBoonPerTurnLimit(tail.pop(), 1);
            foundOptionalField = true;
            continue;
          }
          if (looksLikePurchaseWhen(tailValue) && ((tail.length > 1) || foundOptionalField)) {
            purchaseWhen = parseBoonPurchaseWhen(tail.pop(), "default");
            foundOptionalField = true;
            continue;
          }
          keepParsing = false;
        }
        description = tail.join("|").trim();
      }

      if (!name || !Number.isFinite(cost) || cost < 0) return null;
      const { rewardUuid, rewardLabel } = parseRewardReference(rewardRaw);
      return {
        name,
        cost,
        description,
        rewardUuid,
        rewardLabel: rewardLabel || rewardUuid,
        perTurnLimit,
        purchaseWhen
      };
    })
    .filter(Boolean);
}

export function buildBoonKey(boon = {}) {
  const name = String(boon?.name ?? "").trim();
  const cost = Number.parseInt(boon?.cost, 10) || 0;
  const description = String(boon?.description ?? "").trim();
  const rewardUuid = String(boon?.rewardUuid ?? "").trim();
  const perTurnLimit = parseBoonPerTurnLimit(boon?.perTurnLimit, 1);
  const purchaseWhen = parseBoonPurchaseWhen(boon?.purchaseWhen, "default");
  const limitText = perTurnLimit === null ? "unlimited" : String(perTurnLimit);
  return [name, cost, description, rewardUuid, limitText, purchaseWhen].join("::");
}

export function getActorGp(actor) {
  return Number(actor?.system?.currency?.gp ?? 0) || 0;
}
