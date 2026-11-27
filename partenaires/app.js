/* global document, window, location, fetch, sessionStorage, crypto, createImageBitmap, URL, Blob, setTimeout -- fournis par le navigateur. */
/**
 * Espace partenaire — le fonctionnement de la page.
 *
 * L'intervenant se connecte avec le compte de son app. La page lit trois choses au serveur
 * (migration 0022) : son compte (`partner_overview`), ses relevés (`partner_billing`) et, pour
 * une société, ses salariés (`partner_list_employees`). Une société agréée inscrit ses salariés
 * et dépose les photos de leurs pièces dans le seau privé `partner-documents`.
 *
 * Choix de construction :
 *   - aucune bibliothèque : la page parle au serveur avec `fetch`, comme la page du voyageur ;
 *   - la session vit dans `sessionStorage` : elle disparaît à la fermeture de l'onglet. C'est
 *     voulu — cette page montre des pièces d'identité, souvent sur un ordinateur de bureau partagé ;
 *   - ce que la page affiche vient du serveur et n'est JAMAIS injecté comme du HTML ;
 *   - une photo est réduite (1 600 px, JPEG) AVANT l'envoi : le serveur n'accepte que du JPEG
 *     de 3 Mo au plus, et une photo de téléphone en pèse souvent le triple ;
 *   - c'est le serveur qui décide de tout : qui est une société agréée, combien de fichiers,
 *     qui lit quoi. La page ne fait que demander, et explique les refus.
 */
