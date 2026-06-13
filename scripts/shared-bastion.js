import { MODULE_ID, SETTINGS, TEMPLATE_PATHS } from "./constants.js";
import { moduleLog, moduleWarn } from "./logger.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export const VENTURE_PERMISSION_NAMES = ["NONE", "LIMITED", "OBSERVER", "OWNER"];

export const SHARED_BASTION_DEFAULT_CONFIG = {
  enabled: false,
  actorUuid: "",
  defaultPermission: "OBSERVER",
  users: {},
  syncActorOwnership: true,
  limitGlobalAdvance: true,
  facilitySlots: {
    enabled: false,
    normalSpecial: "5:2, 9:4, 13:5, 17:6",
    ventureSpecial: "5:0"
  }
};

export const DEFAULT_FACILITY_VENTURE_PERMISSIONS = {
  defaultPermission: "OBSERVER",
  users: {}
};

const patchedSheetClasses = new WeakSet();
const facilityVentureLocks = new Map();
let dndBastionAdvancePatched = false;
let originalDndFacilityAdvancement = null;

function getOwnershipLevels() {
  return CONST?.DOCUMENT_OWNERSHIP_LEVELS ?? {
    NONE: 0,
    LIMITED: 1,
    OBSERVER: 2,
    OWNER: 3
  };
}

export function normalizePermissionName(value, fallback = "OBSERVER") {
  const levels = getOwnershipLevels();
  if (typeof value === "number") {
    const match = Object.entries(levels).find(([, level]) => level === value);
    return VENTURE_PERMISSION_NAMES.includes(match?.[0]) ? match[0] : fallback;
  }

  const name = String(value ?? "").trim().toUpperCase();
  return VENTURE_PERMISSION_NAMES.includes(name) ? name : fallback;
}

export function normalizeFacilityVenturePermissions(raw = {}) {
  const config = foundry.utils.mergeObject(DEFAULT_FACILITY_VENTURE_PERMISSIONS, raw, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });

  config.defaultPermission = normalizePermissionName(config.defaultPermission, "OBSERVER");
  const users = {};
  if (config.users && (typeof config.users === "object")) {
    for (const [userId, permission] of Object.entries(config.users)) {
      const normalized = normalizePermissionName(permission, "");
      if (!normalized) continue;
      users[userId] = normalized;
    }
  }
  config.users = users;
  return config;
}

export function getFacilityVenturePermissionConfig(facility) {
  return normalizeFacilityVenturePermissions(facility?.getFlag?.(MODULE_ID, "permissions") ?? {});
}

export function getVenturePermissionLevel(permissionName) {
  const levels = getOwnershipLevels();
  const name = normalizePermissionName(permissionName, "NONE");
  return levels[name] ?? 0;
}

export async function withFacilityVentureLock(facilityUuid, work) {
  const key = String(facilityUuid ?? "").trim();
  if (!key) return work();

  const previous = facilityVentureLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  facilityVentureLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (facilityVentureLocks.get(key) === current) {
      facilityVentureLocks.delete(key);
    }
  }
}

function sortSlotTable(table) {
  return Object.fromEntries(
    Object.entries(table ?? {})
      .map(([level, count]) => [Number(level), Number(count)])
      .filter(([level, count]) => Number.isInteger(level) && Number.isInteger(count) && level > 0 && count >= 0)
      .sort(([a], [b]) => a - b)
      .map(([level, count]) => [String(level), count])
  );
}

function parseFacilitySlotTable(value, fallback = {}) {
  if (value && (typeof value === "object") && !Array.isArray(value)) {
    const parsed = sortSlotTable(value);
    return Object.keys(parsed).length ? parsed : foundry.utils.deepClone(fallback);
  }

  const table = {};
  for (const part of String(value ?? "").split(/[,;\n]+/)) {
    const match = part.trim().match(/^(\d+)\s*[:=]\s*(\d+)$/);
    if (!match) continue;
    const level = Number(match[1]);
    const count = Number(match[2]);
    if (!Number.isInteger(level) || !Number.isInteger(count) || level <= 0 || count < 0) continue;
    table[level] = count;
  }

  const parsed = sortSlotTable(table);
  return Object.keys(parsed).length ? parsed : foundry.utils.deepClone(fallback);
}

