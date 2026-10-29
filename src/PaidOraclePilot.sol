// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWorkOracle} from "./interfaces/IWorkOracle.sol";
import {TransientReentrancyGuard} from "./TransientReentrancyGuard.sol";

interface IPilotVault {
    function earn(uint256 amount) external;
    function stablecoin() external view returns (address);
    function parameters() external view returns (address);
}

interface IPilotGoverned {
    function governor() external view returns (address);
}

/// @dev The plane's ERC-8004 adapter. An agent is bound to one token; its controller is that token's holder.
interface IPilotAdapter {
    struct Binding {
        uint8 standard; // 0 = ERC721, 1 = ERC1155, 2 = ERC6909
        address tokenContract;
        uint256 tokenId;
    }

    function bindingOf(uint256 agentId) external view returns (Binding memory);
}

interface IPilotOwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice A capped, time-boxed pilot of minting imdUSD for swarm work: agents who answer a PAID oracle
/// request share a fixed bonus per request, pushed to them with no action on their part.
///
/// WHY ONLY PAID ORACLE REQUESTS, AND WHY THROUGH THE INTAKE. A request paid through the on-chain Intake
/// leaves its request id on chain (`Completed`'s uri), and the plane's daily receipt, pinned to IPFS and
/// anchored by `WorkRegistry.latest`, names every oracle job of the day; each job's frozen document names
/// the agents its acceptance credited. So "which agents did paid oracle work" is rebuildable by anyone from
/// chain + IPFS. Paid premium jobs and x402-paid requests are not (their payer lives only in the plane's
/// live API), which is why they are out of the pilot.
///
/// WHAT IS TRUSTED. The root of each epoch is posted by `poster`, built by a published script from those
/// public inputs. It is not verified on chain. What bounds a wrong root: EPOCH_CAP per epoch, at most one
/// epoch per MIN_EPOCH_GAP, LIFETIME_CAP in all, and a VETO_WINDOW in which the protocol's governor can
/// strike it before anything is payable. The vault's own `earnLine` bounds everything minted from work
/// on top of that. Windows are contiguous (`nextFromBlock`) and end at or before the current block, so a
/// typo cannot skip paid work or close the pilot.
///
/// WHO HOLDS WHAT POWER (audit 3d5324e9, info). The governor (the protocol Safe) is the only vetoer and
/// may appoint itself poster, so the Safe alone can direct up to LIFETIME_CAP, 350 at a time; it can
/// also veto every honest epoch (denial of service, not theft). A compromised poster alone gets an epoch
/// paid only if the Safe misses its 24 h window, bounded by the caps. The plane's adapter is a third
/// trusted party: its upgrader decides who controls each agent, so it decides every recipient.
///
/// HOW IT ENDS. Shares are payable only while this is the vault's work oracle and the wage is nonzero:
/// at wage 0 `earn` refuses, and after a successor is installed the vault reads the successor's rights.
/// So pay every posted epoch out before turning the pilot off; `retire` releases an epoch that cannot
/// be paid. This contract answers no `predecessor()`: once it has minted, its successor must be a new
/// contract that names it (Parameters enforces that).
///
/// HOW MINTING WORKS. This contract is the only holder of minting rights it ever reports, and only inside
/// `pay`: it authorises exactly the batch total, calls `vault.earn`, which consumes exactly that, and
/// forwards each share to the agent's controller. Outside `pay` it reports no rights for anyone, so no
/// standing credit exists to be spent by anyone else, at any time. `earn` needs fresh, agreeing feeds,
/// so a batch is paid in a window after a price update; nothing is lost while feeds are stale.
///
/// HOW IT IS INSTALLED. `Parameters.proposeWorkOracle(this)` while the wage is zero, then a nonzero wage.
/// The wage is the vault's on switch only: this contract prices nothing by it.
contract PaidOraclePilot is IWorkOracle, TransientReentrancyGuard {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error InvalidVault();
    error InvalidRoot();
    error OverEpochCap();
    error OverLifetimeCap();
    error TooSoon();
    error WindowNotContiguous(uint64 expected);
    error WindowInFuture();
    error EpochRetired();
    error TooEarlyToRetire();
    error UnknownEpoch();
    error EpochVetoed();
    error VetoWindowOpen();
    error VetoWindowClosed();
    error LengthMismatch();
    error BadProof();
    error OverEpochTotal();
    error NothingToPay();
    error InvalidAccount();
    error InsufficientRights();
    error InvalidFirstBlock();
    error PaidRecently();

    event PosterSet(address indexed poster);
    event EpochProposed(
        uint256 indexed epoch, bytes32 root, uint256 total, uint64 fromBlock, uint64 toBlock, string uri
    );
    event EpochVetoedBy(uint256 indexed epoch, address indexed governor);
    event EpochRetiredBy(uint256 indexed epoch, address indexed governor, uint256 released);
    event Paid(uint256 indexed epoch, uint256 indexed agentId, address indexed recipient, uint256 amount);
    event Unpayable(uint256 indexed epoch, uint256 indexed agentId);
    event RightsConsumed(address indexed account, uint256 amount);

    /// @notice The bonus each paid request shares among the agents its acceptance credited. Informational:
    /// the posted totals are built from it, and the caps below are what the contract enforces.
    uint256 public constant BONUS_PER_REQUEST = 1.5e18;
    uint256 public constant EPOCH_CAP = 350e18;
    uint256 public constant LIFETIME_CAP = 3_000e18;
    uint256 public constant MIN_EPOCH_GAP = 6 days;
    uint256 public constant VETO_WINDOW = 24 hours;
    /// @notice How long after posting the governor may retire an epoch's unpaid remainder, giving its cap back.
    uint256 public constant RETIRE_AFTER = 30 days;
    /// @dev Gas allowed to each binding lookup: a binding's token contract is not ours, so it gets a stipend,
    /// and a lookup that fails or runs out leaves that share unpaid (and payable later) instead of the batch.
    uint256 private constant LOOKUP_GAS = 60_000;

    IPilotAdapter public constant ADAPTER = IPilotAdapter(0xde152AfB7db5373F34876E1499fbD893A82dD336);

    /// @notice The only consumer of rights.
    address public immutable vault;
    IERC20 public immutable stablecoin;

    address public poster;

    struct Epoch {
        bytes32 root;
        uint128 total;
        uint128 paid;
        uint64 fromBlock;
        uint64 toBlock;
        uint40 proposedAt;
        bool vetoed;
        bool retired;
        uint40 lastPaidAt;
    }

    Epoch[] private _epochs;
    /// @notice Sum of the totals of every epoch not vetoed: what this pilot can ever mint.
    uint256 public totalCommitted;
    /// @notice Everything minted through this pilot.
    uint256 public totalPaid;
    mapping(uint256 epoch => mapping(uint256 agentId => bool)) public paidOut;
    /// @notice The block the next epoch's window must start at: windows are contiguous, so no block of paid
    /// work is skipped and none is counted twice. A veto hands the struck window back.
    uint64 public nextFromBlock;

    /// @dev Rights authorised for the batch in progress; zero outside `pay`.
    uint256 private _authorised;

    /// @param firstFromBlock The first block the pilot counts paid work from; at most the current block, so the
    /// first window can always be posted (there is no setter for it; audit d516fafb, info).
    constructor(address vault_, address poster_, uint64 firstFromBlock) {
        if (vault_ == address(0) || vault_.code.length == 0) revert InvalidVault();
        if (firstFromBlock > block.number) revert InvalidFirstBlock();
        vault = vault_;
        stablecoin = IERC20(IPilotVault(vault_).stablecoin());
        poster = poster_;
        nextFromBlock = firstFromBlock;
        emit PosterSet(poster_);
    }

    // ------------------------------------------------------------------ governance

    /// @notice The protocol's governor, read live from the vault's Parameters: no authority is stored here.
    function governor() public view returns (address) {
        return IPilotGoverned(IPilotVault(vault).parameters()).governor();
    }

    modifier onlyGovernor() {
        if (msg.sender != governor()) revert Unauthorized();
        _;
    }

    /// @notice Replace the poster; zero stops new epochs. Posted epochs stay payable only while this is the
    /// vault's work oracle and the wage is nonzero: pay them out before turning the pilot off.
    function setPoster(address next) external onlyGovernor {
        poster = next;
        emit PosterSet(next);
    }

    /// @notice Strike an epoch before it becomes payable, and hand its window back to be recounted.
    /// @dev Only the latest epoch can be inside its window (VETO_WINDOW < MIN_EPOCH_GAP), so the window it
    /// hands back is always the one `nextFromBlock` moved past.
    function veto(uint256 epoch) external onlyGovernor {
        Epoch storage e = _epoch(epoch);
        if (e.vetoed) revert EpochVetoed();
        if (block.timestamp >= uint256(e.proposedAt) + VETO_WINDOW) revert VetoWindowClosed();
        e.vetoed = true;
        totalCommitted -= e.total;
        nextFromBlock = e.fromBlock;
        emit EpochVetoedBy(epoch, msg.sender);
    }

    /// @notice Release an epoch's unpaid remainder from the lifetime cap, RETIRE_AFTER after posting; its
    /// shares can no longer be paid. For an epoch that cannot be paid (a mistaken root, agents who never
    /// bind a seat).
    /// @dev TRUST (audit d516fafb, info): this is a governor power over any epoch at least RETIRE_AFTER old,
    /// and it ends that epoch's unpaid shares, valid or not. It cannot pay anyone and cannot run within
    /// VETO_WINDOW of a batch being paid, so an epoch being paid out in batches is not cut off mid-way.
    /// THE WINDOW (audit d516fafb, low): if nothing of the epoch was ever paid and it is the latest epoch,
    /// its window is handed back exactly as a veto does, so a corrected root can recount it with no risk of
    /// paying anything twice. Otherwise the window stays counted (a recount could pay a share twice, and a
    /// later epoch has already started after it).
    function retire(uint256 epoch) external onlyGovernor {
        Epoch storage e = _epoch(epoch);
        if (e.vetoed) revert EpochVetoed();
        if (e.retired) revert EpochRetired();
        if (block.timestamp < uint256(e.proposedAt) + RETIRE_AFTER) revert TooEarlyToRetire();
        if (e.lastPaidAt != 0 && block.timestamp < uint256(e.lastPaidAt) + VETO_WINDOW) revert PaidRecently();
        e.retired = true;
        uint256 released = uint256(e.total) - e.paid;
        totalCommitted -= released;
        if (e.paid == 0 && epoch == _epochs.length - 1) nextFromBlock = e.fromBlock;
        emit EpochRetiredBy(epoch, msg.sender, released);
    }

    // ------------------------------------------------------------------ epochs

    /// @notice Post an epoch's tally root. Leaves are (epoch, agentId, amount) under the OpenZeppelin
    /// StandardMerkleTree encoding; `epoch` is `epochCount()` at the time of posting.
    /// @param fromBlock First block of Intake `Completed` events counted (inclusive); must be `nextFromBlock`.
    /// @param toBlock Last block counted (inclusive), before the current block; the next epoch starts after it.
    /// @param uri Where the tally, its inputs and the script that built it are published.
    function propose(bytes32 root, uint256 total, uint64 fromBlock, uint64 toBlock, string calldata uri)
        external
        returns (uint256 epoch)
    {
        if (msg.sender != poster || poster == address(0)) revert Unauthorized();
        if (root == bytes32(0) || total == 0 || toBlock < fromBlock) revert InvalidRoot();
        if (toBlock >= block.number) revert WindowInFuture();
        if (fromBlock != nextFromBlock) revert WindowNotContiguous(nextFromBlock);
        if (total > EPOCH_CAP) revert OverEpochCap();
        if (totalCommitted + total > LIFETIME_CAP) revert OverLifetimeCap();
        epoch = _epochs.length;
        if (epoch != 0) {
            Epoch storage last = _epochs[epoch - 1];
            if (block.timestamp < uint256(last.proposedAt) + MIN_EPOCH_GAP) revert TooSoon();
        }
        _epochs.push(
            Epoch({
                root: root,
                total: uint128(total),
                paid: 0,
                fromBlock: fromBlock,
                toBlock: toBlock,
                proposedAt: uint40(block.timestamp),
                vetoed: false,
                retired: false,
                lastPaidAt: 0
            })
        );
        totalCommitted += total;
        nextFromBlock = toBlock + 1; // toBlock < block.number, so this cannot overflow
        emit EpochProposed(epoch, root, total, fromBlock, toBlock, uri);
    }

    function epochCount() external view returns (uint256) {
        return _epochs.length;
    }

    function epochs(uint256 epoch) external view returns (Epoch memory) {
        return _epoch(epoch);
    }

    /// @notice Whether an epoch's shares can be paid now (feeds permitting).
    function isPayable(uint256 epoch) public view returns (bool) {
        if (epoch >= _epochs.length) return false;
        Epoch storage e = _epochs[epoch];
        return !e.vetoed && !e.retired && block.timestamp >= uint256(e.proposedAt) + VETO_WINDOW;
    }

    // ------------------------------------------------------------------ payment

    /// @notice Mint and push a batch of an epoch's shares. Anyone may call it; shares go only to each
    /// agent's current controller. Shares already paid, or whose controller cannot be resolved, are skipped.
    function pay(uint256 epoch, uint256[] calldata agentIds, uint256[] calldata amounts, bytes32[][] calldata proofs)
        external
        nonReentrant
        returns (uint256 sum)
    {
        if (agentIds.length != amounts.length || agentIds.length != proofs.length) revert LengthMismatch();
        Epoch storage e = _epoch(epoch);
        if (e.vetoed) revert EpochVetoed();
        if (e.retired) revert EpochRetired();
        if (block.timestamp < uint256(e.proposedAt) + VETO_WINDOW) revert VetoWindowOpen();

        address[] memory to;
        (to, sum) = _resolve(epoch, e.root, agentIds, amounts, proofs);
        if (sum == 0) revert NothingToPay();
        if (uint256(e.paid) + sum > e.total) revert OverEpochTotal();
        e.paid += uint128(sum);
        e.lastPaidAt = uint40(block.timestamp);
        totalPaid += sum;

        _authorised = sum;
        IPilotVault(vault).earn(sum);
        if (_authorised != 0) revert InsufficientRights(); // the vault consumed exactly the batch

        _push(epoch, agentIds, amounts, to);
    }

    /// @notice Who an agent's share goes to: the holder of the ERC-721 token the agent is bound to, or zero
    /// if the agent is unknown, bound to another standard, or its token's owner cannot be read.
    /// @dev TRUST: the adapter is the plane's upgradeable proxy, so its upgrader decides every recipient.
    /// Every answer is read as raw words and range-checked, never `abi.decode`d into narrow types, so a
    /// malformed answer skips that one share instead of reverting the batch.
    function controllerOf(uint256 agentId) public view returns (address) {
        (bool ok, bytes memory data) =
            address(ADAPTER).staticcall{gas: LOOKUP_GAS}(abi.encodeCall(IPilotAdapter.bindingOf, (agentId)));
        if (!ok || data.length < 96) return address(0);
        (uint256 standard, uint256 tokenWord, uint256 tokenId) = abi.decode(data, (uint256, uint256, uint256));
        if (standard != 0 || tokenWord >> 160 != 0) return address(0);
        address tokenContract = address(uint160(tokenWord));
        if (tokenContract.code.length == 0) return address(0);
        (ok, data) = tokenContract.staticcall{gas: LOOKUP_GAS}(abi.encodeCall(IPilotOwnerOf.ownerOf, (tokenId)));
        if (!ok || data.length != 32) return address(0);
        uint256 word = abi.decode(data, (uint256));
        if (word >> 160 != 0) return address(0);
        return address(uint160(word));
    }

    // ------------------------------------------------------------------ IWorkOracle

    /// @notice Nonzero only for this contract, and only inside `pay`.
    function mintingRights(address account) external view override returns (uint256) {
        return account == address(this) ? _authorised : 0;
    }

    /// @notice Vault only, and only the batch in progress.
    function consumeRights(address account, uint256 amount) external override {
        if (msg.sender != vault) revert Unauthorized();
        if (account != address(this)) revert InvalidAccount();
        uint256 authorised = _authorised;
        if (amount == 0 || amount > authorised) revert InsufficientRights();
        _authorised = authorised - amount;
        emit RightsConsumed(account, amount);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Verify each share, skip the already paid and the unresolvable, and mark the rest paid.
    function _resolve(
        uint256 epoch,
        bytes32 root,
        uint256[] calldata agentIds,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) private returns (address[] memory to, uint256 sum) {
        mapping(uint256 => bool) storage done = paidOut[epoch];
        to = new address[](agentIds.length);
        for (uint256 i; i < agentIds.length; ++i) {
            if (done[agentIds[i]]) continue;
            _check(epoch, root, agentIds[i], amounts[i], proofs[i]);
            address recipient = controllerOf(agentIds[i]);
            if (recipient == address(0)) {
                emit Unpayable(epoch, agentIds[i]);
                continue;
            }
            done[agentIds[i]] = true;
            to[i] = recipient;
            sum += amounts[i];
        }
    }

    function _check(uint256 epoch, bytes32 root, uint256 agentId, uint256 amount, bytes32[] calldata proof)
        private
        pure
    {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epoch, agentId, amount))));
        if (!_verify(proof, root, leaf)) revert BadProof();
    }

    function _push(uint256 epoch, uint256[] calldata agentIds, uint256[] calldata amounts, address[] memory to)
        private
    {
        for (uint256 i; i < agentIds.length; ++i) {
            if (to[i] == address(0)) continue;
            stablecoin.safeTransfer(to[i], amounts[i]);
            emit Paid(epoch, agentIds[i], to[i], amounts[i]);
        }
    }

    function _epoch(uint256 epoch) private view returns (Epoch storage) {
        if (epoch >= _epochs.length) revert UnknownEpoch();
        return _epochs[epoch];
    }

    /// @dev Sorted-pair Merkle proof, the encoding OpenZeppelin's StandardMerkleTree produces.
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
}
