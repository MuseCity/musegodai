// Local workerd with intercepted outbound traffic. Never imported by production.
import { createRequire } from "node:module";
import type {
  WebsiteInput,
  WebsiteResult,
} from "../src/server/website-verification";
const require = createRequire(import.meta.url);
const wrangler = createRequire(require.resolve("wrangler/package.json"));
const { build } = wrangler("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare");

export async function originalityWorker(
  outbound: (request: Request) => Promise<Response> | Response,
) {
  const bundle = await build({
    stdin: {
      contents: `import { verifyWebsite } from './src/server/website-verification.ts';
        export default { async fetch(request) { return Response.json(await verifyWebsite(await request.json(), 'https://musegod.ai')); } };`,
      resolveDir: process.cwd(),
      sourcefile: "local-originality-worker.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*"],
    conditions: ["workerd", "worker", "browser"],
  });
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-22",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      outboundService: outbound,
    }),
  );
  return {
    async check(input: WebsiteInput): Promise<WebsiteResult> {
      const response = await worker.dispatchFetch("http://local.test/", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
      });
      return response.json();
    },
    dispose: () => worker.dispose(),
  };
}
