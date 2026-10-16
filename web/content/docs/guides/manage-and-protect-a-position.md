---
title: Manage and protect a position
section: guides
order: 3
audience: borrowers
sources:
  - src/CDPVault.sol:328-358
  - src/CDPVault.sol:420-427
  - src/CDPVault.sol:653-755
  - src/CDPVault.sol:691-697
  - src/CDPVault.sol:759-848
  - src/CDPVault.sol:999-1053
  - web/src/math.ts:128-212
---

# Manage and protect a position

This guide covers changing an open position and keeping it from being liquidated, using Deposit (`lock`), Withdraw (`free`), Repay (`wipe`) and, for marks, Clear mark (`heel`).

## Know your liquidation price

Your position is safe while its collateral is worth at least `mat` times its debt. So the dollar price per IMD at which it stops being safe is:

> liquidation price = debt × `mat` ÷ 100 ÷ collateral

with debt in imdUSD, collateral as the IMD your sIMD is worth (sIMD × the staking vault's exchange rate) and `mat` as a whole percentage. The terminal shows this as **Liquidation price**, with your cushion below the current price. Two things besides the IMD price move it:

- **Stability fee.** Your debt grows every second, so your liquidation price creeps up over time.
- **Network health.** `mat` follows the network health index. When health falls, `mat` rises and your liquidation price rises with it, even if IMD is flat. When health rises, `mat` falls. Read the live value in the Position tab or with `mat()`.

Keep a cushion that covers a price fall and a health fall together, and check **Liquidation price** whenever the Oracle tab shows the network health figure has changed.

## Add collateral: Deposit (`lock`)

1. Choose Deposit, pick IMD or sIMD, enter the amount and check **After this** under the button: your ratio and liquidation price once it lands. Review and confirm; a first deposit approves in the same confirmation (one signature if your wallet batches, two prompts if not).
2. Your ratio rises and your liquidation price falls.

Deposit works even when prices are out of date. It fails only with `ZeroAmount`, a token balance or allowance error, or `UnexpectedCollateralReceived`.

## Repay debt: Repay (`wipe`)

1. Choose Repay, enter an imdUSD amount and confirm. No approval is needed: the vault burns the imdUSD from your wallet.
2. Fees are paid first, then principal. Paid fees go to the Treasury.
3. To close the position, repay the whole **Accrued debt**. Fees build up every second, so an amount read a moment earlier can leave a few units owed when your transaction lands; repay again to clear them. Sending more than you owe fails, so do not round up.

Repay works even when prices are out of date. Errors: `ZeroAmount`; `ExcessRepayment` if you repay more than you owe; a token balance error if you hold too little imdUSD.

## Take collateral out: Withdraw (`free`)

1. Choose Withdraw, enter an sIMD amount and confirm.
2. With no debt, the vault simply returns your sIMD; unstake it in the staking vault if you want IMD. With debt, it needs live prices (fresh, and the main and spot prices agreeing) and refuses if what is left would fall below `mat`.

Errors: `InsufficientCollateral` (you asked for more than you hold); `UnsafeCollateralRatio` (what is left would be too thin; the note gives the most you can take); `StaleFeed` or `PriceDivergence` (prices not usable; wait).

## Borrow more: Borrow (`draw`)

See [Open a position](./open-a-position.md), steps 3 and 4. The same checks apply.

## Marks and liquidation

A keeper can mark (`bark`) any position below `mat`. A mark does not liquidate you. It starts a grace period, fixed at the moment of marking, during which you can recover. Once grace has passed a keeper may liquidate (`bite`), until the mark expires. The Keeper tab shows your status when it inspects your address: None, Grace (with a countdown), Active and liquidatable, or Recovered and clearable.

If you are marked and still below `mat`, act during grace:

1. Deposit more collateral or repay debt until your ratio is back above `mat`.
2. If prices are live, that deposit or repayment also clears the mark. Repaying all your debt always clears it. A successful borrow or withdrawal clears it too, since both require you to end at or above `mat`.
3. If your deposit or repayment lands while a price is out of date, it still succeeds but the mark stays. Once prices are live again, press Clear mark (`heel`); anyone may do this. Do it promptly: if your position only recovered because the price moved, the contract has not recorded that, and an old mark does not restart grace if you dip again before it expires.

If you are liquidated, the keeper cancels some of your debt and takes sIMD worth that debt plus a bonus. The bonus is your cost; how it is shared between keepers and the protocol does not change it. If your collateral runs out before your debt does, the rest stays recorded against your address as bad debt. You can still repay it, and anyone can cancel it with imdUSD the Treasury holds (`cover`). If you deposit again into a drained position, collateral worth less than your recorded bad debt can be taken by `cover` at its value, cancelling that much debt; to rebuild the position, deposit more than that. A rebuilt position is marked and given grace like any other.

Full rules: [How liquidation works](../keepers/how-liquidation-works.md).

## Other ways your position can change

- **Redemption.** If your ratio is below `mat` plus the redemption spread `gap`, a redeemer may name your position. Your debt is cancelled and the matching collateral is paid to them at the redemption price, with the fee left in your position. See [Redeem](./redeem.md). Staying above that level avoids it.
- **Paused actions.** While a price is out of date or the main and spot prices disagree, you cannot borrow or withdraw with debt open, and keepers cannot mark or liquidate you. You can still deposit and repay.
