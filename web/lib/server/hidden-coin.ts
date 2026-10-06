import type { Hex } from "@twain/shared";
import { erc20Abi } from "viem";
import { isHiddenCoin } from "@/config/twain-token";
import { rpc } from "@/indexer/rpc";

/**
 * Whether a coin page must answer 404: the coin is on the hidden list, or — when the indexer has no record of it yet —
 * its onchain name or ticker is reserved for the official $TWAIN. The indexer itself never stores hidden coins, so an
 * indexed coin is visible by definition. A failing RPC read shows the page (a fresh legitimate coin is not blocked).
 */
export async function isHiddenCoinPage(address: Hex, indexed: boolean): Promise<boolean> {
  if (isHiddenCoin(address)) return true;
  if (indexed) return false;
  try {
    const [name, symbol] = await rpc.multicall({
      contracts: [
        { address, abi: erc20Abi, functionName: "name" },
        { address, abi: erc20Abi, functionName: "symbol" },
      ],
      allowFailure: true,
    });
    return isHiddenCoin(address, name.result ?? null, symbol.result ?? null);
  } catch {
    return false;
  }
}
