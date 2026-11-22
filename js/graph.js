(function () {
  async function graph(path, options) {
    const opts = options || {};
    const token = await window.DartAuth.token();
    const url = path.startsWith("http") ? path : "https://graph.microsoft.com/v1.0" + path;
    const headers = Object.assign({
      Authorization: "Bearer " + token,
      Accept: "application/json",
    }, opts.headers || {});
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    }
    if (!res.ok) {
      const message = (data && data.error && data.error.message) || res.statusText || "Graph request failed";
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  window.DartGraph = { graph };
})();
