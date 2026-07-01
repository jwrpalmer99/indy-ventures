import { MODULE_ID, SETTINGS, TEMPLATE_PATHS } from "./constants.js";
import { moduleLog, moduleWarn } from "./logger.js";

const { ApplicationV2, DocumentSheetV2, HandlebarsApplicationMixin } = foundry.applications.api;

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
const patchedBastionLevelSheetClasses = new WeakSet();
const facilityVentureLocks = new Map();
const sharedBastionSheetModes = new WeakMap();
const SHARED_BASTION_SHEET_CLASS_ID = `${MODULE_ID}.SharedBastionActorSheet`;
const SHARED_BASTION_LEVEL_FLAG = "bastionLevel";
let dndBastionAdvancePatched = false;
let dndFacilityBrowserPatched = false;
let originalDndFacilityAdvancement = null;
let sharedBastionActorSheetClass = null;
let sharedBastionActorSheetRegistered = false;

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
  const level = getActorBastionLevel(actor);
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

function getBastionMaximumLevel() {
  const max = Number(CONFIG?.DND5E?.maxLevel ?? 20);
  return Number.isInteger(max) && max > 0 ? max : 20;
}

function normalizeBastionLevel(value, fallback = null, minimum = 1) {
  const level = Number(value);
  if (!Number.isFinite(level)) return fallback;
  return Math.min(Math.max(Math.trunc(level), minimum), getBastionMaximumLevel());
}

export function getSharedBastionLevel(actor, { fallbackToActor = true } = {}) {
  const configured = isSharedBastionActor(actor)
    ? normalizeBastionLevel(actor.getFlag?.(MODULE_ID, SHARED_BASTION_LEVEL_FLAG), null)
    : null;
  if (configured !== null) return configured;
  if (!fallbackToActor) return null;
  const actorLevel = normalizeBastionLevel(actor?.system?.details?.level, 0, 0) ?? 0;
  if (isSharedBastionActor(actor) && actorLevel < getBastionMinimumLevel()) return getBastionMinimumLevel();
  return actorLevel;
}

