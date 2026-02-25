/**
 * Indy Ventures - Save Current Venture Facility to Compendium
 * Run as a Script Macro (GM).
 *
 * Usage:
 * 1. Open the Venture Facility item sheet you want to save.
 * 2. Run this macro.
 * 3. It creates a new entry, or updates an existing one.
 *    - Updates existing when identifier+name (or name) matches.
 *    - If identifier matches but name differs, creates a new entry with a new identifier.
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

function slugifyIdentifier(value, fallback = "venture") {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function getUniqueIdentifier(baseIdentifier, docs) {
  const existing = new Set(
    docs
      .map(doc => String(doc.system?.identifier ?? "").trim())
      .filter(Boolean)
  );

  const base = slugifyIdentifier(baseIdentifier);
  if (!existing.has(base)) return base;

  let index = 2;
  let candidate = `${base}-${index}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
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
  const identifier = String(data.system?.identifier ?? "").trim();
  const sameIdentifier = identifier
    ? docs.filter(doc => String(doc.system?.identifier ?? "").trim() === identifier)
    : [];
  const sameIdentifierSameName = sameIdentifier.find(doc => doc.name === data.name);

  const wasLocked = pack.locked;
  try {
    if (wasLocked) await pack.configure({ locked: false });

    if (sameIdentifierSameName) {
      await pack.documentClass.updateDocuments([{ ...data, _id: sameIdentifierSameName.id }], {
        pack: pack.collection
      });
      ui.notifications.info(`Updated compendium venture: ${source.name}`);
    } else if (sameIdentifier.length) {
      const newIdentifier = getUniqueIdentifier(identifier, docs);
      foundry.utils.setProperty(data, "system.identifier", newIdentifier);
      await pack.documentClass.createDocuments([data], {
        pack: pack.collection
      });
      ui.notifications.info(`Added compendium venture copy: ${source.name} (identifier: ${newIdentifier})`);
    } else {
      const sameName = docs.find(doc => doc.name === data.name);
      if (sameName) {
        await pack.documentClass.updateDocuments([{ ...data, _id: sameName.id }], {
          pack: pack.collection
        });
        ui.notifications.info(`Updated compendium venture: ${source.name}`);
      } else {
        await pack.documentClass.createDocuments([data], {
          pack: pack.collection
        });
        ui.notifications.info(`Added compendium venture: ${source.name}`);
      }
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to save venture to compendium`, error);
    ui.notifications.error("Failed to save venture to compendium. Check console for details.");
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
})();
