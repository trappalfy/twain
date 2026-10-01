// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint128} from "v4-core/libraries/FixedPoint128.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";

import {CREATOR_FEE_PCT, LP_FEE, MAX_TICK, MIN_TICK, TICK_SPACING, TOTAL_SUPPLY} from "./Constants.sol";
import {ILaunchpad} from "./interfaces/ILaunchpad.sol";
import {ILiquidityLocker} from "./interfaces/ILiquidityLocker.sol";

/// @title LiquidityLocker
/// @notice Opens every coin's Uniswap v4 pool and holds its liquidity, forever.
///         At creation the whole supply goes into one position that starts exactly at the coin's start price and
///         runs to the end of the price range, so the pool holds only coins until someone buys. The position is
///         created by this contract and belongs to it. There is no function to withdraw, transfer or reduce it,
///         no owner and no upgrade path. The pools have no hook and a static 1% fee.
///         Anyone can collect a position's trading fees: the asset side is credited 60/40 to the creator and the
///         protocol on the launchpad (pull-based), the coin side is sent 60/40 to the creator and the treasury.
///         Rounding dust left over when a position is created stays here permanently: about sqrt(1e27 / startMcap)
///         wei of the coin, a few thousand wei for an ETH pair and under 0.0001 coin in any case.
contract LiquidityLocker is ILiquidityLocker, IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    struct Position {
        address asset;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    uint8 internal constant ACTION_LAUNCH = 1;
    uint8 internal constant ACTION_COLLECT = 2;

    IPoolManager public immutable poolManager;
    ILaunchpad public immutable launchpad;

    mapping(address coin => Position) internal _positions;

    event LiquidityLocked(
        address indexed coin, bytes32 indexed poolId, uint128 liquidity, uint256 coinsInPool, int24 tickLower, int24 tickUpper
    );
    event FeesCollected(
        address indexed coin, uint256 assetToCreator, uint256 assetToProtocol, uint256 coinToCreator, uint256 coinToProtocol
    );

    error NotLaunchpad();
    error NotPoolManager();
    error UnknownCoin();
    error AlreadyLaunched();
    error SlippageExceeded();
    error EthTransferFailed();

    /// @dev Deployed by the launchpad in its constructor.
    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
        launchpad = ILaunchpad(msg.sender);
    }

    /// @dev Native ETH arrives from the PoolManager when fees are taken.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    // ------------------------------------------------------------------ launch

    /// @notice Called by the launchpad right after the coin was minted here. Opens the pool at the start price,
    ///         adds the whole supply as liquidity and, when `assetIn` > 0, runs the creator's first buy, delivered
    ///         to `buyer`. The asset for that buy arrives first: native ETH as msg.value, an ERC-20 transferred in.
    ///         Any part of it the swap does not use is refunded to `buyer`.
    /// @param startTick Start price as a tick of "asset per coin", aligned to the tick spacing.
    function launch(address coin, address asset, int24 startTick, address buyer, uint256 assetIn, uint256 minCoinsOut)
        external
        payable
        returns (LaunchResult memory result)
    {
        if (msg.sender != address(launchpad)) revert NotLaunchpad();
        if (_positions[coin].liquidity != 0) revert AlreadyLaunched();

        PoolKey memory key = _key(coin, asset);
        // Pool price is currency1 per currency0. Asset per coin when the coin is currency0, else its inverse.
        bool coinIs0 = coin < asset;
        int24 initTick = coinIs0 ? startTick : -startTick;
        // The position sits entirely on the coin's side of the start price, so it holds coins only.
        (int24 tickLower, int24 tickUpper) = coinIs0 ? (initTick, MAX_TICK) : (MIN_TICK, initTick);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity = coinIs0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, TOTAL_SUPPLY)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, TOTAL_SUPPLY);
        _positions[coin] = Position({asset: asset, tickLower: tickLower, tickUpper: tickUpper, liquidity: liquidity});

        // Reverts if anyone opened this pool before: the coin is then not created at all.
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(initTick));
        result = abi.decode(
            poolManager.unlock(abi.encode(ACTION_LAUNCH, abi.encode(coin, buyer, assetIn, minCoinsOut))), (LaunchResult)
        );
        result.liquidity = liquidity;

        uint256 refund = assetIn - result.assetIn;
        if (refund > 0) _send(asset, buyer, refund);

        emit LiquidityLocked(coin, PoolId.unwrap(key.toId()), liquidity, result.coinsInPool, tickLower, tickUpper);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Collect the position's accumulated trading fees and split them 60/40. Anyone can call.
    function collectFees(address coin) external nonReentrant returns (uint256 assetFees, uint256 coinFees) {
        Position memory p = _positions[coin];
        if (p.liquidity == 0) revert UnknownCoin();
        (uint256 fee0, uint256 fee1) =
            abi.decode(poolManager.unlock(abi.encode(ACTION_COLLECT, abi.encode(coin))), (uint256, uint256));
        (coinFees, assetFees) = coin < p.asset ? (fee0, fee1) : (fee1, fee0);

        uint256 assetToCreator = assetFees * CREATOR_FEE_PCT / 100;
        uint256 coinToCreator = coinFees * CREATOR_FEE_PCT / 100;
        uint256 coinToProtocol = coinFees - coinToCreator;

        if (assetFees > 0) {
            if (p.asset == address(0)) {
                launchpad.depositFees{value: assetFees}(coin, assetFees);
            } else {
                IERC20(p.asset).safeTransfer(address(launchpad), assetFees);
                launchpad.depositFees(coin, assetFees);
            }
        }
        if (coinToCreator > 0) IERC20(coin).safeTransfer(launchpad.creatorOf(coin), coinToCreator);
        if (coinToProtocol > 0) IERC20(coin).safeTransfer(launchpad.treasury(), coinToProtocol);

        emit FeesCollected(coin, assetToCreator, assetFees - assetToCreator, coinToCreator, coinToProtocol);
    }

    // ------------------------------------------------------------------ PoolManager callback

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, bytes memory args) = abi.decode(data, (uint8, bytes));
        return action == ACTION_LAUNCH ? _launch(args) : _collect(abi.decode(args, (address)));
    }

    function _launch(bytes memory args) internal returns (bytes memory) {
        (address coin, address buyer, uint256 assetIn, uint256 minCoinsOut) =
            abi.decode(args, (address, address, uint256, uint256));
        Position memory p = _positions[coin];
        PoolKey memory key = _key(coin, p.asset);
        bool coinIs0 = coin < p.asset;
        LaunchResult memory r;

        (BalanceDelta added,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                liquidityDelta: int256(uint256(p.liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        r.coinsInPool = uint256(uint128(-(coinIs0 ? added.amount0() : added.amount1())));
        _pay(coin, r.coinsInPool);

        if (assetIn > 0) {
            // Asset in, coin out: towards currency1 when the asset is currency0.
            bool zeroForOne = !coinIs0;
            BalanceDelta swapped = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(assetIn),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            (int128 assetDelta, int128 coinDelta) =
                zeroForOne ? (swapped.amount0(), swapped.amount1()) : (swapped.amount1(), swapped.amount0());
            r.assetIn = uint256(uint128(-assetDelta));
            r.coinsOut = uint256(uint128(coinDelta));
            if (r.coinsOut < minCoinsOut) revert SlippageExceeded();
            _pay(p.asset, r.assetIn);
            poolManager.take(Currency.wrap(coin), buyer, r.coinsOut);
        }
        return abi.encode(r);
    }

    /// @dev A zero-liquidity poke realises the position's fees as a positive delta.
    function _collect(address coin) internal returns (bytes memory) {
        Position memory p = _positions[coin];
        PoolKey memory key = _key(coin, p.asset);
        (BalanceDelta fees,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: p.tickLower, tickUpper: p.tickUpper, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        uint256 fee0 = uint256(uint128(fees.amount0()));
        uint256 fee1 = uint256(uint128(fees.amount1()));
        if (fee0 > 0) poolManager.take(key.currency0, address(this), fee0);
        if (fee1 > 0) poolManager.take(key.currency1, address(this), fee1);
        return abi.encode(fee0, fee1);
    }

    /// @dev Settle what this contract owes the PoolManager. A fee-on-transfer token arrives short and the unlock
    ///      reverts with CurrencyNotSettled.
    function _pay(address currency, uint256 amount) internal {
        if (amount == 0) return;
        if (currency == address(0)) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(Currency.wrap(currency));
            IERC20(currency).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _send(address currency, address to, uint256 amount) internal {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    // ------------------------------------------------------------------ views

    function _key(address coin, address asset) internal pure returns (PoolKey memory) {
        (address c0, address c1) = asset < coin ? (asset, coin) : (coin, asset);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    /// @notice Pool id of a coin's pool, known before the pool exists.
    function poolIdFor(address coin, address asset) external pure returns (bytes32) {
        return PoolId.unwrap(_key(coin, asset).toId());
    }

    function poolKeyOf(address coin) external view returns (PoolKey memory) {
        Position memory p = _positions[coin];
        if (p.liquidity == 0) revert UnknownCoin();
        return _key(coin, p.asset);
    }

    function positionOf(address coin) external view returns (Position memory) {
        return _positions[coin];
    }

    /// @notice Fees accumulated by a coin's position and not yet collected.
    function pendingFees(address coin) external view returns (uint256 assetFees, uint256 coinFees) {
        Position memory p = _positions[coin];
        if (p.liquidity == 0) return (0, 0);
        PoolId id = _key(coin, p.asset).toId();
        (uint128 liq, uint256 last0, uint256 last1) =
            poolManager.getPositionInfo(id, address(this), p.tickLower, p.tickUpper, bytes32(0));
        (uint256 inside0, uint256 inside1) = poolManager.getFeeGrowthInside(id, p.tickLower, p.tickUpper);
        uint256 fee0;
        uint256 fee1;
        unchecked {
            fee0 = FullMath.mulDiv(inside0 - last0, liq, FixedPoint128.Q128);
            fee1 = FullMath.mulDiv(inside1 - last1, liq, FixedPoint128.Q128);
        }
        (coinFees, assetFees) = coin < p.asset ? (fee0, fee1) : (fee1, fee0);
    }
}