function getActorBastionLevel(actor) {
  if (isSharedBastionActor(actor)) return getSharedBastionLevel(actor);
  return normalizeBastionLevel(actor?.system?.details?.level, 0, 0) ?? 0;
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
    const previousConfig = getSharedBastionConfig();
    const actorUuid = normalizeActorUuid(data.get("actorUuid"));
    const sharedActorChanged = Boolean(actorUuid) && actorUuid !== previousConfig.actorUuid;
    const users = {};
    for (const user of game.users.filter(entry => !entry.isGM)) {
      const permission = normalizePermissionName(data.get(`user.${user.id}`), "");
      if (permission) users[user.id] = permission;
    }

    const config = normalizeSharedBastionConfig({
      enabled: data.get("enabled") !== null,
      actorUuid,
      defaultPermission: sharedActorChanged ? "OWNER" : data.get("defaultPermission"),
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
    registerSharedBastionActorSheet();
    await syncSharedBastionActorOwnership();
    const actor = await getSharedBastionActor();
    await ensureSharedBastionActorSheet(actor);
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
    await ensureSharedBastionActorSheet(actor);
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

function getBastionSlotLimit(type, level) {
  const config = CONFIG?.DND5E?.facilities?.advancement?.[type] ?? {};
  const entry = Object.entries(config)
    .map(([entryLevel, slots]) => [Number(entryLevel), Number(slots)])
    .filter(([entryLevel, slots]) => Number.isInteger(entryLevel) && entryLevel <= level && Number.isInteger(slots))
    .sort(([a], [b]) => b - a)[0];
  return entry?.[1] ?? 0;
}

function applySharedBastionLevelToContext(actor, context) {
  if (!isSharedBastionActor(actor) || !context?.facilities) return;
  const level = getSharedBastionLevel(actor);
  context.indySharedBastionLevel = level;

  for (const [type, facilities] of Object.entries(context.facilities)) {
    const max = getBastionSlotLimit(type, level);
    facilities.value = (facilities.chosen ?? []).filter(({ free }) => (type === "basic") || !free).length;
    facilities.max = max;
    facilities.available = Array.fromRange(Math.max(0, max - facilities.value)).map(() => ({
      label: `DND5E.FACILITY.AvailableFacility.${type}.free`
    }));
  }

  if (!context.facilities.basic?.available?.length) {
    context.facilities.basic?.available?.push?.({
      label: "DND5E.FACILITY.AvailableFacility.basic.build"
    });
  }
}

function patchSharedBastionLevelMethods(sheetClass) {
  if (!sheetClass || patchedBastionLevelSheetClasses.has(sheetClass)) return;
  patchedBastionLevelSheetClasses.add(sheetClass);

  if ((typeof sheetClass.hasBastion === "function") && !sheetClass.hasBastion._indySharedBastionPatched) {
    const originalHasBastion = sheetClass.hasBastion;
    sheetClass.hasBastion = function(actor, ...args) {
      if (isSharedBastionActor(actor)) {
        return Boolean(game.settings.get("dnd5e", "bastionConfiguration")?.enabled)
          && getSharedBastionLevel(actor) >= getBastionMinimumLevel();
      }
      return originalHasBastion.call(this, actor, ...args);
    };
    sheetClass.hasBastion._indySharedBastionPatched = true;
  }

  const prototype = sheetClass.prototype;
  patchSharedBastionEditModeMethods(prototype);
  patchSharedBastionFakeLevelRenderMethods(prototype);
  patchSharedBastionFindItemAction(prototype);
  if (!prototype || (typeof prototype._prepareBastionContext !== "function")
    || prototype._prepareBastionContext._indySharedBastionPatched) return;

  const originalPrepareBastionContext = prototype._prepareBastionContext;
  prototype._prepareBastionContext = async function(context, options) {
    const prepared = await originalPrepareBastionContext.call(this, context, options);
    applySharedBastionLevelToContext(this.actor ?? this.document, prepared ?? context);
    return prepared;
  };
  prototype._prepareBastionContext._indySharedBastionPatched = true;
}

function withTemporarySharedBastionLevel(sheet, work) {
  const actor = sheet?.actor ?? sheet?.document;
  if (!isSharedBastionActor(actor)) return work();

  const restore = applyTemporarySharedBastionLevel(actor);
  try {
    return work();
  } finally {
    restore?.();
  }
}

async function withTemporarySharedBastionLevelAsync(sheet, work) {
  const actor = sheet?.actor ?? sheet?.document;
  if (!isSharedBastionActor(actor)) return work();

  const restore = applyTemporarySharedBastionLevel(actor);
  try {
    return await work();
  } finally {
    restore?.();
  }
}

function patchSharedBastionFakeLevelRenderMethods(prototype) {
  if (!prototype) return;

  for (const methodName of [
    "_prepareContext",
    "_preparePartContext",
    "_prepareTabsContext",
    "_configureRenderParts",
    "_getTabs"
  ]) {
    const original = prototype[methodName];
    if (typeof original !== "function" || original._indySharedBastionFakeLevelPatched) continue;

    prototype[methodName] = function(...args) {
      const call = () => original.apply(this, args);
      return methodName.startsWith("_prepare")
        ? withTemporarySharedBastionLevelAsync(this, call)
        : withTemporarySharedBastionLevel(this, call);
    };
    prototype[methodName]._indySharedBastionFakeLevelPatched = true;
  }
}

function patchSharedBastionEditModeMethods(prototype) {
  if (!prototype) return;
  for (const methodName of [
    "_onChangeSheetMode",
    "_onToggleSheetMode",
    "_onToggleEditMode",
    "_toggleEditMode",
    "changeSheetMode",
    "toggleEditMode",
    "toggleSheetMode",
    "setSheetMode"
  ]) {
    const original = prototype[methodName];
    if (typeof original !== "function" || original._indySharedBastionPatched) continue;
    moduleLog("Patching shared bastion sheet mode method", {
      sheetClass: prototype.constructor?.name ?? "",
      methodName
    });
    prototype[methodName] = async function(...args) {
      const actor = this.actor ?? this.document;
      if (isSharedBastionActor(actor)) {
        updateSharedBastionSheetModeFromValues(this, args);
        moduleLog("Shared bastion sheet mode method called", {
          actor: actor.name,
          sheetClass: this.constructor?.name ?? "",
          methodName,
          args: summarizeModeValues(args),
          before: getSharedBastionSheetModeDebug(this),
          beforeJson: JSON.stringify(getSharedBastionSheetModeDebug(this))
        });
      }
      const result = await original.apply(this, args);
      if (isSharedBastionActor(actor)) {
        updateSharedBastionSheetModeFromValues(this, [result, ...args]);
        moduleLog("Shared bastion sheet mode method completed", {
          actor: actor.name,
          sheetClass: this.constructor?.name ?? "",
          methodName,
          result: summarizeModeValues([result]),
          after: getSharedBastionSheetModeDebug(this),
          afterJson: JSON.stringify(getSharedBastionSheetModeDebug(this))
        });
        window.setTimeout(() => renderSharedBastionLevelControl(this, this.element), 0);
      }
      return result;
    };
    prototype[methodName]._indySharedBastionPatched = true;
  }
}

function patchSharedBastionSheetTabs(actor = null) {
  const sheetClass = actor?.sheet?.constructor;
  patchSharedBastionLevelMethods(sheetClass);
  const prototype = sheetClass?.prototype;
  if (!prototype?._prepareTabsContext || patchedSheetClasses.has(sheetClass)) return;

  const original = prototype._prepareTabsContext;
  const parentPrepareTabs = Object.getPrototypeOf(prototype)?._prepareTabsContext;
  patchedSheetClasses.add(sheetClass);

  prototype._prepareTabsContext = async function(context, options) {
    const actor = this.actor ?? this.document;
    const sharedActor = getSharedBastionActorSync();
    const sharedBastionEnabled = getSharedBastionConfig().enabled
      && canViewActorVentures(sharedActor, game.user, "LIMITED");
    const hasBastionAccess = isSharedBastionActor(actor)
      ? hasActorBastionLevel(actor)
      : (sharedBastionEnabled ? hasActorBastionLevel(sharedActor) : hasActorBastionLevel(actor));
    const forceBastionTab = Boolean(actor?.type === "character")
      && Boolean(game.settings.get("dnd5e", "bastionConfiguration")?.enabled)
      && hasBastionAccess
      && (
        isSharedBastionActor(actor)
        || (
          actor?.documentName === "Actor"
          && !isSharedBastionActor(actor)
          && sharedBastionEnabled
        )
      )
      && (typeof parentPrepareTabs === "function");

    if (!forceBastionTab) return original.call(this, context, options);
    return parentPrepareTabs.call(this, context, options);
  };
}

function getCharacterSheetClassConfig() {
  const sheetConfig = foundry.applications?.apps?.DocumentSheetConfig;
  const classes = CONFIG?.Actor?.sheetClasses?.character ?? {};
  const { defaultClass } = sheetConfig?.getSheetClassesForSubType?.("Actor", "character") ?? {};
  const configured = defaultClass && defaultClass !== SHARED_BASTION_SHEET_CLASS_ID ? defaultClass : "";
  return {
    classes,
    defaultClass: configured,
    baseClass: classes[configured]?.cls ?? DocumentSheetV2
  };
}

function getApplicationWindowRoot(sheet, root) {
  return sheet?.element?.closest?.(".app, .application, .window-app")
    ?? root?.closest?.(".app, .application, .window-app")
    ?? sheet?.element
    ?? root
    ?? null;
}

function fitSharedBastionSheetToViewport(sheet, root = null) {
  const windowRoot = getApplicationWindowRoot(sheet, root);
  root = windowRoot ?? sheet?.element;
  if (!root || root.classList?.contains("minimized") || root.classList?.contains("minimizing") || root.classList?.contains("maximizing")) return;

  const viewportHeight = Number(globalThis.window?.innerHeight ?? 0);
  if (!viewportHeight) return;

  const availableHeight = Math.max(320, viewportHeight - 32);
  root.style.maxHeight = `${availableHeight}px`;

  const currentHeight = Number(sheet.position?.height ?? root.offsetHeight ?? 0);
  const nextHeight = currentHeight ? Math.min(currentHeight, availableHeight) : availableHeight;
  const currentTop = Number.isFinite(sheet.position?.top)
    ? sheet.position.top
    : Number.parseFloat(root.style.top);
  const nextPosition = { height: nextHeight };

  if (Number.isFinite(currentTop) && currentTop + nextHeight > viewportHeight - 16) {
    nextPosition.top = Math.max(16, viewportHeight - nextHeight - 16);
  }

  if (typeof sheet.setPosition === "function") sheet.setPosition(nextPosition);
  else root.style.height = `${nextHeight}px`;
}

function createSharedBastionActorSheetClass(BaseSheetClass) {
  class SharedBastionActorSheet extends BaseSheetClass {
    constructor(options = {}) {
      super(options);
      this.tabGroups = { ...(this.tabGroups ?? {}), primary: "bastion" };
    }

    _configureRenderOptions(options) {
      super._configureRenderOptions?.(options);
      if (isSharedBastionActor(this.document ?? this.actor)) {
        this.tabGroups.primary = "bastion";
      }
    }

    _configureRenderParts(options) {
      const parts = super._configureRenderParts?.(options) ?? {};
      if (!isSharedBastionActor(this.document ?? this.actor)) return parts;
      if (!Object.prototype.hasOwnProperty.call(parts, "bastion")) return parts;

      for (const partId of Object.keys(parts)) {
        if (!["bastion"].includes(partId)) delete parts[partId];
      }
      return parts;
    }

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      if (!isSharedBastionActor(this.document ?? this.actor)) return context;

      this.tabGroups.primary = "bastion";
      context.indySharedBastionSheet = true;
      if (context.tabs && !Array.isArray(context.tabs)) {
        const bastion = context.tabs.bastion ?? {
          id: "bastion",
          group: "primary",
          icon: "fas fa-chess-rook",
          label: "DND5E.Bastion.Label"
        };
        context.tabs = {
          bastion: {
            ...bastion,
            active: true,
            cssClass: "active"
          }
        };
      }
      return context;
    }

    _getTabs() {
      const tabs = super._getTabs?.() ?? {};
      if (!isSharedBastionActor(this.document ?? this.actor)) return tabs;

      const bastion = tabs.bastion ?? {
        id: "bastion",
        group: "primary",
        icon: "fas fa-chess-rook",
        label: "DND5E.Bastion.Label"
      };
      return {
        bastion: {
          ...bastion,
          active: true,
          cssClass: "active"
        }
      };
    }

    async _onRender(context, options) {
      await super._onRender?.(context, options);
      markSharedBastionOnlySheet(this, this.element);
      Hooks.callAll(`${MODULE_ID}.renderSharedBastionSheet`, this, this.element);
      fitSharedBastionSheetToViewport(this, this.element);
      globalThis.window?.setTimeout?.(() => fitSharedBastionSheetToViewport(this, this.element), 0);
    }
  }

  const defaultOptions = foundry.utils.mergeObject(BaseSheetClass.DEFAULT_OPTIONS ?? {}, {
    position: {
      width: 900,
      height: 900
    }
  }, {
    inplace: false,
    recursive: true,
    insertKeys: true
  });
  defaultOptions.classes = Array.from(new Set([
    ...(BaseSheetClass.DEFAULT_OPTIONS?.classes ?? []),
    "indy-shared-bastion-sheet"
  ]));
  SharedBastionActorSheet.DEFAULT_OPTIONS = defaultOptions;

  return SharedBastionActorSheet;
}

function registerSharedBastionActorSheet() {
  const sheetConfig = foundry.applications?.apps?.DocumentSheetConfig;
  if (!sheetConfig?.registerSheet || !CONFIG?.Actor?.sheetClasses) return null;

  const { baseClass } = getCharacterSheetClassConfig();
  if (!baseClass) return null;
  patchSharedBastionLevelMethods(baseClass);

  if (!sharedBastionActorSheetClass || Object.getPrototypeOf(sharedBastionActorSheetClass) !== baseClass) {
    sharedBastionActorSheetClass = createSharedBastionActorSheetClass(baseClass);
  }
  patchSharedBastionLevelMethods(sharedBastionActorSheetClass);

  sheetConfig.registerSheet(Actor, MODULE_ID, sharedBastionActorSheetClass, {
    types: ["character"],
    label: "INDYVENTURES.SharedBastion.SheetClass",
    makeDefault: false,
    canBeDefault: false,
    canConfigure: true
  });
  sharedBastionActorSheetRegistered = true;
  return sharedBastionActorSheetClass;
}

async function ensureSharedBastionActorSheet(actor = null) {
  if (!game.user?.isGM) return;
  if (!sharedBastionActorSheetRegistered) registerSharedBastionActorSheet();

  const sharedActor = actor ?? await getSharedBastionActor();
  if (!sharedActor || !isSharedBastionActor(sharedActor)) return;

  const current = sharedActor.getFlag("core", "sheetClass") ?? "";
  if (current === SHARED_BASTION_SHEET_CLASS_ID) return;

  moduleLog("Assigning shared bastion actor sheet", {
    actor: sharedActor.name,
    actorUuid: sharedActor.uuid,
    sheetClass: SHARED_BASTION_SHEET_CLASS_ID
  });
  await sharedActor.setFlag("core", "sheetClass", SHARED_BASTION_SHEET_CLASS_ID);
}

function getBastionMinimumLevel() {
  const advancement = CONFIG?.DND5E?.facilities?.advancement ?? {};
  const levels = [
    ...Object.keys(advancement.basic ?? {}),
    ...Object.keys(advancement.special ?? {})
  ]
    .map(level => Number(level))
    .filter(level => Number.isInteger(level) && level > 0);
  return levels.length ? Math.min(...levels) : 5;
}

function hasActorBastionLevel(actor) {
  const level = getActorBastionLevel(actor);
  return level >= getBastionMinimumLevel();
}

function applyTemporarySharedBastionLevel(actor) {
  const level = getSharedBastionLevel(actor);
  const details = actor?.system?.details;
  if (!level || !details) return null;

  const previous = details.level;
  try {
    details.level = level;
  } catch (error) {
    return null;
  }

  return () => {
    try {
      details.level = previous;
    } catch (error) {
      // Leave the temporary value in place if the system rejects restoration.
    }
  };
}

function bindSharedBastionLevelEvents(sheet, root) {
  const actor = sheet?.document ?? sheet?.actor;
  if (!isSharedBastionActor(actor) || !root || root.dataset.indySharedBastionLevelEvents === "1") return;
  root.dataset.indySharedBastionLevelEvents = "1";

  root.addEventListener("click", event => {
    const target = event.target?.closest?.("[data-action='findItem'][data-item-type='facility']");
    if (!target) return;
    const restore = applyTemporarySharedBastionLevel(actor);
    if (restore) window.setTimeout(restore, 0);
  }, { capture: true });
}

function patchSharedBastionFindItemAction(prototype) {
  if (!prototype) return;
  for (const methodName of ["_onFindItem", "_findItem", "findItem"]) {
    const original = prototype[methodName];
    if (typeof original !== "function" || original._indySharedBastionFakeLevelPatched) continue;
    prototype[methodName] = async function(...args) {
      return withTemporarySharedBastionLevelAsync(this, () => original.apply(this, args));
    };
    prototype[methodName]._indySharedBastionFakeLevelPatched = true;
  }
}

function getSharedBastionLevelPanel(root) {
  return root.querySelector('.tab[data-tab="bastion"], .tidy-tab.bastion, [data-tab-contents-for="bastion"]')
    ?? root.querySelector(".tab-body")
    ?? root;
}

function getModeStateFromPrimitive(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (value === 2) return true;
    if (value === 1) return false;
  }
  const text = String(value).trim().toLowerCase();
  if (text === "2") return true;
  if (text === "1") return false;
  if (["edit", "editing", "editmode", "edit-mode", "sheetedit", "sheet-edit", "unlocked"].includes(text)) return true;
  if (["play", "playing", "playmode", "play-mode", "sheetplay", "sheet-play", "locked", "view", "viewing"].includes(text)) return false;
  return null;
}

function inferEditModeFromValue(value, seen = new WeakSet()) {
  const primitive = getModeStateFromPrimitive(value);
  if (primitive !== null) return primitive;
  if (!value || (typeof value !== "object")) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = inferEditModeFromValue(entry, seen);
      if (result !== null) return result;
    }
    return null;
  }

  if ((typeof value.get === "function") && (value.get.length === 0)) {
    try {
      const result = inferEditModeFromValue(value.get(), seen);
      if (result !== null) return result;
    } catch (error) {
      // Some store-like objects expose get methods that require arguments.
    }
  }

  for (const key of ["value", "current", "mode", "sheetMode", "editMode", "state", "detail"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const result = inferEditModeFromValue(value[key], seen);
      if (result !== null) return result;
    }
  }
  return null;
}

