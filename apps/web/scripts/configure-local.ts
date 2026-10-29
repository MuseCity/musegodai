import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse } from "dotenv";
import { assertCloudTarget } from "./cloud-target";

const vars = parse(readFileSync("../../.env", "utf8"));
assertCloudTarget(vars.SUPABASE_DATABASE_URL, "postgres");
if (!existsSync(".local/supabase-ca.crt")) {
  const response = await fetch(
    "https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt",
  );
  if (!response.ok)
    throw new Error(
      "Could not download the official Supabase root certificate.",
    );
  const certificate = await response.text();
  if (!certificate.includes("-----BEGIN CERTIFICATE-----"))
    throw new Error("Invalid certificate response.");
  writeFileSync(".local/supabase-ca.crt", certificate, { mode: 0o600 });
}
const runtime = existsSync(".local/supabase-runtime.json")
  ? JSON.parse(readFileSync(".local/supabase-runtime.json", "utf8"))
      .connectionString
  : "";
if (runtime) assertCloudTarget(runtime, "musecity_worker");
const configured = {
  PRIVY_APP_ID: vars.PRIVY_APP_ID ?? "",
  PRIVY_APP_SECRET: vars.PRIVY_APP_SECRET ?? "",
  ROBINHOOD_RPC_URL: vars.ROBINHOOD_RPC_URL ?? "",
  OPENSEA_API_KEY: vars.OPENSEA_API_KEY ?? "",
  SUPABASE_DATABASE_URL: runtime,
  APP_ORIGIN: "http://127.0.0.1:5190",
};
writeFileSync(
  ".dev.vars",
  Object.entries(configured)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log(
  "Local runtime configured from ignored files; root .env unchanged. Application origin: http://127.0.0.1:5190.",
);
