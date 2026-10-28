import { isOperatorTurn, type KernConfig } from "./config.js";
import { currentTurn, CORE_SCOPE } from "./turn-context.js";

/**
 * Trust of the turn a tool is running in, for tools that act with the
 * agent's own credentials (Slack, Matrix). Set once at startup.
 */
type TrustConfig = Pick<KernConfig, "sessionMode" | "operatorUsers" | "userAliases">;
let _config: TrustConfig = { sessionMode: "shared", operatorUsers: [], userAliases: {} };

export function setTrustConfig(config: TrustConfig) {
  _config = config;
}

/**
 * Null when the turn is trusted (shared mode, or the operator). Otherwise the
 * requester's ID on `iface`, or "" when the turn didn't come from `iface`
 * (e.g. a Slack lookup asked for from a Matrix DM): such a requester has no
 * access of their own there beyond public channels.
 */
export function untrustedRequester(iface: string): string | null {
  const turn = currentTurn();
  if (isOperatorTurn(_config, turn?.scope ?? CORE_SCOPE, turn?.origin.interface)) return null;
  return turn?.origin.interface === iface ? turn.origin.userId : "";
}
