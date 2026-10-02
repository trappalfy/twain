// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {IV4Router} from "v4-periphery/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/libraries/Actions.sol";

import {
    IPonsV2Curve,
    IPonsV2Factory,
    IPonsV2FeeEscrow,
    IPonsV2MemeHook,
    PonsGraduationPhase,
    PonsLaunchedToken,
    PonsSocials
} from "../src/pons/IPonsV2.sol";
import {TwainFeeVault} from "../src/pons/TwainFeeVault.sol";
import {TwainLauncher} from "../src/pons/TwainLauncher.sol";

interface IPonsFactoryGraduation {
    function createGraduatedPool(address token) external returns (uint256 positionId);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// TwainLauncher + TwainFeeVault against the real Pons V2 deployment on a Robinhood Chain mainnet fork.
/// Run: forge test --match-contract PonsForkTest -vv  (RPC_URL_4663 optional, defaults to the public RPC)
contract PonsForkTest is Test {
    IPonsV2Factory constant PONS = IPonsV2Factory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SWEEP_OPERATOR = 0xa1018c1D9655292A2dE0F7dEa9a0F848EaA8cA83;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH = address(0);

    TwainLauncher launcher;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.createSelectFork(vm.envOr("RPC_URL_4663", string("https://rpc.mainnet.chain.robinhood.com")));
        assertEq(block.chainid, 4663);
        launcher = new TwainLauncher(owner, treasury, PONS);
        vm.deal(creator, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ------------------------------------------------------------------ launch

    function test_launch_records() public {
        (address coin, address curve, address vault) = _launch(ETH, 0);
        PonsLaunchedToken memory info = PONS.getLaunchedToken(coin);
        assertEq(info.curve, curve);
        assertEq(info.deployer, address(launcher), "pons deployer = launcher");
        assertEq(info.creatorFeeRecipient, vault, "fees go to the vault");
        assertEq(info.creatorTaxBps, 100);
        assertFalse(info.buybackEnabled);
        assertEq(info.pairToken, ETH);
        assertEq(uint8(info.phase), uint8(PonsGraduationPhase.NotGraduated));
        assertEq(IPonsV2Curve(curve).deployer(), vault, "vault may sweep the curve");
        assertEq(IERC20(coin).totalSupply(), 1_000_000_000e18);

        TwainFeeVault v = TwainFeeVault(payable(vault));
        assertEq(v.creator(), creator);
        assertEq(v.coin(), coin);
        assertEq(v.launcher(), address(launcher));
        assertEq(launcher.vaultOf(coin), vault);
        assertEq(launcher.nonces(creator), 1);
        assertEq(address(launcher).balance, 0);
    }

    function test_firstBuy_eth_isExemptFromSnipeTax() public {
        uint256 q = 0.1 ether;
        (address coin, address curve,) = _launch(ETH, q);
        uint256 got = IERC20(coin).balanceOf(creator);
        // Same block, same size: bob pays the snipe tax, the creator did not.
        (uint256 rq, uint256 rt) = IPonsV2Curve(curve).getReserves();
        uint256 expectedUntaxed = _buyOut(q, rq, rt, 0);
        vm.prank(bob);
        uint256 bobGot = IPonsV2Curve(curve).buy{value: q}(q, 0, bob);
        assertGt(got, 0);
        assertLt(bobGot * 10, expectedUntaxed, "bob loses most of it to the snipe tax");
        assertEq(address(launcher).balance, 0);
        assertEq(IERC20(coin).balanceOf(address(launcher)), 0);
    }

    function test_firstBuy_matchesCurveMath() public {
        // Quote the first buy with the curve's own formula from the reserves a fresh launch starts at.
        (, address curve0,) = _launch(ETH, 0);
        (uint256 rq, uint256 rt) = IPonsV2Curve(curve0).getReserves();
        uint256 q = 0.25 ether;
        uint256 expected = _buyOut(q, rq, rt, 0);
        (address coin,,) = _launch(ETH, q);
        assertEq(IERC20(coin).balanceOf(creator), expected);
    }

    function test_firstBuy_usdg() public {
        uint256 q = 250e6; // 250 USDG (6 decimals)
        deal(USDG, creator, q);
        vm.prank(creator);
        IERC20(USDG).approve(address(launcher), q);
        (address coin,, address vault) = _launch(USDG, q);
        assertGt(IERC20(coin).balanceOf(creator), 0);
        assertEq(IERC20(USDG).balanceOf(creator), 0);
        assertEq(IERC20(USDG).balanceOf(address(launcher)), 0);
        assertEq(IERC20(USDG).allowance(address(launcher), PONS.getLaunchedToken(coin).curve), 0);
        assertEq(TwainFeeVault(payable(vault)).pairToken(), USDG);
    }

    function test_launch_wrongValue_reverts() public {
        uint256 fee = PONS.launchFee();
        TwainLauncher.CoinParams memory p = _params(ETH);
        vm.prank(creator);
        vm.expectRevert(TwainLauncher.WrongValue.selector);
        launcher.launch{value: fee + 1}(p, ETH, 0, 0);
        vm.prank(creator);
        vm.expectRevert(TwainLauncher.WrongValue.selector);
        launcher.launch{value: fee}(p, ETH, 1 ether, 0);
        // ERC-20 pair: msg.value is only the launch fee
        TwainLauncher.CoinParams memory pu = _params(USDG);
        vm.prank(creator);
        vm.expectRevert(TwainLauncher.WrongValue.selector);
        launcher.launch{value: fee + 1e6}(pu, USDG, 1e6, 0);
    }

    function test_owner_controls() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vm.prank(bob);
        launcher.setPaused(true);
        vm.prank(owner);
        launcher.setPaused(true);
        uint256 fee = PONS.launchFee();
        TwainLauncher.CoinParams memory p = _params(ETH);
        vm.prank(creator);
        vm.expectRevert(TwainLauncher.LaunchesPaused.selector);
        launcher.launch{value: fee}(p, ETH, 0, 0);

        vm.prank(owner);
        launcher.setTreasury(bob);
        assertEq(launcher.treasury(), bob);
        vm.prank(owner);
        vm.expectRevert(TwainLauncher.NoRenounce.selector);
        launcher.renounceOwnership();
    }

    // ------------------------------------------------------------------ fees

    function test_curveFees_split60_40() public {
        (address coin, address curve, address vault) = _launch(ETH, 0);
        vm.warp(block.timestamp + 10); // past the snipe window
        uint256 q = 1 ether;
        vm.prank(bob);
        uint256 coins = IPonsV2Curve(curve).buy{value: q}(q, 0, bob);
        vm.startPrank(bob);
        IERC20(coin).approve(curve, coins / 2);
        uint256 quoteOut = IPonsV2Curve(curve).sell(coins / 2, 0, bob);
        vm.stopPrank();

        // Creator side per trade = 70% of the 1% base fee + the whole 1% creator tax, on the quote leg.
        uint256 buyFee = q * 100 / 10_000;
        uint256 gross = _grossFromNet(quoteOut); // sell: fees are taken out of the gross quote
        uint256 sellFee = gross * 100 / 10_000;
        uint256 expected = (buyFee + sellFee) * 7000 / 10_000 + buyFee + sellFee;

        TwainFeeVault v = TwainFeeVault(payable(vault));
        uint256 pendingBefore = v.pending(ETH);
        v.harvest();
        uint256 income = v.creatorOwed(ETH) + v.treasuryOwed(ETH);
        assertApproxEqAbs(income, expected, 10, "creator income = 1.7% of quote volume");
        assertEq(v.creatorOwed(ETH), income * 60 / 100);
        assertEq(v.treasuryOwed(ETH), income - income * 60 / 100);
        assertEq(address(vault).balance, income);
        assertLe(pendingBefore, income);

        uint256 c0 = creator.balance;
        uint256 t0 = treasury.balance;
        vm.prank(bob); // anyone may trigger, funds go to the right place
        v.claimCreator();
        v.claimTreasury();
        assertEq(creator.balance - c0, income * 60 / 100);
        assertEq(treasury.balance - t0, income - income * 60 / 100);
        assertEq(address(vault).balance, 0);
        assertEq(v.creatorOwed(ETH), 0);
        assertEq(v.treasuryOwed(ETH), 0);
    }

    function test_transferCreator_movesOwedAndFuture() public {
        (, address curve, address vault) = _launch(ETH, 0);
        vm.warp(block.timestamp + 10);
        vm.prank(bob);
        IPonsV2Curve(curve).buy{value: 1 ether}(1 ether, 0, bob);
        TwainFeeVault v = TwainFeeVault(payable(vault));
        v.harvest();
        uint256 owed = v.creatorOwed(ETH);
        assertGt(owed, 0);

        address heir = makeAddr("heir");
        vm.expectRevert(TwainFeeVault.NotCreator.selector);
        vm.prank(bob);
        v.transferCreator(heir);
        vm.prank(creator);
        v.transferCreator(heir);
        v.claimCreator();
        assertEq(heir.balance, owed);
    }

    function test_graduation_thenPoolFees() public {
        (address coin, address curve, address vault) = _launch(ETH, 0);
        vm.warp(block.timestamp + 10);
        // Buy through the curve until it graduates (threshold 4.2 ETH of reserves).
        for (uint256 i; i < 20 && PONS.getLaunchedToken(coin).phase == PonsGraduationPhase.NotGraduated; i++) {
            vm.prank(bob);
            IPonsV2Curve(curve).buy{value: 1 ether}(1 ether, 0, bob);
        }
        PonsLaunchedToken memory info = PONS.getLaunchedToken(coin);
        if (info.phase == PonsGraduationPhase.Swept) {
            IPonsFactoryGraduation(address(PONS)).createGraduatedPool(coin);
            info = PONS.getLaunchedToken(coin);
        }
        assertEq(uint8(info.phase), uint8(PonsGraduationPhase.PoolCreated), "graduated into the v4 pool");

        TwainFeeVault v = TwainFeeVault(payable(vault));
        v.harvest(); // fees swept at graduation are claimable
        uint256 beforePool = v.creatorOwed(ETH) + v.treasuryOwed(ETH);
        assertGt(beforePool, 0);

        // Trade in the graduated pool through the Universal Router, then let the Pons keeper sweep.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(ETH),
            currency1: Currency.wrap(coin),
            fee: info.poolFee,
            tickSpacing: info.tickSpacing,
            hooks: IHooks(PONS.memeHook())
        });
        uint256 bought = _routerSwap(bob, key, true, 0.5 ether);
        assertGt(bought, 0);
        _routerSwap(bob, key, false, uint128(bought / 2));
        IPonsV2MemeHook hook = IPonsV2MemeHook(PONS.memeHook());
        PoolId pid = v.poolId();
        vm.prank(SWEEP_OPERATOR);
        hook.sweepPoolFees(pid, 1, 0); // the keeper must set a minimum when it converts the memecoin side

