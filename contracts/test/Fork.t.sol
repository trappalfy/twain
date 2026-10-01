// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {IV4Router} from "v4-periphery/interfaces/IV4Router.sol";
import {IV4Quoter} from "v4-periphery/interfaces/IV4Quoter.sol";
import {Actions} from "v4-periphery/libraries/Actions.sol";

import {Launchpad} from "../src/Launchpad.sol";
import {TOTAL_SUPPLY} from "../src/Constants.sol";
import {Base} from "./Base.t.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// Full cycle against the real Uniswap v4 deployment and a real Robinhood stock token on a Robinhood Chain
/// mainnet fork. Trades go through the Universal Router with Permit2, the path the site and aggregators use.
/// Run: forge test --match-contract ForkTest -vv  (RPC_URL_4663 optional, defaults to the public RPC)
contract ForkTest is Base {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RPC_URL_4663", string("https://rpc.mainnet.chain.robinhood.com")));
        assertEq(block.chainid, 4663);
        _deploy(IPoolManager(POOL_MANAGER));
        _list(TSLA, 20e18);
        deal(TSLA, creator, 100e18);
        deal(TSLA, bob, 100e18);
    }

    function test_fork_ethPair() public {
        // create with a first buy
        uint256 g0 = gasleft();
        vm.prank(creator, creator);
        (address coin, uint256 firstBuy) = lp.create{value: 0.05 ether}(_params(ETH, 0.05 ether));
        emit log_named_uint("create + first buy gas", g0 - gasleft());
        assertEq(IERC20(coin).balanceOf(creator), firstBuy);
        PoolKey memory key = locker.poolKeyOf(coin);
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        assertGt(sqrtP, 0);

        // buy through the Universal Router, exactly as quoted by the official V4Quoter
        uint256 quoted = _quote(key, true, 1 ether);
        uint256 got = _routerSwap(alice, key, true, 1 ether);
        assertEq(got, quoted);
        emit log_named_decimal_uint("coins for 1 ETH via Universal Router", got, 18);

        // sell half back through Permit2
        uint256 ethBack = _routerSwap(alice, key, false, uint128(got / 2));
        assertGt(ethBack, 0);
        assertLt(ethBack, 0.99 ether); // the last-bought (dearest) half comes back, minus fees both ways

        // fees: 1% of 1.05 ETH bought, 1% of the coins sold
        (uint256 pendAsset, uint256 pendCoin) = locker.pendingFees(coin);
        assertApproxEqAbs(pendAsset, 0.0105 ether, 2);
        assertApproxEqAbs(pendCoin, (got / 2) / 100, 2);

        address[] memory list = new address[](1);
        list[0] = coin;
        uint256 cb = creator.balance;
        vm.prank(creator);
        lp.claimCreatorFees(list);
        assertApproxEqAbs(creator.balance - cb, pendAsset * 60 / 100, 2);
        uint256 tb = treasury.balance;
        lp.claimProtocolFees(ETH);
        assertApproxEqAbs(treasury.balance - tb, pendAsset - pendAsset * 60 / 100, 2);
        assertApproxEqAbs(IERC20(coin).balanceOf(treasury), pendCoin - pendCoin * 60 / 100, 2);
    }

    function test_fork_stockPair() public {
        vm.prank(creator);
        IERC20(TSLA).approve(address(lp), 2e18);
        vm.prank(creator, creator);
        (address coin, uint256 firstBuy) = lp.create(_params(TSLA, 2e18));
        assertGt(firstBuy, 0);
        assertApproxEqRel(firstBuy, _cpOut(_effectiveStartMcap(TSLA), TOTAL_SUPPLY, 2e18), 1e12);
        PoolKey memory key = locker.poolKeyOf(coin);
        bool tslaIs0 = Currency.unwrap(key.currency0) == TSLA;

        // buy with TSLA, then sell coins for TSLA, both through the Universal Router + Permit2
        uint256 quoted = _quote(key, tslaIs0, 5e18);
        uint256 got = _routerSwap(bob, key, tslaIs0, 5e18);
        assertEq(got, quoted);
        uint256 tslaBack = _routerSwap(bob, key, !tslaIs0, uint128(got / 3));
        assertGt(tslaBack, 0);

        (uint256 pendAsset,) = locker.pendingFees(coin);
        assertApproxEqAbs(pendAsset, 0.07e18, 2); // 1% of 2 + 5 TSLA
        address[] memory list = new address[](1);
        list[0] = coin;
        uint256 cb = IERC20(TSLA).balanceOf(creator);
        vm.prank(creator);
        lp.claimCreatorFees(list);
        assertApproxEqAbs(IERC20(TSLA).balanceOf(creator) - cb, pendAsset * 60 / 100, 2);
        lp.claimProtocolFees(TSLA);
        assertApproxEqAbs(IERC20(TSLA).balanceOf(treasury), pendAsset - pendAsset * 60 / 100, 2);
        assertEq(IERC20(TSLA).balanceOf(address(lp)), 0);
    }

    /// Every ERC-20 in assets/<chainId>.json (or FORK_ASSETS, comma-separated) through the full cycle. A token that
    /// taxes, blocks or otherwise changes transfers fails here; the log names each failing address and its revert.
    function test_fork_assetList() public {
        address[] memory list = vm.envOr("FORK_ASSETS", ",", new address[](0));
        if (list.length == 0) {
            string memory json = vm.readFile(string.concat(vm.projectRoot(), "/assets/4663.json"));
            uint256 n;
            while (vm.keyExistsJson(json, string.concat(".assets[", vm.toString(n), "]"))) ++n;
            list = new address[](n);
            for (uint256 i; i < n; ++i) {
                list[i] = vm.parseJsonAddress(json, string.concat(".assets[", vm.toString(i), "].address"));
            }
        }
        uint256 failed;
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == ETH) continue;
            try this.assetCycle(list[i]) {
                emit log_named_address("ok    ", list[i]);
            } catch (bytes memory err) {
                ++failed;
                emit log_named_address("FAILED", list[i]);
                emit log_named_bytes("  revert", err);
            }
        }
        assertEq(failed, 0, "some assets failed the cycle");
    }

    /// @dev List `asset`, create with a first buy, buy and sell through the Universal Router, claim both fee sides.
    ///      The start mcap is a sliver of the asset's supply: the mechanics do not depend on the price.
    function assetCycle(address asset) external {
        uint256 startMcap = IERC20(asset).totalSupply() / 1000;
        _list(asset, startMcap);
        uint256 firstBuy = startMcap / 20;
        uint256 buy = startMcap / 5;
        deal(asset, creator, firstBuy);
        deal(asset, bob, buy);

        vm.prank(creator);
        IERC20(asset).approve(address(lp), firstBuy);
        vm.prank(creator, creator);
        (address coin, uint256 got) = lp.create(_params(asset, firstBuy));
        assertGt(got, 0, "first buy");
        assertEq(IERC20(asset).balanceOf(creator), 0, "first buy spent exactly");
        assertEq(IERC20(coin).balanceOf(creator), got, "coins to creator");

        PoolKey memory key = locker.poolKeyOf(coin);
        bool assetIs0 = Currency.unwrap(key.currency0) == asset;
        uint256 quoted = _quote(key, assetIs0, uint128(buy));
        uint256 bought = _routerSwap(bob, key, assetIs0, uint128(buy));
        assertEq(bought, quoted, "router buy = quote");
        assertEq(IERC20(asset).balanceOf(bob), 0, "buy spent exactly");
        uint256 back = _routerSwap(bob, key, !assetIs0, uint128(bought / 2));
        assertGt(back, 0, "sell");

        (uint256 pendAsset,) = locker.pendingFees(coin);
        assertApproxEqAbs(pendAsset, (firstBuy + buy) / 100, 2, "asset fees");
        address[] memory coins = new address[](1);
        coins[0] = coin;
        vm.prank(creator);
        lp.claimCreatorFees(coins);
        assertApproxEqAbs(IERC20(asset).balanceOf(creator), pendAsset * 60 / 100, 2, "creator share");
        uint256 tb = IERC20(asset).balanceOf(treasury);
        lp.claimProtocolFees(asset);
        assertApproxEqAbs(IERC20(asset).balanceOf(treasury) - tb, pendAsset - pendAsset * 60 / 100, 2, "protocol share");
        assertEq(IERC20(asset).balanceOf(address(lp)), 0, "launchpad emptied");
    }

    // ------------------------------------------------------------ Universal Router

    function _quote(PoolKey memory key, bool zeroForOne, uint128 amountIn) internal returns (uint256 out) {
        (out,) = IV4Quoter(QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: zeroForOne, exactAmount: amountIn, hookData: ""})
        );
    }

    /// @dev V4_SWAP: SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL. ERC-20 input goes through Permit2.
    function _routerSwap(address who, PoolKey memory key, bool zeroForOne, uint128 amountIn)
        internal
        returns (uint256 out)
    {
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        Currency cout = zeroForOne ? key.currency1 : key.currency0;
        address tokenIn = Currency.unwrap(cin);
        address tokenOut = Currency.unwrap(cout);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: 0,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(cin, uint256(amountIn));
        params[2] = abi.encode(cout, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        uint256 before = tokenOut == ETH ? who.balance : IERC20(tokenOut).balanceOf(who);
        vm.startPrank(who, who);
        if (tokenIn != ETH) {
            IERC20(tokenIn).approve(PERMIT2, type(uint256).max);
            IPermit2(PERMIT2).approve(tokenIn, UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 3600));
        }
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: tokenIn == ETH ? amountIn : 0}(
            abi.encodePacked(uint8(0x10)), inputs, block.timestamp + 60
        );
        vm.stopPrank();
        out = (tokenOut == ETH ? who.balance : IERC20(tokenOut).balanceOf(who)) - before;
    }
}
