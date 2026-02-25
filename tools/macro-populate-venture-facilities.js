/**
 * Indy Ventures - Populate Venture Facilities Compendium
 * Run this as a Foundry Script Macro (as GM).
 */

const MODULE_ID = "indy-ventures";
const PACK_ID = `${MODULE_ID}.venture-facilities`;

const facilitySpecs = [
  { name: "Venture Facility (Cramped)", size: "cramped", profitDie: "d6" },
  { name: "Venture Facility (Roomy)", size: "roomy", profitDie: "d8" },
  { name: "Venture Facility (Vast)", size: "vast", profitDie: "d10" }
];

function buildFacilityData(spec, sort) {
  return {
    name: spec.name,
    type: "facility",
    img: "icons/environment/settlement/building-hut.webp",
    system: {
      description: {
        value: "<p>A purpose-built venture facility for bastion-driven business automation.</p>",
        chat: ""
      },
      identifier: `venture-facility-${spec.size}`,
      source: { rules: "2024", book: "", custom: "", license: "" },
      activities: {},
      uses: { spent: 0, max: "", recovery: [] },
      building: { built: true, size: spec.size },
      craft: { item: null, quantity: 1 },
      defenders: { value: [], max: 1 },
      disabled: false,
      enlargeable: false,
      free: false,
      hirelings: { value: [], max: 1 },
      level: 5,
      order: "",
      progress: { value: 0, max: null, order: "" },
      size: spec.size,
      trade: {
        creatures: { value: [], max: 1 },
        pending: { creatures: [], operation: null, stocked: false, value: null },
        profit: 0,
        stock: { stocked: false, value: 0, max: 1 }
      },
      type: { value: "special", subtype: "pub" }
    },
    ownership: { default: 0 },
    folder: null,
    sort,
    flags: {
      [MODULE_ID]: {
        config: {
          enabled: true,
          ventureName: spec.name,
          profitDie: spec.profitDie,
          lossDie: "d6",
          lossModifier: 0,
          gpPerPoint: 100,
          autoCoverLoss: false,
          successThreshold: 3,
          boonsText: ""
        },
        state: {
          currentProfitDie: spec.profitDie,
          streak: 0,
          treasury: 0,
          failed: false,
          lastTurnNet: 0
        }
      }
    }
  };
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

  const docs = facilitySpecs.map((spec, i) => buildFacilityData(spec, i * 10));
  const existingDocs = await pack.getDocuments();
  const findExisting = doc => {
    const identifier = doc.system?.identifier;
    return existingDocs.find(entry =>
      (entry.system?.identifier === identifier)
      || (entry.name === doc.name)
    );
  };

  const toCreate = [];
  const toUpdate = [];
  for (const doc of docs) {
    const existing = findExisting(doc);
    if (existing) toUpdate.push({ ...doc, _id: existing.id });
    else toCreate.push(doc);
  }

  const wasLocked = pack.locked;
  try {
    if (wasLocked) await pack.configure({ locked: false });

    if (toCreate.length) {
      await pack.documentClass.createDocuments(toCreate, { pack: pack.collection });
    }

    if (toUpdate.length) {
      await pack.documentClass.updateDocuments(toUpdate, {
        pack: pack.collection
      });
    }

    await pack.getIndex();

    const summary = `Venture Facilities synced. Created: ${toCreate.length}, Updated: ${toUpdate.length}.`;
    ui.notifications.info(summary);
    console.log(`${MODULE_ID} | ${summary}`);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to populate venture facilities`, error);
    ui.notifications.error(`Failed to populate ${PACK_ID}. Check console for details.`);
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
})();
