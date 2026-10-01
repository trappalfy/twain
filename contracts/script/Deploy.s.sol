// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {Launchpad} from "../src/Launchpad.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";

/// @notice Deploys Launchpad (which deploys its LiquidityLocker) and, when the deployer is the owner, lists the
///         starting assets: native ETH plus optional ERC-20s.
/// Env: PROTOCOL_OWNER, PROTOCOL_TREASURY
///      optional POOL_MANAGER (default: Robinhood Chain mainnet v4), ETH_START_MCAP (wei, default 2.73 ETH),
///      ASSET_ADDRESSES + ASSET_START_MCAPS (comma-separated, same length; start mcap in the asset's smallest unit),
///      DEPLOY_NAME (output file name, default the chain id).
/// The asset list lives in assets/<chainId>.json; script/asset-mcaps.mjs turns it into the env above at live prices.
/// Usage (mainnet ONLY with the owner's explicit go-ahead):
///   eval "$(node script/asset-mcaps.mjs)"
///   forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account <keystore>
/// The indexer start block is the L2 block of the deploy transaction: take blockNumber from the receipt
/// (broadcast/Deploy.s.sol/<chainId>/run-latest.json). `deployBlockL1` below is the parent-chain block on Arbitrum.
contract Deploy is Script {
    address constant ROBINHOOD_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 constant DEFAULT_ETH_START_MCAP = 2.73 ether;

    function run() external {
        address owner = vm.envAddress("PROTOCOL_OWNER");
        address treasury = vm.envAddress("PROTOCOL_TREASURY");
        address poolManager = vm.envOr("POOL_MANAGER", ROBINHOOD_POOL_MANAGER);
        uint256 ethStartMcap = vm.envOr("ETH_START_MCAP", DEFAULT_ETH_START_MCAP);
        address[] memory assets = vm.envOr("ASSET_ADDRESSES", ",", new address[](0));
        uint256[] memory mcaps = vm.envOr("ASSET_START_MCAPS", ",", new uint256[](0));
        require(poolManager.code.length > 0, "PoolManager missing");
        require(assets.length == mcaps.length, "ASSET_ADDRESSES and ASSET_START_MCAPS differ in length");

        vm.startBroadcast();
        address deployer = msg.sender;
        Launchpad launchpad = new Launchpad(owner, treasury, IPoolManager(poolManager));
        bool listed = deployer == owner;
        if (listed) {
            launchpad.setAsset(address(0), ethStartMcap);
            for (uint256 i; i < assets.length; ++i) {
                launchpad.setAsset(assets[i], mcaps[i]);
            }
        }
        vm.stopBroadcast();

        LiquidityLocker locker = LiquidityLocker(payable(address(launchpad.locker())));
        require(address(locker).code.length > 0, "locker missing");
        require(address(locker.launchpad()) == address(launchpad), "wiring");
        require(address(locker.poolManager()) == poolManager, "pool manager");
        require(launchpad.owner() == owner && launchpad.treasury() == treasury, "roles");

        console.log("Launchpad       ", address(launchpad));
        console.log("LiquidityLocker ", address(locker));
        if (!listed) console.log("Deployer is not the owner: the owner must call setAsset for ETH and every asset.");

        string memory json = "d";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "launchpad", address(launchpad));
        vm.serializeAddress(json, "locker", address(locker));
        vm.serializeAddress(json, "owner", owner);
        vm.serializeAddress(json, "treasury", treasury);
        vm.serializeAddress(json, "poolManager", poolManager);
        string memory out = vm.serializeUint(json, "deployBlockL1", block.number);
        vm.writeJson(out, string.concat("deployments/", vm.envOr("DEPLOY_NAME", vm.toString(block.chainid)), ".json"));
    }
}