function updateSharedBastionSheetModeFromValues(sheet, values) {
  const editMode = inferEditModeFromValue(values);
  if (editMode === null) return;
  sharedBastionSheetModes.set(sheet, editMode);
}

function summarizeModeValue(value) {
  const state = getObjectStateValue(value);
  return {
    rawType: typeof value,
    rawConstructor: value?.constructor?.name ?? "",
    rawString: (typeof value === "object") ? "" : String(value),
    state,
    edit: inferEditModeFromValue(value)
  };
}

function summarizeModeValues(values) {
  return values.map(value => summarizeModeValue(value));
}

function getObjectStateValue(value, seen = new WeakSet()) {
  if (!value || (typeof value !== "object")) return value;
  if (seen.has(value)) return null;
  seen.add(value);

  if ((typeof value.get === "function") && (value.get.length === 0)) {
    try {
      const result = value.get();
      if (result !== value) return getObjectStateValue(result, seen);
    } catch (error) {
      // Some store-like objects expose get methods that require arguments.
    }
  }

  for (const key of ["value", "current", "mode", "sheetMode", "editMode", "state"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const result = getObjectStateValue(value[key], seen);
      if (result !== null && result !== undefined) return result;
    }
  }
  return null;
}

function summarizeSheetModeCandidate(label, value) {
  const state = getObjectStateValue(value);
  return {
    label,
    rawType: typeof value,
    rawConstructor: value?.constructor?.name ?? "",
    rawString: (typeof value === "object") ? "" : String(value),
    state,
    stateType: typeof state,
    edit: isEditModeStateValue(state)
  };
}

