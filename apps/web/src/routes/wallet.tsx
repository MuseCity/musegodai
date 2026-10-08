import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { formatUnits, type Hex } from "viem";
import { RequireAuth, useAuth } from "../components/auth";
import { Dialog, Notice } from "../components/ui";
import { MembershipCard, useMembership } from "../components/membership";
import {
  walletChain,
  walletChains,
  type WalletChainId,
} from "../shared/chains";
import {
  transferRequest,
  walletError,
  type Transfer,
  type WalletAsset,
  type TransactionStatus,
} from "../shared/wallet";

export const meta = () => [
  { title: "Your wallet — musegod.ai" },
  { name: "robots", content: "noindex, follow" },
];
type Transaction = {
  hash: Hex;
  chainId: WalletChainId;
  status: TransactionStatus;
  description: string;
};
type BalanceRead = {
  assets: WalletAsset[];
  busy: boolean;
  fresh: boolean;
  error: string;
};
const emptyBalances: BalanceRead = {
  assets: [],
  busy: false,
  fresh: false,
  error: "",
};
const assetKey = (asset: WalletAsset) =>
  asset.address?.toLowerCase() ?? "native";
const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
const txKey = (tx: Transaction) => `${tx.chainId}:${tx.hash}`;
const transferField = (message: string) =>
  /^Enter a valid non-zero recipient address/.test(message)
    ? "recipient"
    : /^Enter a positive amount|^Enter a valid positive amount|^Insufficient asset balance/.test(
          message,
        )
      ? "amount"
      : null;

