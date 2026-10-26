// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from 'vitest';

// Exercise these through real orchestration entry points when their implementations are available.
describe('pending billing workflows: dependency and acceptance recorded in each title', () => {
  it.todo('[webhook handlers] completed payment Checkout activates only its pending invoice memberships once; setup or abandoned Checkout never activates');
  it.todo('[charge runner, webhook handlers] deliver a signed success webhook before confirm returns; replay event ID and runner result leave one durable payment, receipt and activation');
  it.todo('[charge runner, webhook handlers] deliver success after the runner result; replay through the durable inbox leaves one payment and one receipt');
  it.todo('[charge runner] decline on March 1 schedules retries on March 4 and 8 (days 3 and 7), never 3/7 days after the previous retry');
  it.todo('[charge runner] advance clock just before and at each retry deadline: no early attempt, exactly one due attempt, replay creates none');
  it.todo('[charge runner] both retries decline: each failure sends one dunning mail, invoice remains past_due after day 7 and no third retry is scheduled');
  it.todo('[charge runner] day-3 retry succeeds: day-7 job is a no-op, invoice stays paid and late failure never reopens it');
  it.todo('[charge runner] editing the gym\'s retry schedule leaves an invoice already in dunning on its original schedule');
  it.todo('[charge runner, signed-link pages] authentication_required (thrown, last_payment_error or requires_action) sends a signed action link and follows the same retry calendar');
  it.todo('[charge runner, payments UI] one-off decline or SCA stays open; clock advances beyond day 7 without a retry job or dunning email');
  it.todo('[charge runner, signed-link pages] expire an open pay session before retry; already-completed or uncertain expiration reconciles instead of charging again');
  it.todo('[charge runner, signed-link pages] pay link succeeds during the retry window, cancels later charging and produces one receipt');
  it.todo('[charge runner] persist pending attempt before create and compare-and-set the intent ID before confirm; delayed create loses to reconciliation and is cancelled');
  it.todo('[charge runner] delayed confirm races cancellation; reconcile by ID to at most one charge and the final processor state');
  it.todo('[charge runner] crash after processor success before local record; after 24 hours reconcile saved intent, never create a second charge');
  it.todo('[charge runner] concurrent or repeated daily runs issue one invoice per household/due date and advance each membership once');
  it.todo('[charge runner] downtime catches up exact due dates oldest first; seven-day-old periods charge and eight-day-old periods wait for staff review');
  it.todo('[charge runner] billing disabled prevents every create/confirm, retry and catch-up charge');
  it.todo('[membership import, charge runner] persisted imported Feb-29 anniversary differing from startsOn survives Feb-28 renewals and returns to Feb-29 in 2032');
  it.todo('[membership import, charge runner] imported annual renewal and monthly due dates survive first run, adopting the imported customer before charging');
  it.todo('[webhook handlers, payments UI] a dashboard refund without invoice metadata resolves through its payment; pending/failed refund never marks paid invoice refunded');
  it.todo('[webhook handlers] dispute creation flags the paid invoice, emails the gym owner, and shows a dashboard alert once; replay and out-of-order outcomes keep the current dispute state');
  it.todo('[charge runner, webhook handlers] restore keeps billing disabled while post-snapshot success, refund and dispute are reconciled through their payment IDs');
  it.todo('[payments UI] front desk records cash but cannot refund; foreign gym and foreign household cannot read or mutate the invoice');
});
