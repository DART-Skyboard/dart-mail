(function () {
  const SCOPES = ["User.Read", "Mail.ReadWrite", "Mail.Send", "MailboxSettings.Read"];
  let pca = null;
  let account = null;

  function cfg() {
    const base = window.DART_MAIL_CONFIG || {};
    const clientId = (localStorage.getItem("dartmail.clientId") || base.clientId || "").trim();
    const tenantId = (localStorage.getItem("dartmail.tenantId") || base.tenantId || "organizations").trim() || "organizations";
    return { clientId, tenantId };
  }

  function redirectUri() {
    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    let path = url.pathname;
    if (path.endsWith("index.html")) path = path.slice(0, -"index.html".length);
    if (!path.endsWith("/")) path += "/";
    return url.origin + path;
  }

  function configured() {
    const id = cfg().clientId;
    return Boolean(id) && !id.startsWith("REPLACE");
  }

  async function init() {
    if (!configured() || !window.msal) return { configured: configured(), account: null, redirectUri: redirectUri() };
    const c = cfg();
    pca = new msal.PublicClientApplication({
      auth: {
        clientId: c.clientId,
        authority: "https://login.microsoftonline.com/" + encodeURIComponent(c.tenantId),
        redirectUri: redirectUri(),
      },
      cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false },
    });
    await pca.initialize();
    const result = await pca.handleRedirectPromise();
    account = (result && result.account) || pca.getAllAccounts()[0] || null;
    if (account) pca.setActiveAccount(account);
    return { configured: true, account, redirectUri: redirectUri() };
  }

  function signIn(loginHint) {
    if (!pca) throw new Error("Mail sign-in is not connected yet.");
    const hint = loginHint || (window.DART_MAIL_CONFIG && window.DART_MAIL_CONFIG.account) || "";
    return pca.loginRedirect({ scopes: SCOPES, loginHint: hint });
  }

  async function token() {
    if (!account) throw new Error("Sign in required");
    const req = { scopes: SCOPES, account };
    try {
      const silent = await pca.acquireTokenSilent(req);
      return silent.accessToken;
    } catch (err) {
      await pca.acquireTokenRedirect(req);
      throw err;
    }
  }

  function signOut() {
    return pca.logoutRedirect({ account });
  }

  function clearConnection() {
    localStorage.removeItem("dartmail.clientId");
    localStorage.removeItem("dartmail.tenantId");
  }

  window.DartAuth = { init, signIn, token, signOut, cfg, redirectUri, configured, clearConnection, scopes: SCOPES };
})();
