import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { hexToString, stringToHex } from "viem";
import LiveAuth from "../src/components/privy.client";
import { useAuth, type Session } from "../src/components/auth";

const wallet = vi.hoisted(() => ({
  address: "0xAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb",
  request: vi.fn().mockResolvedValue("0x1234"),
}));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => children,
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    user: {
      id: "did:privy:provider-test",
      linkedAccounts: [
        {
          type: "wallet",
          chainType: "ethereum",
          address: "0x3333333333333333333333333333333333333333",
        },
      ],
    },
    login: () => {},
    logout: async () => {},
    getAccessToken: async () => "provider-test",
  }),
  useCreateWallet: () => ({ createWallet: async () => {} }),
  useSendTransaction: () => ({ sendTransaction: vi.fn() }),
  useWallets: () => ({
    ready: true,
    wallets: [
      {
        address: wallet.address,
        linked: true,
        getEthereumProvider: async () => ({ request: wallet.request }),
      },
      { address: "0x2222222222222222222222222222222222222222", linked: false },
    ],
  }),
}));
beforeEach(() => vi.clearAllMocks());
function session() {
  let current!: Session;
  function Probe() {
    current = useAuth();
    return null;
  }
  renderToStaticMarkup(
    createElement(LiveAuth, {
      appId: "local-provider-test",
      children: createElement(Probe),
    }),
  );
  return current;
}
it("sends personal_sign hex DATA with the exact UTF-8 server message and original wallet address", async () => {
  const message = "muse #1: Bard’s home\nSigned at 1793275200.";
  expect(
    await session().signMessage(wallet.address.toLowerCase(), message),
  ).toBe("0x1234");
  expect(wallet.request).toHaveBeenCalledExactlyOnceWith({
    method: "personal_sign",
    params: [stringToHex(message), wallet.address],
  });
  expect(hexToString(wallet.request.mock.calls[0][0].params[0])).toBe(message);
});
it("exposes connected linked wallets without disconnected or unlinked wallets", () => {
  expect(session().evmAddresses).toEqual([wallet.address]);
});
it("refuses a wallet that is not connected before requesting a signature", async () => {
  await expect(
    session().signMessage(
      "0x3333333333333333333333333333333333333333",
      "server line",
    ),
  ).rejects.toThrow("Connect the wallet that holds this muse.");
  expect(wallet.request).not.toHaveBeenCalled();
});
