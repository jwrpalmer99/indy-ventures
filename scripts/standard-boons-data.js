export function asInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const CURRENCY_IN_CP = {
  pp: 1000,
  gp: 100,
  ep: 50,
  sp: 10,
  cp: 1
};
const CURRENCY_ORDER = ["pp", "gp", "ep", "sp", "cp"];

function currencyCount(currency, key) {
  return Math.max(asInt(currency?.[key], 0), 0);
}

export function currencyTotalCp(currency = {}) {
  return CURRENCY_ORDER.reduce((total, key) => total + (currencyCount(currency, key) * CURRENCY_IN_CP[key]), 0);
}

export function spendCurrencyGp(currency = {}, costGp = 0) {
  let remainingCp = currencyTotalCp(currency) - (Math.max(asInt(costGp, 0), 0) * CURRENCY_IN_CP.gp);
  if (remainingCp < 0) return null;

  return CURRENCY_ORDER.reduce((update, key) => {
    const count = Math.floor(remainingCp / CURRENCY_IN_CP[key]);
    remainingCp -= count * CURRENCY_IN_CP[key];
    update[`system.currency.${key}`] = count;
    return update;
  }, {});
}

export function limit(value, fallback = 1) {
  const parsed = asInt(value, fallback);
  return parsed <= 0 ? null : parsed;
}

export function assignedBoonHirelings(active = []) {
  return (Array.isArray(active) ? active : []).reduce((total, entry) => (
    entry?.complete ? total : total + Math.max(asInt(entry?.hirelingsRequired, 0), 0)
  ), 0);
}

export function activeBoonStarts(active = []) {
  return (Array.isArray(active) ? active : []).filter(entry => entry && !entry.complete).length;
}

export function boonClaimCount(boon, sharedBastion = false) {
  const claimed = Array.isArray(boon?.claimedUserIds) ? boon.claimedUserIds.length : 0;
  const available = Math.max(asInt(boon?.rewardsAvailable, 1), 1);
  return sharedBastion ? (claimed < available ? 1 : 0) : Math.max(available - claimed, 0);
}

function parseReward(value) {
  const text = String(value ?? "").trim();
  if (!text) return { rewardUuid: "", rewardLabel: "" };
  const match = text.match(/^@UUID\[([^\]]+)](?:\{([^}]+)})?$/i);
  if (!match) return { rewardUuid: text, rewardLabel: "" };
  return {
    rewardUuid: String(match[1] ?? "").trim(),
    rewardLabel: String(match[2] ?? "").trim()
  };
}

export function rewardReferenceText(boon) {
  const uuid = String(boon?.rewardUuid ?? "").trim();
  if (!uuid) return "";
  const label = String(boon?.rewardLabel ?? "").replace(/[{}]/g, "").trim();
  return label ? `@UUID[${uuid}]{${label}}` : uuid;
}

export function buildBoonLine(boon) {
  const name = String(boon?.name ?? "").trim();
  if (!name) return "";
  const reward = String(boon?.reward ?? rewardReferenceText(boon)).trim();
  return [
    name,
    Math.max(asInt(boon?.turns, 1), 1),
    Math.max(asInt(boon?.costGp, 0), 0),
    Math.max(asInt(boon?.rewardGp, 0), 0),
    String(boon?.description ?? "").trim(),
    reward,
    Math.max(asInt(boon?.hirelingsRequired, 0), 0),
    Math.max(asInt(boon?.rewardsAvailable, 1), 1),
    boon?.restrictToOnePerPlayer === false ? 0 : 1
  ].join(" | ");
}

function boonKey(boon) {
  return [
    boon.name,
    boon.turns,
    boon.costGp,
    boon.rewardGp,
    boon.description,
    boon.rewardUuid,
    boon.hirelingsRequired,
    boon.rewardsAvailable,
    boon.restrictToOnePerPlayer === false ? 0 : 1
  ].map(value => String(value ?? "").trim()).join("::");
}

export function parseBoons(text = "") {
  const looksNumeric = value => /^-?\d+$/.test(String(value ?? "").trim());
  return String(text ?? "")
    .split(/\r?\n/g)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split("|").map(part => part.trim());
      const [nameRaw = "", turnsRaw = ""] = parts;
      const hasGoldColumns = (parts.length >= 6) && looksNumeric(parts[2]) && looksNumeric(parts[3]);
      const costRaw = hasGoldColumns ? parts[2] : "0";
      const rewardGpRaw = hasGoldColumns ? parts[3] : "0";
      const descriptionRaw = hasGoldColumns ? parts[4] : parts[2];
      const rewardRaw = hasGoldColumns ? parts[5] : parts[3];
      const hirelingsRaw = hasGoldColumns ? parts[6] : parts[4];
      const rewardsAvailableRaw = hasGoldColumns ? parts[7] : parts[5];
      const restrictRaw = hasGoldColumns ? parts[8] : parts[6];
      const name = nameRaw.trim();
      if (!name) return null;
      const { rewardUuid, rewardLabel } = parseReward(rewardRaw);
      const boon = {
        name,
        turns: Math.max(asInt(turnsRaw, 1), 1),
        costGp: Math.max(asInt(costRaw, 0), 0),
        rewardGp: Math.max(asInt(rewardGpRaw, 0), 0),
        description: String(descriptionRaw ?? "").trim(),
        rewardUuid,
        rewardLabel: rewardLabel || rewardUuid,
        hirelingsRequired: Math.max(asInt(hirelingsRaw, 0), 0),
        rewardsAvailable: Math.max(asInt(rewardsAvailableRaw, 1), 1),
        restrictToOnePerPlayer: String(restrictRaw ?? "1").trim() !== "0"
      };
      return { ...boon, key: boonKey(boon) };
    })
    .filter(Boolean);
}
