chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.url && !/^https:\/\/(?:www\.)?gigab2b\.com\//.test(sender.url)) {
    sendResponse({ ok: false, error: "unexpected sender" });
    return false;
  }

  const port = Number(message?.port);
  const token = message?.token;
  const path = message?.action === "credentials"
    ? "credentials"
    : message?.action === "logged-in" ? "logged-in" : null;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path || typeof token !== "string") {
    sendResponse({ ok: false, error: "invalid handoff request" });
    return false;
  }

  const url = `http://127.0.0.1:${port}/${path}?token=${encodeURIComponent(token)}`;
  fetch(url, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`handoff returned ${response.status}`);
      return path === "credentials" ? response.json() : null;
    })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
