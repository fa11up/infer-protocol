// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmFeed} from "src/SwarmFeed.sol";
import {SwarmRelay} from "src/SwarmRelay.sol";
import {ConfigurableSwarmFeed} from "./helpers/ConfigurableSwarmFeed.sol";

/// @notice The relay keeps every feed guard and drops the single key.
/// @dev Relaying an attestation by hand is the step that stands between this protocol and running
/// unattended. Pinning an EOA as the relayer means one party must be online for the protocol to see
/// a price; pinning this contract means anyone can carry the same attestation, and the feed cannot
/// tell the difference because every check it makes is on the payload, not the messenger.
contract SwarmRelayTest is Test {
    uint256 private constant ATTESTER_KEY = 0xA11CE;
    address private constant STRANGER = address(0x5174);
    address private constant BORROWER_X = address(0xBEEF);

    SwarmRelay private relay;
    ConfigurableSwarmFeed private priceFeed;
    ConfigurableSwarmFeed private nhiFeed;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(10 days);
        relay = new SwarmRelay();
        priceFeed = _feed();
        nhiFeed = _feed();
    }

    function _feed() private returns (ConfigurableSwarmFeed) {
        // The feeds pin the relay contract, not an EOA.
        return new ConfigurableSwarmFeed(
            vm.addr(ATTESTER_KEY), address(relay), 1, 3, 1 days, 2000
        );
    }

    function test_anyoneMayRelayAndTheFeedCannotTellWho() public {
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("r1"), 1 ether);
        vm.prank(STRANGER);
        relay.relay(priceFeed, a, _sign(priceFeed, a));
        (uint256 value,) = priceFeed.latestValue();
        assertEq(value, 1 ether, "a stranger's relay lands exactly as a pinned key's would");
        assertFalse(priceFeed.isStale());
    }

    function test_theFeedStillRefusesEveryoneElseDirectly() public {
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("r2"), 1 ether);
        bytes memory sig = _sign(priceFeed, a);
        vm.prank(STRANGER);
        vm.expectRevert(SwarmFeed.UnauthorizedRelayer.selector);
        priceFeed.submitAttestation(a, sig);
    }

    /// @dev The relay forwards; it does not vouch. Every guard still runs on the payload.
    function test_relayingDoesNotWeakenASingleGuard() public {
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("r3"), 1 ether);
        (, uint256 wrongKey) = makeAddrAndKey("impostor");
        // Signatures are built BEFORE each expectRevert: _sign reads the feed, and that staticcall
        // would otherwise be the "next call" the cheatcode matches against.
        bytes memory forged = _signWith(priceFeed, a, wrongKey);
        bytes memory good = _sign(priceFeed, a);

        vm.prank(STRANGER);
        vm.expectRevert(SwarmFeed.InvalidSignature.selector);
        relay.relay(priceFeed, a, forged);

        // Replay is still refused, through the relay as it would be directly.
        vm.prank(STRANGER);
        relay.relay(priceFeed, a, good);
        vm.prank(STRANGER);
        vm.expectRevert(SwarmFeed.ReplayedAttestation.selector);
        relay.relay(priceFeed, a, good);

        // A panel under the feed's floor is refused through the relay too.
        SwarmFeed.OracleAttestation memory thin = _attestation(keccak256("r4"), 1 ether);
        thin.agreed = priceFeed.minAgreed() - 1;
        bytes memory thinSig = _sign(priceFeed, thin);
        vm.prank(STRANGER);
        vm.expectRevert(SwarmFeed.NotEnoughAgreement.selector);
        relay.relay(priceFeed, thin, thinSig);
    }

    /// @dev The reason to own the relayer slot at all: the vault compares the price feed against the
    /// spot feed within one call, so the two must never be read a block apart.
    function test_twoFeedsUpdateInOneTransaction() public {
        SwarmFeed.OracleAttestation memory p = _attestation(keccak256("p"), 1 ether);
        SwarmFeed.OracleAttestation memory n = _attestation(keccak256("n"), 0.9 ether);
        SwarmFeed[] memory feeds = new SwarmFeed[](2);
        feeds[0] = priceFeed;
        feeds[1] = nhiFeed;
        SwarmFeed.OracleAttestation[] memory list = new SwarmFeed.OracleAttestation[](2);
        list[0] = p;
        list[1] = n;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(priceFeed, p);
        sigs[1] = _sign(nhiFeed, n);

        vm.prank(STRANGER);
        relay.relayMany(feeds, list, sigs);

        (uint256 pv, uint64 pAt) = priceFeed.latestValue();
        (uint256 nv, uint64 nAt) = nhiFeed.latestValue();
        assertEq(pv, 1 ether);
        assertEq(nv, 0.9 ether);
        assertEq(pAt, nAt, "both feeds carry the same update time");
    }

    /// @dev A batch is all or nothing, so a caller never half-updates a compared set.
    function test_aBatchThatCannotFullyLandChangesNothing() public {
        SwarmFeed.OracleAttestation memory p = _attestation(keccak256("ok"), 1 ether);
        SwarmFeed.OracleAttestation memory bad = _attestation(keccak256("bad"), 1 ether);
        bad.agreed = 0; // under the floor
        SwarmFeed[] memory feeds = new SwarmFeed[](2);
        feeds[0] = priceFeed;
        feeds[1] = nhiFeed;
        SwarmFeed.OracleAttestation[] memory list = new SwarmFeed.OracleAttestation[](2);
        list[0] = p;
        list[1] = bad;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(priceFeed, p);
        sigs[1] = _sign(nhiFeed, bad);

        vm.prank(STRANGER);
        vm.expectRevert(SwarmFeed.NotEnoughAgreement.selector); // signatures built above, see note
        relay.relayMany(feeds, list, sigs);

        assertTrue(priceFeed.isStale(), "the good half must not have landed");
        assertTrue(nhiFeed.isStale());
    }

    function test_mismatchedBatchLengthsAreRefused() public {
        SwarmFeed[] memory feeds = new SwarmFeed[](2);
        SwarmFeed.OracleAttestation[] memory list = new SwarmFeed.OracleAttestation[](1);
        bytes[] memory sigs = new bytes[](1);
        vm.expectRevert(SwarmRelay.LengthMismatch.selector);
        relay.relayMany(feeds, list, sigs);
    }

    /// @dev The relay holds no authority of its own, and the strongest form of that is now available:
    /// there is no `report()` to be refused from. The old test asserted the relay was not an
    /// allowlisted reporter; this asserts the function does not exist on the feed at all, for anyone.
    function test_theFeedHasNoReporterFallbackForTheRelayOrAnyoneElse() public {
        // keccak("report(uint256)") — the selector the deleted fallback answered on.
        bytes memory call = abi.encodeWithSelector(bytes4(keccak256("report(uint256)")), uint256(1 ether));
        vm.prank(address(relay));
        (bool asRelay,) = address(priceFeed).call(call);
        assertFalse(asRelay, "the relay cannot report");
        (bool asAnyone,) = address(priceFeed).call(call);
        assertFalse(asAnyone, "and neither can anyone else: the selector is gone");
    }

    function _attestation(bytes32 id, uint256 figure) private view returns (SwarmFeed.OracleAttestation memory a) {
        a.requestId = id;
        a.chainId = 1;
        a.questionHash = keccak256("q");
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

    function _sign(ConfigurableSwarmFeed feed, SwarmFeed.OracleAttestation memory a)
        private
        view
        returns (bytes memory)
    {
        return _signWith(feed, a, ATTESTER_KEY);
    }

    function _signWith(ConfigurableSwarmFeed feed, SwarmFeed.OracleAttestation memory a, uint256 key)
        private
        view
        returns (bytes memory)
    {
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
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", feed.DOMAIN_SEPARATOR(), body)));
        return abi.encodePacked(r, s, v);
    }
}