function isEditModeStateValue(state) {
  if (state === true) return true;
  if (state === false || state === null || state === undefined) return false;
  return ["edit", "editing", "editmode", "edit-mode", "sheetedit", "sheet-edit", "unlocked"]
    .includes(String(state).trim().toLowerCase());
}

function isEditModeState(value) {
  const state = getObjectStateValue(value);
  return isEditModeStateValue(state);
}

function getSheetModeCandidates(sheet) {
  return [
    ["sheet.editMode", sheet?.editMode],
    ["sheet._editMode", sheet?._editMode],
    ["sheet.mode", sheet?.mode],
    ["sheet._mode", sheet?._mode],
    ["sheet.sheetMode", sheet?.sheetMode],
    ["sheet._sheetMode", sheet?._sheetMode],
    ["sheet.currentSheetMode", sheet?.currentSheetMode],
    ["sheet.options.editMode", sheet?.options?.editMode],
    ["sheet.options.mode", sheet?.options?.mode],
    ["sheet.options.sheetMode", sheet?.options?.sheetMode],
    ["sheet.state.editMode", sheet?.state?.editMode],
    ["sheet.state.mode", sheet?.state?.mode],
    ["sheet.state.sheetMode", sheet?.state?.sheetMode],
    ["sheet.reactive.editMode", sheet?.reactive?.editMode],
    ["sheet.reactive.mode", sheet?.reactive?.mode],
    ["sheet.reactive.sheetMode", sheet?.reactive?.sheetMode],
    ["sheet.context.editMode", sheet?.context?.editMode],
    ["sheet.context.mode", sheet?.context?.mode],
    ["sheet.context.sheetMode", sheet?.context?.sheetMode]
  ];
}

