import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallExecutionError,
  ExecutionRevertedError,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
} from "viem";

let rpc: typeof import("../src/server/rpc");
const publicEndpoints = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood.drpc.org",
  "https://robinhood-rpc.publicnode.com",
];
const configured = "https://configured.example.test/rpc";
beforeEach(async () => {
  vi.resetModules();
  rpc = await import("../src/server/rpc");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Robinhood RPC policy", () => {
  it("orders configured HTTPS before all three public endpoints and de-duplicates normalized URLs", () => {
    expect(rpc.robinhoodEndpoints(configured)).toEqual([
      configured,
      ...publicEndpoints,
    ]);
    for (const endpoint of publicEndpoints) {
      expect(rpc.robinhoodEndpoints(endpoint)).toEqual([
        endpoint,
        ...publicEndpoints.filter((url) => url !== endpoint),
      ]);
      expect(rpc.robinhoodEndpoints(endpoint + "/")).toHaveLength(3);
    }
    for (const value of [undefined, "", "http://a", "ws://a", "invalid"])
      expect(rpc.robinhoodEndpoints(value)).toEqual(publicEndpoints);
  });

  it.each([403, 408, 429, 500, 503, 599])(
    "retries HTTP %s including viem wrappers",
    (status) => {
      expect(rpc.retryableRpc({ status })).toBe(true);
      expect(
        rpc.retryableRpc(new HttpRequestError({ url: configured, status })),
      ).toBe(true);
    },
  );

  it.each([
    { code: -32005, message: "limit exceeded" },
    { code: -32603, message: "internal error" },
    ...[
      "RATE exceeded",
      "daily limit reached",
      "the network is busy",
      "capacity exhausted",
    ].map((message) => ({ code: -32000, message })),
  ])(
    "retries node errors $code: $message including nested viem causes",
    (error) => {
      expect(rpc.retryableRpc(error)).toBe(true);
      expect(
        rpc.retryableRpc(
          new RpcRequestError({ url: configured, body: {}, error }),
        ),
      ).toBe(true);
    },
  );

  it("retries viem limit/internal errors, timeouts and network causes", () => {
    for (const error of [
      new LimitExceededRpcError(new Error("unavailable")),
      new InternalRpcError(new Error("unavailable")),
      new TypeError("fetch failed"),
      new DOMException("timeout", "TimeoutError"),
      new DOMException("aborted", "AbortError"),
      new TimeoutError({ url: configured, body: {} }),
      new HttpRequestError({
        url: configured,
        cause: new TypeError("offline"),
      }),
      { cause: { code: "ECONNRESET" } },
      { code: 429 },
    ])
      expect(rpc.retryableRpc(error)).toBe(true);
  });

  it("does not retry execution reverts, even when their reason mentions a limit", () => {
    const revert = new ExecutionRevertedError({
      message: "execution reverted: owner limit",
    });
    for (const error of [
      revert,
      new CallExecutionError(revert, {}),
      { code: 3, message: "execution reverted" },
      { code: -32000, message: "execution reverted: capacity limit" },
      new RpcRequestError({
        url: configured,
        body: {},
        error: { code: -32000, message: "execution reverted: rate limit" },
      }),
    ])
      expect(rpc.retryableRpc(error)).toBe(false);
  });

  it("rejects validation, malformed responses and unrelated failures", () => {
    for (const error of [
      null,
      "offline",
      new Error("other failure"),
      new SyntaxError("bad JSON"),
      { status: 400 },
      { status: 401 },
      { code: -32602 },
      { code: -32000, message: "invalid input" },
      new HttpRequestError({ url: configured, status: 401 }),
      new HttpRequestError({
        url: configured,
        cause: new SyntaxError("bad JSON"),
      }),
    ])
      expect(rpc.retryableRpc(error)).toBe(false);
  });
});
