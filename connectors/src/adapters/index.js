/**
 * Adapter lookup by connector id. Session D adds one file per adapter under
 * src/adapters/<id>/ and registers it here.
 */
export const ADAPTERS = {};
export function getAdapter(connectorId) {
  return ADAPTERS[connectorId];
}