function getSharedBastionSheetModeDebug(sheet) {
  return getSheetModeCandidates(sheet)
    .map(([label, value]) => summarizeSheetModeCandidate(label, value))
    .filter(candidate => candidate.state !== undefined || candidate.rawString || candidate.rawConstructor);
}

function isSharedBastionSheetInEditMode(sheet) {
  if (sharedBastionSheetModes.has(sheet)) return sharedBastionSheetModes.get(sheet) === true;
  return getSheetModeCandidates(sheet).some(([, value]) => isEditModeState(value));
}

async function saveSharedBastionLevel(actor, input) {
  if (!game.user?.isGM || !isSharedBastionActor(actor)) return;
  const level = normalizeBastionLevel(input?.value, getBastionMinimumLevel(), getBastionMinimumLevel());
  if (!level) return;

  input.value = String(level);
  input.disabled = true;
  try {
    await actor.setFlag(MODULE_ID, SHARED_BASTION_LEVEL_FLAG, level);
    ui.notifications.info("INDYVENTURES.SharedBastion.BastionLevelSaved", { localize: true });
  } finally {
    input.disabled = false;
  }
}

function renderSharedBastionLevelControl(sheet, root) {
  const actor = sheet?.document ?? sheet?.actor;
  if (!game.user?.isGM || !isSharedBastionActor(actor) || !root) return;

  const existing = root.querySelector("[data-indy-shared-bastion-level]");
  const editMode = isSharedBastionSheetInEditMode(sheet);
  moduleLog("Shared bastion level control visibility check", {
    actor: actor.name,
    sheetClass: sheet?.constructor?.name ?? "",
    editMode,
    storedMode: sharedBastionSheetModes.has(sheet) ? sharedBastionSheetModes.get(sheet) : null,
    existing: Boolean(existing),
    candidates: getSharedBastionSheetModeDebug(sheet),
    candidatesJson: JSON.stringify(getSharedBastionSheetModeDebug(sheet))
  });

  if (!editMode) {
    if (existing) moduleLog("Removing shared bastion level control because sheet is not in edit mode", {
      actor: actor.name,
      sheetClass: sheet?.constructor?.name ?? ""
    });
    existing?.remove();
    return;
  }

  const panel = getSharedBastionLevelPanel(root);
  if (existing) {
    moduleLog("Shared bastion level control already present", {
      actor: actor.name,
      sheetClass: sheet?.constructor?.name ?? ""
    });
    return;
  }

  const doc = root.ownerDocument;
  const form = doc.createElement("form");
  form.classList.add("indy-shared-bastion-level");
  form.dataset.indySharedBastionLevel = "1";

  const label = doc.createElement("label");
  label.textContent = game.i18n.localize("INDYVENTURES.SharedBastion.BastionLevel");

  const input = doc.createElement("input");
  input.type = "number";
  input.name = "bastionLevel";
  input.min = String(getBastionMinimumLevel());
  input.max = String(getBastionMaximumLevel());
  input.step = "1";
  input.value = String(Math.max(getSharedBastionLevel(actor) || 0, getBastionMinimumLevel()));
  input.dataset.tooltip = game.i18n.localize("INDYVENTURES.SharedBastion.BastionLevelHint");

  const button = doc.createElement("button");
  button.type = "submit";
  button.dataset.tooltip = game.i18n.localize("INDYVENTURES.SharedBastion.BastionLevelSave");
  button.setAttribute("aria-label", game.i18n.localize("INDYVENTURES.SharedBastion.BastionLevelSave"));
  const icon = doc.createElement("i");
  icon.classList.add("fas", "fa-save");
  icon.setAttribute("inert", "");
  button.append(icon);

  form.append(label, input, button);
  form.addEventListener("submit", event => {
    event.preventDefault();
    saveSharedBastionLevel(actor, input);
  });

  panel.prepend(form);
  moduleLog("Inserted shared bastion level control", {
    actor: actor.name,
    sheetClass: sheet?.constructor?.name ?? "",
    level: input.value
  });
}

