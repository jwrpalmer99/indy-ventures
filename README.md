# Indy Ventures

Indy Ventures adds venture automation to D&D5e bastions. Spice up your bastions with customizable projects and rewards. Run a tavern, organize a cult, open an apothecary - tally your profits and spend them on improvements/items/active effects.

The module integrates the idea of Ventures from https://blackcitadelrpg.com/running-a-business-5e/ directly into the existing Bastion Tab in 5e character sheets. Advance your bastion turn to watch your venture flourish (or fail).

<img width="1486" height="695" alt="venture_image" src="https://github.com/user-attachments/assets/3b92fa94-5793-448f-a28a-7ffa9259cf53" />

## What You Get

- Venture automation controls on D&D5e `facility` items (special facilities).
- Automatic venture resolution on bastion turns.
- Prompted profit/loss rolling (interactive roll dialogs).
- Venture state tracking: current profit die, success streak, venture treasury, and failed state.
- Boon system with per-boon per-turn limits, boons that are only active while making profit/loss, reward UUID (items and effects) support, and group turn limits.
- Active-effect driven venture modifiers (profit/loss die behavior, success threshold override, profit bonus, duration).
- Venture summary chat cards with collapsible venture sections, boon purchase buttons, and treasury claim actions.
- Compendiums grouped under **Indy Ventures**:
  - `Venture Facilities`
  - `Venture Macros`

## Requirements

- Foundry VTT: `13.x` or `14.x`
- System: `dnd5e` `5.3.0+`

## Module Settings

- `Integrate with Bastion Turns`: ventures auto-process when a bastion turn summary chat message is created.
- `Post Venture Summary Cards`: posts an Indy Ventures summary card after processing.
- `Hide Venture Hirelings`: venture-enabled facilities hide hireling slots in the bastion tab.
- `Enable Debug Logging`: writes detailed logs to browser console.
- `Coverage Prompt Timeout (seconds)`: owner response timeout for deficit coverage prompts (default `180`).
- `Roll Prompt Timeout (seconds)`: timeout for delegated owner profit/loss roll prompts before GM fallback (default `180`).
- `Shared Bastion`: choose a shared character actor, set default and per-player venture permissions, and optionally sync those permissions to Foundry actor ownership.

## Shared Bastion

The shared bastion feature uses one real character actor as the shared bastion. Configure it from **Configure Settings -> Module Settings -> Indy Ventures -> Shared Bastion**.

- `None`: no shared venture access.
- `Limited` / `Observer`: can view shared venture summaries.
- `Owner`: can purchase boons, claim venture treasury, answer delegated venture prompts, and manage standard D&D bastion controls when ownership sync is enabled.

When **Sync Actor Ownership** is enabled, the module updates the shared actor's Foundry ownership to match the venture permissions. This is required for players to use D&D's built-in bastion controls because embedded facilities inherit actor ownership.

When a player opens a character sheet, the normal D&D **Bastion** tab opens the configured shared bastion instead of that character's personal bastion. The module does not add a separate shared bastion button to character sheets.

GM users can also set per-venture permissions on each venture-enabled facility. A player's effective venture permission is the lower of their shared bastion permission and that facility's override/default, so you can give several players Owner access to the shared bastion while limiting each venture to a smaller subset.

For shared bastions, Indy Ventures chat actions that mutate state, such as purchasing boons and claiming treasury, are delegated to the primary active GM over the module socket. The GM client re-checks the requester's per-venture permission, serializes actions and bastion-turn venture processing with a per-facility lock, and recalculates current treasury/purchase limits before writing changes.

When **Advance Only Shared Bastion** is enabled, D&D's global **Advance Bastion Turn** button advances only the configured shared bastion actor instead of every character actor with facilities.

Enable **Split Special Facility Slots** in the shared bastion configuration to give normal special facilities and Indy Venture facilities separate limits. Use comma-separated `level:slots` entries, for example normal specials `5:2, 9:4, 13:5, 17:6` and Indy Ventures `5:6`. Basic facilities are left to D&D5e's normal behavior: initial free basic facilities, then additional basic facilities can be built with time and money.

## Quick Start

1. Open a **Special Facility** item.
2. In **Details -> Venture Automation**, check **Enable Venture**.
3. Configure:
   - `Venture Name`
   - `Profit Die`
   - `Base Loss Die`
   - `Loss Die Modifier`
   - `Gold per Point (GP)`
   - `Successes to Grow`
   - `Natural 1 Degrades Profit Die`
   - `Auto-use Venture Treasury for Losses`
   - `Auto-cover Deficits (GP)`
