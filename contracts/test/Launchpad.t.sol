// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Coin} from "../src/Coin.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {ILiquidityLocker} from "../src/interfaces/ILiquidityLocker.sol";
import {MAX_TICK, MIN_TICK, TOTAL_SUPPLY} from "../src/Constants.sol";
import {Base, FeeOnTransferAsset, MockAsset, RevertingReceiver} from "./Base.t.sol";

contract LaunchpadTest is Base {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal constant LOW = address(0x1000); // sorts before any coin: asset = currency0
    address internal constant HIGH = 0xfFfffFFFfffFFfFFFFffFFFFffffFfFFFFff0000; // sorts after: asset = currency1

    MockAsset internal low;
    MockAsset internal high;
    MockAsset internal usd6;

    function setUp() public {
        _deploy(IPoolManager(address(new PoolManager(address(this)))));
        low = _mockAsset(LOW, 18);
        high = _mockAsset(HIGH, 18);
        usd6 = _mockAsset(address(0x2000), 6);
        _list(LOW, 20e18); // e.g. a stock token at ~$350: 20 units ≈ $7k
        _list(HIGH, 20e18);
        _list(address(usd6), 7_000e6); // a 6-decimal dollar: $7k
    }

    // ------------------------------------------------------------ start price

    function test_startTick_eth() public view {
        (bool listed, bool enabled, int24 tick, uint256 mcap) = lp.assetConfig(ETH);
        assertTrue(listed && enabled);
        assertEq(mcap, ETH_START_MCAP);
        assertEq(tick % 200, 0);
        uint256 eff = _effectiveStartMcap(ETH);
        assertLe(eff, ETH_START_MCAP);
        assertGt(eff, ETH_START_MCAP * 98 / 100);
    }

    /// Start tick is the largest grid tick whose price is at or below the requested start market cap.
    function testFuzz_startTick_roundsDownToGrid(uint256 startMcap) public view {
        startMcap = bound(startMcap, 1e6, lp.MAX_START_MCAP());
        int24 tick = lp.startTickFor(startMcap);
        assertEq(tick % 200, 0);
        uint256 atTick = _mcapAtTick(tick);
        uint256 atNext = _mcapAtTick(tick + 200);
        assertLe(atTick, startMcap);
        assertGt(atNext, startMcap);
    }

    function test_startTick_rejectsOutOfRange() public {
        vm.expectRevert(Launchpad.InvalidStartMcap.selector);
        lp.startTickFor(0);
        uint256 max = lp.MAX_START_MCAP();
        vm.expectRevert(Launchpad.InvalidStartMcap.selector);
        lp.startTickFor(max + 1);
        vm.expectRevert(Launchpad.InvalidStartMcap.selector);
        lp.startTickFor(type(uint256).max);
        lp.startTickFor(1); // 1 wei is a valid (if silly) start market cap
        lp.startTickFor(max);
    }

    // ------------------------------------------------------------ create

    function test_create_eth_noBuy() public {
        vm.recordLogs();
        (address coin, uint256 out) = _create(creator, ETH, 0);
        assertEq(out, 0);
        assertEq(IERC20(coin).totalSupply(), TOTAL_SUPPLY);
        assertEq(IERC20(coin).balanceOf(creator), 0);
        assertEq(lp.creatorOf(coin), creator);
        assertEq(lp.coinInfo(coin).asset, ETH);

        // ETH sorts first: the coin is currency1 and the pool opens at the inverse of the start tick.
        PoolKey memory key = locker.poolKeyOf(coin);
        assertEq(Currency.unwrap(key.currency0), ETH);
        assertEq(Currency.unwrap(key.currency1), coin);
        assertEq(address(key.hooks), address(0));
        assertEq(key.fee, 10_000);
        (,, int24 startTick,) = lp.assetConfig(ETH);
        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(key.toId());
        assertEq(sqrtP, TickMath.getSqrtPriceAtTick(-startTick));
        assertEq(tick, -startTick);

        LiquidityLocker.Position memory pos = locker.positionOf(coin);
        assertEq(pos.tickLower, MIN_TICK);
        assertEq(pos.tickUpper, -startTick);
        assertGt(pos.liquidity, 0);
        // The pool opens exactly at the position's upper edge: its liquidity turns active with the first buy.
        assertEq(pm.getLiquidity(key.toId()), 0);
        _buy(alice, coin, 1);
        assertEq(pm.getLiquidity(key.toId()), pos.liquidity);

        // Whole supply in the pool, a few wei of rounding dust in the locker, nothing anywhere else.
        uint256 dust = IERC20(coin).balanceOf(address(locker));
        assertLt(dust, 1e6);
        assertEq(IERC20(coin).balanceOf(address(pm)) + IERC20(coin).balanceOf(alice), TOTAL_SUPPLY - dust);
    }

    function test_create_poolIdInEventMatches() public {
        vm.recordLogs();
        (address coin,) = _create(creator, ETH, 0);
        bytes32 expected = PoolId.unwrap(locker.poolKeyOf(coin).toId());
        assertEq(locker.poolIdFor(coin, ETH), expected);
        bytes32 sig = keccak256("CoinCreated(address,address,address,bytes32,string,string,string,uint256,int24)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(lp) && logs[i].topics[0] == sig) {
                (bytes32 poolId,,,,,) = abi.decode(logs[i].data, (bytes32, string, string, string, uint256, int24));
                assertEq(poolId, expected);
                assertEq(address(uint160(uint256(logs[i].topics[1]))), coin);
                found = true;
            }
        }
        assertTrue(found);
    }

    function test_create_eth_firstBuy_followsConstantProduct() public {
        uint256 creatorBefore = creator.balance;
        (address coin, uint256 out) = _create(creator, ETH, 1 ether);
        assertEq(IERC20(coin).balanceOf(creator), out);
        assertEq(creatorBefore - creator.balance, 1 ether);
        uint256 expected = _cpOut(_effectiveStartMcap(ETH), TOTAL_SUPPLY, 1 ether);
        assertApproxEqRel(out, expected, 1e12); // 0.0001%
        emit log_named_decimal_uint("coins for 1 ETH first buy", out, 18);
    }

    /// The whole price path matches x·y = k with virtual reserves (start mcap, supply), fee included.
    function test_pricePath_matchesConstantProduct() public {
        (address coin,) = _create(creator, ETH, 0);
        uint256 vAsset = _effectiveStartMcap(ETH);
        uint256 vCoin = TOTAL_SUPPLY;
        uint256[4] memory buys = [uint256(0.5 ether), 2 ether, 5 ether, 20 ether];
        for (uint256 i; i < buys.length; ++i) {
            uint256 out = _buy(alice, coin, buys[i]);
            uint256 expected = _cpOut(vAsset, vCoin, buys[i]);
            assertApproxEqRel(out, expected, 1e12);
            uint256 net = buys[i] * 99 / 100;
            vCoin = vAsset * vCoin / (vAsset + net);
            vAsset += net;
        }
    }

    function test_create_erc20_assetIsCurrency0() public {
        (address coin, uint256 out) = _create(creator, LOW, 2e18);
        PoolKey memory key = locker.poolKeyOf(coin);
        assertEq(Currency.unwrap(key.currency0), LOW);
        assertEq(Currency.unwrap(key.currency1), coin);
        assertApproxEqRel(out, _cpOut(_effectiveStartMcap(LOW), TOTAL_SUPPLY, 2e18), 1e12);
        assertEq(low.balanceOf(address(locker)), 0);
        assertEq(low.balanceOf(address(pm)), 2e18);
    }

    function test_create_erc20_assetIsCurrency1() public {
        (address coin, uint256 out) = _create(creator, HIGH, 2e18);
        PoolKey memory key = locker.poolKeyOf(coin);
        assertEq(Currency.unwrap(key.currency0), coin);
        assertEq(Currency.unwrap(key.currency1), HIGH);
        (,, int24 startTick,) = lp.assetConfig(HIGH);
        (, int24 tick0,,) = pm.getSlot0(key.toId());
        assertGt(tick0, startTick); // the first buy pushed asset-per-coin up
        LiquidityLocker.Position memory pos = locker.positionOf(coin);
        assertEq(pos.tickLower, startTick);
        assertEq(pos.tickUpper, MAX_TICK);
        assertApproxEqRel(out, _cpOut(_effectiveStartMcap(HIGH), TOTAL_SUPPLY, 2e18), 1e12);
    }

    function test_create_sixDecimalAsset() public {
        (address coin, uint256 out) = _create(creator, address(usd6), 100e6);
        assertApproxEqRel(out, _cpOut(_effectiveStartMcap(address(usd6)), TOTAL_SUPPLY, 100e6), 1e12);
        uint256 sold = _sell(creator, coin, out / 2);
        assertGt(sold, 0);
        assertLt(sold, 50e6);
    }

    function test_create_slippage() public {
        Launchpad.CreateParams memory p = _params(ETH, 1 ether);
        p.minCoinsOut = type(uint256).max;
        vm.prank(creator, creator);
        vm.expectRevert(LiquidityLocker.SlippageExceeded.selector);
        lp.create{value: 1 ether}(p);
    }

    function test_create_wrongValue() public {
        Launchpad.CreateParams memory p = _params(ETH, 1 ether);
        vm.prank(creator);
        vm.expectRevert(Launchpad.WrongValue.selector);
        lp.create{value: 0.5 ether}(p);

        p = _params(LOW, 0);
        vm.prank(creator);
        vm.expectRevert(Launchpad.WrongValue.selector);
        lp.create{value: 1}(p);
    }

    function test_create_validation() public {
        Launchpad.CreateParams memory p = _params(ETH, 0);
        p.name = "";
        vm.expectRevert(Launchpad.InvalidName.selector);
        lp.create(p);
        p.name = "123456789012345678901234567890123"; // 33 bytes
        vm.expectRevert(Launchpad.InvalidName.selector);
        lp.create(p);
        p.name = "Ok";
        p.symbol = "low";
        vm.expectRevert(Launchpad.InvalidSymbol.selector);
        lp.create(p);
        p.symbol = "ABCDEFGHIJK";
        vm.expectRevert(Launchpad.InvalidSymbol.selector);
        lp.create(p);
        p.symbol = "OK1";
        p.asset = address(0xBEEF);
        vm.expectRevert(Launchpad.AssetNotEnabled.selector);
        lp.create(p);
    }

    function test_create_paused() public {
        vm.prank(owner);
        lp.setCreationPaused(true);
        Launchpad.CreateParams memory p = _params(ETH, 0);
        vm.expectRevert(Launchpad.CreationPaused.selector);
        lp.create(p);
        vm.prank(owner);
        lp.setCreationPaused(false);
        lp.create(p);
    }

    function test_create_sameSaltTwice_reverts_differentCreatorsDiffer() public {
        Launchpad.CreateParams memory p = _params(ETH, 0);
        vm.prank(creator);
        (address a,) = lp.create(p);
        vm.prank(creator);
        vm.expectRevert();
        lp.create(p);
        vm.prank(alice);
        (address b,) = lp.create(p);
        assertTrue(a != b);
    }

    /// Someone who opens the pool of a future coin address first only makes that create revert; a new salt works.
    function test_create_preOpenedPool_reverts_retryWorks() public {
        Launchpad.CreateParams memory p = _params(ETH, 0);
        bytes memory init = abi.encodePacked(type(Coin).creationCode, abi.encode(p.name, p.symbol, address(locker)));
        address predicted = vm.computeCreate2Address(keccak256(abi.encode(creator, p.salt)), keccak256(init), address(lp));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(ETH),
            currency1: Currency.wrap(predicted),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(0))
        });
        pm.initialize(key, uint160(1 << 96));

        vm.prank(creator);
        vm.expectRevert();
        lp.create(p);

        p.salt = bytes32(uint256(999));
        vm.prank(creator);
        (address coin,) = lp.create(p);
        assertTrue(coin != predicted);
    }

    function test_create_feeOnTransferAsset_reverts() public {
        FeeOnTransferAsset tax = new FeeOnTransferAsset();
        _list(address(tax), 20e18);
        tax.mint(creator, 1e18);
        vm.prank(creator);
        tax.approve(address(lp), 1e18);
        Launchpad.CreateParams memory p = _params(address(tax), 1e18);
        vm.prank(creator, creator);
        vm.expectRevert();
        lp.create(p);
    }

    function test_launch_onlyLaunchpad() public {
        vm.expectRevert(LiquidityLocker.NotLaunchpad.selector);
        locker.launch(address(1), ETH, 0, alice, 0, 0);
        vm.expectRevert(LiquidityLocker.NotPoolManager.selector);
        locker.unlockCallback("");
        vm.expectRevert(Launchpad.NotLocker.selector);
        lp.depositFees(address(1), 0);
    }

    // ------------------------------------------------------------ fees

    function test_fees_eth_split_collect_claim() public {
        (address coin,) = _create(creator, ETH, 0);
        uint256 bought = _buy(alice, coin, 3 ether);
        _sell(alice, coin, bought / 2);

        (uint256 pendAsset, uint256 pendCoin) = locker.pendingFees(coin);
        assertApproxEqAbs(pendAsset, 0.03 ether, 1);
        assertApproxEqAbs(pendCoin, (bought / 2) / 100, 1);

        uint256 tCoin = IERC20(coin).balanceOf(treasury);
        (uint256 assetFees, uint256 coinFees) = locker.collectFees(coin);
        assertApproxEqAbs(assetFees, pendAsset, 1);
        assertApproxEqAbs(coinFees, pendCoin, 1);
        assertEq(IERC20(coin).balanceOf(creator), coinFees * 60 / 100);
        assertEq(IERC20(coin).balanceOf(treasury) - tCoin, coinFees - coinFees * 60 / 100);
        assertEq(lp.coinInfo(coin).creatorFees, assetFees * 60 / 100);
        assertEq(lp.protocolFees(ETH), assetFees - assetFees * 60 / 100);
        assertEq(address(lp).balance, assetFees);
        (pendAsset, pendCoin) = locker.pendingFees(coin);
        assertEq(pendAsset + pendCoin, 0);

        // A claim collects what accrued since, then pays the creator in ETH.
        _buy(bob, coin, 1 ether);
        address[] memory list = new address[](1);
        list[0] = coin;
        uint256 cb = creator.balance;
        vm.prank(creator);
        lp.claimCreatorFees(list);
        uint256 expectedCreator = assetFees * 60 / 100 + 0.01 ether * 60 / 100;
        assertApproxEqAbs(creator.balance - cb, expectedCreator, 2);
        assertEq(lp.coinInfo(coin).creatorFees, 0);

        uint256 tb = treasury.balance;
        uint256 pf = lp.protocolFees(ETH);
        assertEq(lp.claimProtocolFees(ETH), pf);
        assertEq(treasury.balance - tb, pf);
        assertEq(address(lp).balance, 0);
    }

    function test_fees_erc20_bothOrders() public {
        address[2] memory assets = [LOW, HIGH];
        for (uint256 i; i < 2; ++i) {
            address asset = assets[i];
            (address coin,) = _create(creator, asset, 0);
            uint256 bought = _buy(alice, coin, 4e18);
            _sell(alice, coin, bought / 4);
            (uint256 assetFees, uint256 coinFees) = locker.collectFees(coin);
            assertApproxEqAbs(assetFees, 0.04e18, 1);
            assertApproxEqAbs(coinFees, bought / 4 / 100, 1);
            assertEq(IERC20(asset).balanceOf(address(lp)), assetFees);
            assertEq(lp.coinInfo(coin).creatorFees + lp.protocolFees(asset), assetFees);

            address[] memory list = new address[](1);
            list[0] = coin;
            vm.prank(creator);
            lp.claimCreatorFees(list);
            assertEq(IERC20(asset).balanceOf(creator), assetFees * 60 / 100);
            lp.claimProtocolFees(asset);
            assertEq(IERC20(asset).balanceOf(treasury), assetFees - assetFees * 60 / 100);
            assertEq(IERC20(asset).balanceOf(address(lp)), 0);
        }
    }

    function test_creatorFirstBuyFee_goesToTheSamePosition() public {
        (address coin,) = _create(creator, ETH, 1 ether);
        (uint256 pendAsset,) = locker.pendingFees(coin);
        assertApproxEqAbs(pendAsset, 0.01 ether, 1);
    }

    function test_claim_notCreator_reverts() public {
        (address coin,) = _create(creator, ETH, 0);
        address[] memory list = new address[](1);
        list[0] = coin;
        vm.prank(alice);
        vm.expectRevert(Launchpad.NotCreator.selector);
        lp.claimCreatorFees(list);
        list[0] = address(0x1234);
        vm.prank(alice);
        vm.expectRevert(Launchpad.UnknownCoin.selector);
        lp.claimCreatorFees(list);
    }

    function test_transferCreator_movesUnclaimedAndFutureFees() public {
        (address coin,) = _create(creator, ETH, 0);
        _buy(alice, coin, 1 ether);
        locker.collectFees(coin);
        uint256 owed = lp.coinInfo(coin).creatorFees;
        assertGt(owed, 0);

        vm.prank(alice);
        vm.expectRevert(Launchpad.NotCreator.selector);
        lp.transferCreator(coin, alice);
        vm.prank(creator);
        vm.expectRevert(Launchpad.ZeroAddress.selector);
        lp.transferCreator(coin, address(0));
        vm.prank(creator);
        lp.transferCreator(coin, bob);
        assertEq(lp.creatorOf(coin), bob);

        uint256 sold = _buy(alice, coin, 1 ether);
        _sell(alice, coin, sold);
        address[] memory list = new address[](1);
        list[0] = coin;
        vm.prank(creator);
        vm.expectRevert(Launchpad.NotCreator.selector);
        lp.claimCreatorFees(list);
        uint256 bb = bob.balance;
        vm.prank(bob);
        lp.claimCreatorFees(list);
        assertApproxEqAbs(bob.balance - bb, owed + 0.01 ether * 60 / 100, 2);
        assertGt(IERC20(coin).balanceOf(bob), 0); // coin-side fees after the transfer go to the new creator
    }

    function test_claimToRevertingCreator_reverts() public {
        RevertingReceiver r = new RevertingReceiver();
        (address coin,) = _create(address(r), ETH, 0);
        _buy(alice, coin, 1 ether);
        address[] memory list = new address[](1);
        list[0] = coin;
        vm.prank(address(r));
        vm.expectRevert(Launchpad.EthTransferFailed.selector);
        lp.claimCreatorFees(list);
    }

    function test_collect_unknownCoin_reverts() public {
        vm.expectRevert(LiquidityLocker.UnknownCoin.selector);
        locker.collectFees(address(0x1234));
        (uint256 a, uint256 c) = locker.pendingFees(address(0x1234));
        assertEq(a + c, 0);
    }

    // ------------------------------------------------------------ owner

    function test_owner_only() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(err);
        lp.setAsset(LOW, 1e18);
        vm.expectRevert(err);
        lp.disableAsset(LOW);
        vm.expectRevert(err);
        lp.setTreasury(alice);
        vm.expectRevert(err);
        lp.setCreationPaused(true);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(Launchpad.RenounceDisabled.selector);
        lp.renounceOwnership();
    }

    function test_owner_twoStepTransfer() public {
        vm.prank(owner);
        lp.transferOwnership(alice);
        assertEq(lp.owner(), owner);
        vm.prank(alice);
        lp.acceptOwnership();
        assertEq(lp.owner(), alice);
    }

    function test_setAsset_validation_and_listing() public {
        vm.startPrank(owner);
        vm.expectRevert(Launchpad.NotAContract.selector);
        lp.setAsset(address(0xBEEF), 1e18);
        vm.expectRevert(Launchpad.InvalidStartMcap.selector);
        lp.setAsset(LOW, 0);
        lp.setAsset(LOW, 30e18); // re-price: not listed twice
        vm.stopPrank();
        address[] memory list = lp.assets();
        assertEq(list.length, 4); // ETH, LOW, HIGH, usd6
        assertEq(list[0], ETH);
    }

    function test_setTreasury() public {
        vm.prank(owner);
        vm.expectRevert(Launchpad.ZeroAddress.selector);
        lp.setTreasury(address(0));
        vm.prank(owner);
        lp.setTreasury(bob);
        assertEq(lp.treasury(), bob);
        (address coin,) = _create(creator, ETH, 0);
        _buy(alice, coin, 1 ether);
        locker.collectFees(coin);
        uint256 bb = bob.balance;
        lp.claimProtocolFees(ETH);
        assertGt(bob.balance, bb);
    }

    /// Re-pricing or disabling an asset never touches coins that already exist.
    function test_reprice_and_disable_onlyAffectNewCoins() public {
        (address first,) = _create(creator, ETH, 0);
        LiquidityLocker.Position memory before = locker.positionOf(first);

        _list(ETH, 5 ether);
        (address second,) = _create(creator, ETH, 0);
        LiquidityLocker.Position memory after_ = locker.positionOf(second);
        assertTrue(after_.tickUpper != before.tickUpper);
        assertEq(abi.encode(locker.positionOf(first)), abi.encode(before));

        vm.prank(owner);
        lp.disableAsset(ETH);
        vm.prank(owner);
        vm.expectRevert(Launchpad.AssetNotEnabled.selector);
        lp.disableAsset(ETH);
        Launchpad.CreateParams memory p = _params(ETH, 0);
        vm.expectRevert(Launchpad.AssetNotEnabled.selector);
        lp.create(p);

        // The existing coin trades, earns and pays out as before.
        uint256 out = _buy(alice, first, 1 ether);
        _sell(alice, first, out);
        address[] memory list = new address[](1);
        list[0] = first;
        uint256 cb = creator.balance;
        vm.prank(creator);
        lp.claimCreatorFees(list);
        assertGt(creator.balance, cb);

        _list(ETH, ETH_START_MCAP); // re-enable
        lp.create(_params(ETH, 0));
    }

    // ------------------------------------------------------------ accounting

    /// The launchpad holds exactly what it owes: creators' unclaimed fees plus the protocol's.
    function testFuzz_launchpadHoldsExactlyItsLiabilities(uint96 a, uint96 b, uint8 sellPct) public {
        uint256 buyA = bound(a, 1e12, 50 ether);
        uint256 buyB = bound(b, 1e12, 50 ether);
        (address c1,) = _create(creator, ETH, buyA / 10);
        (address c2,) = _create(alice, ETH, 0);
        uint256 got = _buy(bob, c1, buyA);
        _buy(bob, c2, buyB);
        _sell(bob, c1, got * bound(sellPct, 1, 100) / 100);
        locker.collectFees(c1);
        locker.collectFees(c2);
        assertEq(address(lp).balance, lp.coinInfo(c1).creatorFees + lp.coinInfo(c2).creatorFees + lp.protocolFees(ETH));
        assertEq(address(locker).balance, 0);
    }

    /// Any allowed start market cap works for both currency orders: pool opens, first buy fills, sells work.
    function testFuzz_create_anyStartMcap(uint256 startMcap, bool assetIsCurrency1) public {
        startMcap = bound(startMcap, 1, lp.MAX_START_MCAP());
        address asset = assetIsCurrency1 ? HIGH : LOW;
        _list(asset, startMcap);
        // At least 1000 wei (a 1-wei swap is all fee), at most 1e36 (pool amounts are int128).
        uint256 firstBuy = Math.min(Math.max(startMcap / 10, 1000), 1e36);
        (address coin, uint256 out) = _create(creator, asset, firstBuy);
        assertGt(out, 0);
        // Rounding dust stays in the locker: at most ~sqrt(1e27 / startMcap) wei (< 0.0001 coin even at 1 wei).
        assertLe(IERC20(coin).balanceOf(address(locker)), 2 * Math.sqrt(1e27 / startMcap) + 2);
        uint256 back = _sell(creator, coin, out);
        assertLe(back, firstBuy);
    }

    // ------------------------------------------------------------ helpers

    function _mcapAtTick(int24 tick) internal pure returns (uint256) {
        uint256 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(FullMath.mulDiv(sqrtP, sqrtP, 1 << 96), 1e27, 1 << 96);
    }
}
