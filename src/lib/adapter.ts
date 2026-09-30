// Single typed adapter for the FACTORY-335 `/resources/for-url` response.
// Everything that turns that JSON into a render-ready state lives here so it
// can be tested against fixtures without a browser or a running daemon.

export interface ButchrAgent {
  agentKey: string;
  ruleId: string;
  pane: string | null;
  live: boolean;
  label: string;
}

export interface ButchrResource {
  provider: string;
  id: string;
}

export interface ForUrlResponse {
  url: string;
  canonicalUrl: string | null;
  resource: ButchrResource | null;
  agents: ButchrAgent[];
}

export type ResourceState =
  | { kind: "no-resource" }
  | { kind: "no-agents"; resource: ButchrResource }
  | { kind: "single-agent"; resource: ButchrResource; agent: ButchrAgent }
  | { kind: "multi-agent"; resource: ButchrResource; agents: ButchrAgent[] };

export class MalformedResponseError extends Error {}

export function parseForUrlResponse(json: unknown): ResourceState {
  if (typeof json !== "object" || json === null) {
    throw new MalformedResponseError("response body is not an object");
  }
  const data = json as Record<string, unknown>;

  if (!Array.isArray(data.agents)) {
    throw new MalformedResponseError("response.agents is not an array");
  }
  const agents = data.agents.map(parseAgent);

  if (data.resource === null) {
    return { kind: "no-resource" };
  }
  if (typeof data.resource !== "object") {
    throw new MalformedResponseError("response.resource is not an object or null");
  }
  const resource = parseResource(data.resource as Record<string, unknown>);

  if (agents.length === 0) {
    return { kind: "no-agents", resource };
  }
  if (agents.length === 1) {
    return { kind: "single-agent", resource, agent: agents[0] as ButchrAgent };
  }
  return { kind: "multi-agent", resource, agents };
}

function parseResource(raw: Record<string, unknown>): ButchrResource {
  if (typeof raw.provider !== "string" || typeof raw.id !== "string") {
    throw new MalformedResponseError("resource is missing provider/id strings");
  }
  return { provider: raw.provider, id: raw.id };
}

function parseAgent(raw: unknown): ButchrAgent {
  if (typeof raw !== "object" || raw === null) {
    throw new MalformedResponseError("agent entry is not an object");
  }
  const a = raw as Record<string, unknown>;
  if (
    typeof a.agentKey !== "string" ||
    typeof a.ruleId !== "string" ||
    (typeof a.pane !== "string" && a.pane !== null) ||
    typeof a.live !== "boolean" ||
    typeof a.label !== "string"
  ) {
    throw new MalformedResponseError("agent entry missing a required field");
  }
  return { agentKey: a.agentKey, ruleId: a.ruleId, pane: a.pane, live: a.live, label: a.label };
}

// Failure modes that must each get their own visible, distinct message.
export type Failure =
  | { kind: "unreachable"; detail: string }
  | { kind: "unauthorized"; status: 401 | 403 }
  // FACTORY-530: this extension couldn't read its own chrome.storage.local
  // settings (e.g. getOptions' port lookup rejected) — distinct from
  // "unreachable" because the daemon was never even contacted.
  | { kind: "storage-unreadable"; detail: string }
  // FACTORY-530: chrome.runtime.sendMessage itself rejected or the
  // background's onMessage channel closed before responding (e.g. the
  // service worker was evicted mid-request) — distinct from both of the
  // above because nothing about the daemon or storage is implicated.
  | { kind: "extension-error"; detail: string };

export function resourceKeyFor(resource: ButchrResource): string {
  return `${resource.provider}:${resource.id}`;
}
