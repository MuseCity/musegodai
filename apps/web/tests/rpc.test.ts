import { describe, expect, it } from "vitest";
import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import {
  publicRobinhoodRpc,
  robinhoodEndpoints,
  retryableRpc,
} from "../src/server/rpc";

describe("Robinhood RPC policy", () => {
  it("uses configured HTTPS first, de-duplicates and drops invalid configuration", () => {
    expect(robinhoodEndpoints("https://a")).toEqual([
      "https://a",
      publicRobinhoodRpc,
    ]);
    expect(robinhoodEndpoints(publicRobinhoodRpc)).toEqual([
      publicRobinhoodRpc,
    ]);
    for (const value of [undefined, "", "http://a", "ws://a", "invalid"])
      expect(robinhoodEndpoints(value)).toEqual([publicRobinhoodRpc]);
  });

  it("retries only rate limits, server failures, timeout and network causes", () => {
    const url = "https://rpc.example.test/fake-key";
    for (const status of [429, 500, 503, 599]) {
      expect(retryableRpc({ status })).toBe(true);
      expect(retryableRpc(new HttpRequestError({ url, status }))).toBe(true);
    }
    for (const error of [
      new TypeError("fetch failed"),
      new DOMException("timeout", "TimeoutError"),
      new DOMException("aborted", "AbortError"),
      new TimeoutError({ url, body: {} }),
      new HttpRequestError({ url, cause: new TypeError("offline") }),
      { cause: { code: "ECONNRESET" } },
      { code: 429 },
    ])
      expect(retryableRpc(error)).toBe(true);
    for (const error of [
      null,
      "offline",
      new Error("other failure"),
      new SyntaxError("bad JSON"),
      { status: 400 },
      { status: 401 },
      { status: 403 },
      { code: -32602 },
      new HttpRequestError({ url, status: 403 }),
      new HttpRequestError({ url, cause: new SyntaxError("bad JSON") }),
      new RpcRequestError({
        url,
        body: {},
        error: { code: -32603, message: "internal error" },
      }),
    ])
      expect(retryableRpc(error)).toBe(false);
  });
});
