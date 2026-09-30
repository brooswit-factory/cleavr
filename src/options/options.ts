import { getOptions, setOptions } from "../lib/storage";
import { forUrlEndpoint, forUrlRequestInit, isValidPort } from "../lib/url";

const form = document.querySelector<HTMLFormElement>("#options-form")!;
const portInput = document.querySelector<HTMLInputElement>("#port")!;
const portError = document.querySelector<HTMLDivElement>("#port-error")!;
const saveResult = document.querySelector<HTMLDivElement>("#save-result")!;
const testResult = document.querySelector<HTMLDivElement>("#test-result")!;
const testButton = document.querySelector<HTMLButtonElement>("#test-connection")!;

void getOptions().then((options) => {
  portInput.value = String(options.port);
});

function validatePort(value: string): number | null {
  const port = Number(value);
  if (!isValidPort(port)) {
    portError.textContent = "Enter a port between 1 and 65535.";
    portError.hidden = false;
    return null;
  }
  portError.hidden = true;
  return port;
}

portInput.addEventListener("input", () => validatePort(portInput.value));

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});

async function save(): Promise<void> {
  saveResult.textContent = "";
  const port = validatePort(portInput.value);
  if (port === null) {
    saveResult.textContent = "Fix the port before saving.";
    return;
  }

  await setOptions({ port });
  saveResult.textContent = "Saved.";
}

testButton.addEventListener("click", () => {
  void testConnection();
});

async function testConnection(): Promise<void> {
  testResult.textContent = "Testing…";
  const port = validatePort(portInput.value);
  if (port === null) {
    testResult.textContent = "Fix the port before testing.";
    return;
  }

  const requestUrl = forUrlEndpoint(port);

  try {
    const response = await fetch(requestUrl, forUrlRequestInit("https://example.com/"));
    if (response.status === 401 || response.status === 403) {
      // FACTORY-504: no configurable allowlist exists any more (FACTORY-475/
      // FACTORY-497 hardcoded the single extension origin) — a rejection
      // here means this extension's id doesn't match what the daemon
      // expects, not a setting to go check.
      testResult.textContent = `Daemon reachable, but the request was rejected (${response.status}). This extension's id may not match what the daemon expects — try reloading the extension.`;
      return;
    }
    if (!response.ok) {
      testResult.textContent = `Daemon reachable, but responded with HTTP ${response.status}.`;
      return;
    }
    testResult.textContent = "Connected — the daemon accepted the request.";
  } catch (err) {
    testResult.textContent = `Couldn't reach the daemon: ${err instanceof Error ? err.message : String(err)}`;
  }
}
