// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";

import {Launchpad} from "../src/Launchpad.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";

/// @dev Plain ERC-20 asset with configurable decimals and a public mint.
contract MockAsset is ERC20 {
    uint8 internal immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns 1% of every transfer: must never be usable as an asset.
contract FeeOnTransferAsset is MockAsset {
    constructor() MockAsset("Taxed", "TAX", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 cut = value / 100;
            super._update(from, address(0), cut);
            value -= cut;
        }
        super._update(from, to, value);
    }
}

contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }
}

abstract contract Base is Test {
    address internal constant ETH = address(0);
    uint256 internal constant ETH_START_MCAP = 2.73 ether;

    IPoolManager internal pm;
    Launchpad internal lp;
    LiquidityLocker internal locker;
    PoolSwapTest internal swapRouter;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal saltNonce;

    function _deploy(IPoolManager pm_) internal {
        pm = pm_;
        lp = new Launchpad(owner, treasury, pm);
        locker = LiquidityLocker(payable(address(lp.locker())));
        vm.prank(owner);
        lp.setAsset(ETH, ETH_START_MCAP);

        swapRouter = new PoolSwapTest(pm);
        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    /// @dev Deploys a MockAsset at a fixed address: a low one sorts before every coin (asset = currency0),
    ///      a high one after every coin (asset = currency1).
    function _mockAsset(address at, uint8 decimals_) internal returns (MockAsset) {
        deployCodeTo("Base.t.sol:MockAsset", abi.encode("Asset", "AST", decimals_), at);
        return MockAsset(at);
    }

    function _list(address asset, uint256 startMcap) internal {
        vm.prank(owner);
        lp.setAsset(asset, startMcap);
    }

    function _params(address asset, uint256 assetIn) internal returns (Launchpad.CreateParams memory p) {
        p = Launchpad.CreateParams({
            name: "Twain Test",
            symbol: "TWT",
            metadataURI: "ipfs://meta",
            asset: asset,
            salt: bytes32(++saltNonce),
            assetIn: assetIn,
            minCoinsOut: 0
        });
    }

    /// @dev Creates a coin as `who`, funding and approving an ERC-20 first buy.
    function _create(address who, address asset, uint256 assetIn) internal returns (address coin, uint256 out) {
        Launchpad.CreateParams memory p = _params(asset, assetIn);
        if (asset != ETH && assetIn > 0) {
            MockAsset(asset).mint(who, assetIn);
            vm.prank(who);
            IERC20(asset).approve(address(lp), assetIn);
        }
        vm.prank(who, who);
        (coin, out) = lp.create{value: asset == ETH ? assetIn : 0}(p);
    }

    // ------------------------------------------------------------ pool trading

    function _coinIs0(address coin) internal view returns (bool) {
        PoolKey memory key = locker.poolKeyOf(coin);
        return Currency.unwrap(key.currency0) == coin;
    }

    /// @dev Exact-input buy of `coin` with its asset through the pool. Returns coins received.
    function _buy(address who, address coin, uint256 assetIn) internal returns (uint256 out) {
        PoolKey memory key = locker.poolKeyOf(coin);
        address asset = lp.coinInfo(coin).asset;
        bool zeroForOne = !_coinIs0(coin);
        uint256 before = IERC20(coin).balanceOf(who);
        vm.startPrank(who, who);
        if (asset != ETH) {
            MockAsset(asset).mint(who, assetIn);
            IERC20(asset).approve(address(swapRouter), assetIn);
        }
        swapRouter.swap{value: asset == ETH ? assetIn : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(assetIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        out = IERC20(coin).balanceOf(who) - before;
    }

    /// @dev Exact-input sell of `coinsIn` for the asset through the pool. Returns asset received.
    function _sell(address who, address coin, uint256 coinsIn) internal returns (uint256 out) {
        PoolKey memory key = locker.poolKeyOf(coin);
        address asset = lp.coinInfo(coin).asset;
        bool zeroForOne = _coinIs0(coin);
        uint256 before = asset == ETH ? who.balance : IERC20(asset).balanceOf(who);
        vm.startPrank(who, who);
        IERC20(coin).approve(address(swapRouter), coinsIn);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(coinsIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        out = (asset == ETH ? who.balance : IERC20(asset).balanceOf(who)) - before;
    }

    // ------------------------------------------------------------ math

    /// @dev Effective start market cap of `asset` (price at its aligned start tick × supply), in asset units.
    function _effectiveStartMcap(address asset) internal view returns (uint256) {
        (,, int24 tick,) = lp.assetConfig(asset);
        uint256 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        // price = sqrtP² / 2^192 asset units per coin unit
        return FullMath.mulDiv(FullMath.mulDiv(sqrtP, sqrtP, 1 << 96), 1e27, 1 << 96);
    }

    /// @dev Coins out of a constant-product buy with virtual reserves (vAsset0 = start mcap, vCoin0 = supply),
    ///      after the 1% pool fee: what the single-sided position must reproduce.
    function _cpOut(uint256 vAsset, uint256 vCoin, uint256 assetIn) internal pure returns (uint256) {
        uint256 net = assetIn * 99 / 100;
        return vCoin - vAsset * vCoin / (vAsset + net);
    }
}
