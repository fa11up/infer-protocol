// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwarmFeed} from "src/SwarmFeed.sol";
import {SwarmRelay} from "src/SwarmRelay.sol";
import {OracleAsker} from "src/OracleAsker.sol";
import {MockIMD} from "src/MockIMD.sol";
import {ConfigurableSwarmFeed} from "./helpers/ConfigurableSwarmFeed.sol";
import {MockIntake, MockPoolManager} from "./helpers/MockIntake.sol";
import {
    APPROVED_OPERATOR,
    INTAKE,
    ORACLE_ACTION,
    ATTESTATION_RELAYER,
    POOL_MANAGER,
    IMD_POOL_ID,
    ASK_MIN_INTERVAL,
    ASK_TIMEOUT,
    ARM_DELAY_BLOCKS,
    ARM_WINDOW_BLOCKS
} from "src/DeploymentConfig.sol";

/// @notice The treasury-paid oracle: it pays only when the chain says an update is needed, cannot be
/// spammed, and delivers through SwarmRelay inside the Intake's gas stipend.
contract OracleAskerTest is Test {
    uint256 private constant ATTESTER_KEY = 0xA11CE;
    address private constant STRANGER = address(0x5757);
    uint256 private constant PRICE = 0.5 ether;
    uint256 private constant IMD_ETH = 0.001 ether;

    MockIMD private imd;
    MockIntake private intake;
    MockPoolManager private pool;
    ConfigurableSwarmFeed private priceFeed;
    ConfigurableSwarmFeed private healthFeed;
    OracleAsker private asker;
    bytes private constant PRICE_BODY = '{"question":"IMD/ETH median"}';
    bytes private constant HEALTH_BODY = '{"question":"network health"}';

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(10 days);
        vm.roll(1_000);
        vm.etch(ATTESTATION_RELAYER, address(new SwarmRelay()).code);
        vm.etch(INTAKE, address(new MockIntake()).code);
        vm.etch(POOL_MANAGER, address(new MockPoolManager()).code);
        intake = MockIntake(INTAKE);
        pool = MockPoolManager(POOL_MANAGER);
        imd = new MockIMD();
        intake.setPrice(ORACLE_ACTION, address(imd), PRICE);

        priceFeed = new ConfigurableSwarmFeed(vm.addr(ATTESTER_KEY), ATTESTATION_RELAYER, 1, 3, 1 days, 2000);
        healthFeed = new ConfigurableSwarmFeed(vm.addr(ATTESTER_KEY), ATTESTATION_RELAYER, 1, 3, 1 days, 2000);
        address[] memory feeds = new address[](2);
        feeds[0] = address(priceFeed);
        feeds[1] = address(healthFeed);
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = keccak256(PRICE_BODY);
        hashes[1] = keccak256(HEALTH_BODY);
        bool[] memory tracks = new bool[](2);
        tracks[0] = true;
        // The price feed lives on demand; the health feed is kept alive by the Treasury.
        bool[] memory keepAlive = new bool[](2);
        keepAlive[1] = true;
        asker = new OracleAsker(IERC20(address(imd)), feeds, hashes, tracks, keepAlive);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(address(asker), 100 ether);

        priceFeed.seed(IMD_ETH);
        healthFeed.seed(0.9 ether);
        _setPool(IMD_ETH);
    }

    /// @dev The pool's sqrtPriceX96 for a price in wei of ETH per 1e18 IMD (currency0 ETH, currency1 IMD).
    function _setPool(uint256 weiPerImd) private {
        uint160 sqrtP = uint160(Math.sqrt(Math.mulDiv(1e18, 1 << 192, weiPerImd)));
        pool.set(keccak256(abi.encode(IMD_POOL_ID, uint256(6))), sqrtP);
    }

    function test_poolPriceReadsTheRightSlotInTheRightDirection() public view {
        assertApproxEqRel(asker.poolPrice(), IMD_ETH, 1e12, "wei of ETH per 1e18 IMD, from slot0");
        assertEq(asker.driftBps(address(priceFeed)), 0);
    }

    // --- when it pays ---------------------------------------------------------------------------

    function test_aFeedNearStaleMayBeAskedForWithoutArming() public {
        vm.warp(block.timestamp + 18 hours); // 75% of a 1-day maxAge
        uint256 before = imd.balanceOf(address(asker));
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        assertTrue(id != bytes32(0));
        assertEq(before - imd.balanceOf(address(asker)), PRICE, "paid exactly the Intake's price");
        assertEq(imd.allowance(address(asker), INTAKE), 0, "no allowance left behind");
        assertEq(intake.bodyOf(id), HEALTH_BODY, "the pinned body went to the Intake");
    }

    /// @dev Final review 2026-10-07: the allowance widens with staleness (SwarmFeed), so a feed left
    /// silent long enough would accept a value far from its anchor in one purchase. Once it reads
    /// WIDE_ALLOWANCE_BPS the Treasury refreshes it whatever its policy, no arming; the honest value then
    /// holds the rest of that epoch to the cap around it (test_aDeliveredRefreshClosesWideOpen).
    function test_aFeedWhoseAllowanceHasWidenedIsRefreshedWithoutArming() public {
        // A lifetime (a day here) and an hour stale: 40% of a 2,000 bps cap, under the 6,000 threshold.
        // The allowance widens hourly whatever the lifetime (SwarmFeed.STALE_GROWTH_PERIOD).
        vm.warp(block.timestamp + 1 days + 1 hours + 1);
        assertFalse(asker.wideOpen(address(priceFeed)));
        vm.expectRevert(OracleAsker.NotArmed.selector);
        asker.ask(address(priceFeed), PRICE_BODY);
        // Nine whole hours past the lifetime: 40% + 8 x 2.5% = 60%.
        vm.warp(block.timestamp + 8 hours);
        assertTrue(asker.wideOpen(address(priceFeed)));
        uint256 before = imd.balanceOf(address(asker));
        bytes32 id = asker.ask(address(priceFeed), PRICE_BODY);
        assertTrue(id != bytes32(0));
        assertEq(before - imd.balanceOf(address(asker)), PRICE, "the Treasury's IMD paid for the refresh");
    }

    /// @dev Review of cc4103f, 2026-10-07: wideOpen read the stored epoch allowance, which an honest
    /// refresh keeps wide for a lifetime, so it stayed true after the refresh and anyone could make the
    /// Treasury pay every ASK_MIN_INTERVAL for the rest of it. Once the refresh lands the feed is fresh
    /// and not wide open; a second Treasury-paid ask is refused.
    function test_aDeliveredRefreshClosesWideOpen() public {
        vm.warp(block.timestamp + 1 days + 9 hours + 1);
        assertTrue(asker.wideOpen(address(priceFeed)));
        bytes32 id = asker.ask(address(priceFeed), PRICE_BODY);
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("wide-refresh"), IMD_ETH);
        assertTrue(intake.complete(id, abi.encode(id, a, _sign(priceFeed, a))));
        (uint256 value, uint64 at) = priceFeed.latestValue();
        assertEq(value, IMD_ETH);
        assertEq(at, block.timestamp, "the honest refresh landed");
        (,, uint256 allowance) = priceFeed.epoch();
        assertGe(allowance, 6_000, "its epoch is still wide on paper");
        assertFalse(asker.wideOpen(address(priceFeed)), "but the feed is fresh, so not wide open");
        vm.warp(block.timestamp + ASK_MIN_INTERVAL);
        uint256 before = imd.balanceOf(address(asker));
        vm.expectRevert(OracleAsker.NotArmed.selector);
        asker.ask(address(priceFeed), PRICE_BODY);
        assertEq(imd.balanceOf(address(asker)), before, "the Treasury paid once");
    }

    /// @dev Review of cc4103f, 2026-10-07: the allowance widened once per LIFETIME, so the one-day NHI
    /// feed took 120 hours to follow a 50% step, with the vault halted from hour 24. It widens hourly now.
    function test_aOneDayFeedFollowsAFiftyPercentStepWithinHoursOfGoingStale() public {
        uint256 t0 = block.timestamp; // healthFeed was seeded at 0.9 in setUp
        uint256 half = 0.45 ether;
        vm.warp(t0 + 1 days + 4 hours + 1); // 40% + 3 x 2.5% = 47.5%
        vm.expectRevert(SwarmFeed.ExcessDeviation.selector);
        healthFeed.seed(half);
        vm.warp(t0 + 1 days + 5 hours + 1); // 50%
        healthFeed.seed(half);
        (uint256 value,) = healthFeed.latestValue();
        assertEq(value, half);
    }

    function test_anUnseededFeedReadsWideOpen() public {
        ConfigurableSwarmFeed fresh = new ConfigurableSwarmFeed(vm.addr(ATTESTER_KEY), ATTESTATION_RELAYER, 1, 3, 1 days, 2000);
        assertTrue(asker.wideOpen(address(fresh)), "no value yet: the first attestation may sit anywhere");
    }

    function test_aFreshFeedThatHasNotDriftedIsNotPaidFor() public {
        vm.expectRevert(OracleAsker.NotArmed.selector);
        asker.ask(address(priceFeed), PRICE_BODY);
        vm.expectRevert(OracleAsker.NotNeeded.selector);
        asker.ask(address(healthFeed), HEALTH_BODY);
        vm.expectRevert(OracleAsker.NotNeeded.selector);
        asker.arm(address(priceFeed)); // no drift to arm
    }

    /// @dev A fall past a quarter of the feed's 20% cap (5%) must be armed, and still there
    /// ARM_DELAY_BLOCKS later.
    function test_driftMustBeArmedAndStillPresentBlocksLater() public {
        _setPool(IMD_ETH * 90 / 100);
        vm.expectRevert(OracleAsker.NotArmed.selector);
        asker.ask(address(priceFeed), PRICE_BODY);

        asker.arm(address(priceFeed));
        vm.roll(block.number + ARM_DELAY_BLOCKS - 1);
        vm.expectRevert(OracleAsker.NotArmed.selector);
        asker.ask(address(priceFeed), PRICE_BODY);

        vm.roll(block.number + 1);
        asker.ask(address(priceFeed), PRICE_BODY);
    }

    /// @dev A pool pushed off-price to arm and then put back cannot be cashed in.
    function test_aDriftThatDoesNotPersistIsNotPaidFor() public {
        _setPool(IMD_ETH * 90 / 100);
        asker.arm(address(priceFeed));
        _setPool(IMD_ETH);
        vm.roll(block.number + ARM_DELAY_BLOCKS);
        vm.expectRevert(OracleAsker.NotNeeded.selector);
        asker.ask(address(priceFeed), PRICE_BODY);
    }

    function test_anArmLapsesAfterItsWindow() public {
        _setPool(IMD_ETH * 90 / 100);
        asker.arm(address(priceFeed));
        vm.roll(block.number + ARM_WINDOW_BLOCKS + 1);
        vm.expectRevert(OracleAsker.NotArmed.selector);
        asker.ask(address(priceFeed), PRICE_BODY);
    }

    function test_driftInsideTheBandDoesNotArm() public {
        _setPool(IMD_ETH * 96 / 100); // a 4% fall, under a quarter of the 20% cap
        vm.expectRevert(OracleAsker.NotNeeded.selector);
        asker.arm(address(priceFeed));
    }

    /// @dev Asymmetric by design (docs/oracle-guards/): a fall over-values collateral and is bought at a
    /// quarter of the cap; a rise only under-values it, and the Treasury never pays for one however
    /// large — whoever wants the borrowing room uses askPaid.
    function test_theTreasuryPaysForFallsAndNeverForRises() public {
        (uint256 fall, uint256 rise) = asker.triggerBps(address(priceFeed));
        assertEq(fall, 500, "a quarter of the 20% cap");
        assertEq(rise, 0, "rises are never paid for");
        _setPool(IMD_ETH * 300 / 100); // tripled
        vm.expectRevert(OracleAsker.NotNeeded.selector);
        asker.arm(address(priceFeed));
        _setPool(IMD_ETH * 9_490 / 10_000); // a 5.1% fall
        asker.arm(address(priceFeed));
        (,,,, uint64 armedAt,,,) = asker.feeds(address(priceFeed));
        assertEq(armedAt, block.number);
    }

    // --- what stops spam --------------------------------------------------------------------------

    function test_oneRequestInFlightAndAMinimumInterval() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 first = asker.ask(address(healthFeed), HEALTH_BODY);

        vm.expectRevert(abi.encodeWithSelector(OracleAsker.InFlight.selector, first));
        asker.ask(address(healthFeed), HEALTH_BODY);

        // Undelivered past its timeout, the slot frees; the interval has long passed.
        vm.warp(block.timestamp + ASK_TIMEOUT);
        asker.ask(address(healthFeed), HEALTH_BODY);
        assertEq(asker.feedOf(first), address(healthFeed), "the timed-out request keeps its entry: a late delivery still lands");
    }

    /// @dev Second-half review 2026-10-07, low. A request that timed out and was replaced had its feedOf
    /// deleted, so the Intake's late delivery of it reverted UnknownRequest and the paid answer was lost.
    function test_aTimedOutRequestsLateDeliveryStillLands() public {
        address payer = address(0xB0B);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(payer, 1 ether);
        vm.startPrank(payer);
        imd.approve(address(asker), PRICE * 2);
        bytes32 r1 = asker.askPaid(address(priceFeed), PRICE_BODY, PRICE);
        vm.warp(block.timestamp + ASK_TIMEOUT);
        bytes32 r2 = asker.askPaid(address(priceFeed), PRICE_BODY, PRICE);
        vm.stopPrank();
        SwarmFeed.OracleAttestation memory a = _attestation(r1, IMD_ETH * 101 / 100);
        assertTrue(intake.complete(r1, abi.encode(r1, a, _sign(priceFeed, a))), "the late callback completes");
        (uint256 value,) = priceFeed.latestValue();
        assertEq(value, IMD_ETH * 101 / 100, "and the paid answer landed");
        (,,,,,,, bytes32 inFlight) = asker.feeds(address(priceFeed));
        assertEq(inFlight, r2, "the live request is untouched");
        assertEq(asker.feedOf(r1), address(0), "and the delivered one is forgotten");
    }

    /// @dev And a superseded request's REFUSED delivery does not back the Treasury off: it says nothing
    /// about the feed now.
    function test_aSupersededRefusalDoesNotHoldTheTreasuryBack() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 r1 = asker.ask(address(healthFeed), HEALTH_BODY);
        vm.warp(block.timestamp + ASK_TIMEOUT);
        asker.ask(address(healthFeed), HEALTH_BODY);
        uint64 askedAt = uint64(block.timestamp);
        assertTrue(intake.complete(r1, abi.encode(r1, _attestation(r1, 0.9 ether), hex"00")), "refused, not reverted");
        (,,, uint64 lastAsk,,,,) = asker.feeds(address(healthFeed));
        assertEq(lastAsk, askedAt, "no back-off written for a superseded request");
    }

    /// @dev Second-half review 2026-10-07, low. Staleness runs from the attestation's signed issuedAt,
    /// the epoch from the block it was relayed in, so inside the epoch an honest refresh opened the value
    /// went stale before the epoch expired and wideOpen read true again: one more Treasury purchase per
    /// silence, up to a whole lifetime of it for an answer relayed by hand an hour after it was signed.
    /// wideOpen now also requires that no epoch is live.
    function test_wideOpenStaysClosedInsideTheRefreshsEpochWhateverTheIssuedAt() public {
        vm.warp(block.timestamp + 1 days + 9 hours + 1);
        bytes32 id = asker.ask(address(priceFeed), PRICE_BODY);
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("late-signed"), IMD_ETH);
        a.issuedAt = uint64(block.timestamp - 5 minutes);
        assertTrue(intake.complete(id, abi.encode(id, a, _sign(priceFeed, a))));
        (, uint64 at) = priceFeed.latestValue();
        assertEq(at, block.timestamp - 5 minutes);
        // The value goes stale five minutes before the epoch it opened runs out.
        vm.warp(block.timestamp + 1 days - 5 minutes + 1);
        assertTrue(priceFeed.isStale());
        (, uint64 openedAt, uint256 allowance) = priceFeed.epoch();
        assertLt(openedAt, block.timestamp, "the wide epoch is still live");
        assertGe(allowance, 6_000);
        assertFalse(asker.wideOpen(address(priceFeed)), "not wide open while the epoch is live");
        vm.expectRevert(OracleAsker.NotArmed.selector);
        asker.ask(address(priceFeed), PRICE_BODY);
        // Once the epoch has run out the silence counts from the refresh: the allowance is the cap again.
        vm.warp(block.timestamp + 5 minutes);
        (, openedAt, allowance) = priceFeed.epoch();
        assertEq(openedAt, block.timestamp);
        assertEq(allowance, priceFeed.maxDeviationBps());
        assertFalse(asker.wideOpen(address(priceFeed)));
    }

    function test_theIntervalHoldsEvenAfterADelivery() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        // A delivery that does not refresh the value (a bad signature) still frees nothing early.
        intake.complete(id, abi.encode(id, _attestation(keccak256("x"), 0.9 ether), hex"00"));
        vm.warp(block.timestamp + ASK_TIMEOUT);
        uint256 next = block.timestamp;
        asker.ask(address(healthFeed), HEALTH_BODY);
        vm.warp(next + ASK_MIN_INTERVAL - 1);
        // In flight again, so that is what refuses it first.
        vm.expectRevert();
        asker.ask(address(healthFeed), HEALTH_BODY);
    }

    function test_onlyThePinnedBodyForAKnownFeed() public {
        vm.warp(block.timestamp + 20 hours);
        vm.expectRevert(OracleAsker.WrongBody.selector);
        asker.ask(address(healthFeed), PRICE_BODY);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.UnknownFeed.selector, STRANGER));
        asker.ask(STRANGER, HEALTH_BODY);
    }

    function test_neverPaysAboveTheCeilingOrForAnUnsoldAction() public {
        vm.warp(block.timestamp + 20 hours);
        intake.setPrice(ORACLE_ACTION, address(imd), 2 ether);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.PriceTooHigh.selector, 2 ether));
        asker.ask(address(healthFeed), HEALTH_BODY);
        intake.setPrice(ORACLE_ACTION, address(imd), 0);
        vm.expectRevert(OracleAsker.NotSold.selector);
        asker.ask(address(healthFeed), HEALTH_BODY);
    }

    // --- delivery ---------------------------------------------------------------------------------

    /// @dev The whole point: the Intake calls back, the attestation goes through SwarmRelay into the
    /// feed, and all of it fits inside the Intake's fixed 200,000-gas stipend.
    function test_deliveryRelaysIntoTheFeedInsideTheIntakeStipend() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("delivered"), 0.88 ether);
        bool delivered = intake.complete(id, abi.encode(id, a, _sign(healthFeed, a)));
        assertTrue(delivered, "delivered within the stipend");
        (uint256 value,) = healthFeed.latestValue();
        assertEq(value, 0.88 ether, "the feed holds the attested figure");
        assertEq(asker.feedOf(id), address(0));
        (,,,,, uint64 inFlightAt,, bytes32 inFlight) = asker.feeds(address(healthFeed));
        assertEq(inFlight, bytes32(0));
        assertEq(inFlightAt, 0);
        emit log_named_uint("callback gas used (stipend 200000)", intake.lastCallbackGasUsed());
        assertLt(intake.lastCallbackGasUsed(), 150_000, "leaves headroom under the stipend");
    }

    function test_onlyTheIntakeMayDeliver() public {
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("d"), 0.88 ether);
        bytes memory sig = _sign(healthFeed, a);
        vm.prank(STRANGER);
        vm.expectRevert(OracleAsker.NotTheIntake.selector);
        asker.onOracleResult(keccak256("any"), a, sig);
        vm.prank(INTAKE);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.UnknownRequest.selector, keccak256("any")));
        asker.onOracleResult(keccak256("any"), a, sig);
    }

    /// @dev A delivery the feed refuses is recorded as undelivered, and the answer can still be relayed
    /// by hand by anyone, because SwarmRelay is permissionless.
    function test_aFailedDeliveryCanStillBeRelayedByHand() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("late"), 0.87 ether);
        bytes memory good = _sign(healthFeed, a);
        (uint256 before,) = healthFeed.latestValue();
        // The callback no longer reverts on a refused relay (launch audit, oracle panel, medium): it
        // completes, reports relayed = false, and frees the feed's in-flight slot.
        vm.expectEmit(true, true, false, true, address(asker));
        emit OracleAsker.Delivered(address(healthFeed), id, false);
        assertTrue(intake.complete(id, abi.encode(id, a, hex"00")), "the callback itself succeeds");
        (uint256 value,) = healthFeed.latestValue();
        assertEq(value, before, "a bad signature changed nothing");
        (,,,,, uint64 inFlightAt,, bytes32 inFlight) = asker.feeds(address(healthFeed));
        assertEq(inFlight, bytes32(0), "the in-flight slot is free");
        assertEq(inFlightAt, 0);
        vm.prank(STRANGER);
        SwarmRelay(ATTESTATION_RELAYER).relay(healthFeed, a, good);
        (value,) = healthFeed.latestValue();
        assertEq(value, 0.87 ether, "and the answer can still be relayed by hand");
    }

    /// @dev Adversarial review 2026-10-05, finding 2 (medium): a body pinned with an ABSOLUTE window
    /// asks the same question forever; a bound feed refuses every repeat, and the F4 catch used to free
    /// the slot at once, so the Treasury could buy one undeliverable answer every ASK_MIN_INTERVAL. A
    /// refused delivery now backs Treasury asks off for a full ASK_TIMEOUT — the cadence the pre-F4 code
    /// had — while a caller paying with their own IMD (askPaid) is not held back.
    function test_aRefusedDeliveryBacksTreasuryAsksOffForTheTimeout() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("refused"), 0.87 ether);
        assertTrue(intake.complete(id, abi.encode(id, a, hex"00")), "the callback completes");
        emit log_named_uint("refused-delivery callback gas (stipend 200000)", intake.lastCallbackGasUsed());
        assertLt(intake.lastCallbackGasUsed(), 150_000, "the catch path's extra write fits easily");
        uint256 until = block.timestamp + ASK_TIMEOUT;
        vm.warp(block.timestamp + ASK_MIN_INTERVAL);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.TooSoon.selector, until));
        asker.ask(address(healthFeed), HEALTH_BODY);
        vm.warp(until - 1);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.TooSoon.selector, until));
        asker.ask(address(healthFeed), HEALTH_BODY);
        vm.warp(until);
        asker.ask(address(healthFeed), HEALTH_BODY);
    }

    // --- Intake v2's failure callback: a request closed without an answer -------------------------

    function test_everyRequestNamesTheFailureCallback() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        assertEq(intake.failureSelectorOf(id), OracleAsker.onOracleFailure.selector);
        (address target, bytes4 selector) = intake.callbackOf(id);
        assertEq(target, address(asker));
        assertEq(selector, OracleAsker.onOracleResult.selector);
    }

    /// @dev The point of the hook: a refused Treasury purchase no longer holds the feed's slot for ASK_TIMEOUT.
    /// The slot clears at once, a caller may pay straight away, and the Treasury itself backs off as it does
    /// after a refused relay (the request was not refunded).
    function test_aRefusalClearsTheSlotAtOnceAndBacksTheTreasuryOff() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        vm.expectEmit(true, true, false, true, address(asker));
        emit OracleAsker.AskFailed(address(healthFeed), id, 1, keccak256("refused"), 0, 0);
        assertTrue(intake.fail(id, 1, keccak256("refused"), 0, 0), "the callback completes");
        emit log_named_uint("failure callback gas (stipend 200000)", intake.lastCallbackGasUsed());
        assertLt(intake.lastCallbackGasUsed(), 60_000, "a few writes: well inside the stipend");
        (,,, uint64 lastAsk,, uint64 inFlightAt,, bytes32 inFlight) = asker.feeds(address(healthFeed));
        assertEq(inFlight, bytes32(0), "cleared now, not at ASK_TIMEOUT");
        assertEq(inFlightAt, 0);
        assertEq(asker.feedOf(id), address(0));
        uint256 until = block.timestamp + ASK_TIMEOUT;
        assertEq(lastAsk + ASK_MIN_INTERVAL, until, "the Treasury waits the timeout before buying this feed again");
        // Anyone else may pay for a fresh answer immediately, and that purchase's own failure (caller-paid)
        // neither extends nor shortens the Treasury's back-off.
        vm.prank(APPROVED_OPERATOR);
        imd.mint(STRANGER, 1 ether);
        vm.startPrank(STRANGER);
        imd.approve(address(asker), PRICE);
        bytes32 theirs = asker.askPaid(address(healthFeed), HEALTH_BODY, PRICE);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 hours); // later, so a wrongful second back-off would show as a later timestamp
        assertTrue(intake.fail(theirs, 2, keccak256("disagreed"), 9, 20));
        (,,, lastAsk,,,, inFlight) = asker.feeds(address(healthFeed));
        assertEq(inFlight, bytes32(0));
        assertEq(lastAsk + ASK_MIN_INTERVAL, until, "unchanged by the caller's failure: askPaid cleared treasuryPaid");
        // The Treasury may not buy until the back-off ends.
        vm.warp(until - 1);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.TooSoon.selector, until));
        asker.ask(address(healthFeed), HEALTH_BODY);
        vm.warp(until);
        asker.ask(address(healthFeed), HEALTH_BODY);
    }

    /// @dev A panel that did not agree (status 2) on a CALLER's purchase: the slot clears, the Treasury is not
    /// held back (its money was not spent), exactly as a refused relay of a caller-paid answer is treated.
    function test_aCallerPaidFailureClearsTheSlotAndDoesNotHoldTheTreasuryBack() public {
        vm.prank(APPROVED_OPERATOR);
        imd.mint(STRANGER, 1 ether);
        vm.startPrank(STRANGER);
        imd.approve(address(asker), PRICE);
        bytes32 id = asker.askPaid(address(priceFeed), PRICE_BODY, PRICE);
        vm.stopPrank();
        (,,, uint64 lastAskBefore,,,,) = asker.feeds(address(priceFeed));
        assertTrue(intake.fail(id, 2, keccak256("disagreed"), 7, 20));
        (,,, uint64 lastAsk,,,, bytes32 inFlight) = asker.feeds(address(priceFeed));
        assertEq(inFlight, bytes32(0));
        assertEq(lastAsk, lastAskBefore, "no back-off for a purchase that cost the Treasury nothing");
    }

    /// @dev A request that timed out and was replaced fails late: nothing to clear, no back-off, no revert.
    function test_aSupersededFailureClearsNothingAndHoldsNothingBack() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 r1 = asker.ask(address(healthFeed), HEALTH_BODY);
        vm.warp(block.timestamp + ASK_TIMEOUT);
        bytes32 r2 = asker.ask(address(healthFeed), HEALTH_BODY);
        uint64 askedAt = uint64(block.timestamp);
        assertTrue(intake.fail(r1, 1, bytes32(0), 0, 0), "completes");
        (,,, uint64 lastAsk,,,, bytes32 inFlight) = asker.feeds(address(healthFeed));
        assertEq(inFlight, r2, "the live request keeps its slot");
        assertEq(lastAsk, askedAt, "no back-off written for a superseded request");
        assertEq(asker.feedOf(r1), address(0), "the stale entry is gone");
        assertEq(asker.feedOf(r2), address(healthFeed));
    }

    function test_onlyTheIntakeMayReportAFailureAndOnlyForAKnownRequest() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        vm.prank(STRANGER);
        vm.expectRevert(OracleAsker.NotTheIntake.selector);
        asker.onOracleFailure(id, 1, bytes32(0), 0, 0, "");
        vm.prank(INTAKE);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.UnknownRequest.selector, keccak256("never")));
        asker.onOracleFailure(keccak256("never"), 1, bytes32(0), 0, 0, "");
        // A failure after the answer (or the answer after the failure) finds nothing: the Intake calls once, but
        // the second path must not roll anything back either way.
        assertTrue(intake.fail(id, 1, bytes32(0), 0, 0));
        vm.prank(INTAKE);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.UnknownRequest.selector, id));
        asker.onOracleFailure(id, 1, bytes32(0), 0, 0, "");
    }

    function test_aRefusedDeliveryDoesNotHoldBackACallerWhoPays() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("refused"), 0.87 ether);
        intake.complete(id, abi.encode(id, a, hex"00"));
        vm.prank(APPROVED_OPERATOR);
        imd.mint(STRANGER, 1 ether);
        vm.startPrank(STRANGER);
        imd.approve(address(asker), PRICE);
        asker.askPaid(address(healthFeed), HEALTH_BODY, PRICE);
        vm.stopPrank();
    }

    /// @dev Launch audit (oracle panel, medium): an answer relayed by hand BEFORE the Intake's callback
    /// made the callback revert (replayed request), which rolled back the slot clearing and refused
    /// ask / askPaid for ASK_TIMEOUT. Now the callback completes and the slot is free at once.
    function test_aHandRelayBeforeTheCallbackDoesNotHoldTheSlot() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("raced"), 0.86 ether);
        bytes memory sig = _sign(healthFeed, a);
        vm.prank(STRANGER);
        SwarmRelay(ATTESTATION_RELAYER).relay(healthFeed, a, sig);
        vm.expectEmit(true, true, false, true, address(asker));
        emit OracleAsker.Delivered(address(healthFeed), id, false);
        assertTrue(intake.complete(id, abi.encode(id, a, sig)), "the duplicate delivery does not revert");
        (,,,,,,, bytes32 inFlight) = asker.feeds(address(healthFeed));
        assertEq(inFlight, bytes32(0), "the feed can be asked for again without waiting ASK_TIMEOUT");
        vm.prank(APPROVED_OPERATOR);
        imd.mint(STRANGER, 1 ether);
        vm.startPrank(STRANGER);
        imd.approve(address(asker), PRICE);
        asker.askPaid(address(healthFeed), HEALTH_BODY, PRICE);
        vm.stopPrank();
    }

    // --- on demand ------------------------------------------------------------------------------

    /// @dev A price feed is not kept alive: once stale, the Treasury still pays only for drift.
    function test_aStalePriceFeedIsNotRefreshedWithTreasuryMoney() public {
        // Stale and near stale, but six hours past its lifetime its allowance (55%) is not yet wide open.
        vm.warp(block.timestamp + 1 days + 6 hours);
        assertTrue(asker.nearStale(address(priceFeed)));
        vm.expectRevert(OracleAsker.NotArmed.selector);
        asker.ask(address(priceFeed), PRICE_BODY);
    }

    /// @dev Anyone can buy an update with their own IMD, at any time, with no need check.
    /// @dev Final panel audit (oracle, low). A caller-paid request whose public answer was relayed by hand
    /// first had its callback refused, and the refusal backed the TREASURY off for two hours: about 0.5 IMD
    /// to disable Treasury-paid asks. Only the Treasury's own purchase backs the Treasury off now.
    function test_aCallerPaidRefusalDoesNotHoldTheTreasuryBack() public {
        address attacker = address(0xA77);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(attacker, 1 ether);
        vm.startPrank(attacker);
        imd.approve(address(asker), PRICE);
        bytes32 id = asker.askPaid(address(priceFeed), PRICE_BODY, PRICE);
        vm.stopPrank();
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("hand-relayed"), IMD_ETH);
        bytes memory sig = _sign(priceFeed, a);
        vm.prank(attacker);
        SwarmRelay(ATTESTATION_RELAYER).relay(priceFeed, a, sig);
        assertTrue(intake.complete(id, abi.encode(id, a, sig)), "the callback completes, refused as a replay");
        (,,, uint64 lastAsk,,,,) = asker.feeds(address(priceFeed));
        assertEq(lastAsk, 0, "the Treasury is not backed off by a request it did not pay for");
    }

    /// @dev And the Treasury's own refused purchase still backs it off, as before.
    function test_theTreasurysOwnRefusalStillBacksItOff() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 id = asker.ask(address(healthFeed), HEALTH_BODY);
        assertTrue(intake.complete(id, abi.encode(id, _attestation(id, 0.9 ether), hex"00")), "refused");
        (,,, uint64 lastAsk,,,,) = asker.feeds(address(healthFeed));
        assertEq(lastAsk, uint64(block.timestamp + ASK_TIMEOUT - ASK_MIN_INTERVAL), "backed off");
    }

    /// @dev Sweep panel audit (oracle, low). Inferring "the Treasury paid" from lastAsk == inFlightAt was
    /// forged: a back-off writes lastAsk to a future second, and an askPaid mined in exactly that second
    /// satisfied the test, so its refusal extended the back-off again and again. It is a recorded flag now.
    function test_anAskPaidInTheBackOffSecondCannotPassAsTreasuryPaid() public {
        vm.warp(block.timestamp + 20 hours);
        bytes32 r1 = asker.ask(address(healthFeed), HEALTH_BODY);
        assertTrue(intake.complete(r1, abi.encode(r1, _attestation(r1, 0.9 ether), hex"00")), "refused");
        (,,, uint64 lastAsk,,,,) = asker.feeds(address(healthFeed));
        assertEq(lastAsk, uint64(block.timestamp + ASK_TIMEOUT - ASK_MIN_INTERVAL));
        vm.warp(lastAsk); // the second the back-off wrote: a slot boundary on mainnet
        address attacker = address(0xA77);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(attacker, 1 ether);
        vm.startPrank(attacker);
        imd.approve(address(asker), PRICE);
        bytes32 r2 = asker.askPaid(address(healthFeed), HEALTH_BODY, PRICE);
        vm.stopPrank();
        (,,,,, uint64 inFlightAt, bool treasuryPaid,) = asker.feeds(address(healthFeed));
        assertEq(inFlightAt, lastAsk, "the timestamps coincide");
        assertFalse(treasuryPaid, "but the flag says who paid");
        assertTrue(intake.complete(r2, abi.encode(r2, _attestation(r2, 0.9 ether), hex"00")), "refused");
        (,,, uint64 after_,,,,) = asker.feeds(address(healthFeed));
        assertEq(after_, lastAsk, "the caller-paid refusal did not extend the back-off");
    }

    function test_askPaidSpendsTheCallersIMDNotTheTreasurys() public {
        address borrower = address(0xB0B);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(borrower, 1 ether);
        uint256 treasuryBefore = imd.balanceOf(address(asker));
        vm.startPrank(borrower);
        imd.approve(address(asker), PRICE);
        bytes32 id = asker.askPaid(address(priceFeed), PRICE_BODY, PRICE);
        vm.stopPrank();
        assertEq(imd.balanceOf(borrower), 1 ether - PRICE, "the caller paid");
        assertEq(imd.balanceOf(address(asker)), treasuryBefore, "the asker's budget is untouched");
        assertEq(imd.allowance(address(asker), INTAKE), 0);
        assertEq(asker.feedOf(id), address(priceFeed));
        (,,, uint64 lastAsk,,,,) = asker.feeds(address(priceFeed));
        assertEq(lastAsk, 0, "a paid ask does not use up the Treasury's interval");

        // It is delivered exactly like a Treasury ask.
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("paid"), IMD_ETH * 101 / 100);
        assertTrue(intake.complete(id, abi.encode(id, a, _sign(priceFeed, a))));
        (uint256 value,) = priceFeed.latestValue();
        assertEq(value, IMD_ETH * 101 / 100);
    }

    function test_priceIsTheIntakesListedPriceForThePayToken() public {
        assertEq(asker.price(), PRICE);
        intake.setPrice(ORACLE_ACTION, address(imd), 0.7 ether);
        assertEq(asker.price(), 0.7 ether);
    }

    function test_askPaidHonoursTheCallersCeilingAndTheInFlightSlot() public {
        address borrower = address(0xB0B);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(borrower, 2 ether);
        vm.startPrank(borrower);
        imd.approve(address(asker), 2 ether);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.PriceTooHigh.selector, PRICE));
        asker.askPaid(address(priceFeed), PRICE_BODY, PRICE - 1);
        bytes32 first = asker.askPaid(address(priceFeed), PRICE_BODY, PRICE);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.InFlight.selector, first));
        asker.askPaid(address(priceFeed), PRICE_BODY, PRICE);
        vm.expectRevert(OracleAsker.WrongBody.selector);
        asker.askPaid(address(priceFeed), HEALTH_BODY, PRICE);
        vm.stopPrank();
    }

    /// @dev The terminal's "Update price": primary and spot in one transaction, each a separate request.
    function test_askPaidManyBuysSeveralFeedsInOneTransaction() public {
        address borrower = address(0xB0B);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(borrower, 2 ether);
        address[] memory feeds = new address[](2);
        (feeds[0], feeds[1]) = (address(priceFeed), address(healthFeed));
        bytes[] memory bodies = new bytes[](2);
        (bodies[0], bodies[1]) = (PRICE_BODY, HEALTH_BODY);
        uint256 treasuryBefore = imd.balanceOf(address(asker));
        vm.startPrank(borrower);
        imd.approve(address(asker), 2 * PRICE);
        uint256 gasBefore = gasleft();
        bytes32[] memory ids = asker.askPaidMany(feeds, bodies, PRICE);
        emit log_named_uint("askPaidMany gas, two feeds", gasBefore - gasleft());
        vm.stopPrank();
        assertEq(imd.balanceOf(borrower), 2 ether - 2 * PRICE, "the caller paid for both");
        assertEq(imd.balanceOf(address(asker)), treasuryBefore, "the Treasury's budget is untouched");
        assertEq(imd.allowance(address(asker), INTAKE), 0);
        assertEq(asker.feedOf(ids[0]), address(priceFeed));
        assertEq(asker.feedOf(ids[1]), address(healthFeed));
        assertTrue(ids[0] != ids[1]);

        // Each is delivered on its own, like any other ask.
        SwarmFeed.OracleAttestation memory a = _attestation(keccak256("batch-1"), IMD_ETH * 101 / 100);
        assertTrue(intake.complete(ids[0], abi.encode(ids[0], a, _sign(priceFeed, a))));
        (uint256 value,) = priceFeed.latestValue();
        assertEq(value, IMD_ETH * 101 / 100);
    }

    /// @dev A feed already on its way is skipped and not charged, a feed named twice is bought once, and a
    /// batch that buys nothing reverts.
    function test_askPaidManySkipsWhatIsInFlightAndChargesOnlyWhatItBuys() public {
        address borrower = address(0xB0B);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(borrower, 3 ether);
        vm.startPrank(borrower);
        imd.approve(address(asker), 3 ether);
        bytes32 first = asker.askPaid(address(priceFeed), PRICE_BODY, PRICE);

        address[] memory feeds = new address[](3);
        (feeds[0], feeds[1], feeds[2]) = (address(priceFeed), address(healthFeed), address(healthFeed));
        bytes[] memory bodies = new bytes[](3);
        (bodies[0], bodies[1], bodies[2]) = (PRICE_BODY, HEALTH_BODY, HEALTH_BODY);
        uint256 before = imd.balanceOf(borrower);
        bytes32[] memory ids = asker.askPaidMany(feeds, bodies, PRICE);
        assertEq(ids[0], bytes32(0), "the primary was already on its way");
        assertTrue(ids[1] != bytes32(0));
        assertEq(ids[2], bytes32(0), "named twice, bought once");
        assertEq(before - imd.balanceOf(borrower), PRICE, "charged for the one it bought");
        assertTrue(first != ids[1]);

        vm.expectRevert(OracleAsker.NothingToAsk.selector);
        asker.askPaidMany(feeds, bodies, PRICE);

        bodies[1] = PRICE_BODY;
        vm.expectRevert(OracleAsker.WrongBody.selector);
        asker.askPaidMany(feeds, bodies, PRICE);
        vm.expectRevert(OracleAsker.EmptyBatch.selector);
        asker.askPaidMany(new address[](0), new bytes[](0), PRICE);
        vm.expectRevert(abi.encodeWithSelector(OracleAsker.PriceTooHigh.selector, PRICE));
        asker.askPaidMany(feeds, bodies, PRICE - 1);
        vm.stopPrank();
    }

    // --- helpers ----------------------------------------------------------------------------------

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

    function _sign(ConfigurableSwarmFeed feed, SwarmFeed.OracleAttestation memory a) private view returns (bytes memory) {
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
