import {
  PrivyProvider,
  usePrivy,
  useCreateWallet,
  useWallets,
  useSendTransaction,
} from "@privy-io/react-auth";
import { type Address } from "viem";
import { useMemo, useRef, type ReactNode } from "react";
import { AuthContext } from "./auth";
import { robinhood, walletChains } from "../shared/chains";
import {
  walletAssets,
  prepareTransfer,
  transactionStatus,
  switchWalletChain,
} from "./wallet-network";
import type { WalletSession } from "../shared/wallet";
function Session({ children }: { children: ReactNode }) {
  const p = usePrivy();
  const { createWallet } = useCreateWallet();
  const { wallets, ready: walletsReady } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const linked = p.user?.linkedAccounts.find(
    (a) =>
      a.type === "wallet" &&
      a.chainType === "ethereum" &&
      a.walletClientType === "privy" &&
      a.connectorType === "embedded" &&
      a.imported === false &&
      a.walletIndex === 0,
  );
  const address = linked?.type === "wallet" ? linked.address : undefined;
  const connected = wallets.find(
    (w) =>
      w.walletClientType === "privy" &&
      w.address.toLowerCase() === address?.toLowerCase(),
  );
  const identity = useRef(p.user?.id);
  identity.current = p.authenticated ? p.user?.id : undefined;
  const currentWallet = useRef(connected);
  currentWallet.current = connected;
  const wallet = useMemo<WalletSession | undefined>(() => {
    if (!p.authenticated || !connected) return;
    const userId = p.user?.id;
    const activeWallet = () =>
      identity.current === userId ? currentWallet.current : undefined;
    return {
      address: connected.address,
      switchChain: (chainId) => switchWalletChain(activeWallet, chainId),
      assets: (chainId, token) =>
        walletAssets(connected.address as Address, chainId, token),
      status: transactionStatus,
      send: async (transfer) => {
        const tx = await prepareTransfer(
          connected.address as Address,
          transfer,
        );
        if (identity.current !== userId)
          throw new Error(
            "Your account changed. Open your current wallet before sending.",
          );
        await switchWalletChain(activeWallet, transfer.chainId);
        if (identity.current !== userId)
          throw new Error(
            "Your account changed. Please retry from your wallet.",
          );
        try {
          const result = await sendTransaction(tx, {
            address: connected.address,
            uiOptions: {
              showWalletUIs: true,
              isCancellable: true,
              description: `Send ${transfer.amount} ${transfer.asset.symbol} on ${transfer.chainId === 4663 ? "Robinhood Chain" : "Base"}`,
              buttonText: "Confirm transfer",
            },
          });
          return result.hash;
        } catch (error) {
          if (
            error instanceof Error &&
            /reject|denied|cancelled|canceled|4001/i.test(error.message)
          )
            throw error;
          throw new Error(
            "The wallet did not return a transaction hash. Submission is uncertain. Check wallet activity before sending again.",
          );
        }
      },
    };
  }, [connected, p.authenticated, p.user?.id, sendTransaction]);
  return (
    <AuthContext
      value={{
        ready: p.ready,
        userId: p.authenticated ? (p.user?.id ?? null) : null,
        login: p.login,
        logout: p.logout,
        token: p.getAccessToken,
        walletAddress: address,
        wallet,
        walletsReady,
        retryWallet: async () => {
          await createWallet();
        },
        link: (kind) => {
          if (kind === "email") p.linkEmail();
          else if (kind === "google") p.linkGoogle();
          else if (kind === "twitter") p.linkTwitter();
          else p.linkWallet();
        },
        linked:
          p.user?.linkedAccounts
            .filter(
              (a) => a.type !== "wallet" || a.walletClientType !== "privy",
            )
            .map((a) => a.type) ?? [],
        configured: true,
      }}
    >
      {children}
    </AuthContext>
  );
}
export default function LiveAuth({
  appId,
  children,
}: {
  appId: string;
  children: ReactNode;
}) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "google", "twitter", "wallet"],
        defaultChain: robinhood,
        supportedChains: [...walletChains],
        appearance: {
          theme: "light",
          accentColor: "#9F1D2D",
          logo: "/brand/icon.png",
          landingHeader: "Log in to musegod.ai",
        },
        embeddedWallets: {
          showWalletUIs: true,
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      <Session>{children}</Session>
    </PrivyProvider>
  );
}
