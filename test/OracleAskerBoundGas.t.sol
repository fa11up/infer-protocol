// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwarmFeed} from "src/SwarmFeed.sol";
import {SwarmRelay} from "src/SwarmRelay.sol";
import {NhiFeed} from "src/NhiFeed.sol";
import {OracleAsker} from "src/OracleAsker.sol";
import {MockIMD} from "src/MockIMD.sol";
import {BoundTestFeed} from "./helpers/BoundTestFeed.sol";
import {MockIntake} from "./helpers/MockIntake.sol";
import {APPROVED_OPERATOR, INTAKE, ORACLE_ACTION, ATTESTATION_RELAYER} from "src/DeploymentConfig.sol";

/// @notice D8 (launch audit) and the 2026-10-05 gas review: the Intake gives the callback a FIXED
/// 200,000 gas, and the expensive part of a production delivery is the question binding — hashing the
/// ~1.9 KB NhiFeed prefix with two decimal block numbers — which the unbound OracleAsker suite never
/// exercises. This delivers into a feed bound to that exact question, on mainnet's chain id with the
/// head-relative window check live, and asserts the FEED VALUE, because onOracleResult catches a failed
/// relay and a caught out-of-gas would otherwise read as a successful callback.
contract OracleAskerBoundGasTest is Test {
    uint256 private constant ATTESTER_KEY = 0xA11CE;
    uint256 private constant STIPEND = 200_000;
    uint64 private constant FROM = 26_000_000;
    uint64 private constant TO = 26_000_600;
    bytes private constant BODY = '{"question":"network health"}';

    MockIntake private intake;
    BoundTestFeed private feed;
    OracleAsker private asker;

    function setUp() public {
        vm.chainId(1);
        vm.warp(10 days);
        vm.roll(TO);
        vm.etch(ATTESTATION_RELAYER, address(new SwarmRelay()).code);
        vm.etch(INTAKE, address(new MockIntake()).code);
        intake = MockIntake(INTAKE);
        MockIMD imd = new MockIMD();
        intake.setPrice(ORACLE_ACTION, address(imd), 0.5 ether);
        feed = new BoundTestFeed(vm.addr(ATTESTER_KEY), ATTESTATION_RELAYER, 1 days, 2000);
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = keccak256(BODY);
        bool[] memory flags = new bool[](1);
        bool[] memory keepAlive = new bool[](1);
        keepAlive[0] = true;
        asker = new OracleAsker(IERC20(address(imd)), feeds, hashes, flags, keepAlive);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(address(asker), 10 ether);
    }

    function test_theTestFeedAsksExactlyTheProductionQuestion() public {
        NhiFeed real = new NhiFeed(1 days, 2000);
        assertEq(feed.expectedQuestionHash(FROM, TO), real.expectedQuestionHash(FROM, TO));
    }

    function test_firstBoundDeliveryFitsTheStipendWithHeadroom() public {
        uint256 used = _deliver(keccak256("first"), 0.88 ether);
        emit log_named_uint("bound first-value callback gas (stipend 200000)", used);
        assertLt(used, 150_000, "a quarter of the stipend to spare (was 151,534 before the decimal patch)");
    }

    function test_boundUpdateFitsTheStipendWithHeadroom() public {
        feed.seed(0.9 ether);
        vm.warp(block.timestamp + 20 hours); // near stale, so the keep-alive ask is due
        uint256 used = _deliver(keccak256("update"), 0.88 ether);
        emit log_named_uint("bound update callback gas (stipend 200000)", used);
        assertLt(used, 150_000);
    }

    /// @dev The heaviest delivery since the review of cc4103f: one that opens a WIDE epoch on a long-stale
    /// value, writing the anchor and recording the epoch's first value (packed into the slot every
    /// acceptance writes, so it adds no storage write).
    function test_aDeliveryThatOpensAWideEpochFitsTheStipendWithHeadroom() public {
        feed.seed(0.9 ether);
        vm.warp(block.timestamp + 1 days + 9 hours); // stale, and its allowance past the cap
        uint256 used = _deliver(keccak256("wide"), 0.6 ether);
        emit log_named_uint("wide-epoch callback gas (stipend 200000)", used);
        assertLt(used, 150_000);
        (,, uint256 allowance) = feed.epoch();
        assertGt(allowance, feed.maxDeviationBps(), "the delivery opened a wide epoch");
    }

    function _deliver(bytes32 panel, uint256 figure) private returns (uint256 used) {
        bytes32 id = asker.ask(address(feed), BODY);
        SwarmFeed.OracleAttestation memory a;
        a.requestId = id;
        a.chainId = 1;
        a.questionHash = feed.expectedQuestionHash(FROM, TO);
        a.answerType = 3;
        a.answer = abi.encode(figure);
        a.figure = figure;
        a.answer = abi.encode(a.figure);
        a.fromBlock = FROM;
        a.toBlock = TO;
        a.blockHash = keccak256("b");
        a.panelJobId = panel;
        a.panelSize = 100;
        a.quorum = 67;
        a.agreed = 67;
        a.issuedAt = uint64(block.timestamp);
        a.expiresAt = uint64(block.timestamp + 1 hours);
        assertTrue(intake.complete(id, abi.encode(id, a, _sign(a))), "the callback completes");
        used = intake.lastCallbackGasUsed();
        assertLt(used, STIPEND);
        (uint256 value,) = feed.latestValue();
        assertEq(value, figure, "and the relay inside it really landed");
        assertEq(feed.lastToBlock(), TO);
    }

    function _sign(SwarmFeed.OracleAttestation memory a) private view returns (bytes memory) {
        bytes32 body = keccak256(
            bytes.concat(
                abi.encode(
                    feed.ATTESTATION_TYPEHASH(), a.requestId, a.chainId, a.questionHash, a.answerType,
                    keccak256(a.answer), a.figure
                ),
                abi.encode(
                    a.fromBlock, a.toBlock, a.blockHash, a.panelJobId, a.panelSize, a.quorum, a.agreed,
                    a.issuedAt, a.expiresAt
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ATTESTER_KEY, keccak256(abi.encodePacked("\x19\x01", feed.DOMAIN_SEPARATOR(), body)));
        return abi.encodePacked(r, s, v);
    }
}
