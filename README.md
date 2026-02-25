# Indy Ventures

`indy-ventures` adds venture-style automation to D&D5e bastions. Spice up your bastions! 

## Features

- This module integrates the idea of Ventures from https://blackcitadelrpg.com/running-a-business-5e/ into DnD5e Bastions - spice up your Bastions!

- Adds a **Venture Automation** section to each D&D5e `facility` item sheet.
- Adds `Indy Ventures` compendium folder with:
  - `Venture Facilities` item pack
  - `Venture Macros` macro pack
- Provides ready-to-drop special facilities:
  - `Venture Facility`
  - Example `Apothecary`
  - Example `Tavern`
  - Example `Cult`
  
- Resolves venture profit/loss on bastion turns (with prompted rolls).
- Tracks per-facility venture state:
  - current profit die
  - success streak
  - venture treasury
  - failed status
- Supports configurable boons with:
  - per-turn purchase limits
  - shared group purchase limits (group + group turn limit)
  - purchase windows (any turn / loss-or-break-even / profit-or-break-even)
  - item rewards and Active Effect rewards
  - text description only boons where the GM will manage the effect
- Supports venture modifier Active Effects (profit/loss die changes, growth threshold override, roll bonus, durations).
- Posts a venture summary chat card with:
  - boon purchase buttons
  - claim treasury to character GP button
  - deficit coverage status

## Requirements

- Foundry VTT v13
- dnd5e 5.2.5+

## Quick Setup

1. Open a **special bastion facility**.
2. In **Details**, scroll to **Venture Automation**.
3. Enable venture automation.
4. Configure:
   - Venture Name
   - Profit Die
   - Base Loss Die
   - Loss Die Modifier
   - Gold per Point (GP)
   - Successes to Grow
   - Auto-use Venture Treasury for Losses
   - Auto-cover Deficits
5. Click **Open Boon Editor** to manage boons (recommended).

## Boon Rewards

- Item reward UUID: grants a copy of the item to the actor.
- ActiveEffect reward UUID:
  - Venture modifier effects are applied to the venture facility.
  - Non-venture effects are applied to the actor.
- You can drag-drop Item/ActiveEffect documents into boon reward UUID fields.

## Bastion Duration Flags (Non-venture Active Effects)

Use these flags for effects that should tick on bastion turns:

- `flags.indy-ventures.bastionDuration.expireNextTurn` (`true`/`false`)
- `flags.indy-ventures.bastionDuration.remainingTurns` (number)
- `flags.indy-ventures.bastionDuration.durationFormula` (roll formula)
- `flags.indy-ventures.bastionDuration.consumePerTurn` (`true`/`false`)

## Notes / Behavior

- If **Auto-cover Deficits** is enabled, any remaining deficit is paid from the actor's GP before degrading profit die.
- If **Auto-use Venture Treasury for Losses** is enabled, treasury is spent first on deficits.
- If **Auto-cover Deficits** is disabled and the actor has enough GP for the remainder, the module prompts an active owner (prefers non-GM owner) to decide whether to cover it.
- When a venture fails at `d4` profit die with uncovered losses, it is disabled.
- When venture automation is enabled on a facility, the standard facility order/crafting sections are hidden.
- Venture-enabled facilities suppress hireling slots in the character bastion tab.
- If a facility does not have **Enable Venture** checked, venture-specific fields are hidden.
