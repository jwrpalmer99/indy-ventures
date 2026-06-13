import { registerChatHooks } from "./chat.js";
import { registerDaeIntegration } from "./dae.js";
import { processActorVenturesFromBastionMessage, registerCoveragePromptSocket } from "./engine.js";
import { moduleWarn } from "./logger.js";
import { registerSettings } from "./settings.js";
import { registerFacilitySheetHooks, registerModuleApi, registerModuleTemplates } from "./sheet.js";
import { initializeSharedBastion, registerSharedBastionHooks } from "./shared-bastion.js";

Hooks.once("init", async () => {
  registerSettings();
  registerDaeIntegration();
  await registerModuleTemplates();
  registerSharedBastionHooks();
  registerFacilitySheetHooks();
  registerChatHooks();
});

Hooks.once("ready", async () => {
  if (game.system.id !== "dnd5e") {
    moduleWarn("This module only supports the dnd5e system.");
    return;
  }

  registerCoveragePromptSocket();
  await initializeSharedBastion();
  registerModuleApi();
});

Hooks.on("createChatMessage", async message => {
  if (game.system.id !== "dnd5e") return;
  await processActorVenturesFromBastionMessage(message);
});
