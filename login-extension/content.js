(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const port = params.get("handoff_port");
  const token = params.get("handoff_token");
  if (!port || !token) return;

  const requestHandoff = (action) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, port, token }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "handoff unavailable"));
        return;
      }
      resolve(response.data);
    });
  });
  const loggedIn = () => {
    const text = document.body?.innerText || "";
    return text.includes("退出") && text.includes("Buyer");
  };

  const notifyLoggedIn = () => requestHandoff("logged-in").catch((error) => {
    console.error("GIGA login handoff notification failed", error);
  });

  if (loggedIn()) {
    notifyLoggedIn();
    return;
  }

  const visible = (element) => element && element.offsetParent !== null;
  let credentialsRequested = false;

  const fillCredentials = () => {
    if (credentialsRequested || loggedIn()) return;
    const passwordInput = [...document.querySelectorAll('input[type="password"]')].find(visible);
    const usernameInput = [
      ...document.querySelectorAll('input[name="email"],input[name="username"],input[autocomplete="username"],input[autocomplete="email"],input[type="email"],input[type="text"]'),
    ].find(visible);
    if (!usernameInput || !passwordInput) return;

    credentialsRequested = true;
    requestHandoff("credentials")
      .then(({ username, password }) => {
        const setValue = (input, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setValue(usernameInput, username);
        setValue(passwordInput, password);

        const loginButton = [...document.querySelectorAll("button,input[type=submit]")].find((element) => {
          const label = (element.innerText || element.value || "").trim();
          return visible(element) && /^(Login Now|登录|Login|Sign in)$/i.test(label);
        });
        loginButton?.click();
      })
      .catch((error) => {
        credentialsRequested = false;
        console.error("GIGA credential handoff failed", error);
      });
  };

  const observer = new MutationObserver(() => {
    if (loggedIn()) {
      observer.disconnect();
      notifyLoggedIn();
      return;
    }
    fillCredentials();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  fillCredentials();
  setInterval(() => {
    if (loggedIn()) notifyLoggedIn();
    else fillCredentials();
  }, 2000);
})();
