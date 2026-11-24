import { NeoDeviceClient } from "../neo-client";
import "./style.css";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
const $ = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing UI element: " + id);
  return node as T;
};
const connectButton = $("connect-button") as HTMLButtonElement;
const welcomeConnect = $("welcome-connect") as HTMLButtonElement;
const connectionState = $("connection-state");
const welcome = $("welcome");
const chatPanel = $("chat-panel");
const errorPanel = $("error-panel");
const deviceLabel = $("device-label");
const form = $("chat-form") as HTMLFormElement;
const input = $("message-input") as HTMLTextAreaElement;
const sendButton = $("send-button") as HTMLButtonElement;
const messagesNode = $("messages");
const clearButton = $("clear-button") as HTMLButtonElement;
let client: NeoDeviceClient | null = null;
let history: ChatMessage[] = [];
let busy = false;
let googleIdToken: string | null = null;
type GoogleCredentialResponse = { credential?: string };
type GoogleIdentityApi = { initialize(options: { client_id: string; callback(response: GoogleCredentialResponse): void }): void; renderButton(parent: HTMLElement, options: { theme: string; size: string; shape: string; text: string }): void };
declare global { interface Window { google?: { accounts?: { id?: GoogleIdentityApi } } } }

function showError(message: string) {
  errorPanel.textContent = message;
  errorPanel.hidden = false;
}
function clearError() { errorPanel.hidden = true; errorPanel.textContent = ""; }
function setConnected(label: string) {
  connectionState.textContent = "Connected";
  connectionState.className = "state state-connected";
  deviceLabel.textContent = label;
  welcome.hidden = true;
  chatPanel.hidden = false;
}
function addMessage(role: "user" | "assistant", content: string) {
  const empty = messagesNode.querySelector(".empty-state");
  empty?.remove();
  const wrapper = document.createElement("article");
  wrapper.className = "message message-" + role;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "YOU" : "NEO";
  const body = document.createElement("div");
  body.textContent = content;
  wrapper.append(meta, body);
  messagesNode.append(wrapper);
  messagesNode.scrollTop = messagesNode.scrollHeight;
}
async function connect() {
  clearError();
  connectionState.textContent = "Connecting…";
  try {
    if (!googleIdToken) throw new Error("Sign in with Google first, then connect this browser.");
    const baseUrl = window.location.origin;
    const identityToken = async () => {
      if (!googleIdToken) throw new Error("Google sign-in has expired. Sign in again.");
      return googleIdToken;
    };
    const account = await NeoDeviceClient.resolveAccountScope(baseUrl, identityToken);
    const device = await NeoDeviceClient.create(baseUrl, identityToken, account);
    await device.enrol("NEO Browser", "browser", ["chat", "memory.sync"]);
    await device.heartbeat();
    client = device;
    setConnected("Browser device · " + device.deviceId.slice(0, 8));
  } catch (error) {
    connectionState.textContent = "Not connected";
    connectionState.className = "state state-error";
    const message = error instanceof Error ? error.message : "Connection failed";
    showError(message + " — NEO staging may not be configured or reachable yet.");
  }
}
async function initialiseGoogleSignIn() {
  try {
    const response = await fetch("/v1/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load NEO sign-in configuration.");
    const config = await response.json() as { google_web_client_id?: string | null };
    if (!config.google_web_client_id) {
      showError("Google sign-in is not configured yet. The NEO owner must add the Google Web OAuth client ID before browser authentication can be tested.");
      return;
    }
    let attempts = 0;
    const waitForGoogle = () => {
      const api = window.google?.accounts?.id;
      if (!api) {
        if (++attempts < 40) window.setTimeout(waitForGoogle, 100);
        else showError("Google sign-in could not load. Check the network connection and content blockers.");
        return;
      }
      api.initialize({
        client_id: config.google_web_client_id!,
        callback: (credentialResponse: GoogleCredentialResponse) => {
          if (!credentialResponse.credential) {
            showError("Google did not return an identity token. Please try signing in again.");
            return;
          }
          googleIdToken = credentialResponse.credential;
          clearError();
          void connect();
        },
      });
      api.renderButton(googleButton, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with" });
      api.renderButton(googleTopButton, { theme: "outline", size: "medium", shape: "pill", text: "signin" });
    };
    waitForGoogle();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Google sign-in initialisation failed.");
  }
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !client || busy) return;
  clearError();
  history.push({ role: "user", content: text });
  addMessage("user", text);
  input.value = "";
  busy = true;
  sendButton.disabled = true;
  try {
    const result = await client.chatCompletion({ messages: history, model: "auto", max_tokens: 512 });
    const answer = result.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) throw new Error("NEO returned an empty response");
    history.push({ role: "assistant", content: answer });
    addMessage("assistant", answer);
  } catch (error) {
    history.pop();
    const message = error instanceof Error ? error.message : "Chat request failed";
    showError(message);
    if (message.includes("401") || message.includes("403")) {
      client = null;
      welcome.hidden = false;
      chatPanel.hidden = true;
      connectionState.textContent = "Sign-in required";
      connectionState.className = "state state-error";
    }
  } finally {
    busy = false;
    sendButton.disabled = false;
    input.focus();
  }
});
clearButton.addEventListener("click", () => {
  history = [];
  messagesNode.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "Your conversation starts here. Ask NEO anything.";
  messagesNode.append(empty);
});
