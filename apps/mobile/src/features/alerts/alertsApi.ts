import type { Alert, AlertsResponse } from '@manaclaude/shared';
import { api } from '../../data/backend/client';

/** The Worker lists at most this many alerts at a time, newest first. */
export const ALERTS_LISTED = 100;

/** GET /v1/alerts: the alerts that have not been dismissed, newest first (at most 100). */
export async function listAlerts(): Promise<Alert[]> {
  return (await api<AlertsResponse>('GET', '/v1/alerts')).alerts;
}

/**
 * POST /v1/alerts/:id/dismiss: marks one alert as dismissed. The Worker has
 * no way to bring a dismissed alert back, and it answers `{ ok: true }` for
 * an id it does not know as well.
 */
export async function dismissAlert(id: string): Promise<void> {
  await api<{ ok: boolean }>('POST', `/v1/alerts/${encodeURIComponent(id)}/dismiss`, {});
}
