/**
 * A service notice shown on the terminal and the homepage, and the reason the Update price button is held.
 * Set to null (and redeploy) once the outage is over.
 *
 * 2026-10-23: imd.fun is on a registrar hold (clientHold), so the IdentityMD oracle API cannot be reached and
 * no paid request can be answered. Buying an update now would spend IMD on an answer that cannot arrive.
 */
export const ORACLE_OUTAGE: { since: string; reason: string } | null = {
  since: "23 Oct, 06:26 UTC",
  reason: "IdentityMD's oracle service (imd.fun) has been offline",
};

/** The banner sentence: what is paused while the feeds cannot update, and what still works. */
export const outageNotice = (o: NonNullable<typeof ORACLE_OUTAGE>) =>
  `${o.reason} since ${o.since}, so price feeds cannot update. Borrowing, withdrawing collateral, redemptions and liquidations are paused until it is back. Deposits and repayments still work.`;

/** The terminal's one-line version: the desk must still fit 1280x720. */
export const outageShort = (o: NonNullable<typeof ORACLE_OUTAGE>) =>
  `imd.fun offline since ${o.since}. Price updates off; borrowing, withdrawals, redemptions, liquidations paused. Deposits and repays work.`;

/** Why the Update price button is off: an update bought now could not be answered. */
export const outageHold = (o: NonNullable<typeof ORACLE_OUTAGE>) =>
  `Price updates are off: ${o.reason} since ${o.since}, so an update bought now could not be answered. This turns back on when the service returns.`;
