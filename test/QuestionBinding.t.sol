// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmFeed} from "src/SwarmFeed.sol";
import {SwarmRelay} from "src/SwarmRelay.sol";
import {PriceFeed} from "src/PriceFeed.sol";
import {NhiFeed} from "src/NhiFeed.sol";
import {SpotFeed} from "src/SpotFeed.sol";

/// @notice A feed that pins its question, so it does not need to trust whoever carries the answer.
/// @dev The prefix is a real canonical question document with the window's two numbers cut off the
/// end. Keys are sorted (RFC 8785 subset), which is why `window` is last and the varying part is a
/// suffix: {"answerType":"uint256","chainId":1,"question":"q","v":1,"window":{"fromBlock":N,"toBlock":M}}
contract BoundFeed is SwarmFeed {
    constructor(address attester_, address relayer_)
        SwarmFeed(attester_, relayer_, 1, 3, 1 days, 2000)
    {}

    /// @dev Test-only seeding door; the reporter fallback it replaces no longer exists.
    function seed(uint256 value) external {
        _accept(value, uint64(block.timestamp));
    }

    function questionPolicy() internal pure override returns (bytes memory, uint64, uint64) {
        return ('{"answerType":"uint256","chainId":1,"question":"q","v":1,"window":{"fromBlock":', 300, 1200);
    }
}