(function () {
  "use strict";

  // ───────────────────────────── Réglages ─────────────────────────────

  var CONFIG = globalThis.AIRCLEAN_PARTNER_CONFIG || {};
  var BUCKET = "partner-documents";
  var SESSION_KEY = "airclean.partner.session";
  var MAX_SIDE = 1600;
  var TZ = "Europe/Paris";

  var $ = function (id) {
    return document.getElementById(id);
  };

  /** Fabrique un élément. Le texte passe par `textContent` : rien n'est interprété. */
  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      if (key === "class") node.className = props[key];
      else if (key === "text") node.textContent = props[key];
      else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), props[key]);
      else node.setAttribute(key, props[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  // ───────────────────────────── Textes ─────────────────────────────

  var ERRORS = {
    AC157: "Ce compte n'a pas de dossier d'intervenant.",
    AC158: "Cette rubrique est réservée aux sociétés partenaires dont le dossier est validé.",
    AC159: "Vérifiez la fiche : un nom, une adresse e-mail valide et, s'il y a un titre de séjour, une date de fin plausible.",
    AC160: "Cette adresse e-mail est déjà inscrite pour un autre de vos salariés.",
    AC161: "Vous avez atteint le nombre maximal de salariés. Écrivez-nous pour aller au-delà.",
    AC162: "Des pièces sont encore déposées pour ce salarié : supprimez-les d'abord.",
    AC163: "Ce salarié est introuvable. Rechargez la page.",
  };
  var STATUS = { candidate: "Dossier à compléter", pending_validation: "Dossier en cours d'examen", active: "Partenaire validé", suspended: "Suspendu" };
  var FORMS = { particulier: "Particulier (salarié du client)", auto_entrepreneur: "Auto-entrepreneur", societe: "Société" };
  var SERVICES = { menage: "Ménage", checkin: "Check-in, check-out", maintenance: "Petits travaux" };
  var MISSION_STATUS = { to_review: "À valider", validated: "Validée", done: "Terminée" };
  var KINDS = { identity: "Pièce d'identité", permit: "Titre de séjour" };

  function messageOf(error) {
    if (error && ERRORS[error.code]) return ERRORS[error.code];
    if (error && error.network) return "Le serveur ne répond pas. Vérifiez votre connexion et réessayez.";
    if (error && error.status === 413) return "Cette photo est trop lourde.";
    if (error && (error.status === 403 || error.code === "42501")) return "Ce geste n'est pas autorisé pour votre compte.";
    return "Une erreur est survenue. Réessayez dans un instant.";
  }

  var euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
  var dayFormat = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  var monthFormat = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" });
  var dateFormat = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });

  /** « 2026-11 » → « novembre 2026 ». */
  function monthLabel(month) {
    return monthFormat.format(new Date(month + "-01T00:00:00Z"));
  }
  /** Le mois en cours à Paris, et le précédent, au format « AAAA-MM ». */
  function currentMonths() {
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date()).split("-");
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var prev = month === 1 ? [year - 1, 12] : [year, month - 1];
    return { now: parts[0] + "-" + parts[1], previous: prev[0] + "-" + String(prev[1]).padStart(2, "0") };
  }

  // ───────────────────────────── Serveur ─────────────────────────────

  var session = null;
  try {
    session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    session = null;
  }
  function keepSession(next) {
    session = next;
    try {
      if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* stockage refusé (navigation privée) : la session tient le temps de la page */
    }
  }

  /** Une requête au serveur. Rejette avec { status, code, message } (ou { network: true }). */
  function request(path, options) {
    var headers = Object.assign({ apikey: CONFIG.publicKey }, options.headers || {});
    if (options.auth !== false && session) headers.Authorization = "Bearer " + session.access_token;
    return fetch(CONFIG.supabaseUrl + path, { method: options.method || "POST", headers: headers, body: options.body }).then(
      function (response) {
        if (response.ok) return options.blob ? response.blob() : response.text().then(function (text) { return text ? JSON.parse(text) : null; });
        return response.text().then(function (text) {
          var body = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* réponse sans JSON */
          }
          throw { status: response.status, code: body.code || body.error_code || body.error || null, message: body.message || body.msg || body.error_description || "" };
        });
      },
      function () {
        throw { network: true };
      },
    );
  }

  /** Renouvelle la session ; rejette si elle n'est plus renouvelable. */
  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject({ status: 401 });
    return request("/auth/v1/token?grant_type=refresh_token", {
      auth: false,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    }).then(function (data) {
      keepSession({ access_token: data.access_token, refresh_token: data.refresh_token });
    });
  }

  /** Une requête authentifiée : si la session a expiré, on la renouvelle une fois et on rejoue. */
  function authed(path, options) {
    return request(path, options).catch(function (error) {
      if (error.status !== 401 && error.code !== "PGRST301" && error.code !== "PGRST303") throw error;
      return refresh().then(
        function () {
          return request(path, options);
        },
        function () {
          keepSession(null);
          showLogin("Votre session a expiré. Reconnectez-vous.");
          throw { status: 401, handled: true };
        },
      );
    });
  }

  function rpc(name, args) {
    return authed("/rest/v1/rpc/" + name, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(args || {}) });
  }
  function upload(path, blob) {
    return authed("/storage/v1/object/" + BUCKET + "/" + path, { headers: { "Content-Type": "image/jpeg" }, body: blob });
  }
  function removeFiles(paths) {
    if (!paths.length) return Promise.resolve();
    return authed("/storage/v1/object/" + BUCKET, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }) }).then(
      function (gone) {
        // Le stockage répond « 200 » même s'il n'a rien supprimé : on compte.
        if (!Array.isArray(gone) || gone.length !== paths.length) throw { status: 403 };
      },
    );
  }
  function download(path) {
    return authed("/storage/v1/object/authenticated/" + BUCKET + "/" + path, { method: "GET", blob: true });
  }

  // ───────────────────────────── Photos ─────────────────────────────

  /** Réduit une image à 1 600 px de côté au plus et la rend en JPEG. Rejette si elle est illisible. */
  function toJpeg(file) {
    return createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      var context = canvas.getContext("2d");
      // Fond blanc : une image PNG transparente deviendrait noire en JPEG.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) { return blob ? resolve(blob) : reject({ unreadable: true }); }, "image/jpeg", 0.85);
      });
    }, function () {
      throw { unreadable: true };
    });
  }

  // ───────────────────────────── Écrans ─────────────────────────────

  var overview = null;
  var billing = null;
  var employees = [];

  function show(view) {
    ["view-login", "view-none", "view-app"].forEach(function (id) {
      $(id).hidden = id !== view;
    });
    $("loading").hidden = true;
    $("who").hidden = view === "view-login";
  }
  function banner(text) {
    $("banner").textContent = text || "";
    $("banner").hidden = !text;
  }
  function showLogin(reason) {
    show("view-login");
    $("login-error").textContent = reason || "";
    $("login-error").hidden = !reason;
    $("login-password").value = "";
  }

  function start() {
    banner("");
    if (!session) return showLogin();
    $("loading").hidden = false;
    rpc("partner_overview").then(
      function (data) {
        overview = data;
        $("who-name").textContent = data.profile.full_name || data.profile.email;
        $("nav-salaries").hidden = !data.is_company;
        show("view-app");
        renderAccount();
        route();
        loadBilling();
        if (data.is_company) loadEmployees();
      },
      function (error) {
        if (error.handled) return;
        if (error.code === "AC157") {
          $("who-name").textContent = "";
          return show("view-none");
        }
        show("view-app");
        $("view-app").hidden = true;
        banner(messageOf(error));
      },
    );
  }

  /** La rubrique affichée suit l'adresse (#releves, #salaries, #compte). */
  function route() {
    if (!overview) return;
    var wanted = location.hash.replace("#", "");
    if (["releves", "salaries", "compte"].indexOf(wanted) < 0 || (wanted === "salaries" && !overview.is_company)) wanted = "releves";
    ["releves", "salaries", "compte"].forEach(function (tab) {
      $("tab-" + tab).hidden = tab !== wanted;
    });
    document.querySelectorAll(".tabs a").forEach(function (a) {
      if (a.dataset.tab === wanted) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  // ── Mon compte ──
  function renderAccount() {
    var r = overview.runner;
    var rows = [
      ["Nom", overview.profile.full_name || "—"],
      ["Adresse e-mail", overview.profile.email],
      ["Téléphone", overview.profile.phone || "—"],
      ["Statut", FORMS[r.legal_form] || r.legal_form],
      ["SIRET", r.siret ? r.siret + (r.siret_verified ? " (vérifié)" : " (non vérifié)") : "—"],
      ["Prestations", (r.services || []).map(function (s) { return SERVICES[s] || s; }).join(", ") || "—"],
      ["Dossier", STATUS[r.status] || r.status],
      ["Partenaire depuis", dateFormat.format(new Date(r.created_at))],
    ];
    var list = $("account");
    list.replaceChildren();
    rows.forEach(function (row) {
      list.appendChild(el("dt", { text: row[0] }));
      list.appendChild(el("dd", { text: row[1] }));
    });
  }

  // ── Relevés ──
  function loadBilling() {
    rpc("partner_billing").then(
      function (data) {
        billing = data;
        renderBilling();
      },
      function (error) {
        if (!error.handled) $("months").replaceChildren(el("p", { class: "empty", text: messageOf(error) }));
      },
    );
  }

  function renderBilling() {
    var months = billing.months || [];
    var lines = billing.lines || [];
    var which = currentMonths();
    var totalOf = function (month) {
      var found = months.filter(function (m) { return m.month === month; })[0];
      return found ? Number(found.total_eur) : 0;
    };
    // Somme faite en centimes : des euros à virgule additionnés tels quels dérivent.
    var all = months.reduce(function (sum, m) { return sum + Math.round(Number(m.total_eur) * 100); }, 0) / 100;

    var totals = $("totals");
    totals.replaceChildren(
      el("div", {}, [el("b", { text: euros.format(totalOf(which.now)) }), el("span", { text: "ce mois-ci" })]),
      el("div", {}, [el("b", { text: euros.format(totalOf(which.previous)) }), el("span", { text: "le mois dernier" })]),
      el("div", {}, [el("b", { text: euros.format(all) }), el("span", { text: "depuis le début" })]),
    );

    $("billing-note").textContent =
      overview.runner.legal_form === "particulier"
        ? "Vous êtes salarié des clients chez qui vous intervenez : ces montants sont ceux des interventions, pas votre salaire net. Le montant exact figure sur chaque déclaration CESU."
        : "Ces montants sont votre part prévue pour chaque intervention rendue, validée ou terminée. Ce relevé n'est pas une facture, et la date du versement n'est pas encore suivie ici.";
    $("export-csv").hidden = lines.length === 0;

    var box = $("months");
    box.replaceChildren();
    if (!months.length) {
      box.appendChild(el("p", { class: "empty", text: "Aucune intervention terminée pour l'instant. Vos relevés apparaîtront ici, mois par mois." }));
      return;
    }
    var oldest = lines.length ? lines[lines.length - 1].scheduled_at : null;
    months.forEach(function (m, index) {
      var mine = lines.filter(function (l) { return monthOf(l.scheduled_at) === m.month; });
      var body;
      if (mine.length) {
        body = el("div", { class: "scroll" }, [
          el("table", {}, [
            el("thead", {}, [el("tr", {}, [el("th", { text: "Date" }), el("th", { text: "Prestation" }), el("th", { text: "Lieu" }), el("th", { text: "État" }), el("th", { class: "num", text: "Montant" })])]),
            el("tbody", {}, mine.map(function (l) {
              return el("tr", {}, [
                el("td", { text: dayFormat.format(new Date(l.scheduled_at)) }),
                el("td", { text: SERVICES[l.category] || l.category }),
                el("td", { text: [l.postcode, l.city].filter(Boolean).join(" ") || "—" }),
                el("td", { text: MISSION_STATUS[l.status] || l.status }),
                el("td", { class: "num", text: euros.format(Number(l.payout_eur)) }),
              ]);
            })),
          ]),
        ]);
      } else {
        body = el("p", { class: "note", text: "Le détail de ce mois n'est plus affiché ici (seules les 300 interventions les plus récentes le sont)." });
      }
      var block = el("details", { class: "month" }, [
        el("summary", {}, [
          el("b", { text: monthLabel(m.month) }),
          el("span", { text: m.count + (m.count > 1 ? " interventions" : " intervention") }),
          el("strong", { text: euros.format(Number(m.total_eur)) }),
        ]),
        body,
      ]);
      if (index === 0) block.open = true;
      // Un mois dont une partie seulement du détail est connue : le dire plutôt que d'afficher un tableau incomplet.
      if (mine.length && mine.length < m.count && oldest) {
        block.appendChild(el("p", { class: "note", text: "Détail partiel : seules les 300 interventions les plus récentes sont listées." }));
      }
      box.appendChild(block);
    });
  }

  function monthOf(iso) {
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date(iso)).split("-");
    return parts[0] + "-" + parts[1];
  }

  /** Le détail en CSV (séparateur « ; », virgule décimale : s'ouvre tel quel dans un tableur français). */
  function exportCsv() {
    var cell = function (value) {
      var text = String(value == null ? "" : value);
      // Une cellule qui commence par = + - @ serait lue comme une formule par un tableur.
      if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    var rows = [["Date", "Prestation", "Code postal", "Ville", "État", "Montant (EUR)"]].concat(
      (billing.lines || []).map(function (l) {
        return [dayFormat.format(new Date(l.scheduled_at)), SERVICES[l.category] || l.category, l.postcode || "", l.city || "", MISSION_STATUS[l.status] || l.status, Number(l.payout_eur).toFixed(2).replace(".", ",")];
      }),
    );
    var text = "﻿" + rows.map(function (row) { return row.map(cell).join(";"); }).join("\r\n");
    var url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    var link = el("a", { href: url, download: "releve-airclean.csv" });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ── Salariés ──
  function loadEmployees() {
    return rpc("partner_list_employees").then(
      function (data) {
        employees = data || [];
        renderEmployees();
      },
      function (error) {
        if (!error.handled) $("employees").replaceChildren(el("p", { class: "empty", text: messageOf(error) }));
      },
    );
  }

  function stateBadge(employee) {
    if (employee.state === "registered") return el("span", { class: "badge", text: "Inscrit" });
    if (employee.state === "permit_expired") return el("span", { class: "badge danger", text: "Titre de séjour expiré" });
    return el("span", { class: "badge warn", text: "Pièces manquantes" });
  }

  function renderEmployees() {
    var can = overview.can_manage_employees;
    $("employee-add").hidden = !can;
    $("employees-note").textContent = can
      ? "Inscrivez ici les salariés qui interviennent pour votre société : un nom, une adresse e-mail, la photo d'une pièce d'identité et, si besoin, celle du titre de séjour. Un salarié est inscrit dès que ses pièces sont déposées. Vous restez son employeur et responsable de ces vérifications."
      : "Votre dossier de société n'est pas validé pour l'instant : vous pouvez consulter et retirer vos salariés, mais pas en inscrire de nouveaux.";

    var box = $("employees");
    box.replaceChildren();
    if (!employees.length) {
      box.appendChild(el("p", { class: "empty", text: can ? "Aucun salarié inscrit. Commencez par « Inscrire un salarié »." : "Aucun salarié inscrit." }));
      return;
    }
    employees.forEach(function (employee) {
      var docs = el("div", { class: "docs" });
      if (!employee.documents.length) docs.appendChild(el("span", { text: "Aucune pièce déposée." }));
      employee.documents.forEach(function (doc) {
        var same = employee.documents.filter(function (d) { return d.kind === doc.kind; });
        var label = (KINDS[doc.kind] || doc.kind) + (same.length > 1 ? " " + (same.indexOf(doc) + 1) : "");
        docs.appendChild(el("button", { type: "button", class: "btn ghost small", text: label, onclick: function () { openViewer(doc.path, label + " de " + employee.full_name); } }));
      });
      if (employee.needs_permit && employee.permit_expires_on) {
        docs.appendChild(el("span", { text: "Titre valable jusqu'au " + dateFormat.format(new Date(employee.permit_expires_on + "T00:00:00Z")) }));
      }
      var actions = el("div", { class: "actions" }, [
        can ? el("button", { type: "button", class: "btn ghost small", text: "Modifier", onclick: function () { openEmployee(employee); } }) : null,
        el("button", { type: "button", class: "btn ghost small", text: "Retirer", onclick: function () { askRemove(employee); } }),
      ]);
      box.appendChild(
        el("article", { class: "employee" }, [
          el("header", {}, [el("div", {}, [el("h3", { text: employee.full_name }), el("p", { class: "mail", text: employee.email || "—" })]), stateBadge(employee)]),
          docs,
          actions,
        ]),
      );
    });
  }

  // ── Lecture d'une pièce ──
  var viewerUrl = null;
  function openViewer(path, label) {
    banner("");
    download(path).then(
      function (blob) {
        if (viewerUrl) URL.revokeObjectURL(viewerUrl);
        viewerUrl = URL.createObjectURL(blob);
        $("viewer-img").src = viewerUrl;
        $("viewer-img").alt = label;
        $("viewer").showModal();
      },
      function (error) {
        if (!error.handled) banner("Cette pièce n'a pas pu être affichée. " + messageOf(error));
      },
    );
  }
  function closeViewer() {
    $("viewer").close();
    $("viewer-img").removeAttribute("src");
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  }

  // ── Fiche d'un salarié (inscription ou correction) ──
  var editing = null; // la fiche en cours de correction, ou null pour une inscription
  var lastSaved = null; // nom du salarié qui vient d'être inscrit (« à la chaîne »)
  var doomed = []; // pièces déjà déposées que l'utilisateur veut supprimer (faites à l'enregistrement)

  function openEmployee(employee) {
    editing = employee || null;
    doomed = [];
    $("employee-title").textContent = editing ? "Modifier " + editing.full_name : "Inscrire un salarié";
    $("emp-name").value = editing ? editing.full_name : "";
    $("emp-email").value = editing ? editing.email || "" : "";
    $("emp-permit").checked = editing ? editing.needs_permit : false;
    $("emp-until").value = editing && editing.permit_expires_on ? editing.permit_expires_on : "";
    $("emp-identity").value = "";
    $("emp-permit-file").value = "";
    $("emp-attest").checked = false;
    // L'attestation se donne à l'inscription ; une fiche ancienne qui n'en a pas la demande à sa première correction.
    $("emp-attest-row").hidden = Boolean(editing && editing.attested_at);
    $("emp-error").hidden = true;
    $("emp-submit").disabled = false;
    // « Enregistrer et inscrire le suivant » : pour inscrire ses salariés à la chaîne, sans refermer.
    $("emp-next").hidden = Boolean(editing);
    $("emp-next").disabled = false;
    $("emp-done").hidden = !lastSaved;
    $("emp-done").textContent = lastSaved ? "✓ " + lastSaved + " est inscrit. Au suivant." : "";
    lastSaved = null;
    renderDialogFiles();
    if (!$("employee-dialog").open) $("employee-dialog").showModal();
    $("emp-name").focus();
  }

  /** Les pièces déjà déposées, dans la fiche, avec de quoi en retirer une. */
  function renderDialogFiles() {
    $("emp-permit-box").hidden = !$("emp-permit").checked;
    [["identity", "emp-identity-files"], ["permit", "emp-permit-files"]].forEach(function (pair) {
      var list = $(pair[1]);
      list.replaceChildren();
      (editing ? editing.documents : [])
        .filter(function (d) { return d.kind === pair[0] && doomed.indexOf(d.path) < 0; })
        .forEach(function (doc, index) {
          list.appendChild(
            el("li", {}, [
              el("span", { text: KINDS[doc.kind] + " " + (index + 1) + " (déjà déposée)" }),
              el("button", { type: "button", class: "link", text: "Supprimer", onclick: function () { doomed.push(doc.path); renderDialogFiles(); } }),
            ]),
          );
        });
    });
  }

  function keptCount(kind) {
    return (editing ? editing.documents : []).filter(function (d) { return d.kind === kind && doomed.indexOf(d.path) < 0; }).length;
  }

  function fail(text) {
    $("emp-error").textContent = text;
    $("emp-error").hidden = false;
    $("emp-submit").disabled = false;
    $("emp-submit").textContent = "Enregistrer";
    $("emp-next").disabled = false;
  }

  function submitEmployee(event) {
    event.preventDefault();
    var chain = Boolean(event.submitter && event.submitter.id === "emp-next") && !editing;
    var name = $("emp-name").value.trim();
    var email = $("emp-email").value.trim();
    var needsPermit = $("emp-permit").checked;
    var until = needsPermit ? $("emp-until").value || null : null;
    var identity = Array.prototype.slice.call($("emp-identity").files);
    var permit = needsPermit ? Array.prototype.slice.call($("emp-permit-file").files) : [];
    var perKind = overview.limits.files_per_kind;

    // Les mêmes règles que le serveur, dites tout de suite et en clair.
    if (name.length < 2) return fail("Écrivez le nom et le prénom du salarié.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Écrivez une adresse e-mail valide pour ce salarié.");
    if (keptCount("identity") + identity.length < 1) return fail("Ajoutez la photo de la pièce d'identité.");
    if (keptCount("identity") + identity.length > perKind) return fail("Deux photos au plus pour la pièce d'identité (recto et verso).");
    if (needsPermit && keptCount("permit") + permit.length < 1) return fail("Ajoutez la photo du titre de séjour.");
    if (needsPermit && keptCount("permit") + permit.length > perKind) return fail("Deux photos au plus pour le titre de séjour (recto et verso).");
    if (needsPermit && !until) return fail("Indiquez la date de fin de validité du titre de séjour.");
    var mustAttest = !editing || !editing.attested_at;
    if (mustAttest && !$("emp-attest").checked) return fail("Cochez l'attestation pour inscrire ce salarié.");

    $("emp-error").hidden = true;
    $("emp-done").hidden = true;
    $("emp-submit").disabled = true;
    $("emp-next").disabled = true;
    $("emp-submit").textContent = "Préparation des photos…";

    // 1. Réduire toutes les photos AVANT d'écrire quoi que ce soit : une image illisible ne
    //    doit pas laisser une fiche à moitié faite.
    var files = identity.map(function (f) { return { kind: "identity", file: f }; }).concat(permit.map(function (f) { return { kind: "permit", file: f }; }));
    Promise.all(files.map(function (item) { return toJpeg(item.file).then(function (blob) { return { kind: item.kind, blob: blob }; }); }))
      .then(function (ready) {
        $("emp-submit").textContent = "Enregistrement…";
        // 2. Supprimer les pièces écartées ; si le salarié n'a plus besoin de titre, les siennes aussi.
        var remove = doomed.slice();
        if (editing && !needsPermit) {
          editing.documents.forEach(function (d) { if (d.kind === "permit" && remove.indexOf(d.path) < 0) remove.push(d.path); });
        }
        return removeFiles(remove)
          .then(function () {
            // 3. La fiche.
            return rpc("partner_save_employee", {
              p_id: editing ? editing.id : null,
              p_full_name: name,
              p_email: email,
              p_needs_permit: needsPermit,
              p_permit_expires_on: until,
              p_attested: mustAttest,
            });
          })
          .then(function (saved) {
            // 4. Les nouvelles pièces, l'une après l'autre (le serveur compte les fichiers).
            return ready.reduce(function (chain, item) {
              return chain.then(function () {
                return upload(overview.runner.id + "/" + saved.id + "/" + item.kind + "-" + crypto.randomUUID() + ".jpg", item.blob);
              });
            }, Promise.resolve());
          });
      })
      .then(
        function () {
          $("emp-submit").textContent = "Enregistrer";
          loadEmployees();
          if (chain) {
            lastSaved = name;
            openEmployee(null); // formulaire vidé, toujours ouvert : le salarié suivant
          } else {
            $("employee-dialog").close();
          }
        },
        function (error) {
          if (error.handled) return $("employee-dialog").close();
          // La fiche a pu être créée avant l'échec : on recharge pour montrer l'état réel.
          loadEmployees();
          fail(error.unreadable ? "Une des photos n'a pas pu être lue. Utilisez une photo JPEG ou PNG (pas un PDF)." : messageOf(error) + " Si la fiche apparaît dans la liste, rouvrez-la pour compléter ses pièces.");
        },
      );
  }

  // ── Retrait ──
  var leaving = null;
  function askRemove(employee) {
    leaving = employee;
    $("confirm-text").textContent = employee.full_name + " sera retiré de votre liste et ses pièces seront supprimées définitivement.";
    $("confirm-error").hidden = true;
    $("confirm-yes").disabled = false;
    $("confirm-dialog").showModal();
  }
  function confirmRemove() {
    $("confirm-yes").disabled = true;
    removeFiles(leaving.documents.map(function (d) { return d.path; }))
      .then(function () {
        return rpc("partner_remove_employee", { p_id: leaving.id });
      })
      .then(
        function () {
          $("confirm-dialog").close();
          loadEmployees();
        },
        function (error) {
          if (error.handled) return $("confirm-dialog").close();
          loadEmployees();
          $("confirm-error").textContent = messageOf(error);
          $("confirm-error").hidden = false;
          $("confirm-yes").disabled = false;
        },
      );
  }

  // ───────────────────────────── Connexion ─────────────────────────────

  function login(event) {
    event.preventDefault();
    var email = $("login-email").value.trim();
    var password = $("login-password").value;
    if (!email || !password) {
      $("login-error").textContent = "Écrivez votre adresse e-mail et votre mot de passe.";
      $("login-error").hidden = false;
      return;
    }
    $("login-submit").disabled = true;
    $("login-error").hidden = true;
    request("/auth/v1/token?grant_type=password", { auth: false, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: password }) }).then(
      function (data) {
        $("login-submit").disabled = false;
        keepSession({ access_token: data.access_token, refresh_token: data.refresh_token });
        start();
      },
      function (error) {
        $("login-submit").disabled = false;
        $("login-error").textContent = error.network
          ? messageOf(error)
          : error.status === 400 || error.status === 401
            ? "Adresse e-mail ou mot de passe incorrect."
            : error.status === 429
              ? "Trop d'essais. Patientez une minute avant de réessayer."
              : messageOf(error);
        $("login-error").hidden = false;
      },
    );
  }

  function logout() {
    var leavingSession = session;
    keepSession(null);
    overview = null;
    billing = null;
    employees = [];
    showLogin();
    if (leavingSession) {
      // Au mieux : même si le serveur ne répond pas, la page a déjà oublié la session.
      fetch(CONFIG.supabaseUrl + "/auth/v1/logout?scope=local", { method: "POST", headers: { apikey: CONFIG.publicKey, Authorization: "Bearer " + leavingSession.access_token } }).catch(function () {});
    }
  }

  // ───────────────────────────── Démarrage ─────────────────────────────

  if (!CONFIG.supabaseUrl || !CONFIG.publicKey || /service_role|^sb_secret_/.test(CONFIG.publicKey)) {
    $("loading").hidden = true;
    banner("Cette page n'est pas configurée. Prévenez AirClean.");
    return;
  }
  $("login-form").addEventListener("submit", login);
  $("logout").addEventListener("click", logout);
  $("export-csv").addEventListener("click", exportCsv);
  $("employee-add").addEventListener("click", function () { openEmployee(null); });
  $("employee-form").addEventListener("submit", submitEmployee);
  $("emp-permit").addEventListener("change", renderDialogFiles);
  $("emp-cancel").addEventListener("click", function () { $("employee-dialog").close(); });
  $("confirm-no").addEventListener("click", function () { $("confirm-dialog").close(); });
  $("confirm-yes").addEventListener("click", confirmRemove);
  $("viewer-close").addEventListener("click", closeViewer);
  $("viewer").addEventListener("close", function () { $("viewer-img").removeAttribute("src"); });
  window.addEventListener("hashchange", route);
  start();
})();
