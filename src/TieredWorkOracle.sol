// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SwarmFeed} from "./SwarmFeed.sol";
import {IWorkOracle} from "./interfaces/IWorkOracle.sol";
import {
    ORACLE_ATTESTER,
    ATTESTATION_RELAYER,
    ATTESTATION_CHAIN_ID,
    ATTESTATION_ANSWER_TYPE,
    ERC8004_ADAPTER,
    WAGE_WAD
} from "./DeploymentConfig.sol";

interface ITierAdapter8004 {
    function isController(uint256 agentId, address account) external view returns (bool);
}

/// @dev What a predecessor answers. `SwarmWorkOracle` answers all four; a `TieredWorkOracle` also
/// answers `creditedCount`, which is probed rather than required so either can be a predecessor.
interface IPredecessorOracle {
    function vault() external view returns (address);
    function mintingRights(address account) external view returns (uint256);
    function totalCredited() external view returns (uint256);
    function creditedTasks(uint256 agentId) external view returns (uint256);
}

/// @notice Minting rights earned from attested swarm work, weighted by the CLASS of work: the
/// successor to `SwarmWorkOracle`, which credits accepted oracle jobs only.
/// @dev DRAFT. Depends on an upstream receipt change that does not exist yet: see
/// docs/PROPOSAL-TIERED-WORK-TALLY.md. Until IdentityMD publishes `agentTierRoot`, no attestation
/// for this question can be bought and the oracle accepts nothing.
///
/// WHY TIERS AND NOT MODELS. The API reports which model ran each submission, but that figure comes
/// from the seat's own daemon and `premiumModel` is declared by the seat. Paying for a self-reported
/// model pays for a claim. The tier is the node the dispatcher ASSIGNED and the acceptance review
/// PASSED, which no seat can promote itself into. It also prices the work rather than the model.
///
/// THE FOUR TIERS are counts of distinct accepted nodes, cumulative, per agent:
///   0 oracle  — exactly `SwarmWorkOracle`'s `cumulative`, unchanged, so the predecessor's credit
///               carries over one for one;
///   1 light   — images, logos, research notes, manifests: about the cost of an oracle answer;
///   2 build   — contract, frontend and site builds, test suites;
///   3 review  — audits, judges, design and content critics.
/// The node-to-tier table is upstream's and published with the receipt. What each tier is WORTH is
/// ours, fixed here at construction: upstream reports facts, this protocol prices them.
///
/// PRICES ARE IMMUTABLE, AND THAT IS THE GOVERNANCE. Changing a multiplier means deploying a successor
/// and passing it through `Parameters.proposeWorkOracle`: the 48-hour delay, wage at zero across the
/// swap, a predecessor to carry credit. No new governed power exists here.
contract TieredWorkOracle is SwarmFeed, IWorkOracle {
    error InvalidVault();
    error InvalidPredecessor();
    error InvalidMultiplier(uint8 tier, uint256 bps);
    error WorkMintingOff();
    error NotTheVaultsOracle();
    error Unauthorized();
    error InvalidAccount();
    error ZeroAmount();
    error InsufficientRights();
    error UnknownRoot();
    error BadProof();
    error NotTheController();
    error NothingToClaim();

    event TallyClaimed(uint256 indexed agentId, address indexed controller, uint64[4] counts, uint256 rights);
    event RightsConsumed(address indexed account, uint256 amount);
    event RootAccepted(bytes32 indexed root, uint64 toBlock);

    uint8 public constant TIERS = 4;
    uint256 public constant BPS = 10_000;
    /// @notice No tier may be priced above ten oracle answers.
    uint256 public constant MAX_MULTIPLIER_BPS = 100_000;
    /// @notice `Parameters.MAX_WAGE_WAD`, restated: the cap binds on what ONE node earns, whatever its
    /// tier, so a multiplier can never lift a node past what governance may pay for anything.
    uint256 public constant MAX_RATE_WAD = 1 ether;

    /// @notice The only consumer of rights.
    address public immutable vault;
    /// @notice The oracle this one replaced, whose credit it carries; zero for none.
    address public immutable predecessor;

    uint256 private immutable _mult1;
    uint256 private immutable _mult2;
    uint256 private immutable _mult3;

    /// @notice Every tier root this feed has accepted. A set, for the reason `SwarmWorkOracle` gives:
    /// counts are monotone, so an older root can only under-credit.
    mapping(bytes32 root => bool accepted) public acceptedRoots;

    /// @dev Counts credited HERE. `creditedCount` folds in the predecessor's.
    mapping(uint256 agentId => uint64[4] counts) private _credited;

    /// @notice Rights credited here, priced at claim. The predecessor's are read from it, not copied.
    mapping(address account => uint256 rights) public creditedRights;
    /// @notice Rights consumed here, against the predecessor's remainder and this oracle's credit alike.
    mapping(address account => uint256 amount) public consumedRights;
    uint256 private _ownCredited;

    /// @param multipliersBps What tiers 1-3 earn per node, in basis points of the oracle wage. Tier 0
    /// is the wage itself and takes no multiplier, so the predecessor's credit means the same here.
    /// @dev Built directly for an existing vault (never through `WorkOracleFactory`, which binds its
    /// caller), because a successor is installed by governance into a vault that already exists.
    constructor(address vault_, uint256 maxAge_, address predecessor_, uint256[3] memory multipliersBps)
        SwarmFeed(ORACLE_ATTESTER, ATTESTATION_RELAYER, ATTESTATION_CHAIN_ID, ATTESTATION_ANSWER_TYPE, maxAge_, 10_000)
    {
        if (vault_.code.length == 0) revert InvalidVault();
        if (predecessor_ != address(0) && IPredecessorOracle(predecessor_).vault() != vault_) {
            revert InvalidPredecessor();
        }
        for (uint8 i; i < 3; ++i) {
            if (multipliersBps[i] > MAX_MULTIPLIER_BPS) revert InvalidMultiplier(i + 1, multipliersBps[i]);
        }
        vault = vault_;
        predecessor = predecessor_;
        (_mult1, _mult2, _mult3) = (multipliersBps[0], multipliersBps[1], multipliersBps[2]);
    }

    /// @notice Record the tier root an attestation carried. Permissionless, as in `SwarmWorkOracle`.
    function recordRoot() external {
        (uint256 value,) = this.latestValue();
        if (value == 0) revert UnknownRoot();
        bytes32 root = bytes32(value);
        if (!acceptedRoots[root]) {
            acceptedRoots[root] = true;
            emit RootAccepted(root, lastToBlock);
        }
    }

    /// @dev A root has no magnitude; see `SwarmWorkOracle._checkValue`.
    function _checkValue(uint256 value) internal view override {
        if (value == 0) revert ZeroValue();
    }

    /// @dev A root is an identifier, not a quantity: no epoch is kept for it (`SwarmFeed._hasMagnitude`).
    function _hasMagnitude() internal pure override returns (bool) {
        return false;
    }

    /// @notice Claim an agent's published tier tally. Caller must control the agent.
    /// @param accepted That day's oracle count. Signed into the leaf, not used.
    /// @param counts Cumulative distinct accepted nodes per tier: oracle, light, build, review.
    /// @dev Each tier is credited independently, and only upward: a tier whose count is not above what
    /// is already credited contributes nothing, so a stale root never takes anything back.
    function claim(uint256 agentId, uint32 accepted, uint64[4] calldata counts, bytes32[] calldata proof, bytes32 root)
        external
        returns (uint256 rights)
    {
        if (!acceptedRoots[root]) revert UnknownRoot();
        uint256 w = wage();
        if (w == 0) revert WorkMintingOff();
        if (!_isTheVaultsOracle()) revert NotTheVaultsOracle();
        if (!_controls(agentId, msg.sender)) revert NotTheController();
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(agentId, accepted, counts[0], counts[1], counts[2], counts[3])))
        );
        if (!_verify(proof, root, leaf)) revert BadProof();

        uint64[4] storage own = _credited[agentId];
        for (uint8 t; t < TIERS; ++t) {
            uint256 already = creditedCount(agentId, t);
            if (counts[t] > already) {
                rights += (counts[t] - already) * rateOf(t, w);
                own[t] = counts[t];
            }
        }
        if (rights == 0) revert NothingToClaim();
        creditedRights[msg.sender] += rights;
        _ownCredited += rights;
        emit TallyClaimed(agentId, msg.sender, counts, rights);
    }

    /// @notice imdUSD one accepted node of `tier` earns at wage `w`: the multiplier applied, then capped.
    function rateOf(uint8 tier, uint256 w) public view returns (uint256 rate) {
        rate = tier == 0 ? w : (w * multiplierBps(tier)) / BPS;
        if (rate > MAX_RATE_WAD) rate = MAX_RATE_WAD;
    }

    function multiplierBps(uint8 tier) public view returns (uint256) {
        if (tier == 0) return BPS;
        if (tier == 1) return _mult1;
        if (tier == 2) return _mult2;
        if (tier == 3) return _mult3;
        return 0;
    }

    /// @notice Nodes of `tier` already credited to `agentId`, here or by the predecessor chain.
    /// @dev The larger of the two rather than a sum: both count the same cumulative figure, and the
    /// predecessor is frozen once replaced (it refuses claims, and governance swaps only at wage zero).
    function creditedCount(uint256 agentId, uint8 tier) public view returns (uint256) {
        uint256 own = _credited[agentId][tier];
        uint256 inherited = _inheritedCount(agentId, tier);
        return own > inherited ? own : inherited;
    }

    /// @notice The oracle tier, under the name `SwarmWorkOracle` uses, so a successor of THIS reads it.
    function creditedTasks(uint256 agentId) external view returns (uint256) {
        return creditedCount(agentId, 0);
    }

    /// @notice Rights ever credited along the chain. `Parameters` reads it to require a predecessor.
    function totalCredited() external view returns (uint256) {
        return _ownCredited + (predecessor == address(0) ? 0 : IPredecessorOracle(predecessor).totalCredited());
    }

    /// @notice The predecessor's unconsumed rights, plus this oracle's credit, minus what was consumed here.
    /// @dev Rights credited by the predecessor and not minted before the swap stay mintable: that is what
    /// `Parameters` requires a predecessor FOR. The predecessor's own figure is frozen from the swap on,
    /// so all later consumption is counted here.
    function mintingRights(address account) public view override returns (uint256) {
        uint256 available = _inheritedRights(account) + creditedRights[account];
        uint256 spent = consumedRights[account];
        return available > spent ? available - spent : 0;
    }

    /// @notice Spend rights. Vault only.
    function consumeRights(address account, uint256 amount) external override {
        if (msg.sender != vault) revert Unauthorized();
        if (account == address(0)) revert InvalidAccount();
        if (amount == 0) revert ZeroAmount();
        if (mintingRights(account) < amount) revert InsufficientRights();
        consumedRights[account] += amount;
        emit RightsConsumed(account, amount);
    }

    /// @notice The vault's governed wage, or the shipped constant; as `SwarmWorkOracle.wage`.
    function wage() public view returns (uint256) {
        (bool ok, bytes memory data) = vault.staticcall(abi.encodeWithSignature("parameters()"));
        if (!ok || data.length != 32) return WAGE_WAD;
        address parameters = address(uint160(abi.decode(data, (uint256))));
        if (parameters == address(0)) return WAGE_WAD;
        (ok, data) = parameters.staticcall(abi.encodeWithSignature("wage()"));
        if (!ok || data.length != 32) return WAGE_WAD;
        return abi.decode(data, (uint256));
    }

    function _inheritedCount(uint256 agentId, uint8 tier) private view returns (uint256) {
        if (predecessor == address(0)) return 0;
        if (tier == 0) return IPredecessorOracle(predecessor).creditedTasks(agentId);
        (bool ok, bytes memory data) =
            predecessor.staticcall(abi.encodeWithSignature("creditedCount(uint256,uint8)", agentId, tier));
        return ok && data.length == 32 ? abi.decode(data, (uint256)) : 0;
    }

    function _inheritedRights(address account) private view returns (uint256) {
        return predecessor == address(0) ? 0 : IPredecessorOracle(predecessor).mintingRights(account);
    }

    function _isTheVaultsOracle() private view returns (bool) {
        (bool ok, bytes memory data) = vault.staticcall(abi.encodeWithSignature("oracle()"));
        if (!ok || data.length != 32) return true;
        return abi.decode(data, (address)) == address(this);
    }

    function _controls(uint256 agentId, address account) private view returns (bool) {
        (bool ok, bytes memory data) =
            ERC8004_ADAPTER.staticcall(abi.encodeCall(ITierAdapter8004.isController, (agentId, account)));
        if (!ok || data.length < 32) return false;
        return abi.decode(data, (uint256)) == 1;
    }

    /// @dev OpenZeppelin's sorted-pair proof; see `SwarmWorkOracle._verify`.
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) private pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == root;
    }

    bytes internal constant QUESTION_PREFIX = hex"7b22616e7377657254797065223a2275696e74323536222c22636861696e4964223a312c22646566696e6974696f6e73223a7b2265786163746e657373223a22457665727920726563656970742069732066726f7a656e20616e642070696e6e65642c20736f206576657279206d656d626572206f6620746869732070616e656c207265616473206964656e746963616c20627974657320616e64206d757374207265706f727420746865206964656e746963616c20696e74656765722e20446f206e6f7420726f756e642c20646f206e6f74206176657261676520616e6420646f206e6f742061646a75737420746f7761726420616e6f74686572206d656d6265722e20496620796f75722072656275696c6420646973616772656573207769746820616e6f746865722072656164696e672c207265706f727420696e6162696c69747920726174686572207468616e2073706c697474696e672074686520646966666572656e63652e222c22666967757265223a2254686520616e7377657220697320746865206167656e7454696572526f6f74206669656c64206f66207468617420646f63756d656e742c20612033322d627974652076616c7565207772697474656e20617320307820666f6c6c6f7765642062792036342068657861646563696d616c20636861726163746572732c207265706f727465642061732074686520756e7369676e656420696e74656765722074686f736520627974657320726570726573656e7420696e206269672d656e6469616e206f726465722e20446f204e4f54207265706f72742074686520726f6f74206669656c642c207768696368206973206120726f6f74206f766572206a6f62206964656e746966696572732c20616e6420646f204e4f54207265706f727420746865206167656e74526f6f74206669656c642c207768696368206973207468652074687265652d6669656c642074616c6c7920776974686f75742074696572732e222c2272656365697074223a22466574636820746865207265636569707420646f63756d656e742074686520576f726b5265636f72646564206576656e74277320757269206e616d65732e20416e20697066733a2f2f20757269207265736f6c766573207468726f75676820616e79207075626c696320676174657761792c20696e636c7564696e672068747470733a2f2f697066732e696d642e66756e2e2043616e6f6e6963616c697a652074686520646f63756d656e7420617320616e2052464320383738352073756273657420616e6420636f6e6669726d206b656363616b323536206f662074686f736520627974657320657175616c732074686520646f63756d656e744861736820726561642066726f6d207468652072656769737472792e204120646f63756d656e742077686f7365206861736820646f6573206e6f74206d61746368206973206e6f7420746865207265636569707420616e64206d757374206e6f7420626520757365642e222c227265667573616c223a225265706f727420696e6162696c69747920726174686572207468616e20737562737469747574696e6720616e797468696e67206966207468652072656769737472792063616e6e6f7420626520726561642c206966206e6f207175616c696679696e6720646179206578697374732c2069662074686520726563656970742063616e6e6f7420626520666574636865642c20696620697473206861736820646f6573206e6f74206d61746368207768617420746865207265676973747279207265636f726465642c206f72206966206974732074696572206c656176657320646f206e6f7420726570726f6475636520697473206f776e206167656e7454696572526f6f742e20416e20616273656e7420746965722074616c6c79206d65616e732074686520636f6e74726f6c20706c616e6520686173206e6f74207075626c6973686564206f6e6520666f7220746861742077696e646f772c20616e642074686520636f727265637420616e7377657220697320696e6162696c6974792c204e4f54207a65726f2c20616e64204e4f5420746865206167656e74526f6f742e222c227265676973747279223a2254686520576f726b52656769737472792069732074686520636f6e747261637420617420307862366430613138376230353066613562623062383730333361323033663337626563663461373735206f6e20457468657265756d206d61696e6e65742e204561636820555443206461792773206f7261636c652072656365697074206973207265636f7264656420756e6465722061206a6f624964206465726976656420617320746865206669727374207369787465656e206279746573206f66206b656363616b323536206f662074686520415343494920737472696e67206964656e746974796d642d6f7261636c652d62617463683a20666f6c6c6f776564206279207468652064617920696e20595959592d4d4d2d444420666f726d2c20776974682074686520555549442076657273696f6e20616e642076617269616e742062697473207365743a206279746520736978206f662074686f7365207369787465656e20686173206974732068696768206e6962626c65207265706c6163656420627920382c20616e64206279746520656967687420686173206974732074776f20686967682062697473207265706c616365642062792031302e2052656164206c6174657374286a6f6249642920666f72207468652063616e6f6e6963616c20646f63756d656e7448617368206f662074686174206461792e222c2273656c656374696f6e223a225768657265207365766572616c2064617973207175616c6966792c2074616b6520746865206f6e65207769746820746865206772656174657374206461792076616c75652077686f736520646f63756d656e7448617368206973207265636f72646564206174206f72206265666f7265207468652077696e646f772773206c61737420626c6f636b2e2041206461792077697468206e6f206167656e7454696572526f6f7420617420616c6c20646f6573206e6f74207175616c6966792c2077686174657665722069747320736368656d612e222c22766572696669636174696f6e223a22496e646570656e64656e746c792072656275696c64207468652074726565206265666f726520616e73776572696e672e2054686520646f63756d656e742063617272696573206167656e74546965724c656166456e636f64696e672c207768696368206d75737420626520746865207369782074797065732075696e743235362c2075696e7433322c2075696e7436342c2075696e7436342c2075696e7436342c2075696e7436342c20616e64206167656e74546965724c65617665732c20616e206172726179206f66206f626a656374732077697468206167656e7449642c2061636365707465642c2063756d756c61746976652c206c696768742c206275696c6420616e64207265766965772e204275696c6420616e204f70656e5a657070656c696e205374616e646172644d65726b6c6554726565206f7665722074686f7365206c656176657320696e2074686174206669656c64206f7264657220616e6420696e20746865206f7264657220676976656e2c20616e6420636f6e6669726d2069747320726f6f7420657175616c73206167656e7454696572526f6f742e204120646f63756d656e742077686f7365206c656176657320646f206e6f7420726570726f6475636520697473206f776e20726f6f74206d75737420626520726566757365642e227d2c2265766964656e6365223a2270616e656c222c227175657374696f6e223a225768617420697320746865206167656e7420746965722074616c6c79204d65726b6c6520726f6f74206f6620746865206d6f737420726563656e74206461696c79206f7261636c652072656365697074207468617420746865204964656e746974794d4420576f726b526567697374727920686173207265636f72646564206173206f6620746865206c61737420626c6f636b206f66207468652070696e6e65642077696e646f772c206578707265737365642061732074686520756e7369676e6564203235362d62697420696e74656765722077686f7365206269672d656e6469616e20627974657320617265207468617420726f6f743f222c2276223a312c2277696e646f77223a7b2266726f6d426c6f636b223a";

    /// @notice The exact question this oracle accepts answers to, and the window span it allows.
    /// @dev DERIVED, NEVER HAND-WRITTEN: emitted by `node oracle/question-prefix.mjs
    /// oracle/work-tier-root-quote.json`. Nothing can be bought against it until upstream publishes
    /// `agentTierRoot`; then buy one and run the generator with `--verify <requestId>` before deploying.
    function questionPolicy() internal pure override returns (bytes memory, uint64, uint64) {
        return (QUESTION_PREFIX, 5_000, 9_000);
    }
}
