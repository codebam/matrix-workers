// Application-service event fanout.
//
// Every stored event (local or federated) is offered to each registered
// appservice whose namespaces match. Delivery is best-effort and isolated
// per appservice: a broken or slow bridge must never fail the originating
// client/federation request. sendAppServiceTransaction bounds each delivery
// with a fetch timeout and records the transaction for retry bookkeeping.

import type { Env, PDU } from '../types';
import {
  getAppServices,
  getInterestedAppServices,
  sendAppServiceTransaction,
} from './appservice';

export async function fanoutEventToAppServices(env: Env, event: PDU): Promise<void> {
  let services;
  try {
    services = await getAppServices(env.DB);
  } catch (err) {
    // Registration table absent (minimal deployment) — nothing to deliver.
    console.warn('[appservice] fanout: cannot list registrations:', err);
    return;
  }
  if (services.length === 0) return;

  const interested = getInterestedAppServices(services, event);
  for (const as of interested) {
    try {
      await sendAppServiceTransaction(env.DB, as, [event as unknown as Record<string, unknown>]);
    } catch (err) {
      console.error(`[appservice] fanout to ${as.id} failed:`, err);
    }
  }
}