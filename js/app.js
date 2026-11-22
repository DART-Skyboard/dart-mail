(function () {
  const $ = (id) => document.getElementById(id);
  const graph = (path, opts) => window.DartGraph.graph(path, opts);
  const SELECT = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,parentFolderId";
  const ORDER = ["inbox", "drafts", "sentitems", "archive", "junkemail", "deleteditems"];

  const state = {
    folders: [],
    folderId: null,
    messages: [],
    next: null,
    selected: null,
    open: null,
    search: "",
    mode: "new",
    replyId: null,
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "\u0026amp;")
      .replace(/</g, "\u0026lt;")
      .replace(/>/g, "\u0026gt;")
      .replace(/"/g, "\u0026quot;")
      .replace(/'/g, "\u0026#39;");
  }

  function textToHtml(text) {
    return esc(text).replace(/\n/g, "<br>");
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    doc.querySelectorAll("script, iframe, object, embed, link, meta").forEach((node) => node.remove());
    doc.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "srcdoc") el.removeAttribute(attr.name);
        if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      });
    });
    return doc.body.innerHTML;
  }

  function person(entry) {
    if (!entry || !entry.emailAddress) return "";
    return entry.emailAddress.name || entry.emailAddress.address || "";
  }

  function people(list) {
    return (list || []).map(person).filter(Boolean).join(", ");
  }

  function when(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(undefined, sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" }).format(date);
  }

  function status(text) {
    $("status").textContent = text;
  }

  function toast(error) {
    const message = error && error.message ? error.message : String(error);
    if (!$("shell").hidden) status(message);
    if (!$("gate").hidden) $("gate-error").textContent = message;
  }

  function addresses(value) {
    return String(value || "").split(/[,;]/).map((part) => part.trim()).filter(Boolean).map((address) => ({
      emailAddress: { address },
    }));
  }

  async function fetchFolders(path, withKnown) {
    const select = "id,displayName,parentFolderId,unreadItemCount,totalItemCount,childFolderCount" + (withKnown ? ",wellKnownName" : "");
    const data = await graph(path + "?$top=80&$select=" + select);
    const out = [];
    for (const folder of data.value || []) {
      if (!withKnown) folder.wellKnownName = "";
      out.push(folder);
      if (folder.childFolderCount > 0) {
        const kids = await fetchFolders("/me/mailFolders/" + folder.id + "/childFolders", withKnown);
        out.push(...kids);
      }
    }
    return out;
  }

  async function loadFolders() {
    try {
      state.folders = await fetchFolders("/me/mailFolders", true);
    } catch (err) {
      state.folders = await fetchFolders("/me/mailFolders", false);
    }
    state.folders.sort((a, b) => {
      const ia = ORDER.indexOf(a.wellKnownName || "");
      const ib = ORDER.indexOf(b.wellKnownName || "");
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.displayName.localeCompare(b.displayName);
    });
    if (!state.folderId) {
      const inbox = state.folders.find((folder) => folder.wellKnownName === "inbox") || state.folders[0];
      state.folderId = inbox ? inbox.id : null;
    }
    renderFolders();
  }

  function depth(folder) {
    const byId = new Map(state.folders.map((item) => [item.id, item]));
    let id = folder.parentFolderId;
    let level = 0;
    while (id && byId.has(id) && level < 8) {
      level += 1;
      id = byId.get(id).parentFolderId;
    }
    return level;
  }

  function renderFolders() {
    const nav = $("folders");
    const tools = document.createElement("div");
    tools.className = "folder-tools";
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "New folder";
    add.addEventListener("click", createFolder);
    tools.appendChild(add);
    nav.replaceChildren(tools);
    state.folders.forEach((folder) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder" + (folder.id === state.folderId ? " active" : "");
      button.style.paddingLeft = (10 + depth(folder) * 14) + "px";
      const name = document.createElement("span");
      name.textContent = folder.displayName;
      button.appendChild(name);
      if (folder.unreadItemCount) {
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = String(folder.unreadItemCount);
        button.appendChild(count);
      }
      button.addEventListener("click", () => openFolder(folder.id));
      nav.appendChild(button);
    });
  }

  async function createFolder() {
    const name = window.prompt("Folder name");
    if (!name) return;
    await graph("/me/mailFolders", { method: "POST", body: { displayName: name.trim() } });
    await loadFolders();
    status("Folder added");
  }

  async function loadMessages(append) {
    if (!state.folderId && !state.search) return;
    let path;
    const headers = {};
    if (append && state.next) {
      path = state.next;
    } else if (state.search) {
      headers.ConsistencyLevel = "eventual";
      path = "/me/messages?$top=30&$search=" + encodeURIComponent('"' + state.search.replace(/"/g, "") + '"') + "&$select=" + SELECT;
    } else {
      path = "/me/mailFolders/" + state.folderId + "/messages?$top=30&$orderby=receivedDateTime%20desc&$select=" + SELECT;
    }
    const data = await graph(path, { headers });
    const batch = data.value || [];
    state.messages = append ? state.messages.concat(batch) : batch;
    state.next = data["@odata.nextLink"] || null;
    renderList();
  }

  function renderList() {
    const list = $("list");
    if (!state.messages.length) {
      list.innerHTML = '<p class="empty">Nothing in this folder.</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    state.messages.forEach((message) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message" + (message.isRead ? "" : " unread") + (message.id === state.selected ? " active" : "");
      button.innerHTML =
        '<span class="when">' + esc(when(message.receivedDateTime)) + "</span>" +
        '<div class="from">' + esc(person(message.from) || "(no sender)") + "</div>" +
        '<div class="subject">' + esc(message.subject || "(no subject)") + "</div>" +
        '<div class="preview">' + esc(message.bodyPreview || "") + "</div>";
      button.addEventListener("click", () => openMessage(message.id));
      frag.appendChild(button);
    });
    list.replaceChildren(frag);
    if (state.next) {
      const more = document.createElement("button");
      more.className = "more";
      more.type = "button";
      more.textContent = "Load more";
      more.addEventListener("click", () => loadMessages(true).catch(toast));
      list.appendChild(more);
    }
  }

  async function openMessage(id) {
    state.selected = id;
    renderList();
    const message = await graph("/me/messages/" + id + "?$select=" + SELECT + ",body,replyTo");
    state.open = message;
    if (!message.isRead) {
      await graph("/me/messages/" + id, { method: "PATCH", body: { isRead: true } });
      const row = state.messages.find((item) => item.id === id);
      if (row) row.isRead = true;
      renderList();
      loadFolders().catch(() => {});
    }
    let attachments = [];
    if (message.hasAttachments) {
      const data = await graph("/me/messages/" + id + "/attachments?$top=20&$select=id,name,size,contentType,isInline");
      attachments = data.value || [];
    }
    renderReader(message, attachments);
  }

  function renderReader(message, attachments) {
    const reader = $("reader");
    const html = message.body && message.body.contentType === "html"
      ? sanitize(message.body.content)
      : textToHtml(message.body ? message.body.content : message.bodyPreview);
    reader.innerHTML =
      "<h2>" + esc(message.subject || "(no subject)") + "</h2>" +
      '<p class="meta">From ' + esc(person(message.from)) + "<br>To " + esc(people(message.toRecipients) || "—") +
      (message.ccRecipients && message.ccRecipients.length ? "<br>Cc " + esc(people(message.ccRecipients)) : "") +
      "<br>" + esc(new Date(message.receivedDateTime).toLocaleString()) + "</p>" +
      '<div class="reader-actions"></div>' +
      '<ul class="attachments"></ul>' +
      '<div class="body"></div>';
    reader.querySelector(".body").innerHTML = html;
    const actions = reader.querySelector(".reader-actions");
    [["Reply", () => startCompose("reply")], ["Forward", () => startCompose("forward")], ["Unread", markUnread], ["Delete", removeMessage]].forEach(([label, fn]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => fn().catch(toast));
      actions.appendChild(button);
    });
    const list = reader.querySelector(".attachments");
    attachments.filter((item) => !item.isInline).forEach((item) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = (item.name || "Attachment") + (item.size ? " (" + Math.ceil(item.size / 1024) + " KB)" : "");
      button.addEventListener("click", () => downloadAttachment(message.id, item).catch(toast));
      li.appendChild(button);
      list.appendChild(li);
    });
  }

  async function downloadAttachment(messageId, item) {
    const full = await graph("/me/messages/" + messageId + "/attachments/" + item.id);
    if (!full.contentBytes) throw new Error("This attachment has to be opened in Outlook.");
    const binary = atob(full.contentBytes);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: full.contentType || "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = full.name || "attachment";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function markUnread() {
    if (!state.selected) return;
    await graph("/me/messages/" + state.selected, { method: "PATCH", body: { isRead: false } });
    await refresh(false);
  }

  async function removeMessage() {
    if (!state.selected) return;
    const trash = state.folders.find((folder) => folder.wellKnownName === "deleteditems");
    if (trash && state.folderId !== trash.id) {
      await graph("/me/messages/" + state.selected + "/move", { method: "POST", body: { destinationId: trash.id } });
    } else {
      await graph("/me/messages/" + state.selected, { method: "DELETE" });
    }
    state.selected = null;
    state.open = null;
    $("reader").innerHTML = '<p class="empty">Message removed.</p>';
    await refresh(false);
  }

  function startCompose(mode) {
    state.mode = mode || "new";
    state.replyId = state.open ? state.open.id : null;
    $("compose-title").textContent = mode === "reply" ? "Reply" : mode === "forward" ? "Forward" : "New message";
    $("compose-to").value = mode === "reply" && state.open ? ((state.open.from && state.open.from.emailAddress && state.open.from.emailAddress.address) || "") : "";
    $("compose-cc").value = "";
    $("compose-subject").value = state.open && mode !== "new" ? ((mode === "forward" ? "FW: " : "RE: ") + (state.open.subject || "")) : "";
    $("compose-body").value = "";
    $("compose-to").disabled = mode !== "new";
    $("compose").showModal();
  }

  async function sendCompose(event) {
    event.preventDefault();
    const send = $("compose-send");
    send.disabled = true;
    try {
      const note = $("compose-body").value;
      if (state.mode === "new") {
        await graph("/me/sendMail", {
          method: "POST",
          body: {
            saveToSentItems: true,
            message: {
              subject: $("compose-subject").value,
              body: { contentType: "HTML", content: textToHtml(note) },
              toRecipients: addresses($("compose-to").value),
              ccRecipients: addresses($("compose-cc").value),
            },
          },
        });
      } else {
        const action = state.mode === "forward" ? "createForward" : "createReply";
        const draft = await graph("/me/messages/" + state.replyId + "/" + action, { method: "POST" });
        const prior = draft.body && draft.body.content ? draft.body.content : "";
        await graph("/me/messages/" + draft.id, {
          method: "PATCH",
          body: {
            subject: $("compose-subject").value,
            body: { contentType: "HTML", content: textToHtml(note) + "<br><br>" + prior },
          },
        });
        await graph("/me/messages/" + draft.id + "/send", { method: "POST" });
      }
      $("compose").close();
      status("Sent through Microsoft 365");
      await refresh(false);
    } finally {
      send.disabled = false;
    }
  }

  async function openFolder(id) {
    state.folderId = id;
    state.search = "";
    $("search").value = "";
    state.selected = null;
    $("reader").innerHTML = '<p class="empty">Select a message.</p>';
    renderFolders();
    await loadMessages(false);
  }

  async function refresh(quiet) {
    await loadFolders();
    await loadMessages(false);
    if (!quiet) status("Synced " + new Date().toLocaleTimeString());
  }

  function initials(account) {
    const name = (account && (account.name || account.username)) || "JV";
    const parts = String(name).replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
    return ((parts[0] || "J")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  function paintAvatar(el, url, account) {
    el.replaceChildren();
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      el.appendChild(img);
      return;
    }
    el.textContent = initials(account);
  }

  async function microsoftPhoto() {
    const token = await window.DartAuth.token();
    const res = await fetch("https://graph.microsoft.com/v1.0/me/photo/$value", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return "";
    return URL.createObjectURL(await res.blob());
  }

  async function showPicture(account) {
    const custom = localStorage.getItem("dartmail.avatar") || "";
    let url = custom;
    if (!url) {
      try { url = await microsoftPhoto(); } catch (err) { url = ""; }
    }
    paintAvatar($("avatar"), url, account);
  }

  function showMail(account) {
    $("gate").hidden = true;
    $("shell").hidden = false;
    $("avatar").hidden = false;
    $("who").textContent = (account && account.username) || "";
    paintAvatar($("avatar"), localStorage.getItem("dartmail.avatar") || "", account);
    showPicture(account);
    refresh(true).then(() => status("Synced " + new Date().toLocaleTimeString())).catch(toast);
    window.setInterval(() => refresh(true).catch(() => {}), 45000);
  }

  function showGate() {
    $("gate").hidden = false;
    $("shell").hidden = true;
    $("avatar").hidden = true;
    $("who").textContent = "";
  }

  $("signin-form").addEventListener("submit", (event) => {
    event.preventDefault();
    window.DartAuth.signIn($("email").value.trim()).catch(toast);
  });
  $("avatar").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        localStorage.setItem("dartmail.avatar", String(reader.result || ""));
        paintAvatar($("avatar"), localStorage.getItem("dartmail.avatar"), { username: $("who").textContent });
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });
  $("signout").addEventListener("click", () => window.DartAuth.signOut());
  $("sync").addEventListener("click", () => refresh(false).catch(toast));
  $("compose-open").addEventListener("click", () => startCompose("new"));
  $("compose-close").addEventListener("click", () => $("compose").close());
  $("compose-cancel").addEventListener("click", () => $("compose").close());
  $("compose-form").addEventListener("submit", (event) => sendCompose(event).catch(toast));
  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.search = $("search").value.trim();
    loadMessages(false).catch(toast);
  });

  window.DartAuth.init().then((info) => {
    showGate();
    if (info.account) showMail(info.account);
  }).catch((error) => {
    showGate();
    toast(error);
  });
})();
