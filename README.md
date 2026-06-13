# Indy Ventures

Indy Ventures adds business-style ventures to D&D5e bastions in Foundry VTT. A bastion can run an apothecary, tavern, cult, workshop, or other venture, earn or lose gold each bastion turn, and spend venture treasury on configurable rewards.

The module works inside the existing D&D5e bastion experience. You still build and manage bastion facilities on character sheets; Indy Ventures adds automation, rewards, and optional shared-bastion support.

<img width="1486" height="695" alt="venture_image" src="https://github.com/user-attachments/assets/3b92fa94-5793-448f-a28a-7ffa9259cf53" />

## Requirements

- Foundry VTT: `13.x` or `14.x`
- System: `dnd5e` `5.3.0+`
- D&D5e bastions must be enabled in the D&D5e system settings.

## What It Adds

- Venture controls on D&D5e special facilities.
- Profit and loss rolls when a bastion turn advances.
- Venture treasury, growth, setbacks, and failure tracking.
- Boons that players can buy from venture treasury.
- Example venture facilities in the **Indy Ventures** compendium folder.
- Optional shared bastion support for parties that manage one bastion together.
- Optional separate slot limits for normal special facilities and Indy Venture facilities.

## GM Setup

1. Enable D&D5e bastions in the D&D5e system settings.
2. Make sure the bastion actor can use bastions. In D&D5e this normally means the character is eligible for bastion features, such as being high enough level.
3. Add a special facility to the bastion.
4. Open the facility item and go to **Details -> Venture Automation**.
5. Check **Enable Venture**.
6. Set the venture name, profit die, loss die, GP per point, and growth options.
7. Click **Open Boon Editor** to add rewards players can buy with venture treasury.
8. Advance a bastion turn as normal.

The module includes example venture facilities in **Compendium Packs -> Indy Ventures -> Venture Facilities**. You can drag these into a bastion and adjust them for your campaign.

## Player Use

When a bastion turn advances, the assigned player may be asked to roll profit and loss for their venture. After the turn resolves, the chat card shows each venture's result:

- Profit and loss totals.
- Net gold gained or lost.
- Current venture treasury.
- Available boons.
- A button to pay venture treasury out to the character, if allowed.

Each venture section in the chat card can be collapsed or expanded. If you can manage that venture, it starts expanded. If you can see it but cannot manage it, it starts collapsed.

## Boons

Boons are rewards that can be bought from a venture's treasury. A boon can grant an item, apply an effect, or simply represent a campaign reward you describe in the boon text.

In the boon editor, a GM can set:

- Name, cost, and description.
- Reward item or effect.
- How often the boon can be bought each turn.
- Whether the boon is only available after a profitable turn, after a loss, or at any time.
- Optional boon groups, so several boons can share a purchase limit.

## Shared Bastion

Shared bastion mode is for campaigns where the party manages one bastion together instead of each player having a separate bastion.

Configure it from **Configure Settings -> Module Settings -> Indy Ventures -> Shared Bastion**.

1. Choose the character actor that represents the shared bastion.
2. Choose a default player permission.
3. Set player overrides if needed.
4. Turn on **Sync Actor Ownership** if players should use D&D5e's normal bastion controls.
5. Turn on **Advance Only Shared Bastion** if the D&D5e advance button should advance only the shared bastion.

When shared bastion mode is enabled, the normal **Bastion** tab on a player character opens the shared bastion. The module does not add a second shared-bastion button.

### Shared Permissions

Shared bastion permissions control what each player can do:

- `None`: cannot see shared venture results.
- `Limited`: can see shared venture results.
- `Observer`: can see shared venture results.
- `Owner`: can manage allowed ventures, answer venture prompts, buy boons, claim treasury, and, with ownership sync enabled, use normal D&D5e bastion controls.

GMs can also set permissions on each individual venture facility. The player's actual access is capped by both permissions. For example, a player can be an Owner of the shared bastion but only an Observer on a specific venture.

## Facility Slots

By default, D&D5e handles bastion facility limits.

If you enable **Split Special Facility Slots** in the shared bastion settings, normal special facilities and Indy Venture facilities get separate limits. For example, at level 5 you can allow:

- 2 normal special facilities.
- 6 Indy Venture facilities.

Use `level:slots` entries in the settings, such as:

- Normal special facilities: `5:2, 9:4, 13:5, 17:6`
- Indy Venture facilities: `5:6`

Basic facilities are left to normal D&D5e behavior.

## Module Settings

- **Integrate with Bastion Turns**: automatically process ventures when a bastion turn advances.
- **Post Venture Summary Cards**: post the venture results to chat.
- **Hide Venture Hirelings**: hide hireling slots on venture-enabled facilities.
- **Coverage Prompt Timeout**: how long to wait for a player to answer deficit prompts.
- **Roll Prompt Timeout**: how long to wait for delegated venture rolls before the GM is prompted.
- **Shared Bastion**: open the shared bastion configuration window.
- **Enable Debug Logging**: show detailed console logs for troubleshooting.

## Turn Results

For each enabled venture, the module:

1. Gets profit and loss rolls.
2. Converts the result to gold using **Gold per Point**.
3. Adds profit to venture treasury or handles a deficit.
4. Updates growth, degradation, or failure.
5. Updates temporary venture effects.

If several ventures need player rolls, the prompts are sent out together where possible so players can roll without waiting for each other in sequence.

## Deficits

If a venture loses money, the GM can configure how that loss is handled:

- Use venture treasury first.
- Automatically cover remaining losses from the character's gold.
- Ask the player or GM whether to cover the loss.

If a deficit is not covered, the venture can degrade or fail depending on its configuration.

## Troubleshooting

- **I do not see the Bastion tab**: confirm D&D5e bastions are enabled and the actor is eligible for bastion features.
- **Players cannot use normal bastion controls**: in shared bastion settings, enable **Sync Actor Ownership** and give those players Owner access.
- **A player can manage the bastion but not a venture**: check the individual venture facility permissions.
- **Boon buttons are disabled**: check the boon cost, purchase window, and per-turn or group limits.
- **The chat card says the summary is stale**: use the newest venture summary card for the current bastion turn.
- **Something is not resolving as expected**: enable **Debug Logging** and check the browser console.

## Compendiums

Indy Ventures includes:

- **Venture Facilities**: example venture facilities and supporting items/effects.
- **Venture Macros**: utility macros, including a macro for copying a venture to a compendium.
