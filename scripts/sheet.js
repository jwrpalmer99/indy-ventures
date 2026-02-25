import { DICE_STEPS, MODULE_ID, SETTINGS, TEMPLATE_PATHS } from "./constants.js";
import {
  prepareFacilitySheetContext,
  sanitizeConfigPatchForUpdate,
  sanitizeStatePatchForUpdate
} from "./config.js";
import { parseBoonsText, parseBoonPerTurnLimit, parseBoonPurchaseWhen } from "./utils.js";
import { moduleLog } from "./logger.js";

const BOON_TEXTAREA_SELECTOR = `textarea[name="flags.${MODULE_ID}.config.boonsText"]`;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

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

function getVentureModifierFromEffect(effect) {
  if (!effect) return null;
  const rawFlagData = effect.getFlag(MODULE_ID, "ventureModifier");
  const fromFlags = (rawFlagData && (typeof rawFlagData === "object")) ? foundry.utils.deepClone(rawFlagData) : {};
  const fromChanges = {};
  for (const change of effect.changes ?? []) {
    const key = String(change?.key ?? "");
    const prefix = `flags.${MODULE_ID}.ventureModifier.`;
    if (!key.startsWith(prefix)) continue;
    const subKey = key.slice(prefix.length);
    foundry.utils.setProperty(fromChanges, subKey, change?.value);
  }
  // Flags are authoritative for runtime values like remainingTurns.
  const merged = foundry.utils.mergeObject(fromChanges, fromFlags, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  if (!merged || (typeof merged !== "object") || (Object.keys(merged).length === 0)) return null;
  return merged;
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

function asInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildVentureModifierSummary(modifier, effect = null) {
  if (!modifier || (typeof modifier !== "object")) return "";
  const lines = [];
  const scope = asBool(modifier.applyToAllVentures)
    ? game.i18n.localize("INDYVENTURES.EffectSummary.ScopeAll")
    : game.i18n.localize("INDYVENTURES.EffectSummary.ScopeThis");
  lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.Scope")}: ${scope}`);

  const profitDieStep = asInt(modifier.profitDieStep, 0);
  if (profitDieStep) lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.ProfitDieStep")}: ${profitDieStep > 0 ? "+" : ""}${profitDieStep}`);
  if (modifier.profitDieOverride) lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.ProfitDieOverride")}: ${modifier.profitDieOverride}`);
  if (modifier.minProfitDie) lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.MinProfitDie")}: ${modifier.minProfitDie}`);

  const lossDieStep = asInt(modifier.lossDieStep, 0);
  if (lossDieStep) lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.LossDieStep")}: ${lossDieStep > 0 ? "+" : ""}${lossDieStep}`);
  if (modifier.lossDieOverride) lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.LossDieOverride")}: ${modifier.lossDieOverride}`);
  if (modifier.maxLossDie) lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.MaxLossDie")}: ${modifier.maxLossDie}`);
  const successThresholdOverride = asInt(modifier.successThresholdOverride, 0);
  if (successThresholdOverride > 0) {
    lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.SuccessThresholdOverride")}: ${successThresholdOverride}`);
  }

  const profitRollBonus = asInt(modifier.profitRollBonus, 0);
  if (profitRollBonus) lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.ProfitRollBonus")}: ${profitRollBonus > 0 ? "+" : ""}${profitRollBonus}`);

  const remainingTurnsRaw = modifier.remainingTurns;
  const hasRemainingTurns = (remainingTurnsRaw !== undefined) && (remainingTurnsRaw !== null) && (String(remainingTurnsRaw).trim() !== "");
  if (hasRemainingTurns) {
    lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.RemainingTurns")}: ${Math.max(asInt(remainingTurnsRaw, 0), 0)}`);
  }
  const durationFormula = String(modifier.durationFormula ?? "").trim();
  if (durationFormula) lines.push(`${game.i18n.localize("INDYVENTURES.EffectSummary.DurationFormula")}: ${durationFormula}`);
  if (String(modifier.bastionDurationType ?? "").trim() === "nextBastionTurn") {
    lines.push(game.i18n.localize("INDYVENTURES.EffectSummary.BastionDurationNextTurn"));
  }
  if (!asBool(modifier.consumePerTurn ?? true)) {
    lines.push(game.i18n.localize("INDYVENTURES.EffectSummary.NoConsume"));
  }
  if (effect?.getFlag?.(MODULE_ID, "ventureModifierTemplate") === true) {
    lines.push(game.i18n.localize("INDYVENTURES.EffectSummary.TemplateNote"));
  }

  if (lines.length <= 1) lines.push(game.i18n.localize("INDYVENTURES.EffectSummary.NoChanges"));
  return lines.join("\n");
}

function bindActiveEffectModifierSummary(sheet, html) {
  const effect = sheet?.object;
  if (!effect || (effect.documentName !== "ActiveEffect")) return;
  const modifier = getVentureModifierFromEffect(effect);
  if (!modifier) return;

  const root = resolveHtmlRoot(sheet, html);
  if (!root || root.querySelector(".indy-venture-modifier-summary")) return;

  const doc = root.ownerDocument;
  const target = root.querySelector("form") ?? root;
  if (!target) return;

  const wrapper = doc.createElement("div");
  wrapper.classList.add("form-group", "indy-venture-modifier-summary");

  const label = doc.createElement("label");
  label.textContent = game.i18n.localize("INDYVENTURES.EffectSummary.Label");

  const fields = doc.createElement("div");
  fields.classList.add("form-fields");

  const summary = doc.createElement("textarea");
  summary.readOnly = true;
  summary.classList.add("indy-venture-modifier-summary-text");
  summary.rows = 6;
  summary.value = buildVentureModifierSummary(modifier, effect);

  fields.append(summary);
  wrapper.append(label, fields);

  const header = target.querySelector(".sheet-header, header");
  if (header?.after) header.after(wrapper);
  else {
    const firstGroup = target.querySelector(".form-group");
    if (firstGroup) firstGroup.before(wrapper);
    else target.prepend(wrapper);
  }
}

function buildUuidLink(data) {
  const uuid = resolveDroppedUuid(data);
  if (!uuid) return "";
  const label = String(data?.name ?? data?.data?.name ?? uuid).replace(/[{}]/g, "").trim() || uuid;
  return `@UUID[${uuid}]{${label}}`;
}

function insertAtCursor(textarea, text) {
  const current = textarea.value ?? "";
  const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : current.length;
  const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
  const nextValue = `${current.slice(0, start)}${text}${current.slice(end)}`;

  textarea.value = nextValue;
  const cursor = start + text.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
}

function normalizeLimitText(value) {
  const raw = String(value ?? "").trim();
  if (!raw || (raw === "1")) return "";
  const limit = parseBoonPerTurnLimit(raw, 1);
  if (limit === null) return "unlimited";
  return String(limit);
}

function normalizePurchaseWhenText(value) {
  return parseBoonPurchaseWhen(value, "default");
}

function getBoonPurchaseWhenOptions() {
  return [
    { value: "default", label: game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Default") },
    { value: "loss", label: game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Loss") },
    { value: "profit", label: game.i18n.localize("INDYVENTURES.BoonPurchaseWhen.Profit") }
  ];
}

function getDieSelectOptions() {
  return ["", ...DICE_STEPS];
}

function normalizeDieSelectValue(value) {
  const die = String(value ?? "").trim().toLowerCase();
  return DICE_STEPS.includes(die) ? die : "";
}

function asIntegerOr(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNonNegativeIntegerOrNull(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(parsed, 0);
}

function asPositiveIntegerOrNull(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || (parsed < 1)) return null;
  return parsed;
}

function escapeHtmlAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildModifierBuilderDialogContent(initialName) {
  const dieOptions = getDieSelectOptions()
    .map(die => {
      const label = die || game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderNone");
      return `<option value="${die}">${label}</option>`;
    })
    .join("");

  const value = escapeHtmlAttribute(initialName);
  return `
    <div class="indy-boon-modifier-scroll">
      <form class="indy-boon-modifier-form" data-indy-modifier-form>
        <p class="hint">${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderHelp")}</p>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderEffectName")}</label>
          <div class="form-fields">
            <input type="text" name="name" value="${value}" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderScope")}</label>
          <div class="form-fields">
            <label><input type="checkbox" name="applyToAllVentures" /> ${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderScopeAll")}</label>
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderProfitDieStep")}</label>
          <div class="form-fields">
            <input type="number" name="profitDieStep" step="1" value="0" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderProfitDieOverride")}</label>
          <div class="form-fields">
            <select name="profitDieOverride">${dieOptions}</select>
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderMinProfitDie")}</label>
          <div class="form-fields">
            <select name="minProfitDie">${dieOptions}</select>
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderLossDieStep")}</label>
          <div class="form-fields">
            <input type="number" name="lossDieStep" step="1" value="0" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderLossDieOverride")}</label>
          <div class="form-fields">
            <select name="lossDieOverride">${dieOptions}</select>
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderMaxLossDie")}</label>
          <div class="form-fields">
            <select name="maxLossDie">${dieOptions}</select>
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderSuccessThresholdOverride")}</label>
          <div class="form-fields">
            <input type="number" name="successThresholdOverride" min="1" step="1" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderProfitRollBonus")}</label>
          <div class="form-fields">
            <input type="number" name="profitRollBonus" step="1" value="0" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderDurationMode")}</label>
          <div class="form-fields">
            <select name="durationMode">
              <option value="standard">${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderDurationModeStandard")}</option>
              <option value="nextBastionTurn">${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderDurationModeNextBastionTurn")}</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderRemainingTurns")}</label>
          <div class="form-fields">
            <input type="number" name="remainingTurns" min="1" step="1" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderDurationFormula")}</label>
          <div class="form-fields">
            <input type="text" name="durationFormula" placeholder="1d6" />
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderConsumePerTurn")}</label>
          <div class="form-fields">
            <input type="checkbox" name="consumePerTurn" checked />
          </div>
        </div>
      </form>
    </div>
  `;
}

function readModifierBuilderDataFromForm(form) {
  if (!form) return null;
  const data = new FormData(form);
  return {
    name: String(data.get("name") ?? "").trim(),
    applyToAllVentures: data.get("applyToAllVentures") !== null,
    profitDieStep: asIntegerOr(data.get("profitDieStep"), 0),
    profitDieOverride: normalizeDieSelectValue(data.get("profitDieOverride")),
    minProfitDie: normalizeDieSelectValue(data.get("minProfitDie")),
    lossDieStep: asIntegerOr(data.get("lossDieStep"), 0),
    lossDieOverride: normalizeDieSelectValue(data.get("lossDieOverride")),
    maxLossDie: normalizeDieSelectValue(data.get("maxLossDie")),
    successThresholdOverride: asPositiveIntegerOrNull(data.get("successThresholdOverride")),
    profitRollBonus: asIntegerOr(data.get("profitRollBonus"), 0),
    durationMode: String(data.get("durationMode") ?? "standard").trim() || "standard",
    remainingTurns: asNonNegativeIntegerOrNull(data.get("remainingTurns")),
    durationFormula: String(data.get("durationFormula") ?? "").trim(),
    consumePerTurn: data.get("consumePerTurn") !== null
  };
}

function resolveModifierBuilderForm(event, button) {
  if (button?.form) return button.form;

  const eventTarget = event?.currentTarget ?? event?.target ?? null;
  if (eventTarget?.closest) {
    const appRoot = eventTarget.closest(".application, .app, .window-app");
    const fromRoot = appRoot?.querySelector?.("[data-indy-modifier-form]");
    if (fromRoot) return fromRoot;
  }

  const activeWindow = ui.windows ? Object.values(ui.windows).at(-1) : null;
  const activeElement = activeWindow?.element?.[0] ?? activeWindow?.element ?? null;
  const fromActive = activeElement?.querySelector?.("[data-indy-modifier-form]");
  if (fromActive) return fromActive;

  return document.querySelector("[data-indy-modifier-form]");
}

function readModifierBuilderDataFromLegacyHtml(html) {
  if (!html?.find) return null;
  const read = name => html.find(`[name='${name}']`).val();
  const checked = name => html.find(`[name='${name}']`).is(":checked");
  return {
    name: String(read("name") ?? "").trim(),
    applyToAllVentures: checked("applyToAllVentures"),
    profitDieStep: asIntegerOr(read("profitDieStep"), 0),
    profitDieOverride: normalizeDieSelectValue(read("profitDieOverride")),
    minProfitDie: normalizeDieSelectValue(read("minProfitDie")),
    lossDieStep: asIntegerOr(read("lossDieStep"), 0),
    lossDieOverride: normalizeDieSelectValue(read("lossDieOverride")),
    maxLossDie: normalizeDieSelectValue(read("maxLossDie")),
    successThresholdOverride: asPositiveIntegerOrNull(read("successThresholdOverride")),
    profitRollBonus: asIntegerOr(read("profitRollBonus"), 0),
    durationMode: String(read("durationMode") ?? "standard").trim() || "standard",
    remainingTurns: asNonNegativeIntegerOrNull(read("remainingTurns")),
    durationFormula: String(read("durationFormula") ?? "").trim(),
    consumePerTurn: checked("consumePerTurn")
  };
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

function buildVentureModifierData(input, facilityId = "") {
  const modifier = {
    enabled: true,
    consumePerTurn: Boolean(input.consumePerTurn)
  };
  if (input.applyToAllVentures) modifier.applyToAllVentures = true;
  else if (facilityId) modifier.facilityId = facilityId;
  if (input.profitDieStep) modifier.profitDieStep = input.profitDieStep;
  if (input.profitDieOverride) modifier.profitDieOverride = input.profitDieOverride;
  if (input.minProfitDie) modifier.minProfitDie = input.minProfitDie;
  if (input.lossDieStep) modifier.lossDieStep = input.lossDieStep;
  if (input.lossDieOverride) modifier.lossDieOverride = input.lossDieOverride;
  if (input.maxLossDie) modifier.maxLossDie = input.maxLossDie;
  if (input.successThresholdOverride) modifier.successThresholdOverride = input.successThresholdOverride;
  if (input.profitRollBonus) modifier.profitRollBonus = input.profitRollBonus;
  const durationMode = String(input.durationMode ?? "standard").trim().toLowerCase();
  if (durationMode === "nextbastionturn") {
    modifier.bastionDurationType = "nextBastionTurn";
    modifier.remainingTurns = 1;
    modifier.consumePerTurn = true;
  } else {
    if ((input.remainingTurns !== null) && (input.remainingTurns > 0)) modifier.remainingTurns = input.remainingTurns;
    if (input.durationFormula) modifier.durationFormula = input.durationFormula;
  }
  return modifier;
}

function hasMeaningfulVentureModifier(input) {
  return Boolean(
    input.profitDieStep
    || input.profitDieOverride
    || input.minProfitDie
    || input.lossDieStep
    || input.lossDieOverride
    || input.maxLossDie
    || input.successThresholdOverride
    || input.profitRollBonus
  );
}

async function promptModifierEffectConfig(initialName) {
  const title = game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderTitle");
  const content = buildModifierBuilderDialogContent(initialName);
  const confirmLabel = game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderCreate");

  if (foundry.applications?.api?.DialogV2?.prompt) {
    return foundry.applications.api.DialogV2.prompt({
      window: { title, resizable: true },
      content,
      rejectClose: false,
      ok: {
        label: confirmLabel,
        callback: (event, button) => {
          const form = resolveModifierBuilderForm(event, button);
          return readModifierBuilderDataFromForm(form);
        }
      }
    });
  }

  if (foundry.applications?.api?.Dialog?.prompt) {
    return foundry.applications.api.Dialog.prompt({
      window: { title, resizable: true },
      content,
      ok: {
        label: confirmLabel,
        callback: (event, button) => {
          const form = resolveModifierBuilderForm(event, button);
          return readModifierBuilderDataFromForm(form);
        }
      }
    });
  }

  return Dialog.prompt({
    title,
    content,
    options: {
      resizable: true,
      width: 640,
      height: "auto"
    },
    callback: html => readModifierBuilderDataFromLegacyHtml(html)
  });
}

function buildBoonLine(row) {
  const name = String(row.name ?? "").trim();
  if (!name) return null;

  const cost = Math.max(Number.parseInt(String(row.cost ?? "0"), 10) || 0, 0);
  const description = String(row.description ?? "").trim();
  const reward = String(row.reward ?? "").trim();
  const limit = normalizeLimitText(row.limit);
  const purchaseWhen = normalizePurchaseWhenText(row.purchaseWhen);

  const parts = [name, String(cost), description];
  if (reward) parts.push(reward);
  if (limit) parts.push(limit);
  if (purchaseWhen !== "default") parts.push(purchaseWhen);
  return parts.join(" | ");
}

function serializeBoonRows(root) {
  const rows = Array.from(root.querySelectorAll(".indy-boon-row"));
  const lines = rows
    .map(row => buildBoonLine({
      name: row.querySelector(".boon-name")?.value,
      cost: row.querySelector(".boon-cost")?.value,
      description: row.querySelector(".boon-description")?.value,
      reward: row.querySelector(".boon-reward")?.value,
      limit: row.querySelector(".boon-limit")?.value,
      purchaseWhen: row.querySelector(".boon-purchase-when")?.value
    }))
    .filter(Boolean);
  return lines.join("\n");
}

function createBoonRowElement(doc, values = {}) {
  const row = doc.createElement("div");
  row.classList.add("indy-boon-row");

  const makeInput = ({ cls, type = "text", placeholder, value = "", min = null, step = null }) => {
    const input = doc.createElement("input");
    input.type = type;
    input.classList.add(cls);
    input.placeholder = placeholder;
    input.value = value;
    if (min !== null) input.min = String(min);
    if (step !== null) input.step = String(step);
    return input;
  };

  row.append(makeInput({
    cls: "boon-name",
    placeholder: game.i18n.localize("INDYVENTURES.BoonEditor.Name"),
    value: values.name ?? ""
  }));
  row.append(makeInput({
    cls: "boon-cost",
    type: "number",
    placeholder: game.i18n.localize("INDYVENTURES.BoonEditor.Cost"),
    value: values.cost ?? 0,
    min: 0,
    step: 1
  }));
  row.append(makeInput({
    cls: "boon-description",
    placeholder: game.i18n.localize("INDYVENTURES.BoonEditor.Description"),
    value: values.description ?? ""
  }));
  const rewardCell = doc.createElement("div");
  rewardCell.classList.add("boon-reward-cell");
  rewardCell.append(makeInput({
    cls: "boon-reward",
    placeholder: game.i18n.localize("INDYVENTURES.BoonEditor.RewardPlaceholder"),
    value: values.reward ?? ""
  }));
  const buildReward = doc.createElement("button");
  buildReward.type = "button";
  buildReward.dataset.action = "buildBoonModifierReward";
  buildReward.classList.add("boon-build-effect", "icon", "fa-solid", "fa-wand-magic-sparkles");
  buildReward.ariaLabel = game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderOpen");
  rewardCell.append(buildReward);
  row.append(rewardCell);
  row.append(makeInput({
    cls: "boon-limit",
    placeholder: game.i18n.localize("INDYVENTURES.BoonEditor.LimitPlaceholder"),
    value: values.limit ?? ""
  }));

  const purchaseWhenSelect = doc.createElement("select");
  purchaseWhenSelect.classList.add("boon-purchase-when");
  const selectedValue = normalizePurchaseWhenText(values.purchaseWhen);
  for (const option of getBoonPurchaseWhenOptions()) {
    const element = doc.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    element.selected = option.value === selectedValue;
    purchaseWhenSelect.append(element);
  }
  row.append(purchaseWhenSelect);

  const remove = doc.createElement("button");
  remove.type = "button";
  remove.dataset.action = "removeBoonRow";
  remove.classList.add("boon-remove", "icon", "fa-solid", "fa-trash");
  remove.ariaLabel = game.i18n.localize("INDYVENTURES.BoonEditor.Remove");
  row.append(remove);

  return row;
}

function bindBoonEditorDialog(root) {
  if (!root) return;

  root.addEventListener("dragover", event => {
    const rewardInput = event.target.closest(".boon-reward");
    if (!rewardInput) return;
    const data = TextEditor.getDragEventData(event);
    if (!["Item", "ActiveEffect"].includes(data?.type)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  root.addEventListener("drop", event => {
    const rewardInput = event.target.closest(".boon-reward");
    if (!rewardInput) return;
    const data = TextEditor.getDragEventData(event);
    if (!["Item", "ActiveEffect"].includes(data?.type)) return;
    event.preventDefault();
    const uuidLink = buildUuidLink(data);
    if (!uuidLink) {
      ui.notifications.warn("INDYVENTURES.Errors.BoonDropMissingUuid", { localize: true });
      return;
    }
    rewardInput.value = uuidLink;
    rewardInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

class BoonEditorApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    actions: {
      addBoonRow: BoonEditorApplication.#onAddRow,
      buildBoonModifierReward: BoonEditorApplication.#onBuildModifierReward,
      removeBoonRow: BoonEditorApplication.#onRemoveRow,
      saveBoonEditor: BoonEditorApplication.#onSave,
      cancelBoonEditor: BoonEditorApplication.#onCancel
    },
    classes: ["indy-ventures", "indy-boon-editor-app"],
    position: {
      width: 1100
    },
    tag: "section",
    window: {
      title: "INDYVENTURES.BoonEditor.Title",
      resizable: true
    }
  };

  static PARTS = {
    content: {
      template: TEMPLATE_PATHS.boonEditor
    }
  };

  #textarea;
  #rows;
  #facility;
  #saved = false;

  constructor({ textarea, rows, facility }) {
    super();
    this.#textarea = textarea;
    this.#rows = rows;
    this.#facility = facility;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      boons: this.#rows,
      purchaseWhenOptions: getBoonPurchaseWhenOptions()
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    bindBoonEditorDialog(this.element);
  }

  static #onAddRow(event, target) {
    const rows = this.element?.querySelector?.("[data-boon-rows]");
    if (!rows) return;
    rows.append(createBoonRowElement(this.element.ownerDocument));
  }

  static async #onBuildModifierReward(event, target) {
    const row = target.closest(".indy-boon-row");
    const rewardInput = row?.querySelector?.(".boon-reward");
    if (!row || !rewardInput) return;

    const facility = this.#facility ?? null;
    if (!facility?.createEmbeddedDocuments) {
      ui.notifications.warn("INDYVENTURES.Errors.BoonModifierNoFacility", { localize: true });
      return;
    }

    const boonName = String(row.querySelector(".boon-name")?.value ?? "").trim();
    const initialName = boonName || game.i18n.localize("INDYVENTURES.BoonEditor.ModifierBuilderDefaultName");
    const input = await promptModifierEffectConfig(initialName);
    if (!input) {
      moduleLog("Boon modifier builder: no input returned from dialog", {
        facility: facility.name,
        boonName: boonName || null
      });
      return;
    }

    if (!hasMeaningfulVentureModifier(input)) {
      ui.notifications.warn("INDYVENTURES.Errors.BoonModifierNoChanges", { localize: true });
      return;
    }

    const effectData = {
      name: String(input.name ?? "").trim() || initialName,
      img: "icons/magic/symbols/rune-sigil-green-purple.webp",
      origin: facility.uuid,
      disabled: true,
      transfer: false,
      changes: [],
      flags: {
        [MODULE_ID]: {
          ventureModifier: buildVentureModifierData(input, facility.id),
          ventureModifierTemplate: true
        }
      }
    };
    effectData.changes = buildModifierChangeRows(effectData.flags[MODULE_ID].ventureModifier);

    try {
      moduleLog("Boon modifier builder: creating reward effect", {
        facility: facility.name,
        boonName: boonName || null,
        modifier: effectData.flags?.[MODULE_ID]?.ventureModifier ?? null
      });
      const created = await facility.createEmbeddedDocuments("ActiveEffect", [effectData]);
      const effect = created?.[0];
      if (!effect?.uuid) {
        ui.notifications.error("INDYVENTURES.Errors.BoonModifierCreateFailed", { localize: true });
        return;
      }

      const effectName = String(effect.name ?? "").trim() || effect.uuid;
      rewardInput.value = `@UUID[${effect.uuid}]{${effectName.replace(/[{}]/g, "").trim()}}`;
      rewardInput.dispatchEvent(new Event("input", { bubbles: true }));
      moduleLog("Boon modifier builder: reward effect created", {
        facility: facility.name,
        effectId: effect.id,
        effectUuid: effect.uuid,
        modifier: effect.getFlag(MODULE_ID, "ventureModifier") ?? null
      });
      ui.notifications.info(game.i18n.format("INDYVENTURES.Notifications.BoonModifierLinked", {
        effect: effect.name
      }));
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to create modifier reward effect`, error);
      ui.notifications.error("INDYVENTURES.Errors.BoonModifierCreateFailed", { localize: true });
    }
  }

  static #onRemoveRow(event, target) {
    const rows = this.element?.querySelector?.("[data-boon-rows]");
    const row = target.closest(".indy-boon-row");
    if (!rows || !row) return;
    if (rows.querySelectorAll(".indy-boon-row").length <= 1) {
      for (const input of row.querySelectorAll("input")) input.value = "";
      const select = row.querySelector(".boon-purchase-when");
      if (select) select.value = "default";
      return;
    }
    row.remove();
  }

  static async #onSave(event, target) {
    const value = serializeBoonRows(this.element);
    this.#textarea.value = value;
    this.#textarea.dispatchEvent(new Event("input", { bubbles: true }));
    this.#textarea.dispatchEvent(new Event("change", { bubbles: true }));
    if (this.#facility?.documentName === "Item") {
      try {
        await this.#facility.update({
          [`flags.${MODULE_ID}.config.boonsText`]: value
        });
        moduleLog("Boon editor: persisted boonsText to facility", {
          facility: this.#facility.name,
          boonsTextLength: value.length
        });
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to persist boon editor changes`, error);
        ui.notifications.error("INDYVENTURES.Errors.BoonSaveFailed", { localize: true });
        return;
      }
    }
    this.#textarea.focus();
    this.#saved = true;
    return this.close();
  }

  static #onCancel(event, target) {
    return this.close();
  }

  _onClose(options = {}) {
    super._onClose(options);
    if (!this.#saved) this.#textarea.focus();
  }
}

async function openBoonEditor(textarea, facility = null) {
  const parsed = parseBoonsText(textarea.value ?? "").map(boon => {
    const limitValue = boon.perTurnLimit;
    return {
      name: boon.name ?? "",
      cost: boon.cost ?? 0,
      description: boon.description ?? "",
      rewardUuid: boon.rewardUuid ?? "",
      perTurnLimitDisplay: limitValue === null ? "unlimited" : ((limitValue ?? 1) === 1 ? "" : String(limitValue)),
      purchaseWhen: normalizePurchaseWhenText(boon.purchaseWhen)
    };
  });
  if (!parsed.length) {
    parsed.push({
      name: "",
      cost: 0,
      description: "",
      rewardUuid: "",
      perTurnLimitDisplay: "",
      purchaseWhen: "default"
    });
  }
  const app = new BoonEditorApplication({ textarea, rows: parsed, facility });
  app.render({ force: true });
}

function bindBoonDropTarget(sheet, html) {
  if (sheet?.document?.documentName !== "Item" || sheet.document.type !== "facility") return;

  const root = resolveHtmlRoot(sheet, html);
  const textarea = root?.querySelector?.(BOON_TEXTAREA_SELECTOR);
  if (!textarea || (textarea.dataset.indyVentureDropBound === "true")) return;

  textarea.dataset.indyVentureDropBound = "true";
  textarea.addEventListener("dragover", event => {
    const data = TextEditor.getDragEventData(event);
    if (!["Item", "ActiveEffect"].includes(data?.type)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  textarea.addEventListener("drop", event => {
    const data = TextEditor.getDragEventData(event);
    if (!["Item", "ActiveEffect"].includes(data?.type)) return;

    event.preventDefault();
    event.stopPropagation();

    const uuidLink = buildUuidLink(data);
    if (!uuidLink) {
      ui.notifications.warn("INDYVENTURES.Errors.BoonDropMissingUuid", { localize: true });
      return;
    }

    insertAtCursor(textarea, uuidLink);
    ui.notifications.info("INDYVENTURES.Notifications.BoonRewardUuidInserted", { localize: true });
  });
}

function bindBoonEditorButton(sheet, html) {
  if (sheet?.document?.documentName !== "Item" || sheet.document.type !== "facility") return;

  const root = resolveHtmlRoot(sheet, html);
  const textarea = root?.querySelector?.(BOON_TEXTAREA_SELECTOR);
  const button = root?.querySelector?.('[data-action="openBoonEditor"]');
  if (!textarea || !button || (button.dataset.indyVentureEditorBound === "true")) return;

  button.dataset.indyVentureEditorBound = "true";
  button.addEventListener("click", event => {
    event.preventDefault();
    openBoonEditor(textarea, sheet.document);
  });
}

function bindBoonTableLinks(sheet, html) {
  if (sheet?.document?.documentName !== "Item" || sheet.document.type !== "facility") return;

  const root = resolveHtmlRoot(sheet, html);
  const links = root?.querySelectorAll?.(".indy-ventures-sheet [data-uuid]");
  if (!links?.length) return;

  for (const link of links) {
    if (link.dataset.indyVentureLinkBound === "true") continue;
    link.dataset.indyVentureLinkBound = "true";
    link.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const uuid = String(link.dataset.uuid ?? "").trim();
      if (!uuid) return;
      const doc = await fromUuid(uuid);
      if (!doc?.sheet) return;
      doc.sheet.render(true);
    });
  }
}

function bindFacilityEditorControls(sheet, html) {
  bindBoonDropTarget(sheet, html);
  bindBoonEditorButton(sheet, html);
  bindBoonTableLinks(sheet, html);
}

export function registerFacilitySheetHooks() {
  Hooks.on("preUpdateItem", (item, change) => {
    if (item.type !== "facility") return;
    sanitizeConfigPatchForUpdate(item, change);
    sanitizeStatePatchForUpdate(item, change);
  });
  Hooks.on("renderItemSheet", (sheet, html) => bindFacilityEditorControls(sheet, html));
  Hooks.on("renderItemSheet5e", (sheet, html) => bindFacilityEditorControls(sheet, html));
  Hooks.on("dnd5e.renderItemSheet", (sheet, html) => bindFacilityEditorControls(sheet, html));
  Hooks.on("renderActiveEffectConfig", (sheet, html) => bindActiveEffectModifierSummary(sheet, html));
  Hooks.on("dnd5e.renderActiveEffectConfig", (sheet, html) => bindActiveEffectModifierSummary(sheet, html));
  Hooks.on("renderDAEActiveEffectConfig", (sheet, html) => bindActiveEffectModifierSummary(sheet, html));

  Hooks.on("dnd5e.prepareSheetContext", (sheet, partId, context) => {
    if (partId === "details") {
      if (sheet?.document?.documentName !== "Item" || sheet.document.type !== "facility") return;
      if (!Array.isArray(context.parts)) return;

      context.indyVentures = prepareFacilitySheetContext(sheet.document);
      if (!context.parts.includes(TEMPLATE_PATHS.facilityDetails)) {
        context.parts.unshift(TEMPLATE_PATHS.facilityDetails);
      }
      return;
    }

    if (partId === "bastion") {
      if (sheet?.document?.documentName !== "Actor" || sheet.document.type !== "character") return;
      if (!game.settings.get(MODULE_ID, SETTINGS.hideVentureHirelings)) return;
      const facilities = context.itemCategories?.facilities ?? [];
      for (const facility of facilities) {
        const ventureEnabled = Boolean(facility.getFlag(MODULE_ID, "config")?.enabled);
        if (!ventureEnabled) continue;
        if (context.itemContext?.[facility.id]) {
          context.itemContext[facility.id].hirelings = [];
        }
      }
    }
  });
}

export function registerModuleTemplates() {
  return loadTemplates([TEMPLATE_PATHS.facilityDetails, TEMPLATE_PATHS.chatSummary, TEMPLATE_PATHS.boonEditor]);
}

export function registerModuleApi() {
  const module = game.modules.get(MODULE_ID);
  if (!module) return;
  module.api = {
    getFacilityConfig: facility => facility.getFlag(MODULE_ID, "config"),
    getFacilityState: facility => facility.getFlag(MODULE_ID, "state"),
    resetFacilityState: async facility => {
      if (facility?.documentName !== "Item") return;
      await facility.update({
        [`flags.${MODULE_ID}.state`]: null
      });
    }
  };
}
