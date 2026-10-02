// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {IPonsV2Factory} from "../src/pons/IPonsV2.sol";
import {TwainLauncher} from "../src/pons/TwainLauncher.sol";

/// @notice Deploys TwainLauncher on top of the official Pons V2 factory.
/// Env: PROTOCOL_OWNER, PROTOCOL_TREASURY; optional PONS_FACTORY (default: Robinhood Chain mainnet), DEPLOY_NAME.
/// Usage (mainnet ONLY with the owner's explicit go-ahead):
///   forge script script/DeployTwain.s.sol --rpc-url robinhood --broadcast --account <keystore> --sender <owner>
/// The indexer start block is the L2 block of the deploy transaction: blockNumber in
/// broadcast/DeployTwain.s.sol/<chainId>/run-latest.json.
contract DeployTwain is Script {
    address constant PONS_V2_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    function run() external {
        address owner = vm.envAddress("PROTOCOL_OWNER");
        address treasury = vm.envAddress("PROTOCOL_TREASURY");
        IPonsV2Factory pons = IPonsV2Factory(vm.envOr("PONS_FACTORY", PONS_V2_FACTORY));
        require(address(pons).code.length > 0, "Pons factory missing");

        vm.startBroadcast();
        TwainLauncher launcher = new TwainLauncher(owner, treasury, pons);
        vm.stopBroadcast();

        require(launcher.owner() == owner && launcher.treasury() == treasury, "roles");
        require(address(launcher.pons()) == address(pons), "wiring");
        console.log("TwainLauncher ", address(launcher));
        console.log("FeeVault impl ", launcher.vaultImplementation());

        string memory json = "d";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "launcher", address(launcher));
        vm.serializeAddress(json, "vaultImplementation", launcher.vaultImplementation());
        vm.serializeAddress(json, "pons", address(pons));
        vm.serializeAddress(json, "owner", owner);
        string memory out = vm.serializeAddress(json, "treasury", treasury);
        vm.writeJson(out, string.concat("deployments/", vm.envOr("DEPLOY_NAME", vm.toString(block.chainid)), "-twain.json"));
    }
}
