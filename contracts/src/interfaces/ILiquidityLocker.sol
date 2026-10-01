// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What Launchpad needs from LiquidityLocker.
interface ILiquidityLocker {
    struct LaunchResult {
        uint128 liquidity;
        uint256 coinsInPool;
        uint256 assetIn;
        uint256 coinsOut;
    }

    function launch(address coin, address asset, int24 startTick, address buyer, uint256 assetIn, uint256 minCoinsOut)
        external
        payable
        returns (LaunchResult memory result);

    function collectFees(address coin) external returns (uint256 assetFees, uint256 coinFees);

    function poolIdFor(address coin, address asset) external view returns (bytes32);
}
