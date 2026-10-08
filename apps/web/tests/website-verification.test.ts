import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { originalityWorker } from "../e2e/originality-worker";
import { verificationUrl } from "../src/server/website-verification";
import type { WebsiteSubject } from "../src/server/website-verification";
const subject = {
  kind: "account" as const,
  id: "account1",
  name: "Creator",
  marker: "mc_u_public-marker",
};
const agent = {
  kind: "agent" as const,
  id: "agent1",
  name: "Muse",
  marker: "mc_a_public-marker",
};
const meta = `<meta name="musecity-creator" content="${subject.marker}">`;
let worker: Awaited<ReturnType<typeof originalityWorker>>;
let serve: (request: Request) => Promise<Response> | Response;
let requests: Request[];
beforeAll(async () => {
  worker = await originalityWorker((request) => {
    requests.push(request);
    return serve(request);
  });
});
afterAll(async () => {
  await worker.dispose();
});
function check(html: string, subjects: WebsiteSubject[] = [subject]) {
  requests = [];
  serve = () =>
    new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  return worker.check({ url: "https://creator.example.com/site", subjects });
}
describe("website verification in real local workerd with intercepted external responses", () => {
  it("matches only complete creator meta values in the initial HTML head", async () => {
    expect(
      (await check(`<html><head>${meta}</head><body>Hello</body></html>`))
        .status,
    ).toBe("verified");
    expect(
      (
        await check(
          `<html><head><META NAME='musecity-creator' CONTENT='${subject.marker}'></head></html>`,
        )
      ).status,
    ).toBe("verified");
    for (const html of [
      `<html><head></head><body>${meta}</body></html>`,
      `<html><head><!-- ${meta} --></head></html>`,
      `<html><head><script>const example = '${meta}';</script></head></html>`,
      `<html><head>&lt;meta name="musecity-creator" content="${subject.marker}"&gt;</head></html>`,
      `<html><head><meta name="musecity-creator" content="${subject.marker}-extra"></head></html>`,
      `<html><head><meta name="musecity-creator" content="somebody-else"></head></html>`,
      `<html><head></head><body><iframe srcdoc='<head>${meta}</head>'></iframe></body></html>`,
      `<html><head></head><body><head>${meta}</head></body></html>`,
      `<html><div><head>${meta}</head></div></html>`,
      `<html><head><div><head>${meta}</head></div></head></html>`,
      `<html><head><template><head>${meta}</head></template></head></html>`,
      `<html>Body text<head>${meta}</head></html>`,
      `<html><head>Body text${meta}</head></html>`,
      `<html><head>&#65;${meta}</head></html>`,
    ])
      expect((await check(html)).reason, html).toBe("marker_missing");
    expect(
      (
        await check(
          `<!doctype html>\n<html><head>\n<title>My site</title><style>body { color: red; }</style><script>let x = 1;</script>${meta}</head></html>`,
        )
      ).status,
    ).toBe("verified");
    const both = await check(
      `<html><head>${meta}<meta name="musecity-creator" content="${agent.marker}"></head></html>`,
      [agent, subject],
    );
    expect(both.subject).toEqual({
      kind: "agent",
      id: agent.id,
      name: agent.name,
    });
  });
  it("rejects unsafe destinations before sending any request", async () => {
    requests = [];
    for (const url of [
      "http://creator.example.com",
      "https://creator.example.com:444",
      "https://u:p@creator.example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://2130706433",
      "https://0x7f000001",
      "https://localhost",
      "https://something.internal",
      "https://something.local",
      "https://example.invalid",
      "https://musegod.ai/api/v1/me",
      "https://api.musegod.ai",
      "https://musecity.xyz/api/v1/me",
      "https://api.musecity.xyz",
    ])
      expect(
        (await worker.check({ url, subjects: [subject] })).reason,
        url,
      ).toBe("unsafe_url");
    expect(requests).toHaveLength(0);
    expect(
      verificationUrl(
        "https://creator.example.com:443/site?q=1#page",
        "https://musegod.ai",
      )?.href,
    ).toBe("https://creator.example.com/site?q=1");
  });
  it("follows bounded same-origin redirects with fresh credential-free requests", async () => {
    requests = [];
    serve = (request) =>
      new URL(request.url).pathname === "/final"
        ? new Response(`<head>${meta}</head>`, {
            headers: { "Content-Type": "text/html" },
          })
        : new Response(null, { status: 302, headers: { Location: "/final" } });
    const good = await worker.check({
      url: "https://creator.example.com/site#route",
      subjects: [subject],
    });
    expect(good.status).toBe("verified");
    expect(good.finalUrl).toBe("https://creator.example.com/final");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.method).toBe("GET");
    }
    requests = [];
    serve = () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://other.example.com/final" },
      });
    expect(
      (
        await worker.check({
          url: "https://creator.example.com/site",
          subjects: [subject],
        })
      ).reason,
    ).toBe("cross_origin_redirect");
    expect(requests).toHaveLength(1);
    requests = [];
    serve = () =>
      new Response(null, { status: 302, headers: { Location: "/loop" } });
    expect(
      (
        await worker.check({
          url: "https://creator.example.com/site",
          subjects: [subject],
        })
      ).reason,
    ).toBe("redirect_limit");
    expect(requests).toHaveLength(4);
    serve = () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://127.0.0.1/secret" },
      });
    expect(
      (
        await worker.check({
          url: "https://creator.example.com/site",
          subjects: [subject],
        })
      ).reason,
    ).toBe("unsafe_url");
  });
  it("limits successful HTML responses and distinguishes failures", async () => {
    for (const [status, type, reason] of [
      [403, "text/html", "http_error"],
      [200, "application/json", "not_html"],
      [503, "text/html", "http_error"],
    ] as const) {
      requests = [];
      serve = () =>
        new Response(meta, { status, headers: { "Content-Type": type } });
      expect(
        (
          await worker.check({
            url: "https://creator.example.com/site",
            subjects: [subject],
          })
        ).reason,
      ).toBe(reason);
    }
    expect(
      (await check(`<head>${meta}</head>` + "a".repeat(1024 * 1024))).reason,
    ).toBe("too_large");
    requests = [];
    // Outbound-service fixtures do not model origin wire compression. Supply
    // the decoded fetch body, while retaining the origin's encoding header.
    serve = () =>
      new Response(`<head>${meta}</head>` + "a".repeat(1024 * 1024), {
        headers: { "Content-Type": "text/html", "Content-Encoding": "gzip" },
      });
    expect(
      (
        await worker.check({
          url: "https://creator.example.com/site",
          subjects: [subject],
        })
      ).reason,
    ).toBe("too_large");
    requests = [];
    serve = () => {
      throw new Error("network unavailable");
    };
    // Miniflare's outbound proxy turns a handler exception into an HTTP error.
    expect(
      (
        await worker.check({
          url: "https://creator.example.com/site",
          subjects: [subject],
        })
      ).reason,
    ).toBe("http_error");
    requests = [];
    serve = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5100));
      return new Response("late", { headers: { "Content-Type": "text/html" } });
    };
    expect(
      (
        await worker.check({
          url: "https://creator.example.com/site",
          subjects: [subject],
        })
      ).reason,
    ).toBe("timeout");
  });
});
