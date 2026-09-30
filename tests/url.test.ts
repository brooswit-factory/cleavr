import { describe, expect, it } from "vitest";
import { daemonBaseUrl, forUrlEndpoint, forUrlRequestInit, isValidPort } from "../src/lib/url";

describe("forUrlEndpoint", () => {
  it("builds off the fixed 127.0.0.1 host and given port, appending /resources/for-url with no query string", () => {
    expect(forUrlEndpoint(9999)).toBe("http://127.0.0.1:9999/resources/for-url");
  });
});

// FACTORY-478/FACTORY-480: a real MV3 service-worker GET carries no Origin
// header, so the page URL now travels in a POST's JSON body instead of a
// query string — see src/lib/url.ts's own header for the measurement.
describe("forUrlRequestInit", () => {
  it("is a POST with a JSON content-type header", () => {
    const init = forUrlRequestInit("https://example.com/path?a=b&c=d");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("carries the page URL, unencoded, as the body's url field", () => {
    const init = forUrlRequestInit("https://example.com/path?a=b&c=d");
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com/path?a=b&c=d" });
  });

  it("round-trips spaces and unicode through JSON, not percent-encoding", () => {
    const init = forUrlRequestInit("https://example.com/café a b");
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com/café a b" });
  });
});

describe("daemonBaseUrl", () => {
  it("is always http://127.0.0.1:<port>", () => {
    expect(daemonBaseUrl(7717)).toBe("http://127.0.0.1:7717");
  });
});

describe("isValidPort", () => {
  it("accepts integers from 1 to 65535", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(7717)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it("rejects 0, negative, non-integer, out-of-range, and non-number values", () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(1.5)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort("7717")).toBe(false);
    expect(isValidPort(undefined)).toBe(false);
    expect(isValidPort(Number.NaN)).toBe(false);
  });
});
