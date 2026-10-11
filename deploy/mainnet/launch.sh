#!/usr/bin/env bash
# The mainnet deploy, run by hand, with the deployer's key kept on a RAM disk that is ejected at the end.
#
#   deploy/mainnet/launch.sh go         EVERYTHING, in order, pausing only where you are needed (key, SEND, seeding,
#                                       references); resumes where it stopped; ejects the RAM disk once the vault lands
#
#   The single steps, for a resume by hand or a closer look:
#   deploy/mainnet/launch.sh ramdisk    make the RAM disk and a key file template on it (nothing touches the SSD)
#   deploy/mainnet/launch.sh status     who signs, who governs, what is deployed so far (never prints the key)
#   deploy/mainnet/launch.sh stage1     relay, factories, the three feeds, the oracle asker (runbook 6)
#   deploy/mainnet/launch.sh seed       buy the three first answers through the OracleAsker (1.5 IMD from the deployer
#                                       key) and wait for the Intake to deliver them; skips what is seeded or in flight
#   deploy/mainnet/launch.sh check      verifySeeded: the first values against the pool and an outside reference (runbook 7.2)
#   deploy/mainnet/launch.sh vault      stage two, through MEV Blocker's full-privacy RPC, with a fresh secret salt
#   deploy/mainnet/launch.sh verify     source-verify every contract on Etherscan and Sourcify (deploy/mainnet/verify.py):
#                                       constructor arguments rebuilt from the record and proven first; read-only, no key
#   deploy/mainnet/launch.sh wipe       eject the RAM disk: the key, the salt and the file are gone
#
# The Etherscan API key is read from ETHERSCAN_API_KEY, else the RAM disk's launch.env, else deploy/mainnet/.etherscan.local
# (gitignored: a line ETHERSCAN_API_KEY=...). This repo is public: the key never goes in a tracked file.
#
# The key file is /Volumes/INFERLAUNCH/launch.env. Edit it with `nano` (TextEdit keeps versions; never paste the key
# into a shell prompt, where it would land in history). Every broadcast is simulated first and waits for you to type SEND.
#
# Rehearsal (runbook rehearsal 2): FORK=1 with MAINNET_RPC_URL pointing at a local anvil fork. Fork mode refuses any
# RPC that is not local, and real mode refuses a local one, so a rehearsal cannot reach mainnet by a typo.
#
# The key reaches forge and cast as --private-key: foundry reads it from no environment variable. It is visible
# to processes of the same user while a command runs, which on a single-user laptop is no wider than the file itself.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
cd "$(dirname "$0")/../.."

VOL=INFERLAUNCH; RD=/Volumes/$VOL; ENVF=$RD/launch.env
DEPLOYER=${EXPECTED_DEPLOYER:-0x5167D014a056E43883e1BBEa5530c3c0dC993281}   # miyagod.eth
# Stage two's private endpoint. MEV Blocker by default; PRIVATE_RPC_URL overrides it (e.g. Flashbots Protect,
# https://rpc.flashbots.net/fast) if MEV Blocker rate-limits the broadcast (Cloudflare 1015, seen 2026-10-11).
PRIVATE_RPC=${PRIVATE_RPC_URL:-https://rpc.mevblocker.io/fullprivacy}
SCRIPT=script/DeployMainnet.s.sol
REC=deploy/mainnet/out/deployment.json

die() { echo "launch: $*" >&2; exit 1; }
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }

