#!/usr/bin/env python3
"""Safe Transaction Builder files that install PaidOraclePilot, and a fork proof of the whole install.

    python3 pilot/safe-files.py                     pilot from pilot/deployment.json -> pilot/out/safe/*.json
    python3 pilot/safe-files.py --pilot 0x..        any address
    python3 pilot/safe-files.py --fork <mainnet rpc>  also prove it: anvil fork, deploy a pilot if none, run file 1 as
                                                    the Safe, +48 h, applyPending, run file 2, +48 h, applyPending,
                                                    check the vault reads the pilot and the wage is 1

Parameters has ONE pending slot, so the two are SEQUENTIAL: sign file 1 (proposeWorkOracle) -> 48 h -> anyone calls
Parameters.applyPending() -> sign file 2 (proposeWage(1)) -> 48 h -> applyPending(). File 2 signed early reverts
ProposalPending. Load each at app.safe.global -> Apps -> Transaction Builder -> drag and drop; 2 of 3 signatures.
"""
import argparse, json, os, subprocess, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SAFE = "0xbeFd108085613662356aa26A2466Ad3426DA9C32"
PARAMS = "0x3D96A6Ffada9C2E5B8fF8eb3f8AFB360116dA881"
VAULT = "0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82"
DEPLOYER = "0x5167D014a056E43883e1BBEa5530c3c0dC993281"
ENV = {**os.environ, "FOUNDRY_DISABLE_NIGHTLY_WARNING": "1"}


def sh(*a):
    r = subprocess.run(a, cwd=ROOT, capture_output=True, text=True, env=ENV)
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(a[:3])}: {(r.stderr or r.stdout).strip()[-400:]}")
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""


def builder(name, desc, to, data):
    return {"version": "1.0", "chainId": "1", "createdAt": int(time.time() * 1000),
            "meta": {"name": name, "description": desc, "txBuilderVersion": "1.18.0",
                     "createdFromSafeAddress": SAFE, "createdFromOwnerAddress": ""},
            "transactions": [{"to": to, "value": "0", "data": data, "contractMethod": None, "contractInputsValues": None}]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pilot")
    ap.add_argument("--fork")
    a = ap.parse_args()
    pilot = a.pilot
    dep = os.path.join(ROOT, "pilot/deployment.json")
    if not pilot and os.path.exists(dep):
        pilot = json.load(open(dep))["pilot"]

    port, anvil = 8549, None
    if a.fork:
        anvil = subprocess.Popen(["anvil", "--fork-url", a.fork, "--port", str(port), "--silent"], env=ENV)
        time.sleep(6)
    rpc = f"http://127.0.0.1:{port}" if a.fork else None
    try:
        if a.fork and not pilot:
            # No deployment yet: deploy one on the fork the way pilot/deploy.sh will on mainnet.
            sh("cast", "rpc", "anvil_impersonateAccount", DEPLOYER, "--rpc-url", rpc)
            out = subprocess.run(["forge", "script", "script/DeployPilot.s.sol", "--rpc-url", rpc, "--sender", DEPLOYER,
                                  "--unlocked", "--broadcast"], cwd=ROOT, capture_output=True, text=True,
                                 env={**ENV, "POSTER": "0x292039c6C5dC3D20c8438Aa8A35C61D2113dc4B0"})
            pilot = [l.split()[-1] for l in out.stdout.splitlines() if l.strip().startswith("PaidOraclePilot")][0]
            print("fork: deployed a pilot at", pilot)
        if not pilot:
            raise SystemExit("no pilot: run pilot/deploy.sh --broadcast first, or pass --pilot / --fork")

        d1 = sh("cast", "calldata", "proposeWorkOracle(address)", pilot)
        d2 = sh("cast", "calldata", "proposeWage(uint256)", "1")
        f1 = builder("Paid-oracle pilot 1/2: propose it as the work oracle",
                     f"Parameters({PARAMS}).proposeWorkOracle(PaidOraclePilot {pilot}). Wage is 0, so this is allowed. "
                     "48 h timelock, then ANYONE calls Parameters.applyPending(); from then the vault reads the pilot's "
                     "minting rights (none exist outside pay). Then sign file 2. Audits 3d5324e9 + d516fafb, all fixed "
                     "(infer-protocol feat/work-pilot f88177e). Fork-proven with pilot/safe-files.py --fork.",
                     PARAMS, d1)
        f2 = builder("Paid-oracle pilot 2/2: wage 1 (the vault's on switch)",
                     f"Parameters({PARAMS}).proposeWage(1). SIGN ONLY AFTER file 1 has been applied (one pending slot: "
                     "otherwise it reverts ProposalPending). 48 h, then applyPending(). The wage is only the on switch: "
                     "the pilot prices nothing by it (1.5 imdUSD per Intake-paid oracle request, 350/epoch, 3,000 lifetime, "
                     "24 h Safe veto per epoch). Back to 0 turns minting off.",
                     PARAMS, d2)
        outd = os.path.join(ROOT, "pilot/out/safe")
        os.makedirs(outd, exist_ok=True)
        for n, f in (("pilot-1-propose-work-oracle.json", f1), ("pilot-2-propose-wage-1.json", f2)):
            json.dump(f, open(os.path.join(outd, n), "w"), indent=1)
            print("wrote", os.path.join("pilot/out/safe", n))

        if a.fork:
            def as_safe(data):
                sh("cast", "send", PARAMS, data, "--from", SAFE, "--unlocked", "--rpc-url", rpc)
            def warp():
                sh("cast", "rpc", "evm_increaseTime", "172801", "--rpc-url", rpc)
                sh("cast", "rpc", "evm_mine", "--rpc-url", rpc)
            sh("cast", "rpc", "anvil_impersonateAccount", SAFE, "--rpc-url", rpc)
            sh("cast", "rpc", "anvil_setBalance", SAFE, "0xde0b6b3a7640000", "--rpc-url", rpc)
            as_safe(d1)
            early = subprocess.run(["cast", "send", PARAMS, d2, "--from", SAFE, "--unlocked", "--rpc-url", rpc],
                                   capture_output=True, text=True, env=ENV)
            assert early.returncode != 0, "file 2 before file 1 is applied must revert"
            warp(); sh("cast", "send", PARAMS, "applyPending()", "--from", SAFE, "--unlocked", "--rpc-url", rpc)
            oracle = sh("cast", "call", VAULT, "oracle()(address)", "--rpc-url", rpc)
            assert oracle.lower() == pilot.lower(), f"vault reads {oracle}"
            as_safe(d2)
            warp(); sh("cast", "send", PARAMS, "applyPending()", "--from", SAFE, "--unlocked", "--rpc-url", rpc)
            wage = sh("cast", "call", PARAMS, "wage()(uint256)", "--rpc-url", rpc)
            assert wage.split()[0] == "1", f"wage {wage}"
            gov = sh("cast", "call", pilot, "governor()(address)", "--rpc-url", rpc)
            print(f"fork proof OK: vault.oracle() = pilot, wage = 1, pilot.governor() = {gov}; file 2 early reverted")
    finally:
        if anvil:
            anvil.terminate()


if __name__ == "__main__":
    main()
