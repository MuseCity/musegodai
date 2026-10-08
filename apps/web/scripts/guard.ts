import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const root = resolve("../..");
const musecity = JSON.parse(
  readFileSync(join(root, "assets/musecity-logo-set/source.json"), "utf8"),
);
for (const file of musecity.files) {
  const bytes = readFileSync(join(root, file.path));
  if (
    createHash("sha256").update(bytes).digest("hex") !== file.sha256 ||
    bytes[25] !== 6
  )
    throw new Error("Musecity original or alpha channel changed: " + file.path);
}
const mascot = JSON.parse(
  readFileSync(join(root, "assets/musecity-mascot-set/source.json"), "utf8"),
);
for (const file of mascot.files) {
  const bytes = readFileSync(join(root, file.path));
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error("Musecity mascot asset changed: " + file.path);
}
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}
for (const path of [...walk("src"), ...walk("workers")]) {
  const text = readFileSync(path, "utf8");
  if (
    /from\s+['"][^'"]*(?:e2e|tests)\//.test(text) ||
    /fixture:(?:alice|bob)|AUTH_BYPASS|SKIP_AUTH/.test(text)
  )
    throw new Error("Production imports test identity: " + path);
}
const parsed = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync("wrangler.jsonc", "utf8"),
);
if (parsed.error) throw new Error("Invalid Wrangler configuration");
const config = parsed.config;
if (!config.compatibility_flags?.includes("global_fetch_strictly_public"))
  throw new Error(
    "Creator-marker verification requires public-only Worker fetch egress.",
  );
if (process.argv.includes("--deployment")) {
  if (!config.hyperdrive?.[0]?.id || /^0+$/.test(config.hyperdrive[0].id))
    throw new Error("Configure a real Hyperdrive binding before deployment.");
  if (config.vars.APP_ORIGIN !== "https://musegod.ai")
    throw new Error("Configure the production origin before deployment.");
  if (!config.vars.PRIVY_APP_ID)
    throw new Error("Configure the production Privy App ID before deployment.");
  if (
    !config.account_id ||
    !config.routes?.some(
      (route: { pattern: string }) => route.pattern === "musegod.ai",
    )
  )
    throw new Error(
      "Configure the new Cloudflare account and domain before deployment.",
    );
}
console.log(
  "Guard passed: " +
    musecity.files.length +
    " Musecity originals and " +
    mascot.files.length +
    " mascot sources/exports intact; production/test identity boundary intact.",
);