function formatFacilitySlotTable(table) {
  return Object.entries(sortSlotTable(table))
    .map(([level, count]) => `${level}:${count}`)
    .join(", ");
}

function getDefaultFacilitySlotTable(type) {
  const dndType = type === "normalSpecial" ? "special" : type;
  const configured = originalDndFacilityAdvancement?.[dndType] ?? CONFIG?.DND5E?.facilities?.advancement?.[dndType];
  const fallback = parseFacilitySlotTable(SHARED_BASTION_DEFAULT_CONFIG.facilitySlots[type], {});
  return parseFacilitySlotTable(configured, fallback);
}

function normalizeFacilitySlotConfig(raw = {}) {
  const config = foundry.utils.mergeObject(SHARED_BASTION_DEFAULT_CONFIG.facilitySlots, raw, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });

  const normalSpecialFallback = getDefaultFacilitySlotTable("normalSpecial");
  const ventureSpecialFallback = getDefaultFacilitySlotTable("ventureSpecial");
  config.enabled = Boolean(config.enabled);
  config.normalSpecial = formatFacilitySlotTable(parseFacilitySlotTable(
    config.normalSpecial ?? config.special,
    normalSpecialFallback
  ));
  config.ventureSpecial = formatFacilitySlotTable(parseFacilitySlotTable(
    config.ventureSpecial,
    ventureSpecialFallback
  ));
  delete config.basic;
  delete config.special;
  return config;
}

export function getFacilitySlotLimit(table, level) {
  const entries = Object.entries(parseFacilitySlotTable(table, {}))
    .map(([entryLevel, slots]) => [Number(entryLevel), Number(slots)])
    .filter(([entryLevel, slots]) => Number.isInteger(entryLevel) && Number.isInteger(slots) && entryLevel <= level)
    .sort(([a], [b]) => b - a);
  return entries[0]?.[1] ?? 0;
}

export function getSharedBastionFacilitySlotLimits(actor = null) {
  const config = getSharedBastionConfig();
  const enabled = Boolean(config.enabled && config.facilitySlots.enabled && (!actor || isSharedBastionActor(actor)));
  const level = Number(actor?.system?.details?.level ?? 0);
  return {
    enabled,
    normalSpecial: getFacilitySlotLimit(config.facilitySlots.normalSpecial, level),
    ventureSpecial: getFacilitySlotLimit(config.facilitySlots.ventureSpecial, level)
  };
}

export function isIndyVentureFacility(facilityOrData) {
  if (!facilityOrData) return false;
  if (facilityOrData.getFlag) return facilityOrData.getFlag(MODULE_ID, "config")?.enabled === true;
  return foundry.utils.getProperty(facilityOrData, `flags.${MODULE_ID}.config.enabled`) === true;
}

export function getSharedBastionSpecialFacilityUsage(actor, { excludeId = "" } = {}) {
  const usage = { normal: 0, venture: 0 };
  for (const facility of actor?.itemTypes?.facility ?? []) {
    if (excludeId && (facility.id === excludeId)) continue;
    if (facility.system?.type?.value !== "special") continue;
    if (facility.system?.free) continue;
    if (isIndyVentureFacility(facility)) usage.venture += 1;
    else usage.normal += 1;
  }
  return usage;
}

export function getSharedBastionSpecialFacilityLimitStatus(actor, { venture = false, excludeId = "" } = {}) {
  const limits = getSharedBastionFacilitySlotLimits(actor);
  const usage = getSharedBastionSpecialFacilityUsage(actor, { excludeId });
  const bucket = venture ? "venture" : "normal";
  const value = usage[bucket] ?? 0;
  const max = venture ? limits.ventureSpecial : limits.normalSpecial;
  return {
    enabled: limits.enabled,
    bucket,
    value,
    max,
    allowed: !limits.enabled || (value < max),
    usage,
    limits
  };
}

