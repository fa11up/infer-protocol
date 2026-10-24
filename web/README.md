# COMP terminal

A static Vite / React / TypeScript terminal for the attested application deployment. Wallet transport and ABI calls use viem. There is no backend, hosted font, WalletConnect project ID, or private credential. Use an injected EIP-1193 browser wallet. The application is an `evm_contracts` deployment with no trading pool; there is no invented swap or liquidity flow.

## Run and rebuild

From the repository root, with Node 22 or newer:

```sh
npm ci --prefix web
npm run --prefix web typecheck
npm run --prefix web build
npm run --prefix web check:export
npm test --prefix web
npm exec --prefix web -- playwright install chromium
npm run --prefix web test:browser
npm run --prefix web preview
```

Dependencies are locked in `web/package-lock.json`. Installation needs npm access or a populated local cache; the build itself makes no network requests. On a worker with a read-only home, append `--cache /tmp/comp-npm-cache` to npm installation commands, and use `PLAYWRIGHT_BROWSERS_PATH=/tmp/comp-playwright` for both browser installation and tests. Dependencies, caches and browser binaries are not submitted.

`build` typechecks, writes the production export to repository-root `dist/`, then regenerates `dist/imd-deployment.json`. Never edit the export independently. The manifest script checks the pinned ABIs using local Git objects; preserve the deployed source commit in a build checkout. `test:browser` runs its own bounded HTTP server at a `/preview/` subpath and closes it afterwards. It uses mocked RPC/wallet responses, never a funded wallet. Its screenshots and machine-readable report are in `docs/frontend/`.

## Configuration and ABI provenance

`dist/imd-deployment.json` is the **only runtime deployment configuration**. The app fetches it relative to its entrypoint and fetches its referenced implementation ABIs. It verifies ABI asset SHA-256 and canonical Keccak before making contract calls. The build input `web/deployment-source.json` preserves the supplied handoff and chain table; it is not separately imported by the app. Runtime addresses of constructor-created dependencies come from vault getters; their ABI files are inventory-verified assets under `dist/abi/`. No dependency address is guessed.

The deployed source is `6c08b0fc122bc0e02016cf9c4f507e2dfaadfcc3`. All four handoff ABI arrays are raw, byte-identical copies of `docs/abi/<Contract>.json` from that commit. Six constructor-dependency ABI arrays also come from that commit. The additional `SwarmWorkOracle` array was generated from that same checkout with:

```sh
forge inspect src/SwarmWorkOracle.sol:SwarmWorkOracle abi --json --offline \
  --out test/scratch/abi-out --cache-path test/scratch/abi-cache \
  > web/public/abi/SwarmWorkOracle.json
```

`web/scripts/manifest.mjs` verifies the pinned commit exports, canonical sorted-key Keccak hashes, exact handoff contract set, optional pool key, and unchanged network/wallet-add-chain objects while the pinned inputs exist. It always verifies all exported asset bytes, including `index.html`, CSS, JavaScript and ABIs. The manifest excludes itself. The handoff has no `poolKey`, so none is invented. All files use relative hosting paths; serve `dist/` over HTTP(S), including from a gateway subdirectory.

## Controls and transaction flow

- **Redemption:** live zero-size fee and constant floor/cap, reserve IMD balance, `minCR + redemptionSpread` ceiling, on-chain size comparisons, fee-adjusted IMD output, exact reserve/position split, debt cancelled, candidate checks and a nonzero minimum. Full `redeem` simulation enforces backing/ratio guards. Quotes invalidate on edits, account changes and refreshed state; a late response cannot replace a newer quote.
- **Work:** discover `vault.oracle()`. For `SwarmWorkOracle`, show effective attested count, published tally, credited high-water mark, publication age/staleness, rate, earned/consumed/remaining rights and claimant. Explicitly identify the count as the swarm's published tally, not an on-chain proof. For the deployed **MockWorkOracle**, show faucet mode and wallet rights, with no invented task count or cumulative accounting. Operator grant controls are permission-gated.
- **Position:** exact IMD approval as its own transaction, deposit, borrow, repay, withdraw, plus an operator-only test collateral faucet. COMP burn paths do not ask for approvals.
- **Oracle:** primary/NHI/spot/USD values, ages, staleness and divergence; permission-checked reporter fallback. Signed attestation submission is relayer infrastructure, not a visitor action.
- **Keeper:** inspect candidate debt/ratio/mark, mark, mark for a beneficiary, clear recovered mark and liquidate inside the execution window.
- **Backing:** reserve value, secured collateral, backed/bad debt, work ceiling, registered assets, permissionless sync and operator withdrawal.
- **Governance:** current economics, pending kind/payload/timelock, permissionless apply, governor proposals (including zero COMP per task), cancel and index checkpoint. Contract-only treasury/oracle entrypoints are not presented as visitor actions.

The application verifies public RPC chain ID, nonempty code for handoff and linked contracts, reciprocal vault links and the handoff's feed links. Each snapshot uses a single block; public reads work before connection, wallet-specific values appear after connection. Polling runs every 15 seconds while visible; snapshots older than 45 seconds cannot authorize a transaction. An explicit refresh is available.

Actions check chain/account, simulate, show a native review dialog, simulate again, ask the wallet to sign, wait for one successful receipt and refresh. A synchronous lock prevents concurrent submissions while each action keeps its own label. Approval stays locked through receipt and refetch. Unknown-chain switching offers the exact supplied `wallet_addEthereumChain` parameters, then switches again. Failed reads, stale/divergent feeds and insufficient permissions are explained and gated. Full addresses are available in explorer links/titles and copy controls; address inputs accept validated `0x` addresses, not ENS names.