contract QuestionBindingTest is Test {
    uint256 private constant ATTESTER_KEY = 0xA11CE;
    address private constant BORROWER_X = address(0xBEEF);
    address private constant STRANGER = address(0x5747);

    BoundFeed private feed;
    SwarmRelay private relay;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(10 days);
        relay = new SwarmRelay();
        // relayer ZERO: permissionless, which is only safe because the question is pinned. This is
        // the configuration the audit's high finding says the feed must earn.
        feed = new BoundFeed(vm.addr(ATTESTER_KEY), address(0));
    }

    /// @dev The attack from the audit: a validly signed attestation for this feed's own EIP-712
    /// domain, answering a question nobody here asked. Previously the only thing standing in its way
    /// was a trusted relayer; now the feed refuses it on its own, from anyone, through anything.
    function test_aForeignQuestionIsRefusedFromAnyoneAndThroughTheRelay() public {
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("anyone's question"), 1, 26_000_000, 26_000_600);
        bytes memory sig = _sign(a);

        vm.prank(STRANGER);
        vm.expectRevert(
            abi.encodeWithSelector(SwarmFeed.WrongQuestion.selector, _expected(26_000_000, 26_000_600), a.questionHash)
        );
        feed.submitAttestation(a, sig);

        vm.prank(STRANGER);
        vm.expectRevert();
        relay.relay(feed, a, sig);

        assertTrue(feed.isStale(), "the feed was never seeded by a foreign question");
    }

    /// @dev And the honest path still works, from a stranger, with no relayer at all.
    function test_theRightQuestionIsAcceptedFromAnyone() public {
        SwarmFeed.OracleAttestation memory a =
            _attestation(_expected(26_000_000, 26_000_600), 3_172_735_462_421_828, 26_000_000, 26_000_600);
        vm.prank(STRANGER);
        feed.submitAttestation(a, _sign(a));
        (uint256 value,) = feed.latestValue();
        assertEq(value, 3_172_735_462_421_828);
        assertEq(feed.lastToBlock(), 26_000_600);
    }

    /// @dev A one-block window is a point read dressed as a window median; a month smooths away a
    /// real move. Both answer the pinned question, so only the span bound catches them.
    function test_theWindowSpanIsBounded() public {
        // Signed BEFORE each expectRevert: _sign reads the feed, and that staticcall would otherwise
        // be the "next call" the cheatcode matches against.
        SwarmFeed.OracleAttestation memory a = _attestation(_expected(26_000_000, 26_000_000), 1 ether, 26_000_000, 26_000_000);
        bytes memory sigPoint = _sign(a);
        vm.expectRevert(abi.encodeWithSelector(SwarmFeed.WindowSpanOutOfRange.selector, uint64(0)));
        feed.submitAttestation(a, sigPoint);

        SwarmFeed.OracleAttestation memory b = _attestation(_expected(26_000_000, 26_050_000), 1 ether, 26_000_000, 26_050_000);
        bytes memory sigWide = _sign(b);
        vm.expectRevert(abi.encodeWithSelector(SwarmFeed.WindowSpanOutOfRange.selector, uint64(50_000)));
        feed.submitAttestation(b, sigWide);
    }

    /// @dev The residual the hash check alone does not cover: the pinned question answered over an
    /// ANCIENT window, in which the price was whatever the buyer needed it to be. The attestation is
    /// freshly signed, so no freshness check sees it.
    function test_anAncientWindowIsRefusedEvenForTheRightQuestion() public {
        SwarmFeed.OracleAttestation memory a =
            _attestation(_expected(26_000_000, 26_000_600), 3_172_735_462_421_828, 26_000_000, 26_000_600);
        feed.submitAttestation(a, _sign(a));

        // A year of blocks earlier, signed one second ago, answering exactly the right question.
        SwarmFeed.OracleAttestation memory old_ = _attestation(_expected(23_000_000, 23_000_600), 1 ether, 23_000_000, 23_000_600);
        old_.requestId = keccak256("ancient");
        bytes memory sigOld = _sign(old_);
        vm.expectRevert(
            abi.encodeWithSelector(SwarmFeed.WindowNotAdvancing.selector, uint64(23_000_600), uint64(26_000_600))
        );
        feed.submitAttestation(old_, sigOld);

        // And the same window cannot be re-answered either, which replay protection alone would miss
        // because the requestId differs.
        SwarmFeed.OracleAttestation memory again = _attestation(_expected(26_000_000, 26_000_600), 1 ether, 26_000_000, 26_000_600);
        again.requestId = keccak256("same-window-again");
        bytes memory sigAgain = _sign(again);
        vm.expectRevert(
            abi.encodeWithSelector(SwarmFeed.WindowNotAdvancing.selector, uint64(26_000_600), uint64(26_000_600))
        );
        feed.submitAttestation(again, sigAgain);
    }

    /// @dev The other unsafe configuration — no question AND no relayer — is covered by
    /// test_aZeroRelayerIsRefusedWithoutAPinnedQuestion in SwarmFeed.t.sol.
    ///
    /// QuestionNeedsWindowBounds has no unit test on purpose. A leaf written to trip it would pin a
    /// question with zero bounds, so its constructor would revert on every path, the immutable
    /// assignments below would be unreachable, and solc refuses to compile it at all ("some
    /// immutables were read from but never assigned", error 1284). The branch is a cheap guard
    /// against a half-configured production leaf rather than a reachable state.

    /// @dev Every production feed must pin a question, and they must pin DIFFERENT ones. The feeds
    /// pass a nonzero relayer, so construction alone proves nothing — expectedQuestionHash returning
    /// zero is what an unbound feed looks like. This is the test that fails if someone adds a fourth
    /// feed and forgets the override, or deletes one.
    function test_everyProductionFeedPinsItsQuestion() public {
        bytes32 price = new PriceFeed(1 days, 2000).expectedQuestionHash(26_000_000, 26_000_600);
        bytes32 nhi = new NhiFeed(1 days, 2000).expectedQuestionHash(26_000_000, 26_000_600);
        bytes32 spot = new SpotFeed(1 hours, 2000).expectedQuestionHash(26_000_000, 26_000_600);
        assertTrue(price != bytes32(0), "PriceFeed pins no question");
        assertTrue(nhi != bytes32(0), "NhiFeed pins no question");
        assertTrue(spot != bytes32(0), "SpotFeed pins no question");
        // Three different questions, so an attestation for one can never be accepted by another even
        // though all three share an attester. The consumer domain already separates them; this means
        // the question does too.
        assertTrue(price != nhi && nhi != spot && price != spot, "two feeds share a question");
        assertEq(feed.expectedQuestionHash(26_000_000, 26_000_600), _expected(26_000_000, 26_000_600));
    }

    // --- window recency (launch audit, oracle panel, high) ---------------------------------------
    // On the chain the data is about (mainnet feeds attest mainnet), the window must have closed at or
    // before this block and within one feed lifetime of it. BoundFeed's maxAge is one day, so 7,200
    // blocks. Before the fix only "toBlock advances" was checked, and a fresh signature over a window
    // from days ago, chosen for its price, was accepted and dated now.

    function test_onTheDataChainAWindowThatClosedDaysAgoIsRefused() public {
        vm.chainId(1);
        vm.roll(26_100_000);
        uint64 to = 26_100_000 - 21_400; // about three days of blocks before the head
        SwarmFeed.OracleAttestation memory a = _attestation(_expected(to - 600, to), 1_500_000_000_000_000, to - 600, to);
        bytes memory sig = _sign(a);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(SwarmFeed.WindowTooOld.selector, to, uint256(26_100_000)));
        feed.submitAttestation(a, sig);
    }

    function test_onTheDataChainAWindowInTheFutureIsRefused() public {
        vm.chainId(1);
        vm.roll(26_100_000);
        uint64 to = 26_101_000;
        SwarmFeed.OracleAttestation memory a = _attestation(_expected(to - 600, to), 1_500_000_000_000_000, to - 600, to);
        bytes memory sig = _sign(a);
        vm.expectRevert(abi.encodeWithSelector(SwarmFeed.WindowInFuture.selector, to, uint256(26_100_000)));
        feed.submitAttestation(a, sig);
        assertEq(feed.lastToBlock(), 0, "nothing pushed lastToBlock past the honest windows");
    }

    function test_onTheDataChainARecentWindowIsAccepted() public {
        vm.chainId(1);
        vm.roll(26_100_000);
        uint64 to = 26_100_000 - 20;
        SwarmFeed.OracleAttestation memory a = _attestation(_expected(to - 600, to), 1_500_000_000_000_000, to - 600, to);
        feed.submitAttestation(a, _sign(a));
        assertEq(feed.lastToBlock(), to);
        assertFalse(feed.isStale());
    }

    /// @dev A feed whose data lives on another chain (Sepolia feeds attest mainnet) cannot see that
    /// chain's head, so the bound does not apply there; the advancing rule still does.
    function test_aFeedOnAnotherChainThanItsDataIsUnaffected() public {
        assertEq(block.chainid, 11155111);
        vm.roll(100);
        SwarmFeed.OracleAttestation memory a =
            _attestation(_expected(26_000_000, 26_000_600), 1_500_000_000_000_000, 26_000_000, 26_000_600);
        feed.submitAttestation(a, _sign(a));
        assertEq(feed.lastToBlock(), 26_000_600);
    }

    function _expected(uint64 fromBlock, uint64 toBlock) private pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                '{"answerType":"uint256","chainId":1,"question":"q","v":1,"window":{"fromBlock":',
                _dec(fromBlock),
                ',"toBlock":',
                _dec(toBlock),
                "}}"
            )
        );
    }

    function _dec(uint64 value) private pure returns (bytes memory) {
        if (value == 0) return "0";
        uint64 digits;
        for (uint64 v = value; v != 0; v /= 10) ++digits;
        bytes memory out = new bytes(digits);
        for (uint64 v = value; v != 0; v /= 10) out[--digits] = bytes1(uint8(48 + (v % 10)));
        return out;
    }

    function _attestation(bytes32 questionHash, uint256 figure, uint64 fromBlock, uint64 toBlock)
        private
        view
        returns (SwarmFeed.OracleAttestation memory a)
    {
        a.requestId = keccak256(abi.encode(questionHash, figure, fromBlock, toBlock));
        a.chainId = 1;
        a.questionHash = questionHash;
        a.answerType = 3;
        a.answer = abi.encode(figure);
        a.figure = figure;
        a.answer = abi.encode(a.figure);
        a.fromBlock = fromBlock;
        a.toBlock = toBlock;
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