export function getSharedBastionConfig() {
  const raw = game.settings?.get(MODULE_ID, SETTINGS.sharedBastion) ?? {};
  const config = foundry.utils.mergeObject(SHARED_BASTION_DEFAULT_CONFIG, raw, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });

  config.enabled = Boolean(config.enabled);
  config.actorUuid = normalizeActorUuid(config.actorUuid);
  config.defaultPermission = normalizePermissionName(config.defaultPermission, "OBSERVER");
  config.syncActorOwnership = config.syncActorOwnership !== false;
  config.limitGlobalAdvance = config.limitGlobalAdvance !== false;
  config.facilitySlots = normalizeFacilitySlotConfig(config.facilitySlots);

  const users = {};
  if (config.users && (typeof config.users === "object")) {
    for (const [userId, permission] of Object.entries(config.users)) {
      const id = String(userId ?? "").trim();
      if (!id) continue;
      users[id] = normalizePermissionName(permission, config.defaultPermission);
    }
  }
  config.users = users;

  return config;
}

export function normalizeSharedBastionConfig(raw = {}) {
  const config = foundry.utils.mergeObject(SHARED_BASTION_DEFAULT_CONFIG, raw, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });

  config.enabled = Boolean(config.enabled);
  config.actorUuid = normalizeActorUuid(config.actorUuid);
  config.defaultPermission = normalizePermissionName(config.defaultPermission, "OBSERVER");
  config.syncActorOwnership = Boolean(config.syncActorOwnership);
  config.limitGlobalAdvance = Boolean(config.limitGlobalAdvance);
  config.facilitySlots = normalizeFacilitySlotConfig(config.facilitySlots);

  const users = {};
  for (const [userId, permission] of Object.entries(config.users ?? {})) {
    const normalized = normalizePermissionName(permission, "");
    if (!normalized) continue;
    users[userId] = normalized;
  }
  config.users = users;
  return config;
}

export function applySharedBastionFacilitySlots() {
  const advancement = CONFIG?.DND5E?.facilities?.advancement;
  if (!advancement) return;

  if (!originalDndFacilityAdvancement) {
    originalDndFacilityAdvancement = foundry.utils.deepClone(advancement);
  }

  const config = getSharedBastionConfig();
  const useOverride = config.enabled && config.facilitySlots.enabled;

  advancement.basic = foundry.utils.deepClone(sortSlotTable(originalDndFacilityAdvancement.basic));
  advancement.special = foundry.utils.deepClone(sortSlotTable(originalDndFacilityAdvancement.special));

  moduleLog("Applied shared bastion facility slot configuration", {
    enabled: useOverride,
    basic: advancement.basic,
    dndSpecial: advancement.special,
    normalSpecial: useOverride
      ? parseFacilitySlotTable(config.facilitySlots.normalSpecial, getDefaultFacilitySlotTable("normalSpecial"))
      : {},
    ventureSpecial: useOverride
      ? parseFacilitySlotTable(config.facilitySlots.ventureSpecial, getDefaultFacilitySlotTable("ventureSpecial"))
      : {}
  });
}

function normalizeActorUuid(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("Actor.")) return raw;
  if (/^[A-Za-z0-9]{16}$/.test(raw) && game?.actors?.has(raw)) return `Actor.${raw}`;
  return raw;
}

function getWorldActorFromUuidSync(uuid) {
  const actorUuid = normalizeActorUuid(uuid);
  if (!actorUuid) return null;
  const id = actorUuid.startsWith("Actor.") ? actorUuid.slice("Actor.".length).split(".")[0] : actorUuid;
  return game.actors?.get(id) ?? null;
}

export function getSharedBastionActorSync() {
  const config = getSharedBastionConfig();
  if (!config.enabled || !config.actorUuid) return null;
  const actor = getWorldActorFromUuidSync(config.actorUuid);
  return actor?.documentName === "Actor" ? actor : null;
}

export async function getSharedBastionActor() {
  const config = getSharedBastionConfig();
  if (!config.enabled || !config.actorUuid) return null;

  try {
    const actor = await fromUuid(config.actorUuid);
    if (actor?.documentName === "Actor") return actor;
  } catch (error) {
    moduleWarn("Unable to resolve shared bastion actor by UUID", {
      actorUuid: config.actorUuid,
      error: String(error?.message ?? error)
    });
  }

  return getWorldActorFromUuidSync(config.actorUuid);
}

