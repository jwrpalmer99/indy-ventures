import { MODULE_ID, SETTINGS, TEMPLATE_PATHS } from "./constants.js";
import {
  prepareFacilitySheetContext,
  sanitizeConfigPatchForUpdate,
  sanitizeStatePatchForUpdate
} from "./config.js";
import { parseBoonsText, parseBoonPerTurnLimit, parseBoonPurchaseWhen } from "./utils.js";

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
  row.append(makeInput({
    cls: "boon-reward",
    placeholder: game.i18n.localize("INDYVENTURES.BoonEditor.RewardPlaceholder"),
    value: values.reward ?? ""
  }));
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
  #saved = false;

  constructor({ textarea, rows }) {
    super();
    this.#textarea = textarea;
    this.#rows = rows;
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

  static #onSave(event, target) {
    const value = serializeBoonRows(this.element);
    this.#textarea.value = value;
    this.#textarea.dispatchEvent(new Event("input", { bubbles: true }));
    this.#textarea.dispatchEvent(new Event("change", { bubbles: true }));
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

async function openBoonEditor(textarea) {
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
  const app = new BoonEditorApplication({ textarea, rows: parsed });
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
    openBoonEditor(textarea);
  });
}

function bindBoonTableLinks(sheet, html) {
  if (sheet?.document?.documentName !== "Item" || sheet.document.type !== "facility") return;

  const root = resolveHtmlRoot(sheet, html);
  const links = root?.querySelectorAll?.(".indy-boons-table [data-uuid]");
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
