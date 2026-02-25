/**
 * Indy Ventures - Save Current Venture Facility to Compendium
 * Run as a Script Macro (GM).
 *
 * Usage:
 * 1. Open the Venture Facility item sheet you want to save.
 * 2. Run this macro.
 * 3. It creates a new entry, or updates an existing one by system.identifier/name.
 */

const MODULE_ID = "indy-ventures";
const PACK_ID = `${MODULE_ID}.venture-facilities`;

function isVentureFacility(item) {
  if (!item || item.documentName !== "Item" || item.type !== "facility") return false;
  const config = item.getFlag(MODULE_ID, "config") ?? {};
  return Boolean(config.enabled);
}

function findOpenVentureFacility() {
  const windows = Object.values(ui.windows ?? {}).reverse();
  for (const app of windows) {
    const doc = app?.document;
    if (isVentureFacility(doc)) return doc;
  }
  return null;
}

(async () => {
  if (!game.user.isGM) {
    ui.notifications.error("Only a GM can run this macro.");
    return;
  }

  const pack = game.packs.get(PACK_ID);
  if (!pack) {
    ui.notifications.error(`Compendium not found: ${PACK_ID}`);
    return;
  }

  const source = findOpenVentureFacility();
  if (!source) {
    ui.notifications.warn("Open a Venture-enabled Facility sheet, then run this macro.");
    return;
  }

  const data = source.toObject();
  delete data._id;
  data.folder = null;
  data.sort = 0;
  data.ownership = { default: 0 };

  const docs = await pack.getDocuments();
  const identifier = data.system?.identifier;
  const existing = docs.find(doc => {
    if (identifier && (doc.system?.identifier === identifier)) return true;
    return doc.name === data.name;
  });

  const wasLocked = pack.locked;
  try {
    if (wasLocked) await pack.configure({ locked: false });

    if (existing) {
      await pack.documentClass.updateDocuments([{ ...data, _id: existing.id }], {
        pack: pack.collection
      });
      ui.notifications.info(`Updated compendium venture: ${source.name}`);
    } else {
      await pack.documentClass.createDocuments([data], {
        pack: pack.collection
      });
      ui.notifications.info(`Added compendium venture: ${source.name}`);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to save venture to compendium`, error);
    ui.notifications.error("Failed to save venture to compendium. Check console for details.");
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
})();
