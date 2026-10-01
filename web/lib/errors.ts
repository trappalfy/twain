import { COPY } from "@lancio/shared";
import { BaseError, ContractFunctionRevertedError, InsufficientFundsError, UserRejectedRequestError } from "viem";

/** Custom errors not covered by COPY.errors. */
const EXTRA: Record<string, string> = {
  InvalidName: "Name must be 1–32 characters.",
  InvalidSymbol: "Ticker must be 1–10 characters: A–Z and 0–9.",
  NotCreator: "Only the coin's creator can do this.",
  NotLocker: "This call is reserved for the liquidity locker.",
  NotLaunchpad: "This call is reserved for the launchpad.",
  NotPoolManager: "This call is reserved for Uniswap's PoolManager.",
  UnknownCoin: "This coin was not launched here.",
  AlreadyLaunched: "This coin's pool already exists.",
  WrongValue: "The ETH sent does not match the first buy.",
  InvalidStartMcap: "That start market cap is out of range.",
  NotAContract: "That address is not a token contract.",
  ZeroAddress: "An address is missing.",
  EthTransferFailed: "The ETH transfer failed. Try again.",
  RenounceDisabled: "Ownership can be handed over but not renounced.",
};

/** Revert error name (e.g. "SlippageExceeded") if the error carries a decoded custom error. */
export function revertErrorName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) return rev.data?.errorName ?? null;
  }
  return null;
}

/** Signature declined in the wallet — a state, not an error (brief §12). */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return true;
  const e = err as { code?: number; name?: string; message?: string } | null;
  return e?.code === 4001 || e?.name === "UserRejectedRequestError" || /user (rejected|denied)/i.test(e?.message ?? "");
}

/** Human text for any wallet / RPC / contract error. */
export function toFriendlyError(err: unknown): string {
  if (isUserRejection(err)) return COPY.errors.UserRejected;
  const name = revertErrorName(err);
  if (name) {
    if (name in COPY.errors) return COPY.errors[name as keyof typeof COPY.errors];
    if (name in EXTRA) return EXTRA[name];
  }
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof InsufficientFundsError)) return COPY.errors.InsufficientEth;
    const msg = `${err.shortMessage} ${err.details ?? ""}`;
    if (/insufficient funds|exceeds balance/i.test(msg)) return COPY.errors.InsufficientEth;
    if (/chain mismatch|does not match the target chain/i.test(msg)) return "Switch to Robinhood Chain and try again.";
    if (/deadline|expired/i.test(msg)) return COPY.errors.DeadlineExpired;
    return err.shortMessage || "Transaction failed.";
  }
  if (err instanceof Error) return /insufficient funds/i.test(err.message) ? COPY.errors.InsufficientEth : err.message.split("\n")[0];
  return "Something went wrong. Try again.";
}
