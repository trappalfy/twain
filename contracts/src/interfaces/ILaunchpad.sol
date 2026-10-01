// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What LiquidityLocker needs from Launchpad.
interface ILaunchpad {
    function creatorOf(address coin) external view returns (address);
    function treasury() external view returns (address);
    /// @dev Asset side of collected pool fees. Native ETH arrives as msg.value; an ERC-20 asset is transferred first.
    function depositFees(address coin, uint256 amount) external payable;
}
