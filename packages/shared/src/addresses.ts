import type { Address } from "viem";

/** Official Uniswap v4 deployment on Robinhood Chain (developers.uniswap.org, verified onchain 2026-09-27). */
export const UNISWAP_V4 = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const satisfies Record<string, Address>;

export type Deployment = {
  /** TwainLauncher: launches coins through Pons V2 (contracts/src/pons/TwainLauncher.sol). */
  launcher: Address;
  /** L2 block of the launcher deploy transaction (indexer start block). */
  startBlock: number;
};

/**
 * Contract addresses per environment. Env overrides (NEXT_PUBLIC_LAUNCHER, NEXT_PUBLIC_START_BLOCK) take precedence.
 * The twain v1 Launchpad (0x2EEB…C0bC, 2026-10-02) is retired: coins now launch through Pons V2.
 */
export const DEPLOYMENTS: Record<"local" | "mainnet", Deployment | null> = {
  local: null,
  // TwainLauncher on Robinhood Chain (chain 4663), deployed by the owner 2026-10-02 (tx 0x8b92…869f); Sourcify: match.
  mainnet: {
    launcher: "0xc8eF70B7Bc47c2D63fD38Cf7124f9b322F949296",
    startBlock: 78457751,
  },
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export function getDeployment(env: Record<string, string | undefined> = {}): Deployment {
  const launcher = env.NEXT_PUBLIC_LAUNCHER || env.LAUNCHER_ADDRESS;
  const fromEnv = launcher
    ? { launcher: launcher as Address, startBlock: Number(env.NEXT_PUBLIC_START_BLOCK || env.START_BLOCK || 0) }
    : null;
  return fromEnv ?? DEPLOYMENTS.mainnet ?? DEPLOYMENTS.local ?? { launcher: ZERO, startBlock: 0 };
}
