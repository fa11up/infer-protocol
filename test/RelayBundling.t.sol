// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CDPVault} from "src/CDPVault.sol";
import {ImdUSD} from "src/ImdUSD.sol";
import {MockIMD} from "src/MockIMD.sol";
import {SwarmFeed} from "src/SwarmFeed.sol";
import {SwarmRelay} from "src/SwarmRelay.sol";
import {ConfigurableSwarmFeed} from "./helpers/ConfigurableSwarmFeed.sol";
import {APPROVED_OPERATOR} from "src/DeploymentConfig.sol";

/// @notice Keeper bundling: one transaction that carries the price AND acts on it.
/// @dev The race this closes is real money. A keeper who relays an attestation and then calls
/// bite in a second transaction is handing every other keeper a free option on the price they
/// just paid to publish. Bundling removes the gap. The difficulty is entirely custody: the vault
/// burns the CALLER's stablecoin and pays the CALLER the collateral, so for the length of one call
/// the relay is the liquidator, and it must end the call holding nothing.
contract RelayBundlingTest is Test {
    uint256 private constant ATTESTER_KEY = 0xA11CE;
    address private constant BORROWER_X = address(0xBEEF);
    address private constant BORROWER = address(0xB0B);
    address private constant KEEPER = address(0x4EEBE4);
    address private constant MARKER = address(0x3A4CE4);

    uint256 private constant PRICE = 1 ether;

    SwarmRelay private relay;
    ConfigurableSwarmFeed private priceFeed;
    ConfigurableSwarmFeed private nhiFeed;
    ConfigurableSwarmFeed private spotFeed;
    CDPVault private vault;
    MockIMD private imd;
    ImdUSD private comp;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(10 days);
        relay = new SwarmRelay();
        imd = new MockIMD();
        priceFeed = _feed();
        nhiFeed = _feed();
        spotFeed = _feed();
        _report(priceFeed, PRICE);
        _report(spotFeed, PRICE);
        _report(nhiFeed, 0.9 ether);
        vault = new CDPVault(
            address(imd), address(0), address(0), address(priceFeed), address(nhiFeed), address(spotFeed)
        );
        comp = vault.stablecoin();

        vm.prank(APPROVED_OPERATOR);
        imd.mint(BORROWER, 1_000 ether);
        vm.startPrank(BORROWER);
        imd.approve(address(vault), type(uint256).max);
        vault.lock(1_000 ether);
        vault.draw(550 ether); // CR ~182%, healthy while NHI is 0.9
        vm.stopPrank();
    }

    /// @dev Dropping NHI to 0.6 raises mat to 200 and sets the grace period to zero, which is how a
    /// position becomes liquidatable immediately instead of after a six-hour wait.
    function _makeLiquidatable() private {
        // Walked in two steps: 0.9 straight to 0.6 is a 33% move and the feed's own deviation bound
        // is 20%, which is exactly the constraint that forced us to walk the live Sepolia feeds. Since
        // the bound became per epoch (internal audit 2026-10-06), the second step needs the next epoch:
        // one maxAge on, which leaves the three feeds exactly at, not past, their lifetime.
        _report(nhiFeed, 0.74 ether);
        vm.warp(block.timestamp + 1 days);
        _report(nhiFeed, 0.6 ether);
    }

    /// @dev COMP for a keeper has to come from somewhere real: the protocol mints principal, never a
    /// spare balance. A second borrower mints against their own collateral and sells it on.
    function _fundKeeper(address keeper, uint256 amount) private {
        address market = address(0x4A4E7);
        vm.prank(APPROVED_OPERATOR);
        imd.mint(market, 1_000 ether);
        vm.startPrank(market);
        imd.approve(address(vault), type(uint256).max);
        vault.lock(1_000 ether);
        vault.draw(amount);
        comp.transfer(keeper, amount);
        vm.stopPrank();
    }

    // --- marking --------------------------------------------------------------

    /// @dev The reason barkFor exists. Through a relay, msg.sender is the relay, so a plain
    /// bark would pay the marker's share of a future bonus to a contract with no owner and
    /// no sweep — stranded forever.
    function test_aRelayedMarkPaysTheKeeperAndNeverTheRelay() public {
        _makeLiquidatable();
        (SwarmFeed[] memory feeds, SwarmFeed.OracleAttestation[] memory a, bytes[] memory sigs) =
            _bundle(keccak256("mark"), PRICE);

        vm.prank(KEEPER);
        relay.relayAndBark(feeds, a, sigs, vault, BORROWER);

        (,,, address beneficiary) = vault.liquidationMarks(BORROWER);
        assertEq(beneficiary, KEEPER, "the keeper that caused the mark is the marker");
        assertTrue(beneficiary != address(relay), "never the relay");
    }

    function test_aRelayedMarkMovesNoTokens() public {
        _makeLiquidatable();
        (SwarmFeed[] memory feeds, SwarmFeed.OracleAttestation[] memory a, bytes[] memory sigs) =
            _bundle(keccak256("mark2"), PRICE);
        vm.prank(KEEPER);
        relay.relayAndBark(feeds, a, sigs, vault, BORROWER);
        assertEq(comp.balanceOf(address(relay)), 0);
        assertEq(imd.balanceOf(address(relay)), 0);
    }

    // --- liquidating ----------------------------------------------------------

    /// @dev The property that matters most: bundling is a convenience, not a discount or a tax. A
    /// keeper must receive exactly what it would have received calling the vault itself.
    function test_bundlingPaysTheKeeperExactlyWhatADirectCallWould() public {
        _makeLiquidatable();
        uint256 debt = 10 ether;

        uint256 snapshot = vm.snapshotState();

        // Direct, for the reference figure.
        _mark(MARKER);
        _fundKeeper(KEEPER, debt);
        vm.startPrank(KEEPER);
        comp.approve(address(vault), debt);
        vault.bite(BORROWER, debt);
        vm.stopPrank();
        uint256 direct = imd.balanceOf(KEEPER);
        assertGt(direct, 0);

        vm.revertToState(snapshot);

        // Bundled, from the same starting state.
        _mark(MARKER);
        _fundKeeper(KEEPER, debt);
        (SwarmFeed[] memory feeds, SwarmFeed.OracleAttestation[] memory a, bytes[] memory sigs) =
            _bundle(keccak256("liq"), PRICE);
        vm.startPrank(KEEPER);
        comp.approve(address(relay), debt);
        relay.relayAndBite(feeds, a, sigs, vault, BORROWER, debt);
        vm.stopPrank();

        assertEq(imd.balanceOf(KEEPER), direct, "to the wei");
        assertEq(comp.balanceOf(address(relay)), 0, "relay holds no stablecoin");
        assertEq(imd.balanceOf(address(relay)), 0, "relay holds no collateral");
    }

    /// @dev A keeper who approved the relay generously keeps the surplus: the relay pulls the debt
    /// amount, never the allowance.
    function test_anOverApprovingKeeperKeepsTheSurplus() public {
        _makeLiquidatable();
        _mark(MARKER);
        uint256 debt = 10 ether;
        _fundKeeper(KEEPER, debt + 5 ether);
        (SwarmFeed[] memory feeds, SwarmFeed.OracleAttestation[] memory a, bytes[] memory sigs) =
            _bundle(keccak256("surplus"), PRICE);

        vm.startPrank(KEEPER);
        comp.approve(address(relay), type(uint256).max);
        relay.relayAndBite(feeds, a, sigs, vault, BORROWER, debt);
        vm.stopPrank();

        assertEq(comp.balanceOf(KEEPER), 5 ether, "only the debt amount was taken");
        assertEq(comp.allowance(KEEPER, address(vault)), 0, "the relay leaves no approval to the vault");
    }

    /// @dev All or nothing. A refused attestation must revert the liquidation too, or a keeper pays
    /// for a liquidation priced off a feed that did not update.
    function test_aRefusedAttestationRevertsTheWholeBundle() public {
        _makeLiquidatable();
        uint256 debtBefore = vault.debtOf(BORROWER); // fees accrue over the walk, so compare, do not pin
        _mark(MARKER);
        uint256 debt = 10 ether;
        _fundKeeper(KEEPER, debt);
        (SwarmFeed[] memory feeds, SwarmFeed.OracleAttestation[] memory a,) = _bundle(keccak256("bad"), PRICE);
        (, uint256 wrongKey) = makeAddrAndKey("impostor");
        bytes[] memory forged = new bytes[](1);
        forged[0] = _signWith(ConfigurableSwarmFeed(address(feeds[0])), a[0], wrongKey);

        vm.startPrank(KEEPER);
        comp.approve(address(relay), debt);
        vm.expectRevert(SwarmFeed.InvalidSignature.selector);
        relay.relayAndBite(feeds, a, forged, vault, BORROWER, debt);
        vm.stopPrank();

        assertEq(comp.balanceOf(KEEPER), debt, "the keeper's stablecoin never left");
        assertEq(comp.balanceOf(address(relay)), 0);
        assertEq(imd.balanceOf(address(relay)), 0);
        assertEq(vault.debtOf(BORROWER), debtBefore, "and the position is untouched");
    }

    /// @dev A donation cannot be stolen by the next liquidator and cannot brick the function for
    /// everyone — which is what absolute-balance assertions would have caused.
    function test_aDonationNeitherBreaksTheCallNorLeavesWithTheKeeper() public {
        vm.prank(APPROVED_OPERATOR);
        imd.mint(address(relay), 7 ether); // an accident, or bait

        _makeLiquidatable();
        _mark(MARKER);
        uint256 debt = 10 ether;
        _fundKeeper(KEEPER, debt);
        (SwarmFeed[] memory feeds, SwarmFeed.OracleAttestation[] memory a, bytes[] memory sigs) =
            _bundle(keccak256("donation"), PRICE);

        vm.startPrank(KEEPER);
        comp.approve(address(relay), debt);
        uint256 before = imd.balanceOf(KEEPER);
        relay.relayAndBite(feeds, a, sigs, vault, BORROWER, debt);
        vm.stopPrank();

        assertEq(imd.balanceOf(address(relay)), 7 ether, "the donation stays put");
        assertLt(imd.balanceOf(KEEPER) - before, 7 ether + 1_000 ether);
        assertGt(imd.balanceOf(KEEPER) - before, 0);
    }

    /// @dev The relay is reentrancy-guarded. No token in this deployment has a transfer hook, so the
    /// path is proven with a vault that calls back rather than a token that does.
    function test_aVaultThatCallsBackCannotReenter() public {
        ReenteringVault evil = new ReenteringVault(relay, comp, imd);
        (SwarmFeed[] memory feeds, SwarmFeed.OracleAttestation[] memory a, bytes[] memory sigs) =
            _bundle(keccak256("reenter"), PRICE);
        vm.expectRevert(); // ReentrancyGuardReentrantCall, surfaced through the vault's own revert
        relay.relayAndBite(feeds, a, sigs, CDPVault(address(evil)), BORROWER, 0);
    }

    // --- helpers --------------------------------------------------------------

    function _mark(address marker) private {
        vm.prank(marker);
        vault.bark(BORROWER);
    }

    function _bundle(bytes32 id, uint256 figure)
        private
        view
        returns (SwarmFeed[] memory feeds, SwarmFeed.OracleAttestation[] memory a, bytes[] memory sigs)
    {
        feeds = new SwarmFeed[](1);
        a = new SwarmFeed.OracleAttestation[](1);
        sigs = new bytes[](1);
        feeds[0] = priceFeed;
        a[0] = _attestation(id, figure);
        sigs[0] = _signWith(priceFeed, a[0], ATTESTER_KEY);
    }

    function _feed() private returns (ConfigurableSwarmFeed) {
        return new ConfigurableSwarmFeed(
            vm.addr(ATTESTER_KEY), address(relay), 1, 3, 1 days, 2000
        );
    }

    function _report(ConfigurableSwarmFeed feed, uint256 value) private {
        feed.seed(value);
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

    function _signWith(ConfigurableSwarmFeed feed, SwarmFeed.OracleAttestation memory a, uint256 key)
        private
        view
        returns (bytes memory)
    {
        bytes32 body = keccak256(
            bytes.concat(
                abi.encode(
                    feed.ATTESTATION_TYPEHASH(),
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
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", feed.DOMAIN_SEPARATOR(), body)));
        return abi.encodePacked(r, s, v);
    }
}

/// @notice A "vault" whose bite calls straight back into the relay.
contract ReenteringVault {
    SwarmRelay private immutable relay;
    ImdUSD private immutable comp;
    MockIMD private immutable imd;

    constructor(SwarmRelay relay_, ImdUSD comp_, MockIMD imd_) {
        relay = relay_;
        comp = comp_;
        imd = imd_;
    }

    function stablecoin() external view returns (ImdUSD) {
        return comp;
    }

    function gem() external view returns (IERC20) {
        return IERC20(address(imd));
    }

    function bite(address, uint256) external {
        SwarmFeed[] memory feeds = new SwarmFeed[](0);
        SwarmFeed.OracleAttestation[] memory a = new SwarmFeed.OracleAttestation[](0);
        bytes[] memory sigs = new bytes[](0);
        relay.relayAndBite(feeds, a, sigs, CDPVault(address(this)), address(0), 0);
    }
}
