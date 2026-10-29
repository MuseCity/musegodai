export const publicRobinhoodRpc = "https://rpc.mainnet.chain.robinhood.com";

export function robinhoodEndpoints(rpcUrl?: string): string[] {
  try {
    if (rpcUrl && new URL(rpcUrl).protocol === "https:")
      return [...new Set([rpcUrl, publicRobinhoodRpc])];
  } catch {
    // Invalid optional configuration leaves the public endpoint available.
  }
  return [publicRobinhoodRpc];
}

export function retryableRpc(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const cause = error as {
      status?: unknown;
      code?: unknown;
      name?: string;
      cause?: unknown;
    };
    if (typeof cause.status === "number")
      return (
        cause.status === 429 || (cause.status >= 500 && cause.status <= 599)
      );
    if (
      cause.code === 429 ||
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(String(cause.code))
    )
      return true;
    if (
      error instanceof TypeError ||
      cause.name === "TimeoutError" ||
      cause.name === "AbortError"
    )
      return true;
    error = cause.cause;
  }
  return false;
}
