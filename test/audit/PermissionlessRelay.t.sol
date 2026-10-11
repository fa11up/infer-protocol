// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmFeed} from "src/SwarmFeed.sol";
import {SwarmRelay} from "src/SwarmRelay.sol";

/// @dev Test leaf for the abstract feed: the production artifacts pin their authorities, so the only
/// way to point a feed at a relay deployed inside the test is a leaf that takes them as arguments.
contract TestFeed is SwarmFeed {
    constructor(address attester_, address relayer_)
        SwarmFeed(attester_, relayer_, 1, 3, 1 days, 2000)
    {}

    /// @dev Test-only seeding door; the reporter fallback it replaces no longer exists.
    function seed(uint256 value) external {
        _accept(value, uint64(block.timestamp));
    }
}

/// @notice Finding: SwarmRelay is the pinned relayer of every feed and has no caller restriction, so
/// the feeds' relayer guard is gone. DeploymentConfig.ATTESTATION_RELAYER documents that guard as the
/// one thing covering "the unseeded first value and stale re-anchors", because questionHash cannot
/// tell the feed WHICH question an attestation answers. The oracle signs any question a paying
/// requester poses, under whatever consumer domain the request names (oracle/*.json carries the
/// question text and `consumer.verifyingContract` verbatim). So anyone can obtain an attester
/// signature for the price feed's domain over a figure of their choosing and push it through the
/// relay, which the feed would refuse from them directly.
contract PermissionlessRelayTest is Test {
    uint256 private constant ATTESTER_KEY = 0xA11CE;
    address private constant BORROWER_X = address(0xBEEF);
    address private constant STRANGER = address(0x5747);

    SwarmRelay private relay;
    TestFeed private priceFeed;

    function setUp() public {
        // Auditor-supplied proof, preserved verbatim apart from this gate. Run with
        // AUDIT_PROOFS=true to reproduce it. Gated so the default suite stays green, because a
        // permanently red test is one no agent can make pass and it burns a build node's whole
        // revision budget.
        //
        // IT STILL REPRODUCES, AND THAT IS ACCURATE rather than a regression: the HIGH was fixed by
        // binding the question, and `TestFeed` below pins NO question, so it takes SwarmFeed's
        // unbound branch where the relayer is the only filter — and its relayer is the
        // permissionless relay. The constructor permits that pairing because it only requires a
        // nonzero relayer. Every feed this repository ships overrides `questionPolicy`, so none is
        // in this state; re-read as a standing demonstration that an unbound leaf is unsafe, which
        // is why a new leaf must override it. See the constructor's note in src/SwarmFeed.sol.
        if (!vm.envOr("AUDIT_PROOFS", false)) vm.skip(true);

        vm.chainId(11155111);
        vm.warp(10 days);
        relay = new SwarmRelay();
        priceFeed = new TestFeed(vm.addr(ATTESTER_KEY), address(relay));
        priceFeed.seed(1 ether);
    }

    /// @dev The feed is stale (no update for > maxAge), so the deviation bound does not apply and the
    /// next accepted figure re-anchors it. The attestation answers an unrelated question (a different
    /// questionHash) but is validly signed for this feed's domain. Direct submission by the stranger
    /// is refused; the same bytes through the relay are accepted and the price becomes 1 wei.
    function test_aStrangerCannotReanchorAStaleFeedThroughTheRelay() public {
        vm.warp(block.timestamp + 2 days);
        assertTrue(priceFeed.isStale());

        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("anyone's question"), 1);
        bytes memory sig = _sign(a);

        // Refused directly: the relayer guard is doing its job.
        vm.prank(STRANGER);
        vm.expectRevert(SwarmFeed.UnauthorizedRelayer.selector);
        priceFeed.submitAttestation(a, sig);

        // Expected: the relay enforces at least the same restriction on who may relay, so this
        // reverts too. Actual: accepted, and the price feed now reads 1 wei per IMD.
        vm.prank(STRANGER);
        vm.expectRevert();
        relay.relay(priceFeed, a, sig);

        (uint256 value,) = priceFeed.latestValue();
        assertEq(value, 1 ether, "the stale feed was re-anchored by an unprivileged caller");
    }

    function _attestation(bytes32 questionHash, uint256 figure)
        private
        view
        returns (SwarmFeed.OracleAttestation memory a)
    {
        a.requestId = keccak256(abi.encode(questionHash, figure));
        a.chainId = 1;
        a.questionHash = questionHash;
        a.answerType = 3;
        a.answer = abi.encode(figure);
        a.figure = figure;
        a.answer = abi.encode(a.figure);
        a.fromBlock = 100;
        a.toBlock = 200;
        a.blockHash = keccak256("b");
        a.panelJobId = keccak256("panel");
        a.panelSize = 100;
        a.quorum = 67;
        a.agreed = 67;
        a.issuedAt = uint64(block.timestamp);
        a.expiresAt = uint64(block.timestamp + 1 hours);
    }

    function _sign(SwarmFeed.OracleAttestation memory a) private view returns (bytes memory) {
        bytes32 body = keccak256(
            bytes.concat(
                abi.encode(
                    priceFeed.ATTESTATION_TYPEHASH(),
                    a.requestId,
                    a.chainId,
                    a.questionHash,
                    a.answerType,
                    keccak256(a.answer),
                    a.figure
                ),
                abi.encode(
                    a.fromBlock,
                    a.toBlock,
                    a.blockHash,
                    a.panelJobId,
                    a.panelSize,
                    a.quorum,
                    a.agreed,
                    a.issuedAt,
                    a.expiresAt
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ATTESTER_KEY, keccak256(abi.encodePacked("\x19\x01", priceFeed.DOMAIN_SEPARATOR(), body)));
        return abi.encodePacked(r, s, v);
    }
}