## Delivery and limitations

See [validation](../docs/frontend/VALIDATION.md), [design](../DESIGN.md), [browser evidence](../docs/frontend/browser-results.json) and [live read evidence](../docs/frontend/live-charts.json).

This task revises the existing terminal; it preserves every action pane and its Vite configuration, package manifest and lockfile. The complete current design is documented in root `DESIGN.md`. Neither `.imd/reads/deployment.json` nor `.imd/reads/network.json` was supplied in this revision, so the existing deployment-source, verified ABI exports and runtime manifest structure are retained. No contract, backend, indexer or subgraph was added.

The injected-wallet actions are tested with mocked accounts and receipts. No funded transaction was broadcast. A live browser session additionally read the real public deployment and one accepted primary attestation; NHI and spot only had reporter updates in that session. The vault returned no verifiable deposit events, so its book correctly says the position count is unknown. Historical provider availability, explorer pagination and final chain execution can vary; successful fixtures do not certify live-chain behavior. See the current validation record and `docs/frontend/live-charts.json` for observations.

The existing metadata and favicon remain, with a theme-aware favicon and theme-color. Absolute social-card metadata still awaits the publisher’s domain. Publication, pinning and naming are outside this local revision.

The assignment explicitly prohibits touching repository `.git/`. Source, the existing lockfile, the rebuilt export and documentation are present for submission; this worker does not stage or commit them. Packaging verification uses an isolated temporary bare repository, never the working repository’s Git metadata.

## Themes and charts

Light uses exactly ivory, surface, ink, slate, hairline, engraved green and oxblood tokens. Dark preserves the original six surface/text tokens, with the same complete semantic roles. The OS is the default; the explicit toggle persists across reloads and follows storage changes across tabs. Clear `comp-terminal-theme` in local storage to resume the OS default.

The new loan pane discovers the vault’s deployment block using historical code reads, falling back to Blockscout creation-transaction metadata when archive state is unavailable. Browser log requests cover deployment through the snapshot in contiguous chunks of at most 2,000 blocks. An error **or an empty RPC chunk** triggers the configured Sepolia Blockscout v2 API. All `next_page_params` pages are followed, address/range/schema checks apply, and malformed known events or incomplete coverage fail closed. Empty discovery is never evidence of an empty loan book. Limits (10,000 chunks / 2,000 pages), the 12-block re-read overlap and the public API URL are together in `src/config.ts`. Hitting a limit reports unread history. Only in-memory session history is cached; there is no backend or persistent index.

Distinct `CollateralDeposited.account` owners are read at the snapshot’s block using `positions(owner)` and `collateralRatio(owner)`, six owners at a time. Zero debt is dropped only after successful owner reads. One failed owner invalidates the book. Refreshed logs retain an anchor and re-read the overlap; this handles shallow reorganizations, not arbitrary deep chain rewrites. Risk limits come from live `minCR()` and `redemptionCeilingCR()`. The strip labels come from fixed engraving/currency word lists and a full-address hash; collisions are possible and public addresses remain available.

Oracle points are paired `ValueUpdated` + `AttestationAccepted` events in transaction/log order. Their x coordinates use the signed `updatedAt`, which is also what the contract uses for staleness. Reporter values and the derived USD feed never create fabricated attestation points. The work feed is plotted when the linked implementation actually supports accepted attestations. Current supply uses `totalDebt + totalWorkMinted − totalNonPrincipalRedeemed`; the split nets non-principal burns and caps principal at supply. A disclosure explains bad debt and the backing-ratio formula. Work headroom continues to use cumulative work minted.

Read source coverage and constraints in `src/history.ts` and `src/Charts.tsx`. The public API pagination schema is documented in [Blockscout’s OpenAPI specification](https://github.com/blockscout/blockscout-api-v2-swagger/blob/main/swagger.yaml).

For an optional current-network browser smoke check (no wallet or broadcasts), run `node web/scripts/live-charts.mjs` with the same Playwright browser path. It serves the existing export at a local subpath for the duration of the check, then closes the browser and server. `node web/scripts/live-check.mjs` separately verifies public chain ID and code. These commands write dated evidence under `docs/frontend/`.

## Stock-token geofence (planned tokenized-stock collateral)

No stock type is shown yet. When one is, it goes through the gate:

- `src/geofence.json` is the one country table, with the issuer's terms quoted and the date it was read. Unknown country
  (`XX`, no header) and Tor (`T1`) are blocked.
- `GET /geo` (`worker/geo.js`, `no-store`) answers `{ country, stocks, reason }` from Cloudflare's country for the request.
- `src/stock-gate.ts` (`StockGate` / `useStockGate`) is the only way a stock pane renders: nothing until `/geo` says yes,
  then a self-declaration per wallet; a restricted country sees only an existing position, read-only, with repay, withdraw
  and claim (`unwindException`). `src/geofence.ts` reads the stock types from chain (Parameters' group 1, so a new type is
  hidden with no site change) and refuses to send a stock borrow or auction take the visitor may not make.
- `scripts/geofence-check.mjs` (in `npm test` and `build:launch`) fails if a source file names a stock type or the stock
  auction without rendering through the gate. `npm run check:geofence-terms` re-reads the issuer's page: run it before
  every terminal deploy.

IP country is beaten by a VPN or another front end; the contracts are permissionless. This keeps our site within the
issuer's terms; it is not a security boundary. `legalConfirmed` stays `false` until legal signs off the table, the
declaration wording and the unwind exception.
