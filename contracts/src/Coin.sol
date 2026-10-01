// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {TOTAL_SUPPLY} from "./Constants.sol";

/// @title Coin
/// @notice Fixed-supply ERC-20. 1,000,000,000 units are minted once, at creation, to the liquidity locker,
///         which puts them into the coin's Uniswap v4 pool in the same transaction.
///         No owner, no mint, no burn, no taxes, no transfer restrictions.
contract Coin is ERC20 {
    constructor(string memory name_, string memory symbol_, address recipient) ERC20(name_, symbol_) {
        _mint(recipient, TOTAL_SUPPLY);
    }
}
