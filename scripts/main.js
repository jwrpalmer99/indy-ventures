import { registerChatHooks } from "./chat.js";
import { processActorVenturesFromBastionMessage, registerCoveragePromptSocket } from "./engine.js";
import { moduleWarn } from "./logger.js";
import { registerSettings } from "./settings.js";
import { registerFacilitySheetHooks, registerModuleApi, registerModuleTemplates } from "./sheet.js";

Hooks.once("init", async () => {
  registerSettings();
  await registerModuleTemplates();
  registerFacilitySheetHooks();
  registerChatHooks();
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    moduleWarn("This module only supports the dnd5e system.");
    return;
  }

  registerCoveragePromptSocket();
  registerModuleApi();
});

Hooks.on("createChatMessage", async message => {
  if (game.system.id !== "dnd5e") return;
  await processActorVenturesFromBastionMessage(message);
});
