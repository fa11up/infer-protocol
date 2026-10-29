// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PaidOraclePilot} from "../src/PaidOraclePilot.sol";

/// Deploys the paid-oracle work-minting pilot against the live v1 vault. It counts paid work FROM ITS OWN DEPLOY
/// BLOCK (user, 2026-10-29: no backpay). POSTER comes from the environment (generated on the keeper box).
///   POSTER=0x.. forge script script/DeployPilot.s.sol --rpc-url <mainnet> --broadcast --verify
contract DeployPilot is Script {
    address constant VAULT = 0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82;

    function run() external returns (PaidOraclePilot pilot) {
        require(block.chainid == 1, "mainnet only");
        address poster = vm.envAddress("POSTER");
        require(poster != address(0), "POSTER");
        uint64 first = uint64(block.number); // the simulated head: at most the block it lands in
        vm.startBroadcast();
        pilot = new PaidOraclePilot(VAULT, poster, first);
        vm.stopBroadcast();
        require(pilot.vault() == VAULT && pilot.poster() == poster && pilot.nextFromBlock() == first, "readback");
        require(pilot.epochCount() == 0 && pilot.totalCommitted() == 0, "readback");
        require(pilot.governor() == 0xbeFd108085613662356aa26A2466Ad3426DA9C32, "governor is the Safe");
        console.log("PaidOraclePilot", address(pilot));
        console.log("firstFromBlock", uint256(first));
    }
}
