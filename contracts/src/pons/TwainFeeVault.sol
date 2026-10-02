// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {CREATOR_FEE_PCT} from "../Constants.sol";
import {
    IPonsV2Curve,
    IPonsV2Factory,
    IPonsV2FeeEscrow,
    IPonsV2MemeHook,
    PonsGraduationPhase,
    PonsLaunchedToken
} from "./IPonsV2.sol";

interface ITwainTreasury {
    function treasury() external view returns (address);
}

/// @title TwainFeeVault
/// @notice The creator fee recipient of one coin launched through Pons V2 by twain. Pons credits the creator's
///         share of every trade (its base fee share plus the creator tax) to this vault in the FeeEscrow; anyone
///         can call `harvest` to pull it in, and every amount that arrives is split CREATOR_FEE_PCT to the coin's
///         creator and the rest to the twain treasury. Each side withdraws its own balance (pull-based).
///         Splits go by what actually arrived, so direct transfers (Pons rescue paths) are split the same way.
///         Deployed as a minimal clone by TwainLauncher, one per coin. No owner, no upgrade path.
contract TwainFeeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    address internal constant NATIVE = address(0);

    address public launcher;
    IPonsV2Factory public pons;
    address public coin;
    address public curve;
    address public pairToken;
    address public creator;

    /// @notice Split balances not yet withdrawn, per asset (address(0) = ETH).
    mapping(address asset => uint256) public creatorOwed;
    mapping(address asset => uint256) public treasuryOwed;

    event Initialized(address indexed coin, address indexed creator, address pairToken);
    event FeesSplit(address indexed asset, uint256 creatorAmount, uint256 treasuryAmount);
    event CreatorPaid(address indexed creator, address indexed asset, uint256 amount);
    event TreasuryPaid(address indexed treasury, address indexed asset, uint256 amount);
    event CreatorTransferred(address indexed from, address indexed to);

    error AlreadyInitialized();
    error NotCreator();
    error ZeroAddress();
    error EthTransferFailed();

    /// @dev Called once by the launcher right after the clone is created.
    function initialize(IPonsV2Factory pons_, address coin_, address curve_, address pairToken_, address creator_)
        external
    {
        if (launcher != address(0)) revert AlreadyInitialized();
        if (creator_ == address(0)) revert ZeroAddress();
        launcher = msg.sender;
        pons = pons_;
        coin = coin_;
        curve = curve_;
        pairToken = pairToken_;
        creator = creator_;
        emit Initialized(coin_, creator_, pairToken_);
    }

    receive() external payable {}

    /// @notice Moves the coin's creator fees from Pons into this vault and splits everything that arrived.
    ///         Before graduation it sweeps the curve's fees itself; after graduation it tries the hook's sweep,
    ///         which Pons only allows the creator side when nothing needs converting (its keeper sweeps otherwise).
    function harvest() public nonReentrant {
        PonsLaunchedToken memory info = pons.getLaunchedToken(coin);
        if (info.phase == PonsGraduationPhase.NotGraduated) {
            try IPonsV2Curve(curve).sweepFees(0) {} catch {}
        } else if (info.phase == PonsGraduationPhase.PoolCreated) {
            try IPonsV2MemeHook(pons.memeHook()).sweepPoolFees(poolId(), 0, 0) {} catch {}
        }

        IPonsV2FeeEscrow escrow = IPonsV2FeeEscrow(pons.feeEscrow());
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        if (pairToken != NATIVE && escrow.balanceOfToken(address(this), pairToken) > 0) escrow.claimToken(pairToken);
        if (escrow.balanceOfToken(address(this), coin) > 0) escrow.claimToken(coin);

        _split(NATIVE);
        if (pairToken != NATIVE) _split(pairToken);
        _split(coin);
    }

    /// @notice Harvests, then pays the creator everything owed to them. Anyone may call; funds go to the creator.
    function claimCreator() external returns (uint256 eth, uint256 pair, uint256 coins) {
        harvest();
        address to = creator;
        eth = _pay(to, NATIVE, creatorOwed, false);
        if (pairToken != NATIVE) pair = _pay(to, pairToken, creatorOwed, false);
        coins = _pay(to, coin, creatorOwed, false);
    }

    /// @notice Harvests, then pays the twain treasury its share. Anyone may call; funds go to the treasury.
    function claimTreasury() external returns (uint256 eth, uint256 pair, uint256 coins) {
        harvest();
        address to = ITwainTreasury(launcher).treasury();
        eth = _pay(to, NATIVE, treasuryOwed, true);
        if (pairToken != NATIVE) pair = _pay(to, pairToken, treasuryOwed, true);
        coins = _pay(to, coin, treasuryOwed, true);
    }

    /// @notice Hands the creator's share (owed and future) to a new address.
    function transferCreator(address newCreator) external {
        if (msg.sender != creator) revert NotCreator();
        if (newCreator == address(0)) revert ZeroAddress();
        creator = newCreator;
        emit CreatorTransferred(msg.sender, newCreator);
    }

    /// @notice The coin's graduated Uniswap v4 pool (Pons: sorted currencies, its MemeHook, the launch's fee and spacing).
    function poolId() public view returns (PoolId) {
        PonsLaunchedToken memory info = pons.getLaunchedToken(coin);
        (address c0, address c1) = pairToken < coin ? (pairToken, coin) : (coin, pairToken);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: info.poolFee,
            tickSpacing: info.tickSpacing,
            hooks: IHooks(pons.memeHook())
        });
        return key.toId();
    }

    /// @notice What `harvest` would add on top of the split balances: escrow credits plus unsplit balances here.
    function pending(address asset) external view returns (uint256) {
        IPonsV2FeeEscrow escrow = IPonsV2FeeEscrow(pons.feeEscrow());
        uint256 inEscrow = asset == NATIVE ? escrow.balanceOf(address(this)) : escrow.balanceOfToken(address(this), asset);
        uint256 held = _balance(asset);
        uint256 owed = creatorOwed[asset] + treasuryOwed[asset];
        return inEscrow + (held > owed ? held - owed : 0);
    }

    function _split(address asset) private {
        uint256 held = _balance(asset);
        uint256 owed = creatorOwed[asset] + treasuryOwed[asset];
        if (held <= owed) return;
        uint256 income = held - owed;
        uint256 toCreator = income * CREATOR_FEE_PCT / 100;
        creatorOwed[asset] += toCreator;
        treasuryOwed[asset] += income - toCreator;
        emit FeesSplit(asset, toCreator, income - toCreator);
    }

    function _pay(address to, address asset, mapping(address => uint256) storage owed, bool treasury)
        private
        nonReentrant
        returns (uint256 amount)
    {
        amount = owed[asset];
        if (amount == 0) return 0;
        owed[asset] = 0;
        if (asset == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
        if (treasury) emit TreasuryPaid(to, asset, amount);
        else emit CreatorPaid(to, asset, amount);
    }

    function _balance(address asset) private view returns (uint256) {
        return asset == NATIVE ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }
}
