// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TreasuryFactoryEtch} from "./helpers/TreasuryFactoryEtch.sol";
import {SwarmWorkOracle} from "src/SwarmWorkOracle.sol";
import {TieredWorkOracle} from "src/TieredWorkOracle.sol";
import {CDPVault} from "src/CDPVault.sol";
import {Parameters} from "src/Parameters.sol";
import {ParameterizedVault} from "src/ParameterizedVault.sol";
import {APPROVED_OPERATOR, ERC8004_ADAPTER, WORK_ORACLE_FACTORY, WORK_ORACLE_SENTINEL} from "src/DeploymentConfig.sol";
import {WorkBackingFixture} from "./helpers/WorkBackingFixture.sol";
import {SeedableWorkOracle, SeedableWorkOracleFactory} from "./helpers/SeedableFeeds.sol";

contract SeedableTieredWorkOracle is TieredWorkOracle {
    constructor(address vault_, uint256 maxAge_, address predecessor_, uint256[3] memory mults)
        TieredWorkOracle(vault_, maxAge_, predecessor_, mults)
    {}

    function seed(uint256 value) external {
        _accept(value, uint64(block.timestamp));
    }
}

/// @notice The tiered successor: what it adds over `SwarmWorkOracle` is a per-tier price, a cap that
/// binds per node, and credit carried from the oracle it replaces. Those three are what is tested.
contract TieredWorkOracleTest is WorkBackingFixture {
    uint256 private constant AGENT_A = 51450;
    uint256 private constant AGENT_B = 51204;
    address private constant CONTROLLER_A = address(0xA11CE);
    address private constant STRANGER = address(0xBAD);
    uint256 private constant RATE = 0.01 ether;

    CDPVault private attestedVault;
    Parameters private governance;
    SeedableWorkOracle private v1;

    function setUp() public override {
        TreasuryFactoryEtch.etch(vm);
        super.setUp();
        SeedableWorkOracleFactory factory = new SeedableWorkOracleFactory();
        vm.etch(WORK_ORACLE_FACTORY, address(factory).code);
        ParameterizedVault governed = new ParameterizedVault(
            address(collateral),
            address(0),
            WORK_ORACLE_SENTINEL,
            address(primary),
            address(health),
            address(backedVault.spotFeed())
        );
        attestedVault = governed;
        governance = governed.parameters();
        v1 = SeedableWorkOracle(address(attestedVault.oracle()));
        _setWage(RATE);
    }

    // --- pricing ---------------------------------------------------------------------------------

    /// @dev light 1x, build 4x, review 3x: 10 oracle + 4 light + 2 build + 1 review = 10 + 4 + 8 + 3.
    function test_eachTierIsPricedAtItsOwnMultipleOfTheWage() public {
        SeedableTieredWorkOracle t = _swap(address(0), [uint256(10_000), 40_000, 30_000]);
        (bytes32 root, bytes32[] memory proof) = _tree(AGENT_A, 3, [uint64(10), 4, 2, 1]);
        _accept(t, root);
        _controls(AGENT_A, CONTROLLER_A);

        vm.prank(CONTROLLER_A);
        uint256 rights = t.claim(AGENT_A, 3, [uint64(10), 4, 2, 1], proof, root);
        assertEq(rights, 25 * RATE);
        assertEq(t.mintingRights(CONTROLLER_A), 25 * RATE);
        assertEq(t.creditedCount(AGENT_A, 2), 2);
        assertEq(t.creditedTasks(AGENT_A), 10, "the oracle tier under its predecessor's name");
    }

    function test_aLaterDayCreditsOnlyEachTiersIncrement() public {
        SeedableTieredWorkOracle t = _swap(address(0), [uint256(10_000), 40_000, 30_000]);
        _controls(AGENT_A, CONTROLLER_A);
        (bytes32 day1, bytes32[] memory p1) = _tree(AGENT_A, 3, [uint64(10), 4, 2, 1]);
        _accept(t, day1);
        vm.prank(CONTROLLER_A);
        t.claim(AGENT_A, 3, [uint64(10), 4, 2, 1], p1, day1);

        // Two more builds; the oracle tier did not move.
        (bytes32 day2, bytes32[] memory p2) = _tree(AGENT_A, 0, [uint64(10), 4, 4, 1]);
        _accept(t, day2);
        vm.prank(CONTROLLER_A);
        assertEq(t.claim(AGENT_A, 0, [uint64(10), 4, 4, 1], p2, day2), 2 * 4 * RATE);

        vm.prank(CONTROLLER_A);
        vm.expectRevert(TieredWorkOracle.NothingToClaim.selector);
        t.claim(AGENT_A, 3, [uint64(10), 4, 2, 1], p1, day1);
    }

    /// @dev A multiplier never lifts one node past what governance may pay for anything.
    function test_theCapBindsPerNodeWhateverTheMultiplier() public {
        SeedableTieredWorkOracle t = _swap(address(0), [uint256(10_000), 40_000, 30_000]);
        assertEq(t.MAX_RATE_WAD(), governance.MAX_WAGE_WAD(), "the same cap as Parameters");
        assertEq(t.rateOf(2, 0.5 ether), 1 ether, "4x of half an imdUSD is capped at one");
        assertEq(t.rateOf(1, 0.5 ether), 0.5 ether);
        assertEq(t.rateOf(0, 0.5 ether), 0.5 ether, "the oracle tier is the wage itself");
    }

    function test_aZeroMultiplierLeavesATierUnpaidButCounted() public {
        SeedableTieredWorkOracle t = _swap(address(0), [uint256(0), 40_000, 30_000]);
        (bytes32 root, bytes32[] memory proof) = _tree(AGENT_A, 0, [uint64(0), 5, 0, 0]);
        _accept(t, root);
        _controls(AGENT_A, CONTROLLER_A);
        vm.prank(CONTROLLER_A);
        vm.expectRevert(TieredWorkOracle.NothingToClaim.selector);
        t.claim(AGENT_A, 0, [uint64(0), 5, 0, 0], proof, root);
    }

    // --- construction ----------------------------------------------------------------------------

    function test_constructionRefusesAnOverpricedTierAForeignPredecessorAndACodelessVault() public {
        vm.expectRevert(abi.encodeWithSelector(TieredWorkOracle.InvalidMultiplier.selector, uint8(3), 100_001));
        new TieredWorkOracle(address(attestedVault), 1 days, address(0), [uint256(10_000), 10_000, 100_001]);

        vm.expectRevert(TieredWorkOracle.InvalidPredecessor.selector);
        new TieredWorkOracle(address(backedVault), 1 days, address(v1), [uint256(10_000), 10_000, 10_000]);

        vm.expectRevert(TieredWorkOracle.InvalidVault.selector);
        new TieredWorkOracle(address(0xC0DE1E55), 1 days, address(0), [uint256(10_000), 10_000, 10_000]);
    }

    // --- succeeding SwarmWorkOracle --------------------------------------------------------------

    /// @dev The case `Parameters` exists to protect: v1 credited and not yet minted. A plain
    /// `SwarmWorkOracle` is refused as its successor; this one names v1 and is accepted.
    function test_governanceAcceptsItAsTheSuccessorOfAnOracleThatHasCredited() public {
        _claimOnV1(10);
        assertGt(v1.totalCredited(), 0);

        SeedableTieredWorkOracle orphan =
            new SeedableTieredWorkOracle(address(attestedVault), 1 days, address(0), [uint256(10_000), 40_000, 30_000]);
        _setWage(0);
        vm.prank(APPROVED_OPERATOR);
        vm.expectRevert(Parameters.InvalidWorkOracle.selector);
        governance.proposeWorkOracle(address(orphan));

        SeedableTieredWorkOracle t = _install(address(v1), [uint256(10_000), 40_000, 30_000]);
        assertEq(address(attestedVault.oracle()), address(t));
        assertEq(t.totalCredited(), v1.totalCredited(), "the chain's credit, for the next replacement");
    }

    /// @dev v1's oracle tasks carry one for one, so the same tasks are not paid twice; v1's unminted
    /// rights stay mintable through the successor, and only up to what was left.
    function test_creditCarriesOverAndIsNotPaidTwice() public {
        uint256 old = _claimOnV1(10);
        SeedableTieredWorkOracle t = _swap(address(v1), [uint256(10_000), 40_000, 30_000]);
        assertEq(t.creditedTasks(AGENT_A), 10, "v1's tally is the baseline");
        assertEq(t.mintingRights(CONTROLLER_A), old, "v1's unminted rights carry");

        (bytes32 root, bytes32[] memory proof) = _tree(AGENT_A, 2, [uint64(12), 0, 1, 0]);
        _accept(t, root);
        vm.prank(CONTROLLER_A);
        assertEq(t.claim(AGENT_A, 2, [uint64(12), 0, 1, 0], proof, root), 2 * RATE + 4 * RATE, "two new oracle, one build");
        assertEq(t.mintingRights(CONTROLLER_A), old + 6 * RATE);

        vm.prank(address(attestedVault));
        t.consumeRights(CONTROLLER_A, old + 6 * RATE);
        assertEq(t.mintingRights(CONTROLLER_A), 0);
        vm.prank(address(attestedVault));
        vm.expectRevert(TieredWorkOracle.InsufficientRights.selector);
        t.consumeRights(CONTROLLER_A, 1);
    }

    /// @dev The later root is accepted BEFORE the swap: seeding v1 after 48-hour delays would hit the
    /// stale-root overflow test/WorkRootAfterSilence.t.sol records, which is not what this tests.
    function test_theReplacedOracleRefusesFurtherClaims() public {
        (bytes32 root, bytes32[] memory proof) = _treeV1(AGENT_A, 2, 12);
        v1.seed(uint256(root));
        v1.recordRoot();
        _claimOnV1(10);
        _swap(address(v1), [uint256(10_000), 40_000, 30_000]);
        vm.prank(CONTROLLER_A);
        vm.expectRevert(SwarmWorkOracle.NotTheVaultsOracle.selector);
        v1.claim(AGENT_A, 2, 12, proof, root);
    }

    // --- refusals, as in SwarmWorkOracle ---------------------------------------------------------

    function test_aStrangerAThreeFieldLeafAndAZeroWageAreRefused() public {
        SeedableTieredWorkOracle t = _swap(address(0), [uint256(10_000), 40_000, 30_000]);
        (bytes32 root, bytes32[] memory proof) = _tree(AGENT_A, 3, [uint64(10), 4, 2, 1]);
        _accept(t, root);

        vm.prank(STRANGER);
        vm.expectRevert(TieredWorkOracle.NotTheController.selector);
        t.claim(AGENT_A, 3, [uint64(10), 4, 2, 1], proof, root);

        _controls(AGENT_A, CONTROLLER_A);
        vm.prank(CONTROLLER_A);
        vm.expectRevert(TieredWorkOracle.BadProof.selector);
        t.claim(AGENT_A, 3, [uint64(10), 4, 2, 9], proof, root);

        (bytes32 v1Root, bytes32[] memory v1Proof) = _treeV1(AGENT_A, 3, 10);
        _accept(t, v1Root);
        vm.prank(CONTROLLER_A);
        vm.expectRevert(TieredWorkOracle.BadProof.selector);
        t.claim(AGENT_A, 3, [uint64(10), 0, 0, 0], v1Proof, v1Root);

        _setWage(0);
        vm.prank(CONTROLLER_A);
        vm.expectRevert(TieredWorkOracle.WorkMintingOff.selector);
        t.claim(AGENT_A, 3, [uint64(10), 4, 2, 1], proof, root);
    }

    // --- helpers ---------------------------------------------------------------------------------

    function _setWage(uint256 wad) private {
        vm.prank(APPROVED_OPERATOR);
        governance.proposeWage(wad);
        vm.warp(governance.pendingEta());
        vm.prank(address(0xA990));
        governance.applyPending();
        _refreshEthUsd();
    }

    /// @dev The real path: wage to zero, propose, 48 hours, apply. Leaves the wage at zero.
    function _install(address predecessor_, uint256[3] memory mults) private returns (SeedableTieredWorkOracle t) {
        t = new SeedableTieredWorkOracle(address(attestedVault), 1 days, predecessor_, mults);
        if (governance.wage() != 0) _setWage(0);
        vm.prank(APPROVED_OPERATOR);
        governance.proposeWorkOracle(address(t));
        vm.warp(governance.pendingEta());
        governance.applyPending();
        _refreshEthUsd();
    }

    function _swap(address predecessor_, uint256[3] memory mults) private returns (SeedableTieredWorkOracle t) {
        t = _install(predecessor_, mults);
        _setWage(RATE);
    }

    function _claimOnV1(uint64 cumulative) private returns (uint256 rights) {
        (bytes32 root, bytes32[] memory proof) = _treeV1(AGENT_A, uint32(cumulative), cumulative);
        v1.seed(uint256(root));
        v1.recordRoot();
        _controls(AGENT_A, CONTROLLER_A);
        vm.prank(CONTROLLER_A);
        rights = v1.claim(AGENT_A, uint32(cumulative), cumulative, proof, root);
    }

    function _accept(SeedableTieredWorkOracle t, bytes32 root) private {
        t.seed(uint256(root));
        t.recordRoot();
    }

    /// @dev Two leaves: the agent's six-field tier leaf and a fixed sibling for AGENT_B.
    function _tree(uint256 id, uint32 accepted, uint64[4] memory c)
        private
        pure
        returns (bytes32 root, bytes32[] memory proof)
    {
        bytes32 a = keccak256(bytes.concat(keccak256(abi.encode(id, accepted, c[0], c[1], c[2], c[3]))));
        bytes32 b = keccak256(
            bytes.concat(keccak256(abi.encode(AGENT_B, uint32(1), uint64(20), uint64(0), uint64(3), uint64(0))))
        );
        root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        proof = new bytes32[](1);
        proof[0] = b;
    }

    /// @dev The predecessor's three-field leaf.
    function _treeV1(uint256 id, uint32 accepted, uint64 cumulative)
        private
        pure
        returns (bytes32 root, bytes32[] memory proof)
    {
        bytes32 a = keccak256(bytes.concat(keccak256(abi.encode(id, accepted, cumulative))));
        bytes32 b = keccak256(bytes.concat(keccak256(abi.encode(AGENT_B, uint32(1), uint64(20)))));
        root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        proof = new bytes32[](1);
        proof[0] = b;
    }

    function _controls(uint256 agentId, address who) private {
        vm.mockCall(
            ERC8004_ADAPTER, abi.encodeWithSignature("isController(uint256,address)", agentId, who), abi.encode(true)
        );
    }
}