4. Click **Open Boon Editor**.

Note: if **Enable Venture** is unchecked, venture-specific fields are hidden.

## Boon Editor

Use the editor (recommended) instead of editing raw text.

Per boon you can set:

- `Name`, `Cost`, `Description`
- `Reward UUID` (or drag/drop Item/ActiveEffect into the field)
- `Per-Turn Limit` (`blank = 1`, `unlimited` supported)
- `Purchase Window` (`Any Turn`, `Loss or Break-even Only`, `Profit or Break-even Only`)

### Boon Groups

- Groups are managed in a separate collapsible section.
- Create groups, set a group turn limit, then drag/drop boon chips into groups.
- The groups section collapses automatically when no groups are configured.

## Reward Types

- **Item UUID reward**: grants an item copy to the actor.
- **ActiveEffect UUID reward**: if it includes `flags.indy-ventures.ventureModifier`, it is applied to the facility. Otherwise it is applied to the actor.

For ActiveEffect rewards with duration formulas, duration rolls are prompted at purchase time.

## Venture Modifier Effects

Venture modifiers are read from Active Effects with `flags.indy-ventures.ventureModifier.*`.

Supported fields include:

- `profitDieStep`
- `profitDieOverride`
- `minProfitDie`
- `lossDieStep`
- `lossDieOverride`
- `maxLossDie`
- `successThresholdOverride`
- `profitRollBonus`
- `remainingTurns` / `durationFormula`
- `consumePerTurn`
- `bastionDurationType` (`nextBastionTurn` supported)

The boon editor wand button can generate a venture-modifier reward effect template and link it automatically.

## Non-Venture Bastion Durations (General Effects)

For non-venture Active Effects (ie if you want to apply a buff to the bastion's owner) use:

- `flags.indy-ventures.bastionDuration.expireNextTurn` (`true` / `false`)
- `flags.indy-ventures.bastionDuration.remainingTurns` (number)
- `flags.indy-ventures.bastionDuration.durationFormula` (roll formula)
- `flags.indy-ventures.bastionDuration.consumePerTurn` (`true` / `false`)

These are consumed on bastion turns and can be used for temporary actor buffs granted by boons that last for 1 (or n) bastion turns.

## Turn Resolution Behavior

Each enabled venture on the actor is processed when a bastion turn is detected. Roll prompts for prepared ventures are dispatched together where possible, then each venture is resolved with its own state lock.

1. Prompt for profit and loss rolls.
2. Convert points to GP using `Gold per Point`.
3. Apply net to treasury (or deficit handling).
4. Handle growth/degradation/failure.
5. Decrement relevant effect durations.

When the GM is processing the bastion turn, roll prompts are delegated to a connected actor owner when available; otherwise the GM is prompted.

Growth/degradation specifics:

- Break-even (`net = 0`) does **not** increase success streak.
- If `Natural 1 Degrades Profit Die` is enabled, a raw profit roll of `1` causes a one-step profit die downgrade (if it can drop).

### Deficit Handling

- If `Auto-use Venture Treasury for Losses` is enabled, treasury is spent first.
- If `Auto-cover Deficits` is enabled, remaining character portion is auto-paid from GP.
- If auto-cover is disabled and funds are available, owner/GM is prompted to:
  - cover from venture treasury first, then actor funds for the remainder
  - cover fully from actor funds
  - decline

## Chat Card Actions

Summary cards support:

- Expanding/collapsing the overall results card and each venture result section.
- Buying boons directly from chat.
- Claiming treasury to character (prompts for claim amount).
- Reward links (open linked Item/Effect sheet).

Cards also show net result styling, profit die changes, and applied venture modifier effects with remaining turns. For shared bastions, venture sections that the current viewer cannot manage start collapsed, while ventures they can manage start expanded.

## Compendium and Macro Workflow

- `Indy Ventures / Venture Facilities` compendium - this includes example ventures and some items/effects those examples need.
- `Indy Ventures / Venture Macros` compendium - contains a macro to copy a venture to a compendium (edit with your required compendium id).

## Troubleshooting

- Boon buttons disabled unexpectedly: verify purchase window and per-turn/group limits for current turn net.
- "Stale venture summary" warning: use the latest venture summary card for the current bastion turn.
- Effect timing unclear: check **Active Venture Effects** table on the facility sheet.
- Need deeper diagnostics: enable **Debug Logging** and inspect browser console output.
