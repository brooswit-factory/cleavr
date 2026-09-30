import { describe, expect, it } from "vitest";
import { parseForUrlResponse, MalformedResponseError } from "../src/lib/adapter";
import noResource from "./fixtures/no-resource.json";
import noAgents from "./fixtures/no-agents.json";
import singleAgent from "./fixtures/single-agent.json";
import multiAgent from "./fixtures/multi-agent.json";

describe("parseForUrlResponse", () => {
  it("renders resource: null as no-resource", () => {
    expect(parseForUrlResponse(noResource)).toEqual({ kind: "no-resource" });
  });

  it("renders a resource with zero agents as no-agents", () => {
    expect(parseForUrlResponse(noAgents)).toEqual({
      kind: "no-agents",
      resource: { provider: "jira", id: "PROJ-1" },
    });
  });

  it("renders exactly one agent as single-agent", () => {
    expect(parseForUrlResponse(singleAgent)).toEqual({
      kind: "single-agent",
      resource: { provider: "jira", id: "PROJ-1" },
      agent: { agentKey: "a1", ruleId: "r1", pane: "main", live: true, label: "PROJ-1 task agent" },
    });
  });

  it("renders several agents as multi-agent, preserving response order", () => {
    const result = parseForUrlResponse(multiAgent);
    expect(result.kind).toBe("multi-agent");
    if (result.kind !== "multi-agent") throw new Error("unreachable");
    expect(result.agents.map((a) => a.agentKey)).toEqual(["a1", "a2"]);
  });

  it("accepts pane: null (a documented, valid value — e.g. a non-live agent)", () => {
    const result = parseForUrlResponse(multiAgent);
    if (result.kind !== "multi-agent") throw new Error("unreachable");
    const nonLiveAgent = result.agents.find((a) => a.agentKey === "a2");
    expect(nonLiveAgent).toEqual({
      agentKey: "a2",
      ruleId: "r2",
      pane: null,
      live: false,
      label: "Story agent",
    });
  });

  it("rejects a non-object body", () => {
    expect(() => parseForUrlResponse(null)).toThrow(MalformedResponseError);
    expect(() => parseForUrlResponse("nope")).toThrow(MalformedResponseError);
  });

  it("rejects a body whose agents field is not an array", () => {
    expect(() => parseForUrlResponse({ resource: null, agents: "nope" })).toThrow(MalformedResponseError);
  });

  it("rejects a resource missing provider/id", () => {
    expect(() => parseForUrlResponse({ resource: { provider: "jira" }, agents: [] })).toThrow(
      MalformedResponseError,
    );
  });

  it("rejects an agent entry missing required fields", () => {
    expect(() =>
      parseForUrlResponse({
        resource: { provider: "jira", id: "X" },
        agents: [{ agentKey: "a1", ruleId: "r1", pane: "main", live: true }],
      }),
    ).toThrow(MalformedResponseError);
  });
});
