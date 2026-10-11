// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmFeed} from "src/SwarmFeed.sol";
import {PriceFeed} from "src/PriceFeed.sol";
import {SpotFeed} from "src/SpotFeed.sol";
import {NhiFeed} from "src/NhiFeed.sol";
import {ConfigurableSwarmFeed} from "./helpers/ConfigurableSwarmFeed.sol";

/// @dev A test leaf with the price feeds' agreement floor, so the base's use of `minAgreed()` is exercised.
contract StrictTestFeed is ConfigurableSwarmFeed {
    constructor(address attester_, address relayer_)
        ConfigurableSwarmFeed(attester_, relayer_, 1, 1, 1 hours, 1000)
    {}

    function minAgreed() public pure override returns (uint16) {
        return 67;
    }
}

/// @notice The 2026-10-11 redeploy's two oracle changes, each against the guard it adds:
///   - the panel floors: 100 members, a majority (51) agreeing; the price and spot feeds two thirds (67);
///   - the value is the signed `answer`: the plane stopped filling `figure` for panel-evidence answers
///     (mainnet NHI request d0203e1a: answer 0.98699e18, figure 0), so a feed reading `figure` could never
///     take such an answer. A nonzero `figure` must equal the answer.
contract PanelFloorsAndAnswerTest is Test {
    uint256 private constant SIGNER_KEY = 0x12345;
    ConfigurableSwarmFeed private feed;
    StrictTestFeed private strict;

    function setUp() public {
        vm.chainId(1);
        vm.warp(10 days);
        feed = new ConfigurableSwarmFeed(vm.addr(SIGNER_KEY), address(this), 1, 1, 1 hours, 1000);
        strict = new StrictTestFeed(vm.addr(SIGNER_KEY), address(this));
    }

    function test_theShippedFeedsCarryTheNewFloors() public {
        PriceFeed price = new PriceFeed(1 hours, 2000);
        SpotFeed spot = new SpotFeed(1 hours, 2000);
        NhiFeed nhi = new NhiFeed(1 days, 2000);
        assertEq(price.MIN_PANEL_SIZE(), 100);
        assertEq(price.MIN_AGREED(), 51, "the base floor is a strict majority of the largest paid panel");
        assertEq(price.minAgreed(), 67, "price: two thirds");
        assertEq(spot.minAgreed(), 67, "spot: two thirds");
        assertEq(nhi.minAgreed(), 51, "NHI: a majority (honest answers to a live read vary)");
    }

    // ------------------------------------------------------------------ the value is the answer

    function test_aPanelAnswerWithNoFigureIsTakenFromTheAnswer() public {
        // Exactly the shape of the refused mainnet NHI answer.
        SwarmFeed.OracleAttestation memory a = _attestation(986990640504303661);
        a.figure = 0;
        feed.submitAttestation(a, _sign(feed, a));
        (uint256 value,) = feed.latestValue();
        assertEq(value, 986990640504303661);
    }

    function test_aFigureThatAgreesWithTheAnswerIsAccepted() public {
        SwarmFeed.OracleAttestation memory a = _attestation(3072137520139192);
        a.figure = 3072137520139192;
        feed.submitAttestation(a, _sign(feed, a));
        (uint256 value,) = feed.latestValue();
        assertEq(value, 3072137520139192);
    }

    function test_aFigureThatDisagreesWithTheAnswerIsRefused() public {
        SwarmFeed.OracleAttestation memory a = _attestation(1 ether);
        a.figure = 2 ether;
        bytes memory sig = _sign(feed, a);
        vm.expectRevert(SwarmFeed.AnswerMismatch.selector);
        feed.submitAttestation(a, sig);
    }

    function test_anAnswerThatIsNotOneWordIsRefused() public {
        SwarmFeed.OracleAttestation memory a = _attestation(1 ether);
        a.answer = bytes("one");
        a.figure = 0;
        bytes memory sig = _sign(feed, a);
        vm.expectRevert(SwarmFeed.InvalidAnswer.selector);
        feed.submitAttestation(a, sig);
        a.answer = abi.encode(uint256(1 ether), uint256(1));
        sig = _sign(feed, a);
        vm.expectRevert(SwarmFeed.InvalidAnswer.selector);
        feed.submitAttestation(a, sig);
    }

    function test_aZeroAnswerIsStillRefused() public {
        SwarmFeed.OracleAttestation memory a = _attestation(0);
        bytes memory sig = _sign(feed, a);
        vm.expectRevert();
        feed.submitAttestation(a, sig);
    }

    // ------------------------------------------------------------------ the floors

    function test_aPanelOfNinetyNineIsRefused() public {
        SwarmFeed.OracleAttestation memory a = _attestation(1 ether);
        a.panelSize = 99;
        bytes memory sig = _sign(feed, a);
        vm.expectRevert(SwarmFeed.PanelTooSmall.selector);
        feed.submitAttestation(a, sig);
    }

    function test_theBaseTakesAMajorityAndNotOneLess() public {
        SwarmFeed.OracleAttestation memory a = _attestation(1 ether);
        a.agreed = 50;
        bytes memory sig = _sign(feed, a);
        vm.expectRevert(SwarmFeed.NotEnoughAgreement.selector);
        feed.submitAttestation(a, sig);
        a.agreed = 51;
        feed.submitAttestation(a, _sign(feed, a));
        (uint256 value,) = feed.latestValue();
        assertEq(value, 1 ether);
    }

    function test_aTwoThirdsFeedRefusesSixtySixAndTakesSixtySeven() public {
        SwarmFeed.OracleAttestation memory a = _attestation(1 ether);
        a.agreed = 66;
        bytes memory sig = _sign(strict, a);
        vm.expectRevert(SwarmFeed.NotEnoughAgreement.selector);
        strict.submitAttestation(a, sig);
        a.agreed = 67;
        strict.submitAttestation(a, _sign(strict, a));
        (uint256 value,) = strict.latestValue();
        assertEq(value, 1 ether);
    }

    function test_agreementCannotExceedThePanel() public {
        SwarmFeed.OracleAttestation memory a = _attestation(1 ether);
        a.agreed = 101;
        bytes memory sig = _sign(feed, a);
        vm.expectRevert(SwarmFeed.NotEnoughAgreement.selector);
        feed.submitAttestation(a, sig);
    }

    // ------------------------------------------------------------------ helpers

    function _attestation(uint256 value) private view returns (SwarmFeed.OracleAttestation memory a) {
        a.requestId = keccak256(abi.encode("request", value, block.timestamp));
        a.chainId = 1;
        a.questionHash = keccak256("question");
        a.answerType = 1;
        a.answer = abi.encode(value);
        a.figure = value;
        a.fromBlock = 100;
        a.toBlock = 200;
        a.blockHash = keccak256("block");
        a.panelJobId = keccak256("panel");
        a.panelSize = 100;
        a.quorum = 51;
        a.agreed = 67;
        a.issuedAt = uint64(block.timestamp);
        a.expiresAt = uint64(block.timestamp + 1 hours);
    }

    function _sign(SwarmFeed target, SwarmFeed.OracleAttestation memory a) private view returns (bytes memory) {
        bytes32 body = keccak256(
            bytes.concat(
                abi.encode(
                    keccak256(
                        "OracleAttestation(bytes32 requestId,uint256 chainId,bytes32 questionHash,uint8 answerType,bytes answer,uint256 figure,uint64 fromBlock,uint64 toBlock,bytes32 blockHash,bytes32 panelJobId,uint16 panelSize,uint16 quorum,uint16 agreed,uint64 issuedAt,uint64 expiresAt)"
                    ),
                    a.requestId,
                    a.chainId,
                    a.questionHash,
                    a.answerType,
                    keccak256(a.answer),
                    a.figure
                ),
                abi.encode(
                    a.fromBlock, a.toBlock, a.blockHash, a.panelJobId, a.panelSize, a.quorum, a.agreed, a.issuedAt, a.expiresAt
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked("\x19\x01", target.DOMAIN_SEPARATOR(), body)));
        return abi.encodePacked(r, s, v);
    }
}