export function isSharedBastionActor(actor) {
  if (!actor || actor.documentName !== "Actor") return false;
  const config = getSharedBastionConfig();
  if (!config.enabled || !config.actorUuid) return false;
  const normalized = normalizeActorUuid(config.actorUuid);
  return actor.uuid === normalized || `Actor.${actor.id}` === normalized || actor.id === normalized;
}

export function getUserSharedVenturePermissionName(user = game.user) {
  if (user?.isGM) return "OWNER";
  const config = getSharedBastionConfig();
  return normalizePermissionName(config.users?.[user?.id] ?? config.defaultPermission, config.defaultPermission);
}

export function getActorVenturePermissionLevel(actor, user = game.user) {
  if (user?.isGM) return getVenturePermissionLevel("OWNER");
  if (isSharedBastionActor(actor)) return getVenturePermissionLevel(getUserSharedVenturePermissionName(user));
  return actor?.getUserLevel?.(user) ?? 0;
}

export function getFacilityVenturePermissionLevel(facility, user = game.user) {
  const actor = facility?.actor;
  if (user?.isGM) return getVenturePermissionLevel("OWNER");
  if (!actor) return 0;

  if (!isSharedBastionActor(actor)) return actor.getUserLevel?.(user) ?? 0;

  const actorLevel = getActorVenturePermissionLevel(actor, user);
  const config = getFacilityVenturePermissionConfig(facility);
  const facilityPermission = normalizePermissionName(
    config.users?.[user?.id] ?? config.defaultPermission,
    config.defaultPermission
  );
  const facilityLevel = getVenturePermissionLevel(facilityPermission);
  return Math.min(actorLevel, facilityLevel);
}

export function canViewActorVentures(actor, user = game.user, permission = "LIMITED") {
  if (user?.isGM) return true;
  if (!actor) return false;
  return getActorVenturePermissionLevel(actor, user) >= getVenturePermissionLevel(permission);
}

export function canViewFacilityVenture(facility, user = game.user, permission = "LIMITED") {
  if (user?.isGM) return true;
  if (!facility) return false;
  return getFacilityVenturePermissionLevel(facility, user) >= getVenturePermissionLevel(permission);
}

export function canManageActorVentures(actor, user = game.user) {
  if (user?.isGM) return true;
  if (!actor) return false;
  if (isSharedBastionActor(actor)) {
    return getActorVenturePermissionLevel(actor, user) >= getVenturePermissionLevel("OWNER");
  }
  return actor.testUserPermission?.(user, "OWNER") === true;
}

export function canManageFacilityVenture(facility, user = game.user) {
  if (user?.isGM) return true;
  if (!facility) return false;
  if (isSharedBastionActor(facility.actor)) {
    return getFacilityVenturePermissionLevel(facility, user) >= getVenturePermissionLevel("OWNER");
  }
  return facility.actor?.testUserPermission?.(user, "OWNER") === true;
}

export function getPreferredVentureUser(actor, permission = "OWNER", facility = null) {
  if (!actor) return null;
  const threshold = getVenturePermissionLevel(permission);

  if (isSharedBastionActor(actor)) {
    const activeUsers = game.users.filter(user => user.active && !user.isGM);
    return activeUsers.find(user => {
      const level = facility
        ? getFacilityVenturePermissionLevel(facility, user)
        : getActorVenturePermissionLevel(actor, user);
      return level >= threshold;
    })
      ?? game.users.find(user => user.active && user.isGM)
      ?? null;
  }

  const activeOwners = game.users
    .filter(user => user.active && actor.testUserPermission(user, "OWNER"));
  return activeOwners.find(user => !user.isGM) ?? activeOwners[0] ?? null;
}

export function getVentureSummaryWhisperUserIds(actor, results = []) {
  if (!isSharedBastionActor(actor)) return null;
  const allowed = game.users.filter(user => (
    user.isGM || results.some(result => {
      const facility = actor.items?.get?.(result?.facilityId)
        ?? actor.itemTypes?.facility?.find?.(item => item.uuid === result?.facilityUuid);
      return canViewFacilityVenture(facility, user, "LIMITED");
    })
  ));
  return allowed.map(user => user.id);
}