export default function Wallet() {
  return (
    <RequireAuth
      title="Your musegod.ai wallet."
      description="Sign in to receive tokens, transfer assets and check your formal membership."
    >
      <WalletPage />
    </RequireAuth>
  );
}
function WalletPage() {
  const auth = useAuth(),
    wallet = auth.wallet,
    member = useMembership();
  const [chainId, setChainId] = useState<WalletChainId>(4663);
  const [balances, setBalances] = useState<BalanceRead>(emptyBalances);
  const [selectedKey, setSelectedKey] = useState("native");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [fields, setFields] = useState<{ recipient?: string; amount?: string }>(
    {},
  );
  const [transferError, setTransferError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [networkError, setNetworkError] = useState("");
  const [creationError, setCreationError] = useState("");
  const [switching, setSwitching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [panel, setPanel] = useState<
    "receive" | "send" | "review" | "result" | null
  >(null);
  const [review, setReview] = useState<Transfer | null>(null);
  const [resultKey, setResultKey] = useState("");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const [copyErrors, setCopyErrors] = useState<Record<string, string>>({});
  const generation = useRef(0),
    alive = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const recipientInput = useRef<HTMLInputElement>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const stepHeading = useRef<HTMLParagraphElement>(null);
  const storageKey = "musecity.wallet.transactions:" + auth.userId;
  useEffect(() => {
    alive.current = true;
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(storageKey) ?? "[]",
      );
      if (Array.isArray(saved))
        setTransactions(
          saved
            .filter(
              (t): t is Transaction =>
                !!t &&
                typeof t === "object" &&
                /^0x[0-9a-fA-F]{64}$/.test(t.hash) &&
                [4663, 8453].includes(t.chainId) &&
                ["pending", "confirmed", "reverted"].includes(t.status) &&
                typeof t.description === "string",
            )
            .slice(0, 5),
        );
    } catch {
      /* Session history is optional. */
    }
    return () => {
      alive.current = false;
      generation.current++;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [storageKey]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (panel === "send")
        (amountInput.current?.getAttribute("aria-invalid") === "true"
          ? amountInput
          : recipientInput
        ).current?.focus();
      else if (panel === "review" || panel === "result")
        stepHeading.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [panel]);
  function saveTransactions(
    update: (previous: Transaction[]) => Transaction[],
  ) {
    if (!alive.current) return;
    setTransactions((previous) => {
      const next = update(previous).slice(0, 5);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* Still show the transaction. */
      }
      return next;
    });
  }
  const refresh = useCallback(async () => {
    if (!wallet) return;
    const run = ++generation.current;
    setBalances((previous) => ({
      ...previous,
      busy: true,
      fresh: false,
      error: "",
    }));
    try {
      const assets = await wallet.assets(chainId);
      if (alive.current && run === generation.current)
        setBalances({ assets, busy: false, fresh: true, error: "" });
    } catch (e) {
      if (alive.current && run === generation.current)
        setBalances((previous) => ({
          ...previous,
          busy: false,
          fresh: false,
          error: walletError(e),
        }));
    }
  }, [wallet, chainId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function switchNetwork(id: WalletChainId) {
    if (!wallet || switching || submitting || id === chainId) return;
    generation.current++;
    setSwitching(true);
    setNetworkError("");
    setBalances((previous) => ({ ...previous, busy: false, fresh: false }));
    try {
      await wallet.switchChain(id);
      if (!alive.current) return;
      setBalances(emptyBalances);
      setChainId(id);
      setSelectedKey("native");
      setAmount("");
      setReview(null);
      setFields({});
      setTransferError("");
      setUncertain(false);
      setPanel(null);
      setCopied("");
      setCopyErrors({});
    } catch (e) {
      if (alive.current) {
        setNetworkError(walletError(e));
        void refresh();
      }
    } finally {
      if (alive.current) setSwitching(false);
    }
  }
  async function checkTransaction(tx: Transaction) {
    if (!wallet || checking[txKey(tx)]) return;
    const key = txKey(tx);
    setChecking((previous) => ({ ...previous, [key]: true }));
    setStatusErrors((previous) => ({ ...previous, [key]: "" }));
    try {
      const status = await wallet.status(tx.chainId, tx.hash);
      saveTransactions((previous) =>
        previous.map((item) =>
          txKey(item) === key ? { ...item, status } : item,
        ),
      );
      if (alive.current && status !== "pending") {
        void refresh();
        member.reload();
      }
    } catch (e) {
      if (alive.current)
        setStatusErrors((previous) => ({
          ...previous,
          [key]:
            "Status is temporarily unavailable. Keep this hash and check again or open the explorer. " +
            walletError(e),
        }));
    } finally {
      if (alive.current)
        setChecking((previous) => ({ ...previous, [key]: false }));
    }
  }
  async function send() {
    if (!wallet || !review || !reviewFresh || submitting || uncertain) return;
    const transfer = review;
    // Remove the native top-layer dialog before Privy's confirmation opens.
    flushSync(() => {
      setPanel(null);
      setSubmitting(true);
      setTransferError("");
    });
    try {
      const hash = await wallet.send(transfer);
      if (!alive.current) return;
      const tx: Transaction = {
        hash,
        chainId: transfer.chainId,
        status: "pending",
        description: `${transfer.amount} ${transfer.asset.symbol} to ${transfer.recipient}`,
      };
      saveTransactions((previous) => [
        tx,
        ...previous.filter((item) => txKey(item) !== txKey(tx)),
      ]);
      setResultKey(txKey(tx));
      setPanel("result");
      setReview(null);
      setAmount("");
      void refresh();
      void checkTransaction(tx);
    } catch (e) {
      if (alive.current) {
        const message = walletError(e);
        const field = transferField(message);
        if (field) {
          setFields({ [field]: message });
          setTransferError("");
          setReview(null);
          setPanel("send");
          void refresh();
        } else {
          setTransferError(message);
          setUncertain(/uncertain|check.*activity/i.test(message));
          setPanel("review");
        }
      }
    } finally {
      if (alive.current) setSubmitting(false);
    }
  }
  async function copy(value: string, key: string) {
    setCopyErrors((previous) => ({ ...previous, [key]: "" }));
    try {
      await navigator.clipboard.writeText(value);
      if (!alive.current) return;
      setCopied(key);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(""), 2000);
    } catch {
      if (alive.current)
        setCopyErrors((previous) => ({
          ...previous,
          [key]: "Copy failed. Select the full address and copy it manually.",
        }));
    }
  }
  function open(next: "receive" | "send", element: HTMLElement) {
    opener.current = element;
    setPanel(next === "send" && review && reviewFresh ? "review" : next);
  }
  function close() {
    setPanel(null);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
    });
  }
  function startNewTransfer() {
    setReview(null);
    setRecipient("");
    setAmount("");
    setFields({});
    setTransferError("");
    setUncertain(false);
    setPanel("send");
  }
  const assets = balances.assets;
  const asset = assets.find((item) => assetKey(item) === selectedKey);
  const assetFresh = balances.fresh;
  const reviewFresh =
    !!review &&
    review.chainId === chainId &&
    balances.fresh &&
    assets.some((item) => assetKey(item) === assetKey(review.asset));
  const chain = walletChain(chainId),
    explorer = chain.blockExplorers.default.url;
  const result = transactions.find((item) => txKey(item) === resultKey);
  function copyButton(value: string, key: string, label: string) {
    return (
      <>
        <button
          className="text-link wallet-copy"
          onClick={() => void copy(value, key)}
        >
          {copied === key ? "Copied" : label}
        </button>
        {copyErrors[key] && <Notice>{copyErrors[key]}</Notice>}
      </>
    );
  }
  function transactionContent(tx: Transaction) {
    const key = txKey(tx);
    return (
      <>
        <div className="wallet-section-heading">
          <strong className="wallet-wrap">
            {walletChain(tx.chainId).name}
          </strong>
          <span className="governance-status" role="status">
            {tx.status}
          </span>
        </div>
        <p className="wallet-wrap">{tx.description}</p>
        <a
          className="text-link wallet-address"
          href={`${walletChain(tx.chainId).blockExplorers.default.url}/tx/${tx.hash}`}
          target="_blank"
          rel="noreferrer"
        >
          {tx.hash}
        </a>
        {statusErrors[key] && <Notice>{statusErrors[key]}</Notice>}
        {(tx.status === "pending" || statusErrors[key]) && (
          <button
            className="secondary"
            disabled={checking[key]}
            onClick={() => void checkTransaction(tx)}
          >
            {checking[key] ? "Checking status…" : "Check status"}
          </button>
        )}
      </>
    );
  }
  return (
    <div className="governance-layout wallet-layout">
      <div className="wallet-page-heading">
        <h1>Your wallet.</h1>
        <p>Assets, ready to receive and send.</p>
      </div>
      <section
        className="governance-panel wallet-home"
        aria-label="Wallet assets"
      >
        {!wallet ? (
          <>
            <h2>musegod.ai embedded wallet</h2>
            <p>
              {!auth.walletsReady
                ? "Preparing your wallet…"
                : auth.walletAddress
                  ? "Your wallet connection is unavailable. Reload to reconnect your existing wallet."
                  : "Create your wallet to receive and send assets. Your account and voting access are already available."}
            </p>
            {auth.walletsReady &&
              (auth.walletAddress ? (
                <button
                  className="primary"
                  onClick={() => window.location.reload()}
                >
                  Reload wallet
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={creating}
                  onClick={async () => {
                    setCreating(true);
                    setCreationError("");
                    try {
                      await auth.retryWallet();
                      if (alive.current) member.reload();
                    } catch (e) {
                      if (alive.current) setCreationError(walletError(e));
                    } finally {
                      if (alive.current) setCreating(false);
                    }
                  }}
                >
                  {creating ? "Creating wallet…" : "Create wallet"}
                </button>
              ))}
            {creationError && <Notice>{creationError}</Notice>}
          </>
        ) : (
          <>
            <div className="wallet-overview">
              <div>
                <p className="wallet-eyebrow">musegod.ai wallet</p>
                <span className="wallet-account" title={wallet.address}>
                  {shortAddress(wallet.address)}
                </span>
              </div>
              <label className="wallet-network">
                Network
                <select
                  value={chainId}
                  disabled={switching || submitting}
                  onChange={(event) =>
                    void switchNetwork(
                      Number(event.target.value) as WalletChainId,
                    )
                  }
                >
                  {walletChains.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {networkError && <Notice>{networkError}</Notice>}
            <div className="wallet-actions">
              <button
                className="secondary"
                disabled={switching}
                onClick={(event) => open("receive", event.currentTarget)}
              >
                <ArrowDownLeft size={20} aria-hidden="true" />
                Receive
              </button>
              <button
                className="primary"
                disabled={switching || submitting}
                onClick={(event) => open("send", event.currentTarget)}
              >
                <ArrowUpRight size={20} aria-hidden="true" />
                Send
              </button>
            </div>
            <p className="wallet-status" role="status">
              {switching
                ? "Switching network…"
                : submitting
                  ? "Continue in your wallet to confirm or cancel the transfer."
                  : copied
                    ? "Full address copied."
                    : ""}
            </p>
            <div className="wallet-section-heading">
              <h2>Assets</h2>
              <button
                className="text-link"
                disabled={switching || balances.busy || submitting}
                onClick={() => void refresh()}
              >
                Refresh
              </button>
            </div>
            {balances.busy && (
              <p role="status" className="text-sm text-muted">
                Updating balances…
              </p>
            )}
            {balances.error && (
              <Notice>
                {balances.error}{" "}
                <button className="text-link" onClick={() => void refresh()}>
                  Retry balances
                </button>
              </Notice>
            )}
            {!balances.fresh && balances.assets.length > 0 && (
              <p className="wallet-stale">
                Balances are out of date. Refresh successfully before reviewing
                a transfer.
              </p>
            )}
            <ul className="wallet-assets">
              {assets.map((item) => (
                <li key={assetKey(item)}>
                  <div className="wallet-asset-row">
                    <strong className="wallet-wrap">{item.symbol}</strong>
                    <span className="wallet-balance">
                      {formatUnits(BigInt(item.balance), item.decimals)}
                    </span>
                  </div>
                  {item.address && (
                    <details className="wallet-contract">
                      <summary>Contract {shortAddress(item.address)}</summary>
                      <code className="wallet-address">{item.address}</code>
                      {copyButton(
                        item.address,
                        assetKey(item),
                        "Copy contract",
                      )}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <MembershipCard query={member} />
      {transactions.length > 0 && (
        <section className="governance-panel wallet-history">
          <h2>Recent transfers</h2>
          <p className="field-note">This account's current browser session.</p>
          <ul>
            {transactions.map((tx) => (
              <li key={txKey(tx)}>{transactionContent(tx)}</li>
            ))}
          </ul>
        </section>
      )}
      {panel && wallet && (
        <Dialog
          className="wallet-dialog"
          title={
            panel === "receive"
              ? "Receive assets"
              : panel === "send"
                ? "Send assets"
                : panel === "review"
                  ? "Review transfer"
                  : "Transfer submitted"
          }
          onClose={close}
        >
          {panel === "receive" && (
            <div className="wallet-receive">
              <p className="wallet-network-badge">{chain.name}</p>
              <div className="wallet-qr">
                <QRCodeSVG
                  value={wallet.address}
                  size={216}
                  marginSize={4}
                  bgColor="#FFFFFF"
                  fgColor="#000000"
                  title="Your receiving wallet address"
                />
              </div>
              <code className="wallet-address">{wallet.address}</code>
              <button
                className="primary"
                onClick={() => void copy(wallet.address, "address")}
              >
                {copied === "address" ? "Copied" : "Copy address"}
              </button>
              {copyErrors.address && <Notice>{copyErrors.address}</Notice>}
              <p className="wallet-status" role="status">
                {copied === "address" ? "Full wallet address copied." : ""}
              </p>
              <p className="wallet-fee-note">
                Send only assets on <strong>{chain.name}</strong>. The QR code
                contains your address; choose this network in the sending
                wallet.
              </p>
              <a
                className="text-link"
                href={`${explorer}/address/${wallet.address}`}
                target="_blank"
                rel="noreferrer"
              >
                View wallet activity ↗
              </a>
            </div>
          )}
          {panel === "send" && (
            <form
              className="wallet-send-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                setFields({});
                setTransferError("");
                if (!asset || !assetFresh || switching) {
                  setTransferError(
                    "Refresh this asset's balance successfully before reviewing a transfer.",
                  );
                  return;
                }
                const transfer: Transfer = {
                  chainId,
                  asset,
                  recipient: recipient.trim(),
                  amount: amount.trim(),
                };
                try {
                  transferRequest(transfer);
                  setReview(transfer);
                  setPanel("review");
                } catch (e) {
                  const message = walletError(e);
                  const field = transferField(message);
                  if (field) {
                    setFields({ [field]: message });
                    requestAnimationFrame(() =>
                      (field === "recipient"
                        ? recipientInput
                        : amountInput
                      ).current?.focus(),
                    );
                  } else setTransferError(message);
                }
              }}
            >
              <p className="wallet-network-badge">{chain.name}</p>
              <label htmlFor="send-asset">
                Asset
                <select
                  id="send-asset"
                  value={selectedKey}
                  onChange={(event) => {
                    setSelectedKey(event.target.value);
                    setFields({});
                  }}
                >
                  {assets.map((item) => (
                    <option key={assetKey(item)} value={assetKey(item)}>
                      {item.symbol}
                      {item.address ? ` · ${shortAddress(item.address)}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p id="send-balance" className="field-note wallet-wrap">
                Available:{" "}
                {asset
                  ? `${formatUnits(BigInt(asset.balance), asset.decimals)} ${asset.symbol}`
                  : "unavailable"}
                {asset && !assetFresh ? " · out of date" : ""}
              </p>
              {!assetFresh && (
                <div className="wallet-fee-note">
                  Refresh the balance before continuing.{" "}
                  <button
                    type="button"
                    className="text-link"
                    disabled={balances.busy}
                    onClick={() => void refresh()}
                  >
                    {balances.busy ? "Updating…" : "Refresh balances"}
                  </button>
                </div>
              )}
              <label htmlFor="send-recipient">
                Recipient address
                <input
                  id="send-recipient"
                  ref={recipientInput}
                  value={recipient}
                  onChange={(event) => {
                    setRecipient(event.target.value);
                    setFields((previous) => ({
                      ...previous,
                      recipient: undefined,
                    }));
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!fields.recipient}
                  aria-describedby={
                    fields.recipient ? "send-recipient-error" : undefined
                  }
                />
              </label>
              {fields.recipient && (
                <p
                  id="send-recipient-error"
                  className="wallet-field-error"
                  role="alert"
                >
                  {fields.recipient}
                </p>
              )}
              <label htmlFor="send-amount">
                Amount
                <input
                  id="send-amount"
                  ref={amountInput}
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setFields((previous) => ({
                      ...previous,
                      amount: undefined,
                    }));
                  }}
                  autoComplete="off"
                  aria-invalid={!!fields.amount}
                  aria-describedby={
                    fields.amount
                      ? "send-balance send-amount-error"
                      : "send-balance"
                  }
                />
              </label>
              {fields.amount && (
                <p
                  id="send-amount-error"
                  className="wallet-field-error"
                  role="alert"
                >
                  {fields.amount}
                </p>
              )}
              <p className="wallet-fee-note">
                Keep enough ETH on {chain.name} for the network fee. Your wallet
                shows the fee before you confirm.
              </p>
              {transferError && <Notice>{transferError}</Notice>}
              {uncertain && (
                <div className="wallet-result">
                  <a
                    className="text-link"
                    href={`${explorer}/address/${wallet.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Check wallet activity before sending again ↗
                  </a>
                  <button
                    type="button"
                    className="secondary"
                    onClick={startNewTransfer}
                  >
                    Start a new transfer
                  </button>
                </div>
              )}
              <button
                className="primary"
                disabled={!asset || !assetFresh || uncertain}
              >
                Review transfer
              </button>
            </form>
          )}
          {panel === "review" && review && (
            <>
              <p ref={stepHeading} tabIndex={-1} className="wallet-step-note">
                Check the details before continuing to your wallet.
              </p>
              <dl className="wallet-review">
                <dt>Network</dt>
                <dd>{walletChain(review.chainId).name}</dd>
                <dt>Amount</dt>
                <dd>
                  {review.amount} {review.asset.symbol}
                </dd>
                {review.asset.address && (
                  <>
                    <dt>Token contract</dt>
                    <dd>
                      <code>{review.asset.address}</code>
                    </dd>
                  </>
                )}
                <dt>Recipient</dt>
                <dd>
                  <code>{review.recipient}</code>
                </dd>
              </dl>
              <p className="wallet-fee-note">
                Your wallet checks the current balance and ETH network fee
                before asking you to confirm.
              </p>
              {!reviewFresh && (
                <p className="wallet-fee-note">
                  This balance is out of date.{" "}
                  <button
                    className="text-link"
                    disabled={balances.busy}
                    onClick={() => void refresh()}
                  >
                    Refresh balances
                  </button>{" "}
                  before continuing.
                </p>
              )}
              {transferError &&
                (/cancelled/i.test(transferError) ? (
                  <p className="wallet-fee-note" role="status">
                    {transferError}
                  </p>
                ) : (
                  <Notice>{transferError}</Notice>
                ))}
              {uncertain && (
                <div className="wallet-result">
                  <a
                    className="text-link"
                    href={`${explorer}/address/${wallet.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Check wallet activity before sending again ↗
                  </a>
                  <button className="secondary" onClick={startNewTransfer}>
                    Start a new transfer
                  </button>
                </div>
              )}
              <div className="wallet-dialog-actions">
                <button className="secondary" onClick={() => setPanel("send")}>
                  Back to edit
                </button>
                <button
                  className="primary"
                  disabled={submitting || uncertain || !reviewFresh}
                  onClick={() => void send()}
                >
                  Continue to wallet confirmation
                </button>
              </div>
            </>
          )}
          {panel === "result" && result && (
            <div className="wallet-result">
              <p ref={stepHeading} tabIndex={-1} className="wallet-step-note">
                A transaction hash was returned. Follow its status below.
              </p>
              {transactionContent(result)}
              <button className="primary" onClick={close}>
                Done
              </button>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
