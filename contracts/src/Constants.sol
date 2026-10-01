// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Rules shared by Launchpad, LiquidityLocker and Coin, fixed at deployment.

// Every coin: 1,000,000,000 units with 18 decimals, all of them in its pool from the first block.
uint256 constant TOTAL_SUPPLY = 1_000_000_000e18;

// Pool LP fee in pips: 10,000 = 1% of every swap.
uint24 constant LP_FEE = 10_000;
int24 constant TICK_SPACING = 200;
int24 constant MIN_TICK = -887_200; // TickMath.minUsableTick(200)
int24 constant MAX_TICK = 887_200; // TickMath.maxUsableTick(200)

// Share of the pool fees that goes to the coin's creator; the rest goes to the protocol.
uint256 constant CREATOR_FEE_PCT = 60;
