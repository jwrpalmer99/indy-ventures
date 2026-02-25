# Indy Ventures

`indy-ventures` adds venture-style business automation to D&D5e bastions (Foundry VTT v13, dnd5e 5.2.5+).

## What it does

- Adds a **Venture Automation** section to each D&D5e `facility` item sheet.
- Adds a `Venture Facilities` compendium pack with ready-to-drop special facilities:
  - `Venture Facility (Cramped)`
  - `Venture Facility (Roomy)`
  - `Venture Facility (Vast)`
- Supports venture presets based on the article examples:
  - `Mangy Minotaur Tavern`
  - `Cult of the Minotaur`
- Resolves venture profit/loss automatically whenever a bastion turn summary is created.
- Tracks per-facility venture state:
  - current profit die
  - success streak
  - venture treasury
  - failed status
- Posts a venture summary chat card with:
  - boon purchase buttons
  - claim treasury to character GP button
  - deficit coverage status

## Configure a facility

1. Open a **special bastion facility**.
2. In **Details**, scroll to **Venture Automation**.
3. Enable venture automation and choose a preset or custom values.
4. Add boons using one line per boon:

```text
Name | Cost | Description
```

## Notes

- One bastion turn is treated as one venture month.
- Venture treasury is always used first to absorb losses.
- If **Auto-cover Deficits** is enabled, any remaining deficit is paid from the actor's GP before degrading profit die.
- If **Auto-cover Deficits** is disabled and the actor has enough GP for the remainder, the module prompts an active owner (prefers non-GM owner) to decide whether to cover it.
- When a venture fails at `d4` profit die with uncovered losses, it is disabled.
- When venture automation is enabled on a facility, the standard facility order/crafting sections are hidden.
- Venture-enabled facilities suppress hireling slots in the character bastion tab.
