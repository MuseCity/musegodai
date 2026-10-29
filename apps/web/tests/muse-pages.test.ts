import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, RouterContextProvider } from "react-router";
import { beforeEach, expect, it } from "vitest";
import { MuseChecklist } from "../src/components/muse-setup";
import { servicesContext } from "../src/context";
import { loader as directoryLoader } from "../src/routes/muses";
import { loader as detailLoader } from "../src/routes/muse";
import { deriveSteps } from "../src/shared/muse-steps";
import { fixture, reset } from "./helpers";
import { withMuses } from "./muse-fakes";

beforeEach(reset);
const origin = "https://musegod.ai";
function args(path: string, ref?: string) {
  const f = withMuses(fixture()),
    context = new RouterContextProvider();
  context.set(servicesContext, { appId: "", origin, api: f.app });
  return {
    f,
    request: new Request(origin + path),
    url: new URL(origin + path),
    pattern: ref ? "/muses/:ref" : "/muses",
    params: ref ? { ref } : {},
    context,
  };
}
it("redirects a unique prefix query but not a one-item filter without a query", async () => {
  await expect(directoryLoader(args("/muses?q=barit"))).rejects.toMatchObject({
    status: 302,
    headers: expect.any(Headers),
  });
  const only = args("/muses?filter=awake");
  const start = await only.f.call("/me/muses/1/start", { method: "POST" });
  const active = await only.f.call("/agent-connections", {
    method: "POST",
    token: null,
    body: { otp: start.data.otp },
  });
  await only.f.call("/agent", { token: active.data.credential.token });
  const response = await directoryLoader(only);
  expect(response.directory.items).toHaveLength(1);
});
it("does not redirect or paint public search results as Mine before authentication", async () => {
  const result = await directoryLoader(args("/muses?filter=mine&q=bard"));
  expect(result.directory.items).toEqual([]);
  expect(result.directory.counts.living).toBe(125);
  expect(result.seo.noindex).toBe(true);
});
it("uses a numbered canonical and ProfilePage metadata, redirecting name references with 301", async () => {
  await expect(detailLoader(args("/muses/bard", "bard"))).rejects.toMatchObject(
    { status: 301 },
  );
  const result = await detailLoader(args("/muses/1", "1"));
  expect(result.seo).toMatchObject({
    title: "Bard · MUSEGOD muse #1 — musegod.ai",
    canonical: origin + "/muses/1",
    noindex: false,
    structured: { "@type": "ProfilePage" },
  });
  expect(result.view.steps).toHaveLength(10);
});
it("qualifies HTTPS evidence and refuses executable, HTTP and protocol-relative upstream URLs", () => {
  const steps = deriveSteps({
    reports: { soul: "done" },
    connected: true,
    helloPostId: "safe-post",
    worlds: {
      flock: {
        linked: true,
        current: true,
        url: "https://flock.musegod.org/founding/12",
      },
      musebook: { linked: true, current: true, url: "javascript:alert(1)" },
      terrakin: {
        linked: true,
        current: true,
        url: "http://terrakin.org/r/r_0123456789abcdef",
      },
      x: { linked: true, current: true, url: "//x.com/bard" },
    },
  });
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(MuseChecklist, { name: "Bard", steps }),
    ),
  );
  expect(html.match(/class="muse-step /g)).toHaveLength(10);
  expect(html).toContain("reported by Bard");
  expect(html).toContain('href="/posts/safe-post"');
  expect(html).toMatch(
    /href="https:\/\/flock.musegod.org\/founding\/12" rel="[^"]*nofollow[^"]*ugc/,
  );
  expect(html).not.toMatch(/href="(?:javascript:|http:|\/\/)/);
});