function isTidySheetRoot(root) {
  return Boolean(root?.classList?.contains("tidy5e-sheet")
    || root?.closest?.(".tidy5e-sheet")
    || root?.querySelector?.(".tidy-tabs"));
}

function markSharedBastionOnlySheet(sheet, html) {
  const actor = sheet?.document ?? sheet?.actor;
  if (!isSharedBastionActor(actor)) return;
  if (actor.getFlag?.("core", "sheetClass") !== SHARED_BASTION_SHEET_CLASS_ID) return;

  const root = resolveHtmlRoot(sheet, html);
  if (!root) return;
  root.classList.add("indy-shared-bastion-sheet");
  getApplicationWindowRoot(sheet, root)?.classList?.add("indy-shared-bastion-sheet");
  if (isTidySheetRoot(root)) {
    root.classList.add("indy-tidy-shared-bastion-sheet");
    root.querySelector(".tidy5e-sheet")?.classList.add("indy-tidy-shared-bastion-sheet");
  }
  if (sheet?.tabGroups) sheet.tabGroups.primary = "bastion";
  bindSharedBastionLevelEvents(sheet, root);

  for (const tab of root.querySelectorAll('[data-tab="bastion"], [data-tab-id="bastion"]')) {
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
  }
  for (const panel of root.querySelectorAll('.tab[data-tab="bastion"], .tidy-tab.bastion, [data-tab-contents-for="bastion"]')) {
    panel.classList.add("active");
    panel.removeAttribute("hidden");
  }
  renderSharedBastionLevelControl(sheet, root);
}

