#!/usr/bin/env bash
# Deploy PaidOraclePilot from miyagod.eth and verify it. YOU run this: it asks for the deployer key itself
# (typed, not echoed, never written to disk). Then: python3 pilot/safe-files.py  (builds + fork-proves the Safe files)
#   pilot/deploy.sh                 simulate only
#   pilot/deploy.sh --broadcast     send + verify
set -euo pipefail
cd "$(dirname "$0")/.."
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
DEPLOYER=0x5167D014a056E43883e1BBEa5530c3c0dC993281      # miyagod.eth
POSTER=0x292039c6C5dC3D20c8438Aa8A35C61D2113dc4B0        # key on the keeper box: /home/keeper/pilot/poster.key
RPC=${MAINNET_RPC_URL:-https://rpc.mevblocker.io}
ESKEY=$(cat ../infer-release/deploy/mainnet/.etherscan.local 2>/dev/null || true)
read -r -s -p "miyagod.eth private key: " PK; echo
[[ "$PK" == 0x* ]] || PK=0x$PK
SIGNER=$(cast wallet address --private-key "$PK" 2>/dev/null | tail -1)
[ "$(echo "$SIGNER" | tr A-F a-f)" = "$(echo "$DEPLOYER" | tr A-F a-f)" ] || { echo "the key signs as $SIGNER, not $DEPLOYER"; exit 1; }
EXTRA=()
if [ "${1:-}" = "--broadcast" ]; then
  EXTRA=(--broadcast --slow --priority-gas-price 100000000)
  [ -n "$ESKEY" ] && EXTRA+=(--verify --etherscan-api-key "$ESKEY")
fi
POSTER=$POSTER forge script script/DeployPilot.s.sol --rpc-url "$RPC" --private-key "$PK" "${EXTRA[@]}" 2>&1 | grep -vE "^Warning|^$"
unset PK
if [ "${1:-}" = "--broadcast" ]; then
  ADDR=$(python3 -c "import json;r=json.load(open('broadcast/DeployPilot.s.sol/1/run-latest.json'));print([t['contractAddress'] for t in r['transactions'] if t['transactionType']=='CREATE'][0])")
  BLOCK=$(python3 -c "import json;r=json.load(open('broadcast/DeployPilot.s.sol/1/run-latest.json'));print(int(r['receipts'][0]['blockNumber'],16))")
  FIRST=$(cast call "$ADDR" "nextFromBlock()(uint64)" --rpc-url "$RPC")
  printf '{"pilot":"%s","deployBlock":%s,"firstFromBlock":%s,"poster":"%s","vault":"0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82"}\n' "$ADDR" "$BLOCK" "$FIRST" "$POSTER" > pilot/deployment.json
  cat pilot/deployment.json
  python3 pilot/safe-files.py --pilot "$ADDR"   # the two Safe files, for THIS address
  echo "Next: sign pilot/out/safe/pilot-1-propose-work-oracle.json in the Safe; 48 h later anyone calls applyPending(); then file 2."
fi
