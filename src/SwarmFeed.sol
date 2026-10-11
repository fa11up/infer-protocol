// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISwarmFeed} from "./interfaces/ISwarmFeed.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Immutable attested numeric feed. Attestations are the only way a value is ever set.
/// @dev THERE IS NO REPORTER FALLBACK, and removing it was the point. `report()` let an allowlisted
/// key set the value directly, bounded by `maxDeviationBps` only while the current value was still
/// fresh — past `maxAge` the bound lifted and the next accepted value re-anchored the band to
/// anything. On a testnet that was a convenience. On mainnet it is one key holding custody of every
/// position that consumes this feed, which is not a fallback but a second, weaker price oracle nobody
/// asked for.
///
/// The cost is accepted deliberately: a freshly deployed feed is INERT until its first attestation,
/// and a feed that goes stale cannot be walked back to market without buying one. That is the
/// behaviour mainnet has, so it is the behaviour a testnet should have too — a reporter fallback let
/// us test a protocol we were never going to deploy.
///
/// There is no admin or setter. Values are scaled by 1e18; consumers enforce any application bounds.
/// Zero is rejected: it is never a valid scaled figure and would pin the relative bound at zero. The deviation bound is PER UNIT OF TIME, not per attestation: every value accepted within one
/// maxAge of an epoch's start must lie within the epoch's allowance of the ANCHOR, the value the feed held
/// when the epoch began. The allowance is maxDeviationBps when that value was fresh, and still
/// maxDeviationBps for the first STALE_GROWTH_PERIOD (an hour) it is stale; after a whole hour of
/// staleness, STALE_DEVIATION_MULTIPLE times the cap, widening by an eighth of the cap for every further
/// hour (`_allowanceNow`). The stale base is earned by silence, never by timing: measured from one second
/// past the lifetime, a buyer relaying one step an hour and a second after the last opened every epoch on
/// the stale base and compounded at it (second-half review, docs/AUDIT-FINAL-2-2026-10-07.md, medium);
/// now a feed anyone keeps alive moves at most the cap per EPOCH however it is driven (two steps can
/// straddle an epoch boundary a block apart, so over a sliding hour the move can reach (1 + cap)^2 - 1
/// once; the sustained rate is the cap per lifetime). An epoch opened
/// wider than the cap closes behind its first value: every later value in it must also lie within the
/// cap of that first one (`_epochFirst`), so an honest refresh of a long-silent feed leaves an attacker
/// the cap around the market, not the stale allowance. It never lifts outright, but it does not stay shut either: the final
/// pre-launch review (docs/AUDIT-FINAL-2026-10-07.md, high) showed that a bound which never widens
/// cannot follow a single-step market move larger than itself — the pinned recipes read the pool, and a
/// step has no intermediate medians — so the feed, and every vault pinned to it, would halt for good
/// after one such gap. Widening with staleness turns a gap into a delay of hours and makes a far
/// re-anchor cost an attacker those same hours of silence, during which anyone can refresh the feed. A value
/// relayed at the end of a live epoch needs no silence to anchor the next one, so once an epoch has expired a
/// value within the cap of the level it held is also accepted (`_returnAnchor`): the honest level is never
/// locked out by a late push (final sweep panel 4 2026-10-09, medium).
///
/// Two revisions from the internal audit of 2026-10-06, the high finding. The bound used to lift entirely
/// once stale. Price feeds live one hour and are bought on demand, so being stale is their normal state,
/// and the first attestation after any quiet hour could set any value. The question binding pins the text
/// but the buyer chooses the window, and the recipe samples fixed blocks inside it, so a buyer who pushes
/// the pool at those blocks has a manipulated value attested honestly. Bounding the stale step alone was
/// then shown insufficient: measured against the LAST value, six attestations relayed in one block walked a
/// 20% cap from 1.0 to 3.48 (test/SwarmFeed.t.sol, `test_chainedAttestationsCannotWalkPastTheEpochBound`).
/// Measured against the anchor, an hour moves the price by at most the allowance however many attestations
/// are bought; with the stale base earned only by a whole hour of silence past the lifetime, a run of
/// steps compounds at no more than the cap per hour after the first: from a fresh feed 2x is four steps
/// (three hours of sustained, visible manipulation of the pool) and 3.48x seven (six hours); from a feed
/// two hours silent, whose first step is the stale 40%, 3.48x is six steps, five hours.
abstract contract SwarmFeed is ISwarmFeed {
    struct OracleAttestation {
        bytes32 requestId;
        uint256 chainId;
        bytes32 questionHash;
        uint8 answerType;
        bytes answer;
        uint256 figure;
        uint64 fromBlock;
        uint64 toBlock;
        bytes32 blockHash;
        bytes32 panelJobId;
        uint16 panelSize;
        uint16 quorum;
        uint16 agreed;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    error InvalidConfiguration();
    error ZeroValue();
    error ExcessDeviation();
    error InvalidSignature();
    error UnauthorizedRelayer();
    error WrongQuestion(bytes32 expected, bytes32 given);
    error WindowSpanOutOfRange(uint64 span);
    error WindowNotAdvancing(uint64 toBlock, uint64 lastAccepted);
    error InvalidWindow();
    error WindowInFuture(uint64 toBlock, uint256 head);
    error WindowTooOld(uint64 toBlock, uint256 head);
    error UnboundQuestionNeedsRelayer();
    error QuestionNeedsWindowBounds();
    error InvalidAttestationChain();
    error InvalidAnswerType();
    error InvalidTimestamp();
    error ExpiredAttestation();
    error StaleAttestation();
    error ReplayedAttestation();
    error PanelTooSmall();
    error NotEnoughAgreement();
    error InvalidAnswer();
    error AnswerMismatch();

    event ValueUpdated(uint256 value, uint64 updatedAt);
    event AttestationAccepted(bytes32 indexed requestId, bytes32 questionHash);

    /// @notice Smallest panel this feed accepts, read from the signed attestation.
    /// @dev Attestation v2 signs panelSize/quorum/agreed, so the CONSUMER sets the real bar instead of
    /// trusting the request's own quorum. A request may therefore ask for a low quorum so that it
    /// attests at all, while this contract still refuses anything thinner than these floors.
    /// RAISED 2026-10-11 from 25/15 (operator's call, before the vault was deployed): the request's own panel and
    /// quorum are not part of the question, so anyone may buy an answer to this feed's question from a small panel
    /// and relay it; these floors are the whole bar. 100 is the plane's largest paid panel, and 51 a strict
    /// majority of it, so two disagreeing answers can never both clear it. A higher floor would refuse honest
    /// answers: on the first mainnet NHI answer only 20 of 35 members agreed, while 15 read the plane's /swarm
    /// endpoint during a fault and agreed on a wrong figure (request d0203e1a).
    uint16 public constant MIN_PANEL_SIZE = 100;
    /// @notice Smallest number of members that must have given the signed answer: a strict majority of the panel.
    /// A feed whose answers are deterministic may demand more (`minAgreed`); none may demand less.
    uint16 public constant MIN_AGREED = 51;
    /// @notice How much wider an epoch's allowance is when it opens on a stale value.
    uint256 public constant STALE_DEVIATION_MULTIPLE = 2;
    /// @notice How much further the allowance widens for every further STALE_GROWTH_PERIOD the value has
    /// been stale, in basis points of maxDeviationBps: an eighth of the cap per period.
    uint256 public constant STALE_GROWTH_OF_CAP_BPS = 1_250;
    /// @notice The step the allowance widens on: an hour, whatever the feed's lifetime. A one-hour feed
    /// widens once per lifetime; the one-day NHI feed widens hourly too, so a gap in the index is followed
    /// within hours rather than days (review of cc4103f, 2026-10-07: a 50% NHI step took 120 hours, with the
    /// vault halted from hour 24).
    uint256 public constant STALE_GROWTH_PERIOD = 1 hours;
    /// @notice The allowance never exceeds this (a value a hundred times the anchor); it also keeps the
    /// packed uint24 exact.
    uint256 public constant MAX_ALLOWANCE_BPS = 1_000_000;

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "OracleAttestation(bytes32 requestId,uint256 chainId,bytes32 questionHash,uint8 answerType,bytes answer,uint256 figure,uint64 fromBlock,uint64 toBlock,bytes32 blockHash,bytes32 panelJobId,uint16 panelSize,uint16 quorum,uint16 agreed,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;
    uint256 private constant _HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable attester;
    address public immutable relayer;

    /// @notice Closing block of the last accepted attestation window; only ever moves forward.
    uint64 public lastToBlock;
    uint256 public immutable attestationChainId;
    uint8 public immutable attestationAnswerType;
    uint256 public immutable maxAge;
    uint256 public immutable maxDeviationBps;

    mapping(bytes32 requestId => bool consumed) public usedRequests;
    uint256 private _value;
    uint64 private _updatedAt;
    bool private _hasValue;
    /// @dev The bounding epoch: when it opened and the move it allows (bps), packed into the slot above
    /// so that opening one costs a single new storage write (the anchor value below) and the Intake's
    /// 200,000-gas callback stipend still fits a first delivery (test/OracleAskerBoundGas.t.sol). An
    /// epoch lasts maxAge from its first acceptance; the next acceptance after that opens a new one
    /// from the value then current. See `_epoch`.
    uint40 private _anchorAt;
    /// @dev At most MAX_ALLOWANCE_BPS (1e6), so 24 bits are exact.
    uint24 private _anchorBound;
    /// @dev The block time the current value was RELAYED (accepted), as opposed to `_updatedAt`, the time
    /// its attestation was signed. Silence is measured from here: a relayer may hold a signed attestation
    /// for up to maxAge before relaying it, and measured from the signature a held value arrived already
    /// an hour old, so the next step earned the stale base an hour early (final panel audit, oracle,
    /// medium: 1.4 per ~65 minutes instead of the cap per hour). Freshness for consumers still runs from
    /// the signature (`isStale`), which is the stricter reading for them.
    uint40 private _acceptedAt;
    /// @dev The first value accepted in the current epoch if that epoch opened wider than the cap (on a
    /// stale value), else zero; see `_checkValue`. Packed into the same slot as `_updatedAt` and the epoch,
    /// which every acceptance writes anyway, so it adds no storage write to a delivery inside the Intake's
    /// stipend. A value too large for 80 bits (above 1.2e24, far beyond any figure the shipped feeds
    /// carry: NHI is at most 1e18, the price feeds about 4e15) is not recorded, and that epoch is then
    /// bounded from its anchor alone.
    uint80 private _epochFirst;
    uint256 private _anchorValue;

    /// @param relayer_ Sole attestation submitter, or zero for permissionless relay.
    /// @param attestationChainId_ Required data chain in the signed payload, independent of the consumer chain.
    /// @param attestationAnswerType_ Required answer type in the signed payload.
    /// @param maxAge_ Maximum accepted age in seconds, strictly positive.
    /// @param maxDeviationBps_ The per-epoch deviation cap in bps, 0 to 10,000: every value accepted within
    /// one lifetime of an epoch's start lies within this much of the epoch's ANCHOR when the epoch opens on
    /// a fresh value, wider when it opens after a silence (`_checkValue`, `_allowanceNow`). Not a bound on
    /// the change from the last accepted value.
    constructor(
        address attester_,
        address relayer_,
        uint256 attestationChainId_,
        uint8 attestationAnswerType_,
        uint256 maxAge_,
        uint256 maxDeviationBps_
    ) {
        if (attester_ == address(0) || maxAge_ == 0 || maxDeviationBps_ > 10_000) revert InvalidConfiguration();
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("IdentityMD Oracle"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
        // The pairing that the HIGH audit finding turned on: a feed that cannot verify WHICH question
        // an attestation answers has only its relayer standing between a bought signature and its
        // price, so it may not be deployed without one. A feed that pins its question needs no
        // relayer, and must pin a window span too — an unbounded span would let the same question be
        // answered over one block or over a month.
        //
        // WHAT THIS CHECK DOES NOT DO, stated because a stronger claim here would be false: it
        // requires a NONZERO relayer, and `SwarmRelay` is a nonzero relayer that admits EVERYONE.
        // That pairing — no pinned question, `ATTESTATION_RELAYER` as the relayer — therefore passes
        // construction and is exactly the configuration the HIGH finding describes;
        // test/audit/PermissionlessRelay.t.sol still reproduces it against a leaf built that way.
        // Nothing this repository SHIPS is in that state: PriceFeed, NhiFeed, SpotFeed and
        // SwarmWorkOracle all override `questionPolicy` with a generated prefix, so all four take the
        // bound branch and the relayer is not load-bearing for any of them. The hole is a footgun for
        // a FUTURE leaf that forgets the override, and closing it in the constructor needs a sound
        // on-chain test for "a relayer that restricts its callers", which `code.length` is not — a
        // relay contract may perfectly well carry an allowlist. Until that is decided, the rule is
        // a review rule: a new feed leaf overrides `questionPolicy`, and the absence of an override
        // is the thing to catch.
        (bytes memory prefix_, uint64 minSpan_, uint64 maxSpan_) = questionPolicy();
        if (prefix_.length == 0) {
            if (relayer_ == address(0)) revert UnboundQuestionNeedsRelayer();
        } else if (minSpan_ == 0 || maxSpan_ < minSpan_) {
            revert QuestionNeedsWindowBounds();
        }
        attester = attester_;
        relayer = relayer_;
        attestationChainId = attestationChainId_;
        attestationAnswerType = attestationAnswerType_;
        maxAge = maxAge_;
        maxDeviationBps = maxDeviationBps_;
    }

    function latestValue() external view override returns (uint256 value, uint64 updatedAt) {
        return (_value, _updatedAt);
    }

    function isStale() external view override returns (bool) {
        return !_hasValue || _tooOld(_updatedAt);
    }

    /// @notice How many members must have given the signed answer for this feed to take it. MIN_AGREED here;
    /// the price and spot feeds, whose answers are deterministic chain reads, demand two thirds of the panel.
    function minAgreed() public pure virtual returns (uint16) {
        return MIN_AGREED;
    }

    /// @notice Accept an IdentityMD EIP-712 attestation through the configured relayer, or anyone if zero.
    /// @dev Uses the signed issue time, so delayed delivery cannot extend freshness. requestId is the
    /// replay nonce. The immutable consumer domain binds the deployment chain and this feed, stopping
    /// cross-feed replay without identifying the question. questionHash binds a changing pinned block
    /// window, so this contract cannot verify WHICH question an attestation answers FROM THE HASH ALONE.
    /// The deviation guard bounds every value after the first against the current epoch's anchor, fresh
    /// or stale (`_checkValue`); a feed that pins its question document (questionPolicy, every shipped
    /// feed) verifies the question directly. The relayer is not a trust boundary on the shipped feeds:
    /// it is SwarmRelay, which forwards for anyone. Nothing on chain bounds the FIRST value, which is why
    /// the deployment buys and relays it, and DeployMainnet.verifySeeded checks it against the pool
    /// before the operator deploys the vault (from a salt no one else knows, so no one else can deploy it first).
    /// Payload chainId and answerType must match the configured policy. Zero values revert.
    /// THE VALUE IS THE SIGNED `answer` (32 bytes, a uint256), not `figure`: the plane stopped filling `figure` for
    /// panel-evidence answers (mainnet NHI request d0203e1a, 2026-10-11: answer 0.98699e18, figure 0), and both
    /// fields are covered by the signature. A nonzero `figure` must equal the answer, so the two can never disagree.
    function submitAttestation(OracleAttestation calldata a, bytes calldata sig) external {
        if (relayer != address(0) && msg.sender != relayer) revert UnauthorizedRelayer();
        if (a.chainId != attestationChainId) revert InvalidAttestationChain();
        if (a.panelSize < MIN_PANEL_SIZE) revert PanelTooSmall();
        if (a.agreed < minAgreed() || a.agreed > a.panelSize) revert NotEnoughAgreement();
        if (a.answerType != attestationAnswerType) revert InvalidAnswerType();
        if (block.timestamp > a.expiresAt) revert ExpiredAttestation();
        if (a.issuedAt > block.timestamp || a.issuedAt > a.expiresAt) revert InvalidTimestamp();
        if (_tooOld(a.issuedAt) || (_hasValue && a.issuedAt < _updatedAt)) revert StaleAttestation();
        if (usedRequests[a.requestId]) revert ReplayedAttestation();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, _attestationHash(a)));
        if (_recover(digest, sig) != attester) revert InvalidSignature();
        usedRequests[a.requestId] = true;
        _requireQuestion(a);
        if (a.answer.length != 32) revert InvalidAnswer();
        uint256 value = abi.decode(a.answer, (uint256));
        if (a.figure != 0 && a.figure != value) revert AnswerMismatch();
        _accept(value, a.issuedAt);
        emit AttestationAccepted(a.requestId, a.questionHash);
    }

    /// @notice The question document this feed accepts answers to, and the window span it allows.
    /// @dev An empty prefix disables question binding, which is only safe behind a trusted relayer —
    /// the constructor enforces that pairing. A production feed overrides this with the canonical
    /// question-document prefix emitted by oracle/question-prefix.mjs. It is a SOURCE CONSTANT for the
    /// same reason every other authority here is: whoever controls the question controls the price, so
    /// it must never be a constructor argument a launch manifest could substitute.
    function questionPolicy() internal pure virtual returns (bytes memory prefix, uint64 minSpan, uint64 maxSpan) {
        return ("", 0, 0);
    }

    /// @dev Decimal ASCII of a uint64, because the document the attester hashed is JSON text and the
    /// window's two numbers appear in it as digits. Written here rather than imported: this repository's
    /// OpenZeppelin checkout carries only the few utils it needs, and a string helper is not worth
    /// widening it for.
    function _decimal(uint64 value) private pure returns (bytes memory) {
        if (value == 0) return "0";
        // Word-sized counters (gas review 2026-10-05): the input stays uint64 and every output byte is
        // identical, but the loop skips narrow-integer cleanup — about 5,100 gas per bound attestation,
        // which also widens the OracleAsker callback's headroom under the Intake's 200,000-gas stipend.
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) ++digits;
        bytes memory out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) out[--digits] = bytes1(uint8(48 + (v % 10)));
        return out;
    }

    /// @notice The questionHash this feed will accept for a given window, or zero if it pins no
    /// question and therefore accepts any.
    /// @dev Public so an operator can check, from the chain, that a feed agrees with the payload they
    /// are about to pay for. Buying a request whose question document differs by one character means
    /// an attestation this feed refuses, and the 0.5 IMD is already spent by then.
    function expectedQuestionHash(uint64 fromBlock, uint64 toBlock) public pure returns (bytes32) {
        (bytes memory prefix,,) = questionPolicy();
        if (prefix.length == 0) return bytes32(0);
        return keccak256(
            abi.encodePacked(prefix, _decimal(fromBlock), ',"toBlock":', _decimal(toBlock), "}}")
        );
    }

    /// @notice Rebuild the control plane's question document and refuse an answer to another question.
    /// @dev The document is canonicalised as an RFC 8785 subset, so its keys are sorted and "window"
    /// sorts last. The only part that differs between two otherwise identical requests is therefore a
    /// SUFFIX, and the attestation carries that suffix's two numbers as SIGNED fields. So the feed
    /// splices them into a pinned prefix and recomputes the very hash the attester signed over.
    ///
    /// Two further bounds, because answering the right question is not yet answering it honestly:
    ///   - the span is bounded, so the question cannot be answered over a single block (a point read
    ///     dressed up as a window median) nor over a month (which smooths away a real move);
    ///   - toBlock must advance past the last accepted window;
    ///   - and, on the chain the data is about, the window must be RECENT: it closed at or before this
    ///     block and no more than one feed lifetime (maxAge, in 12-second blocks) ago. Advancing alone
    ///     was not enough (launch audit, oracle panel, high): after any gap in updates, a buyer could
    ///     have a fresh signature put on a window from hours or days earlier, chosen for its price, and
    ///     it would be accepted and dated now; a window in the future would also have pushed
    ///     lastToBlock past every honest one. A deployment whose data lives on another chain (the
    ///     Sepolia feeds attest mainnet) cannot see that chain's head, so the bound applies only when
    ///     attestationChainId is this chain — which it is for every mainnet feed.
    function _requireQuestion(OracleAttestation calldata a) private {
        (bytes memory prefix, uint64 minSpan, uint64 maxSpan) = questionPolicy();
        if (prefix.length == 0) return;
        if (a.toBlock < a.fromBlock) revert InvalidWindow();
        uint64 span = a.toBlock - a.fromBlock;
        if (span < minSpan || span > maxSpan) revert WindowSpanOutOfRange(span);
        if (a.toBlock <= lastToBlock) revert WindowNotAdvancing(a.toBlock, lastToBlock);
        if (attestationChainId == block.chainid) {
            if (a.toBlock > block.number) revert WindowInFuture(a.toBlock, block.number);
            if (block.number - a.toBlock > maxAge / 12) revert WindowTooOld(a.toBlock, block.number);
        }
        bytes32 expected = expectedQuestionHash(a.fromBlock, a.toBlock);
        if (a.questionHash != expected) revert WrongQuestion(expected, a.questionHash);
        lastToBlock = a.toBlock;
    }

    /// @dev Split across two `abi.encode` calls and concatenated: every field is a static
    /// single-word type, so this is byte-identical to encoding all sixteen at once, and it keeps the
    /// function off a stack-too-deep without turning on viaIR.
    function _attestationHash(OracleAttestation calldata a) private pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    a.requestId,
                    a.chainId,
                    a.questionHash,
                    a.answerType,
                    keccak256(a.answer),
                    a.figure,
                    a.fromBlock
                ),
                abi.encode(
                    a.toBlock, a.blockHash, a.panelJobId, a.panelSize, a.quorum, a.agreed, a.issuedAt, a.expiresAt
                )
            )
        );
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > _HALF_CURVE_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
    }

    /// @notice Refuse a value this feed should not accept. Zero always; a value further from the current
    /// epoch's anchor than its allowance: `maxDeviationBps` for an epoch opened on a fresh value,
    /// STALE_DEVIATION_MULTIPLE times that for one opened on a stale value, and wider the longer it was
    /// stale (`_allowanceNow`). The first value ever has no
    /// bound on chain, and whoever relays first sets it (the relay is permissionless): the deployment buys
    /// and relays it, and DeployMainnet.verifySeeded refuses a price or spot anchor more than a quarter of
    /// the cap from the pool, so a raced first value is caught before deposits open (final panel audit,
    /// oracle, low). It anchors the first epoch.
    /// @dev VIRTUAL, and the reason is that the bound assumes the value is a PRICE. It is the right
    /// guard for one: a price moves continuously, so a large jump is evidence of a bad figure rather
    /// than of a fast market. It is the wrong guard for a value with no magnitude — a Merkle root is a
    /// uniformly random 256-bit number, so two consecutive honest roots differ wildly and this would
    /// reject almost all of them.
    ///
    /// A subclass that carries such a value overrides this and keeps the zero check. What it gives up
    /// is real and must be stated where it is given up: the deviation bound is one of the things
    /// standing between a wrong figure and the consumers of this feed. What remains is question
    /// binding, the attester signature and the panel floors — which, per the HIGH finding of audit
    /// c71449d1, are what actually guard a feed, the deviation bound having been the fallback for a
    /// feed that pinned no question.
    function _checkValue(uint256 value) internal view virtual {
        if (value == 0) revert ZeroValue();
        if (_hasValue && !_fitsEpoch(value) && _returnAnchor(value) == 0) revert ExcessDeviation();
    }

    /// @dev Whether `value` lies within the current epoch's allowance of its anchor (`_epoch`), and, inside a
    /// wide epoch whose first value has landed, within the cap of that first value. Whoever lands first after a
    /// silence gets the stale allowance; an honest refresh therefore closes it for everyone after (review of
    /// cc4103f, 2026-10-07: a +55% value was accepted an hour after the Treasury's honest refresh).
    function _fitsEpoch(uint256 value) private view returns (bool) {
        (uint256 anchor, uint256 bound) = _epoch();
        uint256 change = value > anchor ? value - anchor : anchor - value;
        if (change > Math.mulDiv(anchor, bound, 10_000)) return false;
        uint256 first = _epochFirst;
        if (first != 0 && block.timestamp - uint256(_anchorAt) < maxAge) {
            uint256 drift = value > first ? value - first : first - value;
            if (drift > Math.mulDiv(first, maxDeviationBps, 10_000)) return false;
        }
        return true;
    }

    /// @dev THE WAY BACK. Once the stored epoch has expired, a value within the cap of the level that epoch held
    /// its values to (its first value if it opened wide, else its anchor) is accepted, and opens the next epoch
    /// anchored there. Without it a value relayed in the last minute of an epoch anchored the next epoch, and
    /// the honest level it had moved away from was refused until the pushed value had been silent long enough
    /// to widen the allowance: for a spot feed, one block of a pushed pool attested honestly refused the honest
    /// spot for two hours, and the vault refused every priced action for disagreement, then staleness, long
    /// enough to expire a liquidation mark (final sweep panel 4 2026-10-09, medium). It reaches no level the
    /// expired epoch did not already allow, and only until that epoch is older than two lifetimes and one
    /// STALE_GROWTH_PERIOD, when the stale allowance from the last value takes over. It applies only to a value
    /// the epoch rule refuses (`_fitsEpoch`), so every value accepted before is accepted and anchored as before.
    /// Zero when no way back applies.
    function _returnAnchor(uint256 value) private view returns (uint256 level) {
        uint256 opened = uint256(_anchorAt);
        if (block.timestamp - opened < maxAge || block.timestamp - opened >= 2 * maxAge + STALE_GROWTH_PERIOD) {
            return 0;
        }
        level = _epochFirst != 0 ? uint256(_epochFirst) : (_anchorValue == 0 ? _value : _anchorValue);
        uint256 change = value > level ? value - level : level - value;
        if (change > Math.mulDiv(level, maxDeviationBps, 10_000)) return 0;
    }

    /// @notice The anchor the next value is measured against and the move it may make from it, in bps.
    /// @dev The stored epoch while it lasts; otherwise the epoch the next acceptance will open: anchored at
    /// the current value, with the stale allowance if that value has aged past maxAge. Public so a buyer
    /// can see, before paying, how far the feed will follow.
    function _epoch() private view returns (uint256 anchor, uint256 bound) {
        if (block.timestamp - uint256(_anchorAt) < maxAge) {
            // An empty anchor slot means the first epoch has seen only its first value, which is `_value`.
            return (_anchorValue == 0 ? _value : _anchorValue, _anchorBound);
        }
        return (_value, _allowanceNow());
    }

    /// @dev The allowance an epoch opened now would carry: the cap on a fresh value, and on one stale for
    /// less than a whole STALE_GROWTH_PERIOD (an hour); after that, STALE_DEVIATION_MULTIPLE times the cap
    /// plus an eighth of the cap for every further whole hour stale, up to MAX_ALLOWANCE_BPS. At a 2,000 bps
    /// cap and a one-hour lifetime: 20% through the first hour stale, 40% after two hours of silence, 45%
    /// after four, 50% after six, 60% after ten, 100% after twenty-six. A one-day feed reaches the same
    /// steps a day later: 40% at 25 hours of silence, 50% at 29, 60% at 33.
    /// So a genuine gap larger than the stale allowance is followed once the feed has been stale long
    /// enough — a delay, not a halt for good — while a re-anchor far from the market costs an attacker
    /// that same silence, during which anyone can refresh the feed honestly for one request (the
    /// Treasury does, through OracleAsker, once the allowance reaches WIDE_ALLOWANCE_BPS). A push relayed at the
    /// end of a live epoch needs no silence; the way back (`_returnAnchor`) is what keeps it from locking the
    /// honest level out.
    function _allowanceNow() private view returns (uint256) {
        if (!_tooOld(_updatedAt)) return maxDeviationBps;
        // Whole periods of silence beyond the lifetime. None yet: still the cap. The stale base and its
        // growth are earned by silence, a whole period of it at least, so a value relayed an hour and a
        // second after the last cannot open an epoch on the stale base (second-half review 2026-10-07,
        // medium). Silence runs from the later of the signature and the relay: a held attestation is
        // relayed late, and counting from its signature handed the next step that hour back (final panel
        // audit, oracle, medium). Before the first value there is no relay time and the signature rules.
        uint256 since = _acceptedAt > _updatedAt ? _acceptedAt : _updatedAt;
        if (block.timestamp < since + maxAge + STALE_GROWTH_PERIOD) return maxDeviationBps;
        uint256 periods = (block.timestamp - since - maxAge) / STALE_GROWTH_PERIOD;
        if (periods == 0) return maxDeviationBps;
        uint256 bound = maxDeviationBps * STALE_DEVIATION_MULTIPLE
            + Math.mulDiv(maxDeviationBps, STALE_GROWTH_OF_CAP_BPS, 10_000) * (periods - 1);
        return bound > MAX_ALLOWANCE_BPS ? MAX_ALLOWANCE_BPS : bound;
    }

    /// @notice Whether this feed would accept `value` now, by the same rule a delivery is checked against: the
    /// current epoch's allowance or, once it has expired, the way back to the level it held (`_returnAnchor`).
    /// `epoch()` reports only the first, so a buyer deciding whether an update would be refused asks this (an
    /// honest value returning after a late push fits only the second). A feed whose values have no magnitude
    /// (`_hasMagnitude` false: the work oracle's roots) keeps no epoch, so for it this is only the zero check.
    function accepts(uint256 value) external view returns (bool) {
        return value != 0 && (!_hasValue || !_hasMagnitude() || _fitsEpoch(value) || _returnAnchor(value) != 0);
    }

    /// @notice The current bounding epoch: its anchor value, when it opened, and the allowance in bps that
    /// every value accepted until maxAge after that must stay within. A fresh epoch is reported as the one
    /// the next acceptance would open, so the figures are always the ones the next check uses.
    function epoch() external view returns (uint256 anchor, uint64 openedAt, uint256 allowanceBps) {
        (anchor, allowanceBps) = _epoch();
        openedAt = block.timestamp - uint256(_anchorAt) < maxAge ? uint64(_anchorAt) : uint64(block.timestamp);
    }

    /// @dev INTERNAL rather than private, so a subclass can accept a value without an attestation.
    /// That is a deliberate, narrow door and it is worth being exact about what it does and does not
    /// guarantee. The docstring above says attestations are the only way a value is ever set; with
    /// this visibility that is a property of THE CONTRACTS THIS REPOSITORY SHIPS — `PriceFeed`,
    /// `NhiFeed`, `SpotFeed` and `SwarmWorkOracle` expose no path to it — rather than a property the
    /// base enforces on every conceivable subclass.
    ///
    /// It exists because the test suite has to set values, and with the reporter fallback gone the
    /// alternative is signing as the pinned attester, whose key is the oracle service's and not ours.
    /// The difference from the fallback it replaces is the one that matters: a reporter was an
    /// authority held by a KEY on a DEPLOYED contract, reachable by whoever held it. This is reachable
    /// only by writing a new subclass and deploying it, which is a code review rather than a
    /// transaction. Any new subclass under src/ must be read with that in mind.
    function _accept(uint256 value, uint64 updatedAt) internal {
        _checkValue(value);
        // A value with no magnitude keeps no epoch: there is nothing to anchor, and the epoch rule's
        // `mulDiv(anchor, allowance, 10_000)` overflows on a root above 2^256 / (allowance / 10_000).
        if (_hasMagnitude()) _openEpoch(value);
        _value = value;
        _updatedAt = updatedAt;
        _acceptedAt = uint40(block.timestamp);
        _hasValue = true;
        emit ValueUpdated(value, updatedAt);
    }

    /// @dev Whether this feed's values are quantities the epoch rule can bound. True for every price;
    /// a feed whose value is an identifier (a Merkle root) overrides it to false, and with it overrides
    /// `_checkValue`. Without this a root feed silent for a lifetime and one STALE_GROWTH_PERIOD widened
    /// its allowance past 100%, and from then `_accept` reverted on almost every root, for good: silence
    /// only widens it further (found 2026-10-10, test/WorkRootAfterSilence.t.sol).
    function _hasMagnitude() internal pure virtual returns (bool) {
        return true;
    }

    /// @dev The epoch bookkeeping `_accept` does for a value with magnitude, before `_value` moves.
    function _openEpoch(uint256 value) private {
        // Open a new epoch from the value being replaced once the old one has run its maxAge. Written
        // before `_value` moves, so the anchor is where the feed stood, never where the new value puts it.
        // Bounds are at most MAX_ALLOWANCE_BPS, so uint24 is exact; uint40 holds a timestamp to year 36812.
        if (!_hasValue) {
            // The first value anchors the first epoch and is `_value` itself, so the anchor slot stays
            // empty until a second value arrives: the first delivery pays no extra storage write, which is
            // what keeps it inside the Intake's callback stipend (test/OracleAskerBoundGas.t.sol).
            (_anchorBound, _anchorAt) = (uint24(maxDeviationBps), uint40(block.timestamp));
        } else if (block.timestamp - uint256(_anchorAt) >= maxAge) {
            uint256 back = _fitsEpoch(value) ? 0 : _returnAnchor(value);
            (uint256 anchor, uint256 bound) = back != 0 ? (back, maxDeviationBps) : _epoch();
            (_anchorValue, _anchorBound, _anchorAt) = (anchor, uint24(bound), uint40(block.timestamp));
            // A wide epoch remembers its first value (`_checkValue` holds the rest to the cap around it);
            // a fresh-opened one clears any left from an earlier wide epoch, and otherwise writes nothing.
            _epochFirst = bound > maxDeviationBps && value <= type(uint80).max ? uint80(value) : 0;
        } else if (_anchorValue == 0) {
            _anchorValue = _value; // the first epoch's anchor, materialised before the value moves
        }
    }

    function _tooOld(uint64 timestamp) private view returns (bool) {
        return block.timestamp > timestamp && block.timestamp - timestamp > maxAge;
    }
}
