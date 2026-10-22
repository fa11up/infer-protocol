// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaidOraclePilot} from "../../src/PaidOraclePilot.sol";

interface IVaultView {
    function oracle() external view returns (address);
    function totalEarned() external view returns (uint256);
    function earnLine() external view returns (uint256);
    function priceFeed() external view returns (address);
    function spotFeed() external view returns (address);
    function nhiFeed() external view returns (address);
    function collateralPriceFeed() external view returns (address);
    function usdPriceFeed() external view returns (address);
    function earn(uint256) external;
}

interface IParams {
    function proposeWorkOracle(address next) external;
    function proposeWage(uint256 wad) external;
    function applyPending() external;
    function wage() external view returns (uint256);
    function governor() external view returns (address);
}

interface IFeedView {
    function latestValue() external view returns (uint256, uint64);
}

/// @notice The pilot installed on the LIVE imdUSD vault through the live Parameters timelock, as the Safe,
/// then paying real agents' controllers.
///   forge test --match-path test/fork/PaidOraclePilot.t.sol --fork-url $MAINNET_RPC_URL
/// Feed freshness is mocked (a fork cannot buy an attestation): every other check is the deployed code's.
contract PaidOraclePilotForkTest is Test {
    IVaultView constant VAULT = IVaultView(0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82);
    IParams constant PARAMS = IParams(0x3D96A6Ffada9C2E5B8fF8eb3f8AFB360116dA881);
    address constant SAFE = 0xbeFd108085613662356aa26A2466Ad3426DA9C32;
    IERC20 constant IMDUSD = IERC20(0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25);
    address constant MIYAGOD = 0x5167D014a056E43883e1BBEa5530c3c0dC993281;

    uint256 constant OURS = 51450; // seat 1616
    uint256 constant OTHER = 50904; // a real agent from the 2026-10-15 receipt
    uint256 constant UNKNOWN = 999_999_999; // no binding: unpayable

    PaidOraclePilot pilot;
    address poster = makeAddr("poster");

    function setUp() public {
        if (block.chainid != 1) vm.skip(true);
        pilot = new PaidOraclePilot(address(VAULT), poster, 1);
        vm.startPrank(SAFE);
        PARAMS.proposeWorkOracle(address(pilot));
        vm.warp(block.timestamp + 48 hours);
        PARAMS.applyPending();
        PARAMS.proposeWage(1);
        vm.warp(block.timestamp + 48 hours);
        PARAMS.applyPending();
        vm.stopPrank();
        _freshFeeds();
    }

    // ---------------------------------------------------------------- helpers

    function _freshFeeds() internal {
        address[5] memory feeds = [
            VAULT.priceFeed(), VAULT.spotFeed(), VAULT.nhiFeed(), VAULT.collateralPriceFeed(), VAULT.usdPriceFeed()
        ];
        for (uint256 i; i < feeds.length; ++i) {
            vm.mockCall(feeds[i], abi.encodeWithSignature("isStale()"), abi.encode(false));
        }
        // Spot agrees with the primary, as it does right after an update.
        (uint256 primary,) = IFeedView(VAULT.priceFeed()).latestValue();
        vm.mockCall(
            VAULT.spotFeed(), abi.encodeWithSignature("latestValue()"), abi.encode(primary, uint64(block.timestamp))
        );
    }

    function _leaf(uint256 epoch, uint256 agentId, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(epoch, agentId, amount))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    struct Tree {
        bytes32 root;
        uint256[] ids;
        uint256[] amounts;
        bytes32[][] proofs;
    }

    /// @dev Three leaves: root = H(H(l0, l1), l2).
    function _tree(uint256 epoch, uint256 a0, uint256 a1, uint256 a2) internal pure returns (Tree memory t) {
        t.ids = new uint256[](3);
        t.amounts = new uint256[](3);
        t.proofs = new bytes32[][](3);
        (t.ids[0], t.ids[1], t.ids[2]) = (OURS, OTHER, UNKNOWN);
        (t.amounts[0], t.amounts[1], t.amounts[2]) = (a0, a1, a2);
        bytes32 l0 = _leaf(epoch, OURS, a0);
        bytes32 l1 = _leaf(epoch, OTHER, a1);
        bytes32 l2 = _leaf(epoch, UNKNOWN, a2);
        t.root = _pair(_pair(l0, l1), l2);
        t.proofs[0] = new bytes32[](2);
        (t.proofs[0][0], t.proofs[0][1]) = (l1, l2);
        t.proofs[1] = new bytes32[](2);
        (t.proofs[1][0], t.proofs[1][1]) = (l0, l2);
        t.proofs[2] = new bytes32[](1);
        t.proofs[2][0] = _pair(l0, l1);
    }

    function _propose(Tree memory t, uint256 total) internal returns (uint256 epoch) {
        uint64 from = pilot.nextFromBlock(); // read before the prank: a view is a call and would eat it
        vm.prank(poster);
        epoch = pilot.propose(t.root, total, from, from + 99, "ipfs://tally");
    }

    // ---------------------------------------------------------------- tests

    function test_installedThroughTheLiveTimelock() public view {
        assertEq(VAULT.oracle(), address(pilot), "the vault reads the pilot");
        assertEq(PARAMS.wage(), 1, "wage is only the on switch");
        assertEq(pilot.governor(), SAFE, "governor read live from Parameters");
        assertEq(pilot.controllerOf(OURS), MIYAGOD, "seat 1616's controller");
        assertTrue(pilot.controllerOf(OTHER) != address(0), "a real agent resolves");
        assertEq(pilot.controllerOf(UNKNOWN), address(0), "unbound agent resolves to nobody");
    }

    function test_paysControllersAndMintsExactlyTheBatch() public {
        Tree memory t = _tree(0, 1.2e18, 0.3e18, 0.5e18);
        uint256 epoch = _propose(t, 2e18);

        vm.expectRevert(PaidOraclePilot.VetoWindowOpen.selector);
        pilot.pay(epoch, t.ids, t.amounts, t.proofs);

        vm.warp(block.timestamp + 24 hours);
        _freshFeeds();
        address other = pilot.controllerOf(OTHER);
        uint256 earnedBefore = VAULT.totalEarned();
        uint256 oursBefore = IMDUSD.balanceOf(MIYAGOD);
        uint256 otherBefore = IMDUSD.balanceOf(other);

        vm.prank(makeAddr("anyone"));
        uint256 sum = pilot.pay(epoch, t.ids, t.amounts, t.proofs);

        assertEq(sum, 1.5e18, "the unpayable share is skipped");
        assertEq(VAULT.totalEarned() - earnedBefore, 1.5e18, "minted exactly the payable shares");
        assertEq(IMDUSD.balanceOf(MIYAGOD) - oursBefore, 1.2e18);
        assertEq(IMDUSD.balanceOf(other) - otherBefore, 0.3e18);
        assertEq(IMDUSD.balanceOf(address(pilot)), 0, "nothing stays in the pilot");
        assertEq(pilot.mintingRights(address(pilot)), 0, "no rights outside pay");
        assertTrue(pilot.paidOut(epoch, OURS) && !pilot.paidOut(epoch, UNKNOWN));

        // Paying again pays nothing: shares are paid once.
        vm.expectRevert(PaidOraclePilot.NothingToPay.selector);
        pilot.pay(epoch, t.ids, t.amounts, t.proofs);
    }

    function test_staleFeedsDeferPaymentWithoutLosingIt() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        uint256 epoch = _propose(t, 3e18);
        vm.warp(block.timestamp + 24 hours);
        vm.clearMockedCalls(); // real feeds: stale on the fork after the warps
        vm.expectRevert(bytes4(keccak256("StaleFeed()")));
        pilot.pay(epoch, t.ids, t.amounts, t.proofs);
        assertFalse(pilot.paidOut(epoch, OURS), "a failed batch marks nothing");
        _freshFeeds();
        assertEq(pilot.pay(epoch, t.ids, t.amounts, t.proofs), 2e18);
    }

    function test_nobodyElseCanSpendTheVaultsWorkChannel() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        _propose(t, 3e18);
        vm.warp(block.timestamp + 24 hours);
        _freshFeeds();
        vm.prank(MIYAGOD);
        vm.expectRevert(bytes4(keccak256("InsufficientRights()"))); // no rights exist for anyone outside pay
        VAULT.earn(1e18);
        vm.expectRevert(PaidOraclePilot.Unauthorized.selector);
        pilot.consumeRights(address(pilot), 1);
    }

    function test_vetoStrikesAnEpochAndFreesItsWindow() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        uint256 epoch = _propose(t, 3e18);

        vm.expectRevert(PaidOraclePilot.Unauthorized.selector);
        pilot.veto(epoch);

        vm.prank(SAFE);
        pilot.veto(epoch);
        assertEq(pilot.totalCommitted(), 0);
        vm.warp(block.timestamp + 24 hours);
        _freshFeeds();
        vm.expectRevert(PaidOraclePilot.EpochVetoed.selector);
        pilot.pay(epoch, t.ids, t.amounts, t.proofs);

        // The same window may be recounted after the gap.
        vm.warp(block.timestamp + 6 days);
        Tree memory t1 = _tree(1, 1e18, 1e18, 1e18);
        assertEq(pilot.nextFromBlock(), 1, "the struck window is handed back");
        vm.prank(poster);
        pilot.propose(t1.root, 3e18, 1, 100, "ipfs://tally-recount");
    }

    function test_vetoClosesWhenPayableOpens() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        uint256 epoch = _propose(t, 3e18);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(SAFE);
        vm.expectRevert(PaidOraclePilot.VetoWindowClosed.selector);
        pilot.veto(epoch);
    }

    function test_capsGapAndWindowsBindThePoster() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        vm.startPrank(poster);
        vm.expectRevert(PaidOraclePilot.OverEpochCap.selector);
        pilot.propose(t.root, 350e18 + 1, 1, 2, "");
        pilot.propose(t.root, 350e18, 1, 100, "");
        vm.expectRevert(PaidOraclePilot.TooSoon.selector);
        pilot.propose(t.root, 1e18, 101, 200, "");
        vm.warp(block.timestamp + 6 days);
        vm.expectRevert(abi.encodeWithSelector(PaidOraclePilot.WindowNotContiguous.selector, uint64(101)));
        pilot.propose(t.root, 1e18, 100, 200, "");
        for (uint256 i; i < 7; ++i) {
            pilot.propose(t.root, 350e18, uint64(101 + 100 * i), uint64(200 + 100 * i), "");
            vm.warp(block.timestamp + 6 days);
        }
        assertEq(pilot.totalCommitted(), 2_800e18);
        vm.expectRevert(PaidOraclePilot.OverLifetimeCap.selector);
        pilot.propose(t.root, 200e18 + 1, 801, 900, "");
        vm.stopPrank();

        vm.expectRevert(PaidOraclePilot.Unauthorized.selector);
        pilot.propose(t.root, 1e18, 20_000, 20_100, "");
        vm.prank(SAFE);
        pilot.setPoster(address(0));
        vm.prank(poster);
        vm.expectRevert(PaidOraclePilot.Unauthorized.selector);
        pilot.propose(t.root, 1e18, 20_000, 20_100, "");
    }

    // ---------------------------------------------------------------- audit 3d5324e9 regressions

    /// Finding 1: a far-future or max toBlock used to brick every later propose (checked overflow).
    function test_windowCannotEndInTheFuture() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        vm.startPrank(poster);
        vm.expectRevert(PaidOraclePilot.WindowInFuture.selector);
        pilot.propose(t.root, 3e18, 1, type(uint64).max, "");
        vm.expectRevert(PaidOraclePilot.WindowInFuture.selector);
        pilot.propose(t.root, 3e18, 1, uint64(block.number), "");
        pilot.propose(t.root, 3e18, 1, uint64(block.number - 1), "");
        vm.stopPrank();
        assertEq(pilot.nextFromBlock(), block.number);
    }

    /// Finding 3: a window that skips blocks is refused, so no paid work falls in a hole.
    function test_windowsAreContiguous() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        vm.startPrank(poster);
        vm.expectRevert(abi.encodeWithSelector(PaidOraclePilot.WindowNotContiguous.selector, uint64(1)));
        pilot.propose(t.root, 3e18, 2, 100, "");
        pilot.propose(t.root, 3e18, 1, 100, "");
        vm.warp(block.timestamp + 6 days);
        vm.expectRevert(abi.encodeWithSelector(PaidOraclePilot.WindowNotContiguous.selector, uint64(101)));
        pilot.propose(t.root, 3e18, 300, 400, "");
        pilot.propose(t.root, 3e18, 101, 400, "");
        vm.stopPrank();
    }

    /// Finding 4: two vetoes in a row (the second a narrower recount) still hand back the whole window.
    function test_consecutiveVetoesLoseNoBlocks() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        vm.prank(poster);
        pilot.propose(t.root, 3e18, 1, 100, ""); // epoch 0, live
        vm.warp(block.timestamp + 6 days);
        vm.prank(poster);
        pilot.propose(t.root, 3e18, 101, 300, ""); // epoch 1
        vm.prank(SAFE);
        pilot.veto(1);
        vm.warp(block.timestamp + 6 days);
        vm.prank(poster);
        pilot.propose(t.root, 3e18, 101, 200, ""); // epoch 2, narrower recount
        vm.prank(SAFE);
        pilot.veto(2);
        assertEq(pilot.nextFromBlock(), 101, "blocks 101.. are still to be counted");
        vm.warp(block.timestamp + 6 days);
        vm.prank(poster);
        pilot.propose(t.root, 3e18, 101, 300, "");
    }

    /// Finding 2: an epoch that can never be paid (here: a tree built for the wrong epoch number) can be
    /// retired after RETIRE_AFTER, giving its cap back; a partly paid one releases only its remainder.
    function test_retireReleasesAnUnpayableEpoch() public {
        Tree memory wrong = _tree(1, 1e18, 1e18, 1e18); // leaves say epoch 1, posted as epoch 0
        uint256 epoch = _propose(wrong, 3e18);
        vm.warp(block.timestamp + 24 hours);
        _freshFeeds();
        vm.expectRevert(PaidOraclePilot.BadProof.selector);
        pilot.pay(epoch, wrong.ids, wrong.amounts, wrong.proofs);
        vm.startPrank(SAFE);
        vm.expectRevert(PaidOraclePilot.VetoWindowClosed.selector);
        pilot.veto(epoch);
        vm.expectRevert(PaidOraclePilot.TooEarlyToRetire.selector);
        pilot.retire(epoch);
        vm.warp(block.timestamp + 30 days);
        pilot.retire(epoch);
        vm.expectRevert(PaidOraclePilot.EpochRetired.selector);
        pilot.retire(epoch);
        vm.stopPrank();
        assertEq(pilot.totalCommitted(), 0, "the cap is given back");
        _freshFeeds();
        vm.expectRevert(PaidOraclePilot.EpochRetired.selector);
        pilot.pay(epoch, wrong.ids, wrong.amounts, wrong.proofs);
        vm.expectRevert(PaidOraclePilot.Unauthorized.selector);
        pilot.retire(epoch);
    }

    function test_retireReleasesOnlyTheUnpaidRemainder() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18); // UNKNOWN's share stays unpaid
        uint256 epoch = _propose(t, 3e18);
        vm.warp(block.timestamp + 24 hours);
        _freshFeeds();
        pilot.pay(epoch, t.ids, t.amounts, t.proofs);
        vm.warp(block.timestamp + 30 days);
        vm.prank(SAFE);
        pilot.retire(epoch);
        assertEq(pilot.totalCommitted(), 2e18, "only the 1e18 never paid is released");
    }

    /// Finding 5: a malformed binding word (bits above uint8 / address) skips that share; it used to revert
    /// the whole batch inside abi.decode.
    function test_malformedBindingSkipsOneShareNotTheBatch() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        uint256 epoch = _propose(t, 3e18);
        vm.warp(block.timestamp + 24 hours);
        _freshFeeds();
        address seats = 0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D;
        vm.mockCall(
            address(pilot.ADAPTER()),
            abi.encodeWithSignature("bindingOf(uint256)", OTHER),
            abi.encode(uint256(256), uint256(uint160(seats)), uint256(11))
        );
        assertEq(pilot.controllerOf(OTHER), address(0));
        vm.mockCall(
            address(pilot.ADAPTER()),
            abi.encodeWithSignature("bindingOf(uint256)", UNKNOWN),
            abi.encode(uint256(0), uint256(uint160(seats)) | (uint256(1) << 200), uint256(11))
        );
        assertEq(pilot.controllerOf(UNKNOWN), address(0));
        uint256 before = IMDUSD.balanceOf(MIYAGOD);
        assertEq(pilot.pay(epoch, t.ids, t.amounts, t.proofs), 1e18, "only seat 1616's share is paid");
        assertEq(IMDUSD.balanceOf(MIYAGOD) - before, 1e18);
    }

    function test_badProofRevertsTheWholeBatch() public {
        Tree memory t = _tree(0, 1e18, 1e18, 1e18);
        uint256 epoch = _propose(t, 3e18);
        vm.warp(block.timestamp + 24 hours);
        _freshFeeds();
        t.amounts[0] = 2e18; // claim more than the leaf says
        vm.expectRevert(PaidOraclePilot.BadProof.selector);
        pilot.pay(epoch, t.ids, t.amounts, t.proofs);
    }

    /// @dev Sizing: one batch of 64 real agents from the 2026-10-15..17 dry run (a full binary tree, so every
    /// proof has 6 siblings, as a ~210-agent epoch's proofs have 8).
    function test_gasForABatchOf64RealAgents() public {
        uint256[64] memory real = [uint256(50904), 50953, 50957, 50959, 50962, 50965, 50967, 50973, 50981, 50985, 50987, 50990, 51009, 51010, 51011, 51029, 51030, 51042, 51044, 51050, 51075, 51080, 51098, 51099, 51125, 51129, 51131, 51133, 51136, 51138, 51148, 51149, 51150, 51151, 51152, 51155, 51156, 51157, 51171, 51173, 51179, 51182, 51183, 51188, 51193, 51194, 51195, 51196, 51197, 51198, 51199, 51200, 51204, 51208, 51213, 51214, 51223, 51224, 51228, 51230, 51233, 51236, 51240, 51246];
        uint256 n = 64;
        uint256[] memory ids = new uint256[](n);
        uint256[] memory amounts = new uint256[](n);
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = real[i];
            amounts[i] = 0.5e18;
            level[i] = _leaf(0, ids[i], amounts[i]);
        }
        bytes32[][] memory proofs = new bytes32[][](n);
        for (uint256 i; i < n; ++i) proofs[i] = new bytes32[](6);
        uint256 width = n;
        for (uint256 d; d < 6; ++d) {
            for (uint256 i; i < n; ++i) proofs[i][d] = level[((i >> d) ^ 1)];
            width /= 2;
            bytes32[] memory up = new bytes32[](width);
            for (uint256 j; j < width; ++j) up[j] = _pair(level[2 * j], level[2 * j + 1]);
            level = up;
        }
        vm.prank(poster);
        uint256 epoch = pilot.propose(level[0], 32e18, 1, 2, "");
        vm.warp(block.timestamp + 24 hours);
        _freshFeeds();
        uint256 g = gasleft();
        uint256 sum = pilot.pay(epoch, ids, amounts, proofs);
        g -= gasleft();
        emit log_named_uint("agents paid", sum / 0.5e18);
        emit log_named_uint("gas for the batch", g);
        emit log_named_uint("gas per agent", g / 64);
        assertEq(sum, 32e18, "every real agent resolves to a controller");
    }
}
