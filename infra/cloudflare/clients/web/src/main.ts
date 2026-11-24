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
  connectButton.disabled = true;
  welcomeConnect.disabled = true;
  connectionState.textContent = "Connecting…";
  try {
    const baseUrl = window.location.origin;
    const account = await NeoDeviceClient.resolveAccountScope(baseUrl);
    const device = await NeoDeviceClient.create(baseUrl, undefined, account);
    await device.enrol("NEO Browser", "browser", ["chat", "memory.sync"]);
    await device.heartbeat();
    client = device;
    setConnected("Browser device · " + device.deviceId.slice(0, 8));
  } catch (error) {
    connectionState.textContent = "Not connected";
    connectionState.className = "state state-error";
    const message = error instanceof Error ? error.message : "Connection failed";
    if (message.includes("401") || message.toLowerCase().includes("session")) {
      showError("NEO sign-in is required. Open this page through the configured Cloudflare Access application, then try connecting again.");
    } else {
      showError(message + " — NEO staging may not be configured or reachable yet.");
    }
  } finally {
    connectButton.disabled = false;
    welcomeConnect.disabled = false;
  }
}
connectButton.addEventListener("click", connect);
welcomeConnect.addEventListener("click", connect);
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
