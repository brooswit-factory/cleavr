import type { ResourceState, Failure } from "./adapter";

export interface PingMessage {
  type: "cleavr:ping";
}

export interface ToggleMessage {
  type: "cleavr:toggle";
}

export interface FetchResourcesMessage {
  type: "cleavr:fetch-resources";
  pageUrl: string;
}

export type RuntimeMessage = PingMessage | ToggleMessage | FetchResourcesMessage;

export type FetchResourcesResult =
  | { kind: "success"; state: ResourceState }
  | { kind: "failure"; failure: Failure };
