import { createServer as createHttpServer } from "node:http";
import { createServer } from "vite";
import { getRequestListener } from "@hono/node-server";
import {
  createRequestHandler,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createApi } from "../src/server/api";
import { ApiError } from "../src/server/errors";
import type { ObjectStore } from "../src/server/media";
import { assertLocalTarget } from "../scripts/local-target";
import { localImageProcessor } from "./image-processor";
import { fixtureAddresses } from "./wallet";
import { governanceRules } from "../src/shared/governance";
import { fixtureWebsiteVerifier } from "./originality-fixture";
const local = JSON.parse(readFileSync(".local/database.json", "utf8"));
assertLocalTarget(local.e2eUrl, "musecity_e2e", "musecity_app");
mkdirSync(".local/e2e-media", { recursive: true });
const store: ObjectStore = {
  async put(key, bytes) {
    writeFileSync(
      ".local/e2e-media/" + createHash("sha256").update(key).digest("hex"),
      new Uint8Array(bytes),
    );
  },
  async get(key) {
    try {
      const bytes = readFileSync(
        ".local/e2e-media/" + createHash("sha256").update(key).digest("hex"),
      );
      return {
        body: new Response(bytes).body!,
        httpEtag: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    } catch {
      return null;
    }
  },
};
const api = createApi({
  connectionString: local.e2eUrl,
  store,
  origin: "http://127.0.0.1:5191",
  verifyWebsite: fixtureWebsiteVerifier(local.e2eUrl),
  images: { process: localImageProcessor, origin: "http://127.0.0.1:5191" },
  wallets: {
    findWallet: async (userId) => {
      const name = userId.replace("did:privy:", ""),
        address = fixtureAddresses[name];
      return address ? { id: "fixture-wallet:" + name, address } : null;
    },
    balance: async (address) =>
      address === fixtureAddresses.alice
        ? BigInt(governanceRules.threshold)
        : 0n,
  },
  verify: async (token) => {
    if (!/^fixture:(alice|bob)$/.test(token))
      throw new ApiError(401, "INVALID_CREDENTIAL", "Invalid test identity");
    return "did:privy:" + token.slice(8);
  },
});
const vite = await createServer({
  configFile: "e2e/vite.config.ts",
  server: { middlewareMode: true, hmr: { port: 25191 } },
  appType: "custom",
});
const handler = createRequestHandler(
  () =>
    vite.ssrLoadModule(
      "virtual:react-router/server-build",
    ) as Promise<ServerBuild>,
  "development",
);
const listener = getRequestListener(async (request) => {
  const path = new URL(request.url).pathname;
  if (
    path.startsWith("/api/") ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/") ||
    path.startsWith("/media/") ||
    path.startsWith("/sitemaps/") ||
    [
      "/skill.md",
      "/openapi.json",
      "/mcp",
      "/robots.txt",
      "/sitemap.xml",
    ].includes(path)
  )
    return api.fetch(request);
  const { servicesContext } = await vite.ssrLoadModule("/src/context.ts");
  const context = new RouterContextProvider();
  context.set(servicesContext, {
    appId: "",
    origin: "http://127.0.0.1:5191",
    api,
  });
  return handler(request, context);
});
createHttpServer((req, res) => {
  vite.middlewares(req, res, () => {
    void listener(req, res);
  });
}).listen(5191, "127.0.0.1", () =>
  console.log(
    "Isolated browser fixture: http://127.0.0.1:5191 (test identity, local database, file object store)",
  ),
);
