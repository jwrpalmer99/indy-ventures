export const MODULE_ID = "indy-ventures";

export const TEMPLATE_PATHS = {
  facilityDetails: "modules/indy-ventures/templates/item/details-venture.hbs",
  chatSummary: "modules/indy-ventures/templates/chat/venture-summary.hbs",
  boonEditor: "modules/indy-ventures/templates/dialog/boon-editor.hbs"
};

export const DICE_STEPS = ["d4", "d6", "d8", "d10", "d12"];

export const SETTINGS = {
  integrateBastion: "integrateBastion",
  postChatSummary: "postChatSummary",
  hideVentureHirelings: "hideVentureHirelings",
  debugLogging: "debugLogging"
};

export const VENTURE_PRESETS = {
  custom: {
    profitDie: "d6",
    lossDie: "d6",
    successThreshold: 3,
    boonsText: ""
  },
  tavern: {
    profitDie: "d8",
    lossDie: "d6",
    successThreshold: 3,
    boonsText: [
      "Hirelings | 100 | 1d4 + 1 skilled hirelings become available for recruitment.",
      "Local Celebrities | 200 | Gain +2 Persuasion checks with locals for 2d6 weeks.",
      "Renovations | 400 | Profit die cannot drop below d8 for 1d6 months."
    ].join("\n")
  },
  cult: {
    profitDie: "d4",
    lossDie: "d10",
    successThreshold: 3,
    boonsText: [
      "Friends in High Places | 200 | Increase profit die after 1 successful month instead of 3.",
      "Lured to Their Doom | 300 | Lure and sacrifice one or more enemies of the cult.",
      "Laying Low | 100 | Loss die cannot rise above d6 while growth requires 6 successes."
    ].join("\n")
  }
};
