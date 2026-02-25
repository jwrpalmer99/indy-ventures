# Indy Ventures

Indy Ventures adds venture automation to D&D5e bastions. Spice up your bastions with customizable projects and rewards. Run a tavern, organize a cult, open an apothecary - tally your profits and spend them on boons.

The module integrates the idea of Ventures from https://blackcitadelrpg.com/running-a-business-5e/ directly into the existing Bastion Tab in 5e character sheets. Advance your bastion turn to watch your venture flourish (or fail) and purchase boons.

<img width="1454" height="917" alt="venture_image" src="https://github.com/user-attachments/assets/ea0943cd-14b9-4b93-93bb-d0640d9c204a" />

## What You Get

- Venture automation controls on D&D5e `facility` items (special facilities).
- Automatic venture resolution on bastion turns.
- Prompted profit/loss rolling (interactive roll dialogs).
- Venture state tracking: current profit die, success streak, venture treasury, and failed state.
- Boon system with per-boon per-turn limits, purchase windows, reward UUID support, and group turn limits.
- Active-effect driven venture modifiers (profit/loss die behavior, success threshold override, profit bonus, duration).
- Venture summary chat cards with boon purchase buttons and treasury claim actions.
- Compendiums grouped under **Indy Ventures**:
  - `Venture Facilities`
  - `Venture Macros`

## Requirements

- Foundry VTT: `13.x`
- System: `dnd5e` `5.2.5+`

## Module Settings

- `Integrate with Bastion Turns`: ventures auto-process when a bastion turn summary chat message is created.
- `Post Venture Summary Cards`: posts an Indy Ventures summary card after processing.
- `Hide Venture Hirelings`: venture-enabled facilities hide hireling slots in the bastion tab.
- `Enable Debug Logging`: writes detailed logs to browser console.
- `Coverage Prompt Timeout (seconds)`: owner response timeout for deficit coverage prompts (default `180`).
- `Roll Prompt Timeout (seconds)`: timeout for delegated owner profit/loss roll prompts before GM fallback (default `180`).

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

For non-venture Active Effects, use:

- `flags.indy-ventures.bastionDuration.expireNextTurn` (`true` / `false`)
- `flags.indy-ventures.bastionDuration.remainingTurns` (number)
- `flags.indy-ventures.bastionDuration.durationFormula` (roll formula)
- `flags.indy-ventures.bastionDuration.consumePerTurn` (`true` / `false`)

These are consumed on bastion turns and can be used for temporary actor buffs granted by boons.

## Turn Resolution Behavior

Each enabled venture on the actor is processed when a bastion turn is detected:

1. Prompt for profit roll.
2. Prompt for loss roll.
3. Convert points to GP using `Gold per Point`.
4. Apply net to treasury (or deficit handling).
5. Handle growth/degradation/failure.
6. Decrement relevant effect durations.

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

- Buying boons directly from chat.
- Claiming treasury to character (prompts for claim amount).
- Reward links (open linked Item/Effect sheet).

Cards also show net result styling, profit die changes, and applied venture modifier effects with remaining turns.

## Compendium and Macro Workflow

The module provides:

- `Indy Ventures / Venture Facilities` compendium
- `Indy Ventures / Venture Macros` compendium

Included utility macro scripts in `tools/`:

- `tools/macro-save-current-venture-to-compendium.js`: saves currently open venture facility to compendium.
- `tools/macro-save-selected-actor-venture-to-compendium.js`: pick actor + venture facility, then save to compendium.
- `tools/macro-populate-venture-facilities.js`: seed the facilities pack with starter entries.

Save macros update matching entries when identifier+name (or name) matches.
If identifier matches but name differs, they create a new entry with a new unique identifier.

## Troubleshooting

- Boon buttons disabled unexpectedly: verify purchase window and per-turn/group limits for current turn net.
- "Stale venture summary" warning: use the latest venture summary card for the current bastion turn.
- Effect timing unclear: check **Active Venture Effects** table on the facility sheet.
- Need deeper diagnostics: enable **Debug Logging** and inspect browser console output.
