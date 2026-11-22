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
    checked: new Set(),
    selecting: false,
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
    state.folders = orderFolders(state.folders);
    if (!state.folderId) {
      const inbox = state.folders.find((folder) => folder.wellKnownName === "inbox" || String(folder.displayName || "").toLowerCase() === "inbox") || state.folders[0];
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

  function folderRank(folder) {
    const known = String(folder.wellKnownName || "").toLowerCase();
    const name = String(folder.displayName || "").toLowerCase();
    if (known === "inbox" || name === "inbox") return 0;
    const order = ["drafts", "sentitems", "archive", "junkemail", "deleteditems"];
    const byName = { drafts: 1, "sent items": 2, sent: 2, archive: 3, "junk email": 4, junk: 4, "deleted items": 5, trash: 5 };
    const index = order.indexOf(known);
    if (index !== -1) return index + 1;
    if (byName[name] != null) return byName[name];
    return 50;
  }

  function orderFolders(folders) {
    const ids = new Set(folders.map((folder) => folder.id));
    const children = new Map();
    const roots = [];
    folders.forEach((folder) => {
      if (folder.parentFolderId && ids.has(folder.parentFolderId)) {
        if (!children.has(folder.parentFolderId)) children.set(folder.parentFolderId, []);
        children.get(folder.parentFolderId).push(folder);
      } else {
        roots.push(folder);
      }
    });
    const out = [];
    const walk = (list) => {
      list.sort((a, b) => folderRank(a) - folderRank(b) || a.displayName.localeCompare(b.displayName));
      list.forEach((folder) => {
        out.push(folder);
        if (children.has(folder.id)) walk(children.get(folder.id));
      });
    };
    walk(roots);
    return out;
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

  function knownFolder(name) {
    return state.folders.find((folder) => folder.wellKnownName === name) || null;
  }

  function renderSelection() {
    const on = state.selecting;
    $("select-toggle").textContent = on ? "Cancel" : "Select";
    $("select-all").hidden = !on;
    $("bulk-archive").hidden = !on;
    $("bulk-delete").hidden = !on;
    $("bulk-move").hidden = !on;
    $("select-count").textContent = on ? state.checked.size + " selected" : "";
    $("list-col").classList.toggle("selecting", on);
    const move = $("bulk-move");
    move.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Move";
    move.appendChild(placeholder);
    state.folders.forEach((folder) => {
      if (folder.id === state.folderId) return;
      const option = document.createElement("option");
      option.value = folder.id;
      option.textContent = folder.displayName;
      move.appendChild(option);
    });
  }

  function toggleChecked(id) {
    if (state.checked.has(id)) state.checked.delete(id);
    else state.checked.add(id);
    renderList();
  }

  function bindSwipe(row, message) {
    const front = row.querySelector(".msg-front");
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let tracking = false;
    let horizontal = false;
    let timer = 0;
    let suppress = false;
    let revealed = "";

    function place(x, snap) {
      front.style.transition = snap ? "transform 0.16s ease" : "none";
      front.style.transform = "translateX(" + x + "px)";
      row.classList.toggle("show-delete", x < -20);
      row.classList.toggle("show-archive", x > 20);
    }

    row.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || state.selecting) return;
      tracking = true;
      horizontal = false;
      dx = 0;
      startX = event.clientX;
      startY = event.clientY;
      timer = window.setTimeout(() => {
        if (!tracking) return;
        horizontal = true;
        revealed = dx > 12 ? "archive" : "delete";
        place(revealed === "archive" ? 88 : -88, true);
      }, 460);
    });
    row.addEventListener("pointermove", (event) => {
      if (!tracking) return;
      dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!horizontal) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          window.clearTimeout(timer);
          tracking = false;
          return;
        }
        if (Math.abs(dx) < 8) return;
        horizontal = true;
        window.clearTimeout(timer);
        row.setPointerCapture(event.pointerId);
      }
      place(Math.max(-168, Math.min(168, dx)), false);
    });
    function finish() {
      window.clearTimeout(timer);
      if (!tracking) return;
      tracking = false;
      if (revealed && Math.abs(dx) < 48) {
        suppress = true;
        return;
      }
      revealed = "";
      if (!horizontal) {
        place(0, true);
        return;
      }
      if (dx <= -120) {
        suppress = true;
        trashMessages([message.id]).catch(toast);
        return;
      }
      if (dx >= 120) {
        suppress = true;
        archiveMessages([message.id]).catch(toast);
        return;
      }
      if (dx <= -48) {
        suppress = true;
        place(-88, true);
        return;
      }
      if (dx >= 48) {
        suppress = true;
        place(88, true);
        return;
      }
      place(0, true);
    }
    row.addEventListener("pointerup", finish);
    row.addEventListener("pointercancel", () => {
      window.clearTimeout(timer);
      tracking = false;
      place(0, true);
    });
    front.addEventListener("click", () => {
      if (suppress) {
        suppress = false;
        return;
      }
      if (state.selecting) {
        toggleChecked(message.id);
        return;
      }
      openMessage(message.id).catch(toast);
    });
    row.querySelector(".swipe-delete").addEventListener("click", (event) => {
      event.stopPropagation();
      trashMessages([message.id]).catch(toast);
    });
    row.querySelector(".swipe-archive").addEventListener("click", (event) => {
      event.stopPropagation();
      archiveMessages([message.id]).catch(toast);
    });
  }

  function renderList() {
    const list = $("list");
    renderSelection();
    if (!state.messages.length) {
      list.innerHTML = '<p class="empty">Nothing in this folder.</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    state.messages.forEach((message) => {
      const row = document.createElement("div");
      row.className = "msg" + (message.isRead ? "" : " unread") + (message.id === state.selected ? " active" : "") + (state.checked.has(message.id) ? " checked" : "");
      row.innerHTML =
        '<button type="button" class="swipe-archive">Archive</button>' +
        '<button type="button" class="swipe-delete">Delete</button>' +
        '<div class="msg-front">' +
        '<span class="tick" aria-hidden="true"></span>' +
        '<span class="when">' + esc(when(message.receivedDateTime)) + "</span>" +
        '<div class="from">' + esc(person(message.from) || "(no sender)") + "</div>" +
        '<div class="subject">' + esc(message.subject || "(no subject)") + "</div>" +
        '<div class="preview">' + esc(message.bodyPreview || "") + "</div>" +
        "</div>";
      bindSwipe(row, message);
      frag.appendChild(row);
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

  async function moveMessages(ids, destinationId) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) return;
    if (!destinationId) throw new Error("Pick a folder");
    for (let i = 0; i < list.length; i += 20) {
      const slice = list.slice(i, i + 20);
      const data = await graph("/$batch", {
        method: "POST",
        body: {
          requests: slice.map((id, index) => ({
            id: String(index + 1),
            method: "POST",
            url: "/me/messages/" + encodeURIComponent(id) + "/move",
            headers: { "Content-Type": "application/json" },
            body: { destinationId },
          })),
        },
      });
      const failed = (data && data.responses || []).find((item) => item.status >= 400);
      if (failed) {
        const message = failed.body && failed.body.error && failed.body.error.message;
        throw new Error(message || "Microsoft did not move every message");
      }
    }
    finishBulk(list, list.length + " moved in Microsoft 365");
  }

  async function deleteMessages(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) return;
    for (let i = 0; i < list.length; i += 20) {
      const slice = list.slice(i, i + 20);
      const data = await graph("/$batch", {
        method: "POST",
        body: {
          requests: slice.map((id, index) => ({
            id: String(index + 1),
            method: "DELETE",
            url: "/me/messages/" + encodeURIComponent(id),
          })),
        },
      });
      const failed = (data && data.responses || []).find((item) => item.status >= 400);
      if (failed) {
        const message = failed.body && failed.body.error && failed.body.error.message;
        throw new Error(message || "Microsoft did not delete every message");
      }
    }
    finishBulk(list, list.length + " deleted in Microsoft 365");
  }

  function finishBulk(ids, label) {
    ids.forEach((id) => state.checked.delete(id));
    if (state.selected && ids.includes(state.selected)) {
      state.selected = null;
      state.open = null;
      $("reader").innerHTML = '<p class="empty">Select a message.</p>';
    }
    status(label);
    return refresh(true);
  }

  function trashMessages(ids) {
    const trash = knownFolder("deleteditems");
    if (trash && state.folderId !== trash.id) return moveMessages(ids, trash.id);
    return deleteMessages(ids);
  }

  function archiveMessages(ids) {
    const archive = knownFolder("archive");
    if (!archive) throw new Error("Archive folder was not found");
    if (state.folderId === archive.id) return Promise.resolve();
    return moveMessages(ids, archive.id);
  }

  function selectedIds() {
    return [...state.checked];
  }

  async function markUnread() {
    if (!state.selected) return;
    await graph("/me/messages/" + state.selected, { method: "PATCH", body: { isRead: false } });
    await refresh(false);
  }

  async function removeMessage() {
    if (!state.selected) return;
    await trashMessages([state.selected]);
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
    state.checked.clear();
    state.selecting = false;
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
  $("select-toggle").addEventListener("click", () => {
    state.selecting = !state.selecting;
    if (!state.selecting) state.checked.clear();
    renderList();
  });
  $("select-all").addEventListener("click", () => {
    if (state.checked.size === state.messages.length) state.checked.clear();
    else state.messages.forEach((message) => state.checked.add(message.id));
    renderList();
  });
  $("bulk-delete").addEventListener("click", () => trashMessages(selectedIds()).catch(toast));
  $("bulk-archive").addEventListener("click", () => archiveMessages(selectedIds()).catch(toast));
  $("bulk-move").addEventListener("change", (event) => {
    const destination = event.target.value;
    if (!destination) return;
    moveMessages(selectedIds(), destination).catch(toast);
  });
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
