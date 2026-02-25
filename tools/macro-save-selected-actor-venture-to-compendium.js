/**
 * Indy Ventures - Save Venture from Actor to Compendium
 * Run as a Script Macro (GM).
 *
 * Flow:
 * 1) Pick an actor (defaults to controlled token actor when possible).
 * 2) Pick one of that actor's venture-enabled facilities.
 * 3) Save to indy-ventures.venture-facilities (create or update by identifier/name).
 */

const MODULE_ID = "indy-ventures";
const PACK_ID = `${MODULE_ID}.venture-facilities`;

function isVentureFacility(item) {
  if (!item || item.documentName !== "Item" || item.type !== "facility") return false;
  return Boolean(item.getFlag(MODULE_ID, "config")?.enabled);
}

function getControlledTokenActor() {
  const controlled = canvas?.tokens?.controlled ?? [];
  const actors = controlled.map(token => token.actor).filter(Boolean);
  if (actors.length === 1) return actors[0];
  return null;
}

function getActorsWithVentures() {
  return game.actors
    .filter(actor => actor.type === "character")
    .filter(actor => (actor.itemTypes?.facility ?? []).some(isVentureFacility))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getActorVentureFacilities(actor) {
  return (actor?.itemTypes?.facility ?? [])
    .filter(isVentureFacility)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function chooseFromList({ title, label, choices, initialValue = "" }) {
  const options = choices
    .map(choice => {
      const selected = String(choice.value) === String(initialValue) ? " selected" : "";
      return `<option value="${foundry.utils.escapeHTML(String(choice.value))}"${selected}>${foundry.utils.escapeHTML(String(choice.label))}</option>`;
    })
    .join("");

  const content = `
    <form>
      <div class="form-group">
        <label>${foundry.utils.escapeHTML(label)}</label>
        <div class="form-fields">
          <select name="choice">${options}</select>
        </div>
      </div>
    </form>
  `;

  return new Promise(resolve => {
    new Dialog({
      title,
      content,
      buttons: {
        ok: {
          label: "Select",
          callback: html => resolve(String(html.find('[name="choice"]').val() ?? ""))
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "ok",
      close: () => resolve(null)
    }).render(true);
  });
}

async function saveFacilityToPack({ pack, facility }) {
  const data = facility.toObject();
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

  if (existing) {
    await pack.documentClass.updateDocuments([{ ...data, _id: existing.id }], {
      pack: pack.collection
    });
    return { action: "updated" };
  }

  await pack.documentClass.createDocuments([data], {
    pack: pack.collection
  });
  return { action: "created" };
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

  const actors = getActorsWithVentures();
  if (!actors.length) {
    ui.notifications.warn("No character actors with venture-enabled facilities were found.");
    return;
  }

  const controlledActor = getControlledTokenActor();
  const initialActorId = actors.some(actor => actor.id === controlledActor?.id)
    ? controlledActor.id
    : actors[0].id;

  const actorId = await chooseFromList({
    title: "Select Actor",
    label: "Actor",
    choices: actors.map(actor => ({ value: actor.id, label: actor.name })),
    initialValue: initialActorId
  });
  if (!actorId) return;

  const actor = actors.find(entry => entry.id === actorId);
  if (!actor) {
    ui.notifications.error("Selected actor not found.");
    return;
  }

  const facilities = getActorVentureFacilities(actor);
  if (!facilities.length) {
    ui.notifications.warn(`${actor.name} has no venture-enabled facilities.`);
    return;
  }

  const facilityId = await chooseFromList({
    title: "Select Venture Facility",
    label: "Facility",
    choices: facilities.map(facility => ({ value: facility.id, label: facility.name })),
    initialValue: facilities[0].id
  });
  if (!facilityId) return;

  const facility = facilities.find(entry => entry.id === facilityId);
  if (!facility) {
    ui.notifications.error("Selected facility not found.");
    return;
  }

  const wasLocked = pack.locked;
  try {
    if (wasLocked) await pack.configure({ locked: false });

    const result = await saveFacilityToPack({ pack, facility });
    const verb = result.action === "updated" ? "Updated" : "Added";
    ui.notifications.info(`${verb} compendium venture: ${facility.name}`);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to save venture to compendium`, error);
    ui.notifications.error("Failed to save venture to compendium. Check console for details.");
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
})();
