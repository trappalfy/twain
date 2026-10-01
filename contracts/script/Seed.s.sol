// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IV4Router} from "v4-periphery/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/libraries/Actions.sol";

import {Launchpad} from "../src/Launchpad.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice LOCAL ONLY (anvil fork): launches demo coins and trades them through the Universal Router, so the indexer
///         and the UI have data. Env: LAUNCHPAD, CREATOR_KEY, TRADER_KEY, optional STOCK (an enabled ERC-20 asset the
///         creator and trader already hold, e.g. TSLA moved in with anvil_impersonateAccount).
contract Seed is Script {
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    Launchpad lp;
    LiquidityLocker locker;

    function run() external {
        require(block.chainid == 4663 && block.number > 0, "fork of chain 4663 expected");
        lp = Launchpad(vm.envAddress("LAUNCHPAD"));
        locker = LiquidityLocker(payable(address(lp.locker())));
        uint256 creatorKey = vm.envUint("CREATOR_KEY");
        uint256 traderKey = vm.envUint("TRADER_KEY");
        address stock = vm.envOr("STOCK", address(0));
        address trader = vm.addr(traderKey);

        // ETH pair with a first buy, then a trader buys and sells some back.
        vm.startBroadcast(creatorKey);
        (address alpha,) = lp.create{value: 0.05 ether}(_params("Alpha", "ALPHA", address(0), 0.05 ether, 1));
        vm.stopBroadcast();
        vm.startBroadcast(traderKey);
        uint256 got = _swap(trader, locker.poolKeyOf(alpha), true, 0.3 ether);
        _approvePermit2(alpha);
        _swap(trader, locker.poolKeyOf(alpha), false, uint128(got / 3));
        vm.stopBroadcast();
        console.log("ALPHA", alpha);

        if (stock != address(0)) {
            vm.startBroadcast(creatorKey);
            IERC20(stock).approve(address(lp), 1e18);
            (address stonk,) = lp.create(_params("Stonk", "STONK", stock, 1e18, 2));
            vm.stopBroadcast();
            PoolKey memory key = locker.poolKeyOf(stonk);
            bool stockIs0 = Currency.unwrap(key.currency0) == stock;
            vm.startBroadcast(traderKey);
            _approvePermit2(stock);
            uint256 bought = _swap(trader, key, stockIs0, 2e18);
            _approvePermit2(stonk);
            _swap(trader, key, !stockIs0, uint128(bought / 2));
            vm.stopBroadcast();
            console.log("STONK", stonk);
        }

        // Fees: anyone may collect; the creator claims.
        vm.startBroadcast(creatorKey);
        address[] memory list = new address[](1);
        list[0] = alpha;
        lp.claimCreatorFees(list);
        vm.stopBroadcast();
    }

    function _params(string memory name, string memory symbol, address asset, uint256 assetIn, uint256 salt)
        internal
        view
        returns (Launchpad.CreateParams memory)
    {
        return Launchpad.CreateParams({
            name: name,
            symbol: symbol,
            metadataURI: "",
            asset: asset,
            salt: keccak256(abi.encode(block.timestamp, salt)),
            assetIn: assetIn,
            minCoinsOut: 0
        });
    }

    function _approvePermit2(address token) internal {
        IERC20(token).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(token, UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 3600));
    }

    /// @dev Exact-input single swap through the Universal Router (V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL).
    function _swap(address me, PoolKey memory key, bool zeroForOne, uint128 amountIn) internal returns (uint256 out) {
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        Currency cout = zeroForOne ? key.currency1 : key.currency0;
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
        address outToken = Currency.unwrap(cout);
        uint256 before = outToken == address(0) ? me.balance : IERC20(outToken).balanceOf(me);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: Currency.unwrap(cin) == address(0) ? amountIn : 0}(
            abi.encodePacked(uint8(0x10)), inputs, block.timestamp + 600
        );
        out = (outToken == address(0) ? me.balance : IERC20(outToken).balanceOf(me)) - before;
    }
}