function bindSharedBastionTab(sheet, html) {
  const actor = sheet?.document ?? sheet?.actor;
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return;
  if (!getSharedBastionConfig().enabled) return;
  if (!game.settings.get("dnd5e", "bastionConfiguration")?.enabled) return;
  if (isSharedBastionActor(actor)) return;
  const sharedActor = getSharedBastionActorSync();
  if (!canViewActorVentures(sharedActor, game.user, "LIMITED")) return;

  const root = resolveHtmlRoot(sheet, html);
  if (!root) return;
  const tidy = isTidySheetRoot(root);
  if (!hasActorBastionLevel(actor) && !hasActorBastionLevel(sharedActor)) {
    if (tidy) removeTidyBastionTabs(root);
    return;
  }
  if (tidy) replaceTidySharedBastionTab(root);

  for (const tab of root.querySelectorAll('[data-tab="bastion"], [data-tab-id="bastion"]')) {
    if (!tab.closest("nav, .tabs, [data-application-part='tabs'], [role='tablist']")) continue;
    if (tab.dataset.indySharedBastionTab === "1") continue;
    tab.dataset.indySharedBastionTab = "1";
    tab.dataset.tooltip = game.i18n.localize("INDYVENTURES.SharedBastion.OpenTooltip");
    tab.title = game.i18n.localize("INDYVENTURES.SharedBastion.OpenTooltip");
    tab.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openSharedBastionSheet();
    }, { capture: true });
  }
}

