import { MODULE_ID } from "./constants.js";

const { StringField } = foundry.data.fields;

const DAE_FIELDS = [
  `flags.${MODULE_ID}.ventureModifier.enabled`,
  `flags.${MODULE_ID}.ventureModifier.applyToAllVentures`,
  `flags.${MODULE_ID}.ventureModifier.facilityId`,
  `flags.${MODULE_ID}.ventureModifier.profitDieStep`,
  `flags.${MODULE_ID}.ventureModifier.profitDieOverride`,
  `flags.${MODULE_ID}.ventureModifier.minProfitDie`,
  `flags.${MODULE_ID}.ventureModifier.lossDieStep`,
  `flags.${MODULE_ID}.ventureModifier.lossDieOverride`,
  `flags.${MODULE_ID}.ventureModifier.maxLossDie`,
  `flags.${MODULE_ID}.ventureModifier.successThresholdOverride`,
  `flags.${MODULE_ID}.ventureModifier.profitRollBonus`,
  `flags.${MODULE_ID}.ventureModifier.durationFormula`,
  `flags.${MODULE_ID}.ventureModifier.consumePerTurn`,
  `flags.${MODULE_ID}.ventureModifier.bastionDurationType`,
  `flags.${MODULE_ID}.ventureModifier.remainingTurns`,
  `flags.${MODULE_ID}.bastionDuration.expireNextTurn`,
  `flags.${MODULE_ID}.bastionDuration.remainingTurns`,
  `flags.${MODULE_ID}.bastionDuration.durationFormula`,
  `flags.${MODULE_ID}.bastionDuration.consumePerTurn`
];

export function registerDaeIntegration() {
  // Add fields to DAE browser once DAE has initialized its field registry.
  Hooks.once("DAE.setupComplete", () => {
    if (!globalThis.DAE?.addAutoFields) return;
    globalThis.DAE.addAutoFields(DAE_FIELDS);
  });

  // Keep these flags in custom mode so DAE doesn't try to coerce system schemas.
  Hooks.on("dae.modifySpecials", (specKey, specials, characterSpec) => {
    for (const field of DAE_FIELDS) {
      specials[field] = [new StringField(), 0];
    }
  });

  // Group fields in DAE field browser.
  Hooks.on("dae.setFieldData", fieldData => {
    fieldData.IndyVentures = [...DAE_FIELDS];
  });
}
