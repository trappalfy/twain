// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";

import {Coin} from "./Coin.sol";
import {LiquidityLocker} from "./LiquidityLocker.sol";
import {CREATOR_FEE_PCT, MAX_TICK, MIN_TICK, TICK_SPACING, TOTAL_SUPPLY} from "./Constants.sol";
import {ILiquidityLocker} from "./interfaces/ILiquidityLocker.sol";

/// @title Launchpad
/// @notice Launches coins straight into Uniswap v4. One transaction creates the coin, opens its pool against the
///         chosen asset and locks the whole supply in it forever. Same rules for every coin:
///         - 1B supply, all of it in the pool from the first block. No allocations.
///         - Pool: coin / asset, 1% static fee, no hook. The price starts at the asset's start market cap and
///           rises with every buy (x·y = k over the coin's single-sided position).
///         - Optional first buy by the creator in the same transaction, through the pool, at the pool price.
///         - Pool fees: 60% to the creator, 40% to the protocol. Asset side pull-based here, coin side pushed.
///         The owner can only: change the treasury, pause creation of new coins, and list, re-price or disable
///         assets for NEW coins. Existing coins, their pools and their liquidity are out of anyone's reach.
contract Launchpad is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);
    /// @notice Upper bound for an asset's start market cap, in its smallest unit (10^24 whole units of an 18-decimal
    ///         asset). The position's liquidity is 1e27 · sqrt(startMcap / 1e27), and Uniswap caps liquidity per tick
    ///         at ~3.8e34 for tick spacing 200.
    uint256 public constant MAX_START_MCAP = 1e42;

    // ------------------------------------------------------------------ state

    struct AssetConfig {
        bool listed;
        bool enabled;
        int24 startTick; // start price as a tick of "asset per coin", aligned to the tick spacing
        uint256 startMcap; // start market cap of a coin in the asset's smallest unit, as set by the owner
    }

    struct CoinInfo {
        address creator;
        address asset;
        uint256 creatorFees; // unclaimed, in the coin's asset
    }

    struct CreateParams {
        string name;
        string symbol;
        string metadataURI;
        address asset;
        bytes32 salt; // any value; makes the coin address unpredictable until the transaction lands
        uint256 assetIn; // creator's first buy (0 for none); native ETH must equal msg.value
        uint256 minCoinsOut;
    }

    ILiquidityLocker public immutable locker;
    address public treasury;
    bool public creationPaused;

    mapping(address asset => AssetConfig) public assetConfig;
    address[] internal _assets;
    mapping(address asset => uint256) public protocolFees; // unclaimed, per asset
    mapping(address coin => CoinInfo) internal _coins;

    // ------------------------------------------------------------------ events

    event CoinCreated(
        address indexed coin,
        address indexed creator,
        address indexed asset,
        bytes32 poolId,
        string name,
        string symbol,
        string metadataURI,
        uint256 startMcap,
        int24 startTick
    );
    event FeesDeposited(address indexed coin, uint256 creatorAmount, uint256 protocolAmount);
    event CreatorFeesClaimed(address indexed coin, address indexed creator, uint256 amount);
    event CreatorTransferred(address indexed coin, address indexed from, address indexed to);
    event ProtocolFeesClaimed(address indexed asset, address indexed treasury, uint256 amount);
    event AssetSet(address indexed asset, uint256 startMcap, int24 startTick);
    event AssetDisabled(address indexed asset);
    event TreasuryUpdated(address indexed treasury);
    event CreationPausedSet(bool paused);

    // ------------------------------------------------------------------ errors

    error CreationPaused();
    error AssetNotEnabled();
    error InvalidName();
    error InvalidSymbol();
    error InvalidStartMcap();
    error WrongValue();
    error NotCreator();
    error NotLocker();
    error NotAContract();
    error UnknownCoin();
    error ZeroAddress();
    error EthTransferFailed();
    error RenounceDisabled();

    // ------------------------------------------------------------------ constructor

    constructor(address owner_, address treasury_, IPoolManager poolManager) Ownable(owner_) {
        if (treasury_ == address(0) || address(poolManager).code.length == 0) revert ZeroAddress();
        treasury = treasury_;
        locker = ILiquidityLocker(address(new LiquidityLocker(poolManager)));
    }

    // ------------------------------------------------------------------ create

    /// @notice Create a coin, open its pool against `p.asset` and lock the whole supply in it. With `p.assetIn` > 0
    ///         the creator buys first, in this transaction, through the pool; for an ERC-20 asset approve this
    ///         contract for `p.assetIn` first. Unused input (only possible when buying out the whole pool) is refunded.
    /// @return coin The new coin.
    /// @return coinsOut Coins the creator bought (0 without a first buy).
    function create(CreateParams calldata p) external payable nonReentrant returns (address coin, uint256 coinsOut) {
        if (creationPaused) revert CreationPaused();
        AssetConfig memory a = assetConfig[p.asset];
        if (!a.enabled) revert AssetNotEnabled();
        _validateName(p.name);
        _validateSymbol(p.symbol);
        if (p.asset == NATIVE ? msg.value != p.assetIn : msg.value != 0) revert WrongValue();

        coin = address(new Coin{salt: keccak256(abi.encode(msg.sender, p.salt))}(p.name, p.symbol, address(locker)));
        _coins[coin] = CoinInfo({creator: msg.sender, asset: p.asset, creatorFees: 0});
        emit CoinCreated(
            coin,
            msg.sender,
            p.asset,
            locker.poolIdFor(coin, p.asset),
            p.name,
            p.symbol,
            p.metadataURI,
            a.startMcap,
            a.startTick
        );

        if (p.asset != NATIVE && p.assetIn > 0) IERC20(p.asset).safeTransferFrom(msg.sender, address(locker), p.assetIn);
        coinsOut = locker.launch{value: msg.value}(coin, p.asset, a.startTick, msg.sender, p.assetIn, p.minCoinsOut).coinsOut;
    }

    // ------------------------------------------------------------------ fees

    /// @notice Collect the pool fees of `coins` and pay the caller's share in each coin's asset.
    ///         The caller must be the current creator of every coin in the list.
    function claimCreatorFees(address[] calldata coins) external nonReentrant {
        for (uint256 i; i < coins.length; ++i) {
            CoinInfo storage c = _coin(coins[i]);
            if (c.creator != msg.sender) revert NotCreator();
            locker.collectFees(coins[i]);
            uint256 owed = c.creatorFees;
            if (owed == 0) continue;
            c.creatorFees = 0;
            emit CreatorFeesClaimed(coins[i], msg.sender, owed);
            _send(c.asset, msg.sender, owed);
        }
    }

    /// @notice Hand the creator role (fees from now on, and the unclaimed balance) to another address.
    function transferCreator(address coin, address newCreator) external {
        CoinInfo storage c = _coin(coin);
        if (c.creator != msg.sender) revert NotCreator();
        if (newCreator == address(0)) revert ZeroAddress();
        c.creator = newCreator;
        emit CreatorTransferred(coin, msg.sender, newCreator);
    }

    /// @notice Send the protocol's accrued fees in `asset` to the treasury. Anyone can call.
    function claimProtocolFees(address asset) external nonReentrant returns (uint256 amount) {
        amount = protocolFees[asset];
        if (amount == 0) return 0;
        protocolFees[asset] = 0;
        address to = treasury;
        emit ProtocolFeesClaimed(asset, to, amount);
        _send(asset, to, amount);
    }

    /// @notice Called by the locker with the asset side of collected pool fees; split 60/40 into pull balances.
    function depositFees(address coin, uint256 amount) external payable {
        if (msg.sender != address(locker)) revert NotLocker();
        CoinInfo storage c = _coin(coin);
        if (c.asset == NATIVE ? msg.value != amount : msg.value != 0) revert WrongValue();
        uint256 creatorPart = amount * CREATOR_FEE_PCT / 100;
        c.creatorFees += creatorPart;
        protocolFees[c.asset] += amount - creatorPart;
        emit FeesDeposited(coin, creatorPart, amount - creatorPart);
    }

    // ------------------------------------------------------------------ admin

    /// @notice List an asset, or change its start market cap, for coins created from now on.
    /// @param startMcap Market cap a new coin starts at, in the asset's smallest unit (e.g. 2.73e18 for 2.73 ETH).
    ///        It is rounded down to the pool's price grid (at most ~2% lower).
    function setAsset(address asset, uint256 startMcap) external onlyOwner {
        if (asset != NATIVE && asset.code.length == 0) revert NotAContract();
        int24 tick = startTickFor(startMcap);
        AssetConfig storage a = assetConfig[asset];
        if (!a.listed) {
            a.listed = true;
            _assets.push(asset);
        }
        a.enabled = true;
        a.startTick = tick;
        a.startMcap = startMcap;
        emit AssetSet(asset, startMcap, tick);
    }

    /// @notice Stop new coins against `asset`. Existing coins keep trading and earning fees as before.
    function disableAsset(address asset) external onlyOwner {
        if (!assetConfig[asset].enabled) revert AssetNotEnabled();
        assetConfig[asset].enabled = false;
        emit AssetDisabled(asset);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Pause or resume creation of NEW coins. Trading is never affected.
    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPausedSet(paused);
    }

    /// @notice Ownership can be handed over (two-step) but never renounced: a renounce while creation is
    ///         paused would freeze creation forever.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------ views

    /// @notice Start tick ("asset per coin") for a start market cap, rounded down to the tick spacing.
    function startTickFor(uint256 startMcap) public pure returns (int24 tick) {
        if (startMcap == 0 || startMcap > MAX_START_MCAP) revert InvalidStartMcap();
        // price = startMcap / TOTAL_SUPPLY (asset units per coin unit); sqrtPriceX96 = sqrt(price · 2^192).
        uint256 sqrtPrice = Math.sqrt(FullMath.mulDiv(startMcap, 1 << 192, TOTAL_SUPPLY));
        if (sqrtPrice < TickMath.MIN_SQRT_PRICE || sqrtPrice >= TickMath.MAX_SQRT_PRICE) revert InvalidStartMcap();
        int24 raw = TickMath.getTickAtSqrtPrice(uint160(sqrtPrice));
        tick = raw / TICK_SPACING * TICK_SPACING;
        if (raw < 0 && tick != raw) tick -= TICK_SPACING;
        if (tick < MIN_TICK || tick >= MAX_TICK) revert InvalidStartMcap();
    }

    /// @notice Every asset ever listed (check `assetConfig` for which are enabled).
    function assets() external view returns (address[] memory) {
        return _assets;
    }

    function coinInfo(address coin) external view returns (CoinInfo memory) {
        return _coins[coin];
    }

    function creatorOf(address coin) external view returns (address) {
        return _coins[coin].creator;
    }

    // ------------------------------------------------------------------ internal

    function _coin(address coin) internal view returns (CoinInfo storage c) {
        c = _coins[coin];
        if (c.creator == address(0)) revert UnknownCoin();
    }

    function _send(address asset, address to, uint256 amount) internal {
        if (asset == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    function _validateName(string calldata name) internal pure {
        uint256 len = bytes(name).length;
        if (len == 0 || len > 32) revert InvalidName();
    }

    function _validateSymbol(string calldata symbol) internal pure {
        bytes memory s = bytes(symbol);
        if (s.length == 0 || s.length > 10) revert InvalidSymbol();
        for (uint256 i; i < s.length; ++i) {
            bytes1 ch = s[i];
            bool ok = (ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A); // 0-9 A-Z
            if (!ok) revert InvalidSymbol();
        }
    }
}