ramdisk() {
  [ -d "$RD" ] && die "$RD is already mounted. Run 'wipe' first if it is left over from an earlier run."
  local dev; dev=$(hdiutil attach -nomount ram://65536 | awk '{print $1}')   # 32 MB
  diskutil erasevolume HFS+ "$VOL" "$dev" >/dev/null
  touch "$RD/.metadata_never_index"                 # no Spotlight index of the key
  tmutil addexclusion "$RD" >/dev/null 2>&1 || true     # no Time Machine copy
  ( umask 077; cat > "$ENVF" <<'EOT'
# Fill in, save, and leave the editor. This file lives in memory only and is gone at `launch.sh wipe`.
PRIVATE_KEY=
# the cold governance address: must equal APPROVED_OPERATOR in src/DeploymentConfig.sol, and must not be the deployer
OPERATOR=
# your own RPC for reads and stage one (Chainstack etc.). Stage two always goes through MEV Blocker's full-privacy RPC.
MAINNET_RPC_URL=
# filled in at `check` time: IMD's price in wei of ETH per 1e18 IMD from a source the pool cannot be held against,
# and the network health index from api.imd.fun/swarm, 1e18-scaled
REFERENCE_IMD_ETH_WEI=
REFERENCE_NHI=
EOT
  )
  echo "RAM disk ready: $RD ($dev). Now:  nano $ENVF"
}

load() {
  [ -f "$ENVF" ] || die "no $ENVF. Run 'ramdisk' first."
  hdiutil info | grep -q "$RD" || die "$RD is not a disk image mount. The key file must live on the RAM disk."
  set -a; . "$ENVF"; set +a
  [[ "${PRIVATE_KEY:-}" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || die "PRIVATE_KEY is missing or not 32 bytes of hex."
  [[ "$PRIVATE_KEY" == 0x* ]] || PRIVATE_KEY=0x$PRIVATE_KEY
  SIGNER=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null </dev/null | tail -1)
  [ "$(lc "$SIGNER")" = "$(lc "$DEPLOYER")" ] || die "the key signs as $SIGNER, not the deployer $DEPLOYER."
  [ -n "${OPERATOR:-}" ] || die "OPERATOR is empty."
  [ "$(lc "$OPERATOR")" != "$(lc "$SIGNER")" ] || die "OPERATOR is the deployer. Governance must be a different (cold) address."
  local src; src=$(grep -oE 'APPROVED_OPERATOR = 0x[0-9a-fA-F]{40}' src/DeploymentConfig.sol | awk '{print $3}')
  [ "$(lc "$src")" = "$(lc "$OPERATOR")" ] || die "OPERATOR $OPERATOR differs from APPROVED_OPERATOR $src in source. Run plan.py on the release branch first."
  [ -n "${MAINNET_RPC_URL:-}" ] || die "MAINNET_RPC_URL is empty."
  local local_rpc=0; [[ "$MAINNET_RPC_URL" =~ ^https?://(127\.0\.0\.1|localhost)(:|/|$) ]] && local_rpc=1
  if [ "${FORK:-0}" = 1 ]; then
    [ $local_rpc = 1 ] || die "FORK=1 but MAINNET_RPC_URL is not local. A rehearsal must not reach mainnet."
    VAULT_RPC=$MAINNET_RPC_URL; MODE="REHEARSAL (local fork)"
  else
    [ $local_rpc = 0 ] || die "MAINNET_RPC_URL is local. Set FORK=1 for a rehearsal."
    VAULT_RPC=$PRIVATE_RPC; MODE="MAINNET"
  fi
  [ "$(cast chain-id --rpc-url "$MAINNET_RPC_URL" 2>/dev/null </dev/null)" = 1 ] || die "the RPC is not chain 1."
  export OPERATOR FOUNDRY_PROFILE=deploy
}

confirm() {
  echo; echo "[$MODE] $1"; read -r -p "Type SEND to broadcast, anything else to stop: " a
  [ "$a" = SEND ] || die "stopped, nothing sent."
}

basefee() {
  local wei; wei=$(cast base-fee --rpc-url "$MAINNET_RPC_URL" 2>/dev/null </dev/null | tail -1)
  echo "base fee: $(python3 -c "print(f'{$wei/1e9:.3f}')") gwei (the script refuses above ~1.7)"
}

refs() {
  [ -n "${REFERENCE_IMD_ETH_WEI:-}" ] || read -r -p "REFERENCE_IMD_ETH_WEI (wei of ETH per 1e18 IMD): " REFERENCE_IMD_ETH_WEI
  [ -n "${REFERENCE_NHI:-}" ] || read -r -p "REFERENCE_NHI (1e18-scaled): " REFERENCE_NHI
  # Saved to the key file, so the next step (check, then vault, each a fresh process that re-reads it) keeps them.
  sed -i '' -e "s/^REFERENCE_IMD_ETH_WEI=.*/REFERENCE_IMD_ETH_WEI=$REFERENCE_IMD_ETH_WEI/" -e "s/^REFERENCE_NHI=.*/REFERENCE_NHI=$REFERENCE_NHI/" "$ENVF"
  export REFERENCE_IMD_ETH_WEI REFERENCE_NHI
}

case "${1:-}" in
  ramdisk) ramdisk ;;
  status)
    load
    echo "mode      $MODE"; echo "deployer  $SIGNER  ($(cast balance "$SIGNER" --ether --rpc-url "$MAINNET_RPC_URL" </dev/null) ETH)"
    echo "operator  $OPERATOR"
    if git rev-parse --git-dir >/dev/null 2>&1; then
      echo "commit    $(git rev-parse --short HEAD)$(git diff --quiet -- src script || echo ' + UNCOMMITTED src/script changes')"
    else echo "commit    (not a git checkout: a rehearsal copy)"; fi
    basefee; [ -f "$REC" ] && python3 -m json.tool "$REC" | head -40 || echo "no deployment record yet"
    ;;
  stage1)
    load; basefee
    echo "simulating stage one..."
    forge script $SCRIPT --rpc-url "$MAINNET_RPC_URL" --private-key "$PRIVATE_KEY" 2>&1 </dev/null | grep -vE 'Warning|^$' | tail -25
    confirm "Stage one from $SIGNER."
    forge script $SCRIPT --rpc-url "$MAINNET_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow --priority-gas-price 100000000 --timeout 900 </dev/null
    echo; echo "Next: seed the three feeds (buy + relay), then: launch.sh check"
    ;;
  check)
    load; refs
    forge script $SCRIPT --sig "verifySeeded()" --rpc-url "$MAINNET_RPC_URL" </dev/null
    echo; echo "Passed. Next: launch.sh vault"
    ;;
  vault)
    load; refs; basefee
    if [ -z "${VAULT_SALT:-}" ]; then
      VAULT_SALT=0x$(openssl rand -hex 32)
      echo "VAULT_SALT=$VAULT_SALT" >> "$ENVF"          # kept on the RAM disk only, so a stopped run resumes with the same salt
      echo "fresh vault salt written to the RAM disk (not shown)"
    fi
    export VAULT_SALT
    forge script $SCRIPT --sig "verifySeeded()" --rpc-url "$MAINNET_RPC_URL" >/dev/null </dev/null || die "verifySeeded refuses. Do not deploy the vault."
    echo "verifySeeded passes. Stage two goes through $VAULT_RPC (simulation included)."
    confirm "Stage two (the vault) from $SIGNER."
    # The vault's creation uses ~16.1M gas, under EIP-7825's 16,777,216 per-transaction cap, but forge's default 30%
    # estimate margin set a 20.9M limit that mainnet refuses ("gas limit too high", 2026-10-11). 3% keeps it under the
    # cap (16.59M); DeployMainnet already requires the real usage to stay below it. Anvil enforces no cap, so only
    # mainnet showed this.
    forge script $SCRIPT --sig "runVault()" --rpc-url "$VAULT_RPC" --private-key "$PRIVATE_KEY" --broadcast --slow --priority-gas-price 100000000 --gas-estimate-multiplier 103 --timeout 900 </dev/null
    echo; echo "Next: Claude reads everything back; you send 5 IMD to the OracleAsker; then launch.sh wipe"
    ;;
  go)
    [ -d "$RD" ] || "$0" ramdisk
    if ! grep -qE '^PRIVATE_KEY=.+' "$ENVF"; then
      echo; echo "Opening the key file. Fill in PRIVATE_KEY, OPERATOR and MAINNET_RPC_URL, save (ctrl-O, Enter) and exit (ctrl-X)."
      read -r -p "Press Enter to open it: " _; ${EDITOR:-nano} "$ENVF"
    fi
    "$0" status
    rec() { python3 -c "import json,sys; d=json.load(open('$REC')); print(d.get('$1') or '')" 2>/dev/null || true; }
    # Stage one, unless its record is here and its contracts have code on this chain.
    PF=$(rec priceFeed)
    if [ -n "$PF" ] && [ "$(cast code "$PF" --rpc-url "$(. "$ENVF"; echo "$MAINNET_RPC_URL")" 2>/dev/null </dev/null | wc -c)" -gt 10 ]; then
      echo; echo "stage one: already deployed (price feed $PF), skipping"
    else
      "$0" stage1
    fi
    # Stage two, unless the record's vault has code on this chain: a broadcast that failed after forge's simulation
    # still writes the vault into the record (2026-10-11: MEV Blocker refused the send, the record named a vault, and
    # a rerun skipped stage two and wiped the salt). Code on chain is the only proof the vault exists.
    V=$(rec vault)
    if [ -z "$V" ] || [ "$(cast code "$V" --rpc-url "$(. "$ENVF"; echo "$MAINNET_RPC_URL")" 2>/dev/null </dev/null | wc -c)" -le 10 ]; then
      echo
      if [ -n "${SEED_HOOK:-}" ]; then
        echo "seeding with: $SEED_HOOK"; $SEED_HOOK </dev/null
      else
        "$0" seed
      fi
      "$0" check
      "$0" vault
    else
      echo; echo "stage two: the vault is already deployed ($V, it has code), skipping"
    fi
    # Source verification while the vault's salt is still on the RAM disk. It never blocks the wipe: a failure is
    # printed and `launch.sh verify` can be run again at any time.
    echo; "$0" verify || echo "launch: verification did not finish; run 'deploy/mainnet/launch.sh verify' again later"
    "$0" wipe
    echo; echo "Done. Next (runbook step 6): keeper install + execute, 5 IMD to the OracleAsker, propose the reserve asset."
    ;;
  seed)
    # The first answers, bought by the deployer key through the OracleAsker stage one deployed: askPaidMany pays the
    # Intake for every feed that has no value and nothing in flight, and the Intake's callback relays each answer into
    # its feed. A request the plane refuses comes back through onOracleFailure, which frees the feed to be bought again.
    load
    [ -f "$REC" ] || die "no deployment record: run stage one first"
    rec() { python3 -c "import json; print(json.load(open('$REC'))['$1'])"; }
    ASK=$(rec oracleAsker); IMD=$(rec imd 2>/dev/null || echo 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7)
    [ "$(cast code "$ASK" --rpc-url "$MAINNET_RPC_URL" </dev/null 2>/dev/null | wc -c)" -gt 10 ] || die "no OracleAsker at $ASK: run stage one first"
    c() { cast call "$@" --rpc-url "$MAINNET_RPC_URL" </dev/null 2>/dev/null | head -1 | awk '{print $1}'; }
    FEEDS=(); BODIES=(); ROLES=()
    for role in price nhi spot; do
      f=$(rec ${role}Feed); body="deploy/mainnet/out/bodies/$role.json"
      [ -f "$body" ] || die "no $body: stage one writes it"
      v=$(c "$f" "latestValue()(uint256,uint64)")
      inflight=$(cast call "$ASK" "feeds(address)(bytes32,bool,bool,uint64,uint64,uint64,bool,bytes32)" "$f" --rpc-url "$MAINNET_RPC_URL" </dev/null 2>/dev/null | tail -1)
      stale=$(cast call "$f" "isStale()(bool)" --rpc-url "$MAINNET_RPC_URL" </dev/null 2>/dev/null | head -1)
      if [ "$v" != "0" ] && [ "$stale" != "true" ]; then echo "  $role: seeded ($v)"; continue; fi
      if [ "$inflight" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then echo "  $role: request in flight ($inflight)"; continue; fi
      FEEDS+=("$f"); BODIES+=("$(cast from-utf8 "$(cat "$body")")"); ROLES+=("$role")
    done
    if [ ${#FEEDS[@]} -gt 0 ]; then
      EACH=$(c "$ASK" "price()(uint256)"); NEED=$((${#FEEDS[@]})); TOTAL=$(python3 -c "print($EACH*$NEED)")
      HAVE=$(c "$IMD" "balanceOf(address)(uint256)" "$SIGNER")
      python3 -c "import sys; sys.exit(0 if $HAVE >= $TOTAL else 1)" || die "the deployer holds $(python3 -c "print($HAVE/1e18)") IMD; seeding needs $(python3 -c "print($TOTAL/1e18)")"
      echo; echo "seed: ${ROLES[*]} for $(python3 -c "print($TOTAL/1e18)") IMD ($(python3 -c "print($EACH/1e18)") each) through the OracleAsker $ASK"
      confirm "Approve $(python3 -c "print($TOTAL/1e18)") IMD to the OracleAsker and buy the first answers."
      cast send "$IMD" "approve(address,uint256)" "$ASK" "$TOTAL" --private-key "$PRIVATE_KEY" --rpc-url "$MAINNET_RPC_URL" </dev/null >/dev/null || die "approve failed"
      FL="[$(IFS=,; echo "${FEEDS[*]}")]"; BL="[$(IFS=,; echo "${BODIES[*]}")]"
      cast send "$ASK" "askPaidMany(address[],bytes[],uint256)" "$FL" "$BL" "$EACH" --private-key "$PRIVATE_KEY" --rpc-url "$MAINNET_RPC_URL" </dev/null >/dev/null || die "askPaidMany failed"
      cast send "$IMD" "approve(address,uint256)" "$ASK" 0 --private-key "$PRIVATE_KEY" --rpc-url "$MAINNET_RPC_URL" </dev/null >/dev/null || true
      echo "  bought: the panels answer in minutes; the Intake relays each answer into its feed"
    fi
    # Wait for every feed to hold a value. SEED_WAIT_MINUTES=0 returns at once (a rehearsal, where no plane delivers).
    WAIT=${SEED_WAIT_MINUTES:-90}; start=$(date +%s)
    while :; do
      left=""; for role in price nhi spot; do f=$(rec ${role}Feed); { [ "$(c "$f" "latestValue()(uint256,uint64)")" = "0" ] || [ "$(c "$f" "isStale()(bool)")" = "true" ]; } && left="$left $role"; done
      [ -z "$left" ] && { echo "  all three feeds hold their first answers"; break; }
      [ "$WAIT" = 0 ] && { echo "  still waiting on:$left (not waiting: SEED_WAIT_MINUTES=0)"; break; }
      [ $(( $(date +%s) - start )) -ge $(( WAIT * 60 )) ] && die "still waiting on:$left after $WAIT minutes. Run 'launch.sh seed' again: it waits on what is in flight and re-buys what the plane refused"
      echo "  waiting on:$left ($(( ($(date +%s) - start) / 60 )) min)"; sleep 30
    done
    ;;
  verify)
    # Read-only: the RPC from launch.env when the RAM disk is up, else VERIFY_RPC_URL, else a public one. The vault's
    # secret salt (still on the RAM disk inside `go`) lets its address be re-derived too; without it that one proof
    # is skipped and Etherscan still checks the arguments itself.
    [ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
    [ -f deploy/mainnet/.etherscan.local ] && [ -z "${ETHERSCAN_API_KEY:-}" ] && { set -a; . deploy/mainnet/.etherscan.local; set +a; }
    RPC=${VERIFY_RPC_URL:-${MAINNET_RPC_URL:-https://ethereum-rpc.publicnode.com}}
    [ -f "$REC" ] || die "no deployment record"
    if [ "${FORK:-0}" = 1 ]; then
      python3 deploy/mainnet/verify.py --rpc "$RPC"                       # a rehearsal proves the arguments only
    else
      [ -n "${ETHERSCAN_API_KEY:-}" ] || die "no ETHERSCAN_API_KEY (deploy/mainnet/.etherscan.local or launch.env)"
      python3 deploy/mainnet/verify.py --rpc "$RPC" --submit
    fi
    ;;
  wipe)
    [ -d "$RD" ] || { echo "no RAM disk mounted: nothing to wipe"; exit 0; }
    diskutil eject force "$RD" >/dev/null && echo "ejected $RD: the key file is gone" || die "eject failed; close anything using $RD and run wipe again"
    # forge keeps the RPC URL of every broadcast in cache/ ("sensitive values"); a provider URL can carry an API key.
    rm -f cache/DeployMainnet.s.sol/*/run-*.json && echo "removed forge's cached RPC URLs"
    ;;
  *) sed -n 2,13p "$0"; exit 1 ;;
esac