export function getPermissionOptions(includeDefault = false) {
  const options = VENTURE_PERMISSION_NAMES.map(value => ({
    value,
    label: game.i18n.localize(`INDYVENTURES.SharedBastion.Permission.${value}`)
  }));
  if (!includeDefault) return options;
  return [
    {
      value: "",
      label: game.i18n.localize("INDYVENTURES.SharedBastion.Permission.Default")
    },
    ...options
  ];
}

export function prepareFacilityVenturePermissionContext(facility) {
  if (!facility || !isSharedBastionActor(facility.actor) || !game.user?.isGM) return null;
  const config = getFacilityVenturePermissionConfig(facility);
  return {
    config,
    permissionOptions: getPermissionOptions(),
    userPermissionOptions: getPermissionOptions(true),
    users: game.users
      .filter(user => !user.isGM)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(user => {
        const sharedPermission = getUserSharedVenturePermissionName(user);
        const override = config.users?.[user.id] ?? "";
        const venturePermission = override || config.defaultPermission;
        const effectiveLevel = Math.min(
          getVenturePermissionLevel(sharedPermission),
          getVenturePermissionLevel(venturePermission)
        );
        const effective = VENTURE_PERMISSION_NAMES.find(name => getVenturePermissionLevel(name) === effectiveLevel) ?? "NONE";
        return {
          id: user.id,
          name: user.name,
          sharedPermission,
          sharedPermissionLabel: game.i18n.localize(`INDYVENTURES.SharedBastion.Permission.${sharedPermission}`),
          override,
          venturePermission,
          effective,
          effectiveLabel: game.i18n.localize(`INDYVENTURES.SharedBastion.Permission.${effective}`)
        };
      })
  };
}

export function sanitizeFacilityVenturePermissionsPatch(change, facility = null) {
  const path = `flags.${MODULE_ID}.permissions`;
  const patch = foundry.utils.getProperty(change, path);
  if (!patch) return;
  const current = facility ? getFacilityVenturePermissionConfig(facility) : DEFAULT_FACILITY_VENTURE_PERMISSIONS;
  const merged = foundry.utils.mergeObject(current, patch, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  foundry.utils.setProperty(change, path, normalizeFacilityVenturePermissions(merged));
}

function getCharacterActorOptions() {
  const actors = game.actors
    .filter(actor => actor.type === "character")
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    {
      value: "",
      label: game.i18n.localize("INDYVENTURES.SharedBastion.NoActor")
    },
    ...actors.map(actor => ({
      value: actor.uuid,
      label: `${actor.name} (${actor.itemTypes?.facility?.length ?? 0})`
    }))
  ];
}