function createTidySharedBastionTab(doc, existing = null) {
  const tab = doc.createElement("a");
  const existingClasses = Array.from(existing?.classList ?? []);
  tab.classList.add(...(existingClasses.length ? existingClasses : ["tab-option"]));
  tab.classList.remove("active");
  tab.classList.add("indy-shared-bastion-tidy-tab");
  tab.dataset.tabId = "bastion";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "false");
  tab.setAttribute("tabindex", existing?.getAttribute("tabindex") ?? "-1");
  tab.title = game.i18n.localize("INDYVENTURES.SharedBastion.OpenTooltip");
  tab.dataset.tooltip = game.i18n.localize("INDYVENTURES.SharedBastion.OpenTooltip");

  const icon = doc.createElement("i");
  icon.classList.add("tab-icon", "fa-solid", "fa-house-turret");
  const label = doc.createElement("span");
  label.classList.add("tab-title");
  label.textContent = game.i18n.localize("DND5E.Bastion.Label");
  tab.append(icon, " ", label);
  return tab;
}

function removeTidyBastionTabs(root) {
  for (const tab of root.querySelectorAll('[data-tab-id="bastion"]')) {
    tab.remove();
  }
}

function replaceTidySharedBastionTab(root) {
  const tabLists = Array.from(root.querySelectorAll('[role="tablist"], .tidy-tabs'));
  const nav = tabLists.find(element => element.querySelector("[data-tab-id]"));
  if (!nav) return;

  const existingTabs = Array.from(nav.querySelectorAll('[data-tab-id="bastion"]'));
  const existing = existingTabs.find(tab => !tab.classList.contains("indy-shared-bastion-tidy-tab")) ?? existingTabs[0] ?? null;
  const tab = createTidySharedBastionTab(root.ownerDocument, existing);
  if (existing) {
    existing.replaceWith(tab);
    for (const duplicate of existingTabs) {
      if (duplicate !== existing && duplicate.isConnected) duplicate.remove();
    }
    return;
  }

  const anchor = nav.querySelector('[data-tab-id="features"], [data-tab-id="biography"], [data-tab-id="actions"]');
  if (anchor?.after) anchor.after(tab);
  else nav.append(tab);
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
  await ensureSharedBastionActorSheet(actor);
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

function isFacilityBrowserSelectOptions(options) {
  const locked = options?.filters?.locked;
  if (!locked) return false;
  const types = locked.types;
  if (types instanceof Set && types.has("facility")) return true;
  if (Array.isArray(types) && types.includes("facility")) return true;
  return Boolean(locked.additional?.type?.basic || locked.additional?.type?.special);
}

function patchDndFacilityBrowserLevel() {
  const browser = globalThis.dnd5e?.applications?.CompendiumBrowser;
  if (!browser?.selectOne || dndFacilityBrowserPatched) return;
  dndFacilityBrowserPatched = true;

  const original = browser.selectOne.bind(browser);
  browser.selectOne = async function(options = {}, ...args) {
    if (isFacilityBrowserSelectOptions(options)) {
      const actor = getSharedBastionActorSync();
      const level = getSharedBastionLevel(actor);
      const current = Number(options.filters?.locked?.additional?.level?.max ?? 0);
      if (actor && level > current) {
        foundry.utils.setProperty(options, "filters.locked.additional.level.max", level);
        moduleLog("Adjusted D&D facility browser level filter for shared bastion", {
          actor: actor.name,
          current,
          level,
          filters: options.filters
        });
      }
    }
    return original(options, ...args);
  };
}

export function registerSharedBastionHooks() {
  const onActorSheetRender = (sheet, html) => {
    markSharedBastionOnlySheet(sheet, html);
    bindSharedBastionTab(sheet, html);
  };
  Hooks.on("renderApplicationV2", onActorSheetRender);
  Hooks.on("renderActorSheet", onActorSheetRender);
  Hooks.on("renderActorSheet5e", onActorSheetRender);
  Hooks.on("renderCharacterActorSheet", onActorSheetRender);
  Hooks.on("dnd5e.renderActorSheet", onActorSheetRender);
  Hooks.on("tidy5e-sheet.renderActorSheet", onActorSheetRender);

  Hooks.on("createUser", () => syncSharedBastionActorOwnership());
  Hooks.on("deleteUser", () => syncSharedBastionActorOwnership());
}

export async function initializeSharedBastion() {
  applySharedBastionFacilitySlots();
  registerSharedBastionActorSheet();
  const actor = await getSharedBastionActor();
  await ensureSharedBastionActorSheet(actor);
  patchSharedBastionSheetTabs(actor);
  patchDndBastionAdvance();
  patchDndFacilityBrowserLevel();
  await syncSharedBastionActorOwnership();
}