        v.harvest();
        uint256 income = v.creatorOwed(ETH) + v.treasuryOwed(ETH) - beforePool;
        assertGt(income, 0, "pool trades pay the vault");
        assertApproxEqAbs(v.creatorOwed(ETH) * 100, (v.creatorOwed(ETH) + v.treasuryOwed(ETH)) * 60, 100);
    }

    // ------------------------------------------------------------------ helpers

    function _params(address pair) internal view returns (TwainLauncher.CoinParams memory) {
        return TwainLauncher.CoinParams({
            name: "Twain Test",
            symbol: "TWT",
            logo: "ipfs://bafkreie3ct742hn26y53q5sy7ojcntwkyd4u3d5tar2s2l27dv4nahdbkm",
            description: "fork test",
            socials: PonsSocials({twitter: "", telegram: "", discord: "", website: "", farcaster: ""}),
            expectedEconomics: PONS.previewLaunchEconomics(0, pair)
        });
    }

    function _launch(address pair, uint256 quoteIn) internal returns (address coin, address curve, address vault) {
        uint256 value = PONS.launchFee() + (pair == ETH ? quoteIn : 0);
        TwainLauncher.CoinParams memory p = _params(pair);
        vm.prank(creator);
        (coin, curve, vault) = launcher.launch{value: value}(p, pair, quoteIn, 0);
    }

    /// @dev PonsV2BondingCurve buy: fee, creator tax (1% each) and snipe tax come off the input first.
    function _buyOut(uint256 q, uint256 rq, uint256 rt, uint256 snipeBps) internal pure returns (uint256) {
        uint256 net = q - q * 100 / 10_000 - q * 100 / 10_000 - q * snipeBps / 10_000;
        return net * rt / (rq + net);
    }

    /// @dev Inverse of out = g - floor(g*1%) - floor(g*1%), close enough for a fee estimate.
    function _grossFromNet(uint256 net) internal pure returns (uint256) {
        return net * 10_000 / 9_800;
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