export class SharedBastionConfigApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    actions: {
      cancel: SharedBastionConfigApplication.#onCancel,
      openActor: SharedBastionConfigApplication.#onOpenActor,
      save: SharedBastionConfigApplication.#onSave
    },
    classes: ["dnd5e2", "indy-ventures", "indy-shared-bastion-config"],
    id: "indy-ventures-shared-bastion-config",
    position: {
      width: 720
    },
    tag: "section",
    window: {
      title: "INDYVENTURES.SharedBastion.ConfigTitle",
      resizable: true
    }
  };

  static PARTS = {
    content: {
      template: TEMPLATE_PATHS.sharedBastionConfig
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const config = getSharedBastionConfig();
    const actor = getWorldActorFromUuidSync(config.actorUuid);
    return {
      ...context,
      config,
      actor,
      actorName: actor?.name ?? "",
      actorOptions: getCharacterActorOptions(),
      permissionOptions: getPermissionOptions(),
      userPermissionOptions: getPermissionOptions(true),
      users: game.users
        .filter(user => !user.isGM)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(user => {
          const override = config.users?.[user.id] ?? "";
          const effective = override || config.defaultPermission;
          return {
            id: user.id,
            name: user.name,
            override,
            effective,
            effectiveLabel: game.i18n.localize(`INDYVENTURES.SharedBastion.Permission.${effective}`),
            active: user.active
          };
        })
    };
  }

  static async #onSave(event, target) {
    event.preventDefault();
    const form = this.element?.querySelector?.("[data-indy-shared-bastion-form]");
    if (!form) return;

    const data = new FormData(form);
    const users = {};
    for (const user of game.users.filter(entry => !entry.isGM)) {
      const permission = normalizePermissionName(data.get(`user.${user.id}`), "");
      if (permission) users[user.id] = permission;
    }

    const config = normalizeSharedBastionConfig({
      enabled: data.get("enabled") !== null,
      actorUuid: data.get("actorUuid"),
      defaultPermission: data.get("defaultPermission"),
      syncActorOwnership: data.get("syncActorOwnership") !== null,
      limitGlobalAdvance: data.get("limitGlobalAdvance") !== null,
      facilitySlots: {
        enabled: data.get("facilitySlots.enabled") !== null,
        normalSpecial: data.get("facilitySlots.normalSpecial"),
        ventureSpecial: data.get("facilitySlots.ventureSpecial")
      },
      users
    });

    await game.settings.set(MODULE_ID, SETTINGS.sharedBastion, config);
    applySharedBastionFacilitySlots();
    await syncSharedBastionActorOwnership();
    const actor = await getSharedBastionActor();
    patchSharedBastionSheetTabs(actor);
    if (actor?.sheet?.rendered) {
      if (actor.sheet?.tabGroups) actor.sheet.tabGroups.primary = "bastion";
      await actor.sheet.render({ force: true });
    }
    ui.notifications.info("INDYVENTURES.SharedBastion.Saved", { localize: true });
    return this.close();
  }

  static #onCancel(event, target) {
    event.preventDefault();
    return this.close();
  }

  static async #onOpenActor(event, target) {
    event.preventDefault();
    const form = this.element?.querySelector?.("[data-indy-shared-bastion-form]");
    const actorUuid = form ? new FormData(form).get("actorUuid") : getSharedBastionConfig().actorUuid;
    const actor = getWorldActorFromUuidSync(actorUuid);
    if (!actor) {
      ui.notifications.warn("INDYVENTURES.SharedBastion.ActorMissing", { localize: true });
      return;
    }
    patchSharedBastionSheetTabs(actor);
    if (actor.sheet?.tabGroups) actor.sheet.tabGroups.primary = "bastion";
    try {
      return actor.sheet?.render?.({ force: true });
    } catch (error) {
      return actor.sheet?.render?.(true);
    }
  }
}

export async function syncSharedBastionActorOwnership() {
  if (!game.user?.isGM) return;
  const config = getSharedBastionConfig();
  if (!config.enabled || !config.actorUuid || !config.syncActorOwnership) return;

  const actor = await getSharedBastionActor();
  if (!actor) {
    ui.notifications?.warn?.("INDYVENTURES.SharedBastion.ActorMissing", { localize: true });
    return;
  }

  const ownership = foundry.utils.deepClone(actor.ownership ?? {});
  ownership.default = getVenturePermissionLevel(config.defaultPermission);

  for (const user of game.users.filter(entry => !entry.isGM)) {
    if (Object.prototype.hasOwnProperty.call(config.users, user.id)) {
      ownership[user.id] = getVenturePermissionLevel(config.users[user.id]);
    } else {
      delete ownership[user.id];
    }
  }

  const before = JSON.stringify(actor.ownership ?? {});
  const after = JSON.stringify(ownership);
  if (before === after) return;

  moduleLog("Synchronizing shared bastion actor ownership", {
    actor: actor.name,
    actorUuid: actor.uuid,
    ownership
  });
  await actor.update({ ownership }, { render: false });
}

function patchSharedBastionSheetTabs(actor = null) {
  const sheetClass = actor?.sheet?.constructor;
  const prototype = sheetClass?.prototype;
  if (!prototype?._prepareTabsContext || patchedSheetClasses.has(sheetClass)) return;

  const original = prototype._prepareTabsContext;
  const parentPrepareTabs = Object.getPrototypeOf(prototype)?._prepareTabsContext;
  patchedSheetClasses.add(sheetClass);

  prototype._prepareTabsContext = async function(context, options) {
    const actor = this.actor ?? this.document;
    const sharedActor = getSharedBastionActorSync();
    const forceBastionTab = Boolean(actor?.type === "character")
      && Boolean(game.settings.get("dnd5e", "bastionConfiguration")?.enabled)
      && (
        isSharedBastionActor(actor)
        || (
          actor?.documentName === "Actor"
          && !isSharedBastionActor(actor)
          && getSharedBastionConfig().enabled
          && canViewActorVentures(sharedActor, game.user, "LIMITED")
        )
      )
      && (typeof parentPrepareTabs === "function");

    if (!forceBastionTab) return original.call(this, context, options);
    return parentPrepareTabs.call(this, context, options);
  };
}

