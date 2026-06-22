/**
 * Kiro authentication context for the passthrough flow.
 *
 * This is the API-key-only equivalent of the Python `KiroAuthManager`. In
 * passthrough mode the client supplies its own ksk_ key, which is used directly
 * as the bearer token — there is no token exchange, refresh, or expiry. All this
 * module does is resolve the region-specific upstream hosts and attach the
 * stable machine fingerprint.
 */
import type { KiroAuthContext } from "../types";
import {
  getKiroApiHost,
  getKiroQHost,
  getKiroManagementHost,
} from "../config";
import { getMachineFingerprint } from "../lib/utils";

/**
 * Build a {@link KiroAuthContext} for a passthrough request.
 *
 * @param token  The client's ksk_ API key (used directly as the bearer token).
 * @param region The Kiro API region (e.g. "us-east-1").
 */
export async function createKiroAuthContext(
  token: string,
  region: string,
): Promise<KiroAuthContext> {
  const fingerprint = await getMachineFingerprint();
  return {
    token,
    authType: "api_key",
    fingerprint,
    apiHost: getKiroApiHost(region),
    qHost: getKiroQHost(region),
    managementHost: getKiroManagementHost(region),
  };
}
