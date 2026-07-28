const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("scripts/standard-boons-data.js", "utf8").replace(/^export /gm, "");

vm.runInNewContext(`${source}
const parsed = parseBoons("Workshop | 2 | 25 | 50 | Craft permit | @UUID[Item.abc]{Permit} | 3 | 4\\nLegacy | 1 | Legacy desc | Item.xyz | 1");
assert.equal(parsed.length, 2);
assert.equal(parsed[0].name, "Workshop");
assert.equal(parsed[0].turns, 2);
assert.equal(parsed[0].costGp, 25);
assert.equal(parsed[0].rewardGp, 50);
assert.equal(parsed[0].rewardUuid, "Item.abc");
assert.equal(parsed[0].rewardLabel, "Permit");
assert.equal(parsed[0].hirelingsRequired, 3);
assert.equal(parsed[0].rewardsAvailable, 4);
assert.equal(parsed[0].restrictToOnePerPlayer, true);
assert.equal(parsed[1].costGp, 0);
assert.equal(parsed[1].rewardGp, 0);
assert.equal(parsed[1].description, "Legacy desc");
assert.equal(parsed[1].rewardsAvailable, 1);
assert.equal(parsed[1].restrictToOnePerPlayer, true);
const unrestricted = parseBoons("Kitchen | 1 | 0 | 0 | Soup | Item.soup | 0 | 6 | 0")[0];
assert.equal(unrestricted.restrictToOnePerPlayer, false);
assert.equal(buildBoonLine({ name: "Restock", turns: 0, costGp: -1, rewardGp: 7, description: "Done", reward: "Item.reward", hirelingsRequired: 2, rewardsAvailable: 3, restrictToOnePerPlayer: false }), "Restock | 1 | 0 | 7 | Done | Item.reward | 2 | 3 | 0");
assert.equal(assignedBoonHirelings([
  { hirelingsRequired: 2, complete: false },
  { hirelingsRequired: 3, complete: true },
  { hirelingsRequired: "1" }
]), 3);
assert.equal(activeBoonStarts([
  { complete: false },
  { complete: true },
  {}
]), 2);
assert.equal(boonClaimCount({ rewardsAvailable: 3, claimedUserIds: ["a"] }, false), 2);
assert.equal(boonClaimCount({ rewardsAvailable: 3, claimedUserIds: ["a"] }, true), 1);
assert.equal(boonClaimCount({ rewardsAvailable: 3, claimedUserIds: ["a", "b", "c"] }, true), 0);
assert.deepEqual(spendCurrencyGp({ pp: 90, gp: 0 }, 10), {
  "system.currency.pp": 89,
  "system.currency.gp": 0,
  "system.currency.ep": 0,
  "system.currency.sp": 0,
  "system.currency.cp": 0
});
assert.deepEqual(spendCurrencyGp({ pp: 1, gp: 5, sp: 7 }, 10), {
  "system.currency.pp": 0,
  "system.currency.gp": 5,
  "system.currency.ep": 1,
  "system.currency.sp": 2,
  "system.currency.cp": 0
});
assert.equal(spendCurrencyGp({ gp: 9 }, 10), null);
`, { assert });

console.log("standard boon parser ok");