function bindSharedBastionTab(sheet, html) {
  const actor = sheet?.document ?? sheet?.actor;
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return;
  if (!getSharedBastionConfig().enabled) return;
  if (isSharedBastionActor(actor)) return;
  if (!canViewActorVentures(getSharedBastionActorSync(), game.user, "LIMITED")) return;

  const root = resolveHtmlRoot(sheet, html);
  if (!root) return;

  for (const tab of root.querySelectorAll('[data-tab="bastion"]')) {
    if (!tab.closest("nav, .tabs, [data-application-part='tabs']")) continue;
    if (tab.dataset.indySharedBastionTab === "1") continue;
    tab.dataset.indySharedBastionTab = "1";
    tab.dataset.tooltip = game.i18n.localize("INDYVENTURES.SharedBastion.OpenTooltip");
    tab.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openSharedBastionSheet();
    }, { capture: true });
  }
}

function resolveHtmlRoot(sheet, html) {
  if (html instanceof HTMLElement) return html;
  if (Array.isArray(html) && (html[0] instanceof HTMLElement)) return html[0];
  if (html?.jquery && (html[0] instanceof HTMLElement)) return html[0];
  if (sheet?.element instanceof HTMLElement) return sheet.element;
  return null;
}

export async function openSharedBastionSheet() {
  const actor = await getSharedBastionActor();
  if (!actor) {
    ui.notifications.warn("INDYVENTURES.SharedBastion.ActorMissing", { localize: true });
    return;
  }
  if (!actor.testUserPermission(game.user, "LIMITED")) {
    ui.notifications.warn("INDYVENTURES.SharedBastion.NoViewPermission", { localize: true });
    return;
  }

  patchSharedBastionSheetTabs(actor);
  const sheet = actor.sheet;
  if (!sheet?.render) return;
  if (sheet.tabGroups) sheet.tabGroups.primary = "bastion";

  try {
    await sheet.render({ force: true });
  } catch (error) {
    sheet.render(true);
  }
}

function patchDndBastionAdvance() {
  const bastion = game.dnd5e?.bastion;
  if (!bastion?.advanceAllBastions || dndBastionAdvancePatched) return;
  dndBastionAdvancePatched = true;
  const original = bastion.advanceAllBastions.bind(bastion);

  bastion.advanceAllBastions = async function(...args) {
    const config = getSharedBastionConfig();
    if (!config.enabled || !config.limitGlobalAdvance) return original(...args);

    const actor = await getSharedBastionActor();
    if (!actor) {
      ui.notifications.warn("INDYVENTURES.SharedBastion.ActorMissing", { localize: true });
      return original(...args);
    }

    const { duration = 7 } = game.settings.get("dnd5e", "bastionConfiguration") ?? {};
    moduleLog("Advancing configured shared bastion instead of all character bastions", {
      actor: actor.name,
      actorUuid: actor.uuid,
      duration
    });
    return bastion.advanceAllFacilities(actor, { duration });
  };
}

export function registerSharedBastionHooks() {
  Hooks.on("renderApplicationV2", (sheet, html) => bindSharedBastionTab(sheet, html));
  Hooks.on("renderActorSheet", (sheet, html) => bindSharedBastionTab(sheet, html));
  Hooks.on("renderActorSheet5e", (sheet, html) => bindSharedBastionTab(sheet, html));
  Hooks.on("renderCharacterActorSheet", (sheet, html) => bindSharedBastionTab(sheet, html));
  Hooks.on("dnd5e.renderActorSheet", (sheet, html) => bindSharedBastionTab(sheet, html));

  Hooks.on("createUser", () => syncSharedBastionActorOwnership());
  Hooks.on("deleteUser", () => syncSharedBastionActorOwnership());
}

export async function initializeSharedBastion() {
  applySharedBastionFacilitySlots();
  const actor = await getSharedBastionActor();
  patchSharedBastionSheetTabs(actor);
  patchDndBastionAdvance();
  await syncSharedBastionActorOwnership();
}
