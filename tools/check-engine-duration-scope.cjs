const assert = require("assert");
const fs = require("fs");

const source = fs.readFileSync("scripts/engine.js", "utf8");

assert.match(source, /function collectBastionDurationActors\(actor\)/);
assert.match(source, /isSharedBastionActor\(actor\)/);
assert.match(source, /canViewActorVentures\(actor, user, "LIMITED"\)/);
assert.match(source, /collectBastionDurationActors\(actor\)\s*[\r\n]+\s*\.flatMap\(durationActor => collectActiveBastionDurationEffects\(durationActor\)\)/);

console.log("engine duration scope ok");
