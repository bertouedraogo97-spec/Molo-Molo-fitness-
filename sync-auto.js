/*
 * ============================================================================
 * SYNC AUTO — Synchronisation P2P prête à l'emploi, zéro configuration code
 * ----------------------------------------------------------------------------
 * Ouedraogo Namketa Omar Bertrand © 2026
 *
 * UTILISATION : ajoute une seule ligne dans ton app, juste avant </body> :
 *
 *   <script src="sync-auto.js"></script>
 *
 * C'est tout. Rien d'autre à modifier dans ton code.
 *
 * Un bouton flottant "⇅" apparaît en bas à droite de l'écran. Il ouvre un
 * panneau où tout se règle à la main, sans toucher au code :
 *   - Synchronisation automatique : un interrupteur activer/désactiver et un
 *     champ "Nom de synchronisation". Tous les appareils qui saisissent
 *     EXACTEMENT le même nom se retrouvent et se synchronisent entre eux
 *     automatiquement, sans rien copier-coller nulle part. Le nom sert aussi
 *     de secret de chiffrement partagé (comme le code d'appairage manuel
 *     ci-dessous). Sauvegarde automatique à chaque frappe.
 *   - Mon identifiant : à copier et coller sur l'autre appareil pour établir
 *     la connexion (méthode manuelle, toujours disponible en alternative).
 *   - Mon nom : personnalisable, affiché aux autres appareils.
 *   - Code d'appairage : généré automatiquement, à copier et coller sur
 *     l'autre appareil pour que les deux se reconnaissent (secret de
 *     chiffrement partagé — les deux appareils doivent avoir le même).
 *   - Données à synchroniser : le module détecte automatiquement les
 *     données déjà présentes dans localStorage (celles qui ressemblent à
 *     des listes d'éléments avec un identifiant) et les propose sous forme
 *     de cases à cocher. Rien n'est synchronisé tant que tu n'as pas coché.
 *   - Connexion à un autre appareil : coller son identifiant et appuyer sur
 *     "Se connecter".
 *
 * ATTRIBUTION : chaque donnée modifiée est tamponnée avec le nom de
 * l'appareil responsable, visible dans le journal de synchronisation.
 *
 * RÈGLE DE SUPPRESSION : seuls les 2 premiers appareils connectés au groupe
 * (déterminés par leur date de création, comparée automatiquement lors des
 * connexions) ont le droit de supprimer des données. Si un appareil non
 * autorisé supprime localement, la donnée est restaurée automatiquement
 * dès la prochaine synchronisation — ce mécanisme agit directement sur les
 * données en localStorage, il ne dépend d'aucun bouton ni d'aucune autre
 * modification dans l'app. Le panneau indique à chaque appareil s'il a ce
 * droit ou non.
 *
 * FICHIER UNIQUE : ce script est entièrement autonome. Une seule ligne à
 * ajouter dans index.html (<script src="sync-auto.js"></script>), rien
 * d'autre à modifier. Aucun second fichier n'est nécessaire.
 *
 * La librairie PeerJS est chargée automatiquement si elle n'est pas déjà
 * présente dans la page — aucune balise supplémentaire à ajouter.
 * ============================================================================
 */

(function (global) {
  "use strict";

  const RESERVED_PREFIX = "_syncauto_";
  let engineReady = null;

  // ==========================================================================
  // CHARGEMENT AUTOMATIQUE DE PEERJS SI ABSENT
  // ==========================================================================

  function ensurePeerJs() {
    return new Promise((resolve) => {
      if (typeof global.Peer !== "undefined") return resolve();
      const existing = document.querySelector('script[src*="peerjs"]');
      if (existing) {
        existing.addEventListener("load", () => resolve());
        return;
      }
      const s = document.createElement("script");
      s.src = "https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js";
      s.onload = () => resolve();
      s.onerror = () => resolve(); // on continue quand même, le moteur log l'erreur
      document.head.appendChild(s);
    });
  }

  // ==========================================================================
  // MOTEUR SYNC SUPERVISOR
  // ==========================================================================

  function nowTs() { return Date.now(); }
  function genId() { return "dev_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function genCode() { return Math.random().toString(36).slice(2, 6).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase(); }

  function log(supervisor, level, moduleName, msg, data) {
    const entry = { ts: nowTs(), level, module: moduleName, msg, data: data || null };
    supervisor._logs.push(entry);
    if (supervisor._logs.length > 500) supervisor._logs.shift();
    if (supervisor.config.debug) {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`[SyncAuto:${moduleName}] ${msg}`, data || "");
    }
  }

  const CryptoModule = {
    _key: null,
    async deriveKey(pairingCode, appId) {
      const enc = new TextEncoder();
      const material = await crypto.subtle.importKey("raw", enc.encode(pairingCode), "PBKDF2", false, ["deriveKey"]);
      this._key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("sync-auto-" + appId), iterations: 100000, hash: "SHA-256" },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
      );
    },
    async encrypt(plainObj) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder();
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this._key, enc.encode(JSON.stringify(plainObj)));
      return { iv: Array.from(iv), data: Array.from(new Uint8Array(cipher)) };
    },
    async decrypt(payload) {
      const iv = new Uint8Array(payload.iv);
      const data = new Uint8Array(payload.data);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this._key, data);
      return JSON.parse(new TextDecoder().decode(plain));
    },
  };

  function NetworkMonitor(s) { this.supervisor = s; this.online = navigator.onLine; this.quality = "inconnue"; }
  NetworkMonitor.prototype.start = function () {
    const self = this;
    window.addEventListener("online", () => self._setOnline(true));
    window.addEventListener("offline", () => self._setOnline(false));
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) { conn.addEventListener("change", () => self._evalQuality(conn)); self._evalQuality(conn); }
  };
  NetworkMonitor.prototype._setOnline = function (isOnline) {
    this.online = isOnline;
    if (!isOnline) {
      this.quality = "hors-ligne";
      this.supervisor._notify("offline", "Internet indisponible — mode hors ligne activé");
    } else {
      this.supervisor._notify("info", "Connexion rétablie — synchronisation en cours");
      this.supervisor.syncNow();
    }
  };
  NetworkMonitor.prototype._evalQuality = function (conn) {
    const type = conn.effectiveType || "";
    this.quality = (type === "4g" || type === "5g") ? "bonne" : (type === "" ? "inconnue" : "faible");
  };

  function AuthManager(s) { this.supervisor = s; this.trustedPeers = new Set(this._load()); }
  AuthManager.prototype._key = function () { return `${RESERVED_PREFIX}trusted_${this.supervisor.config.appId}`; };
  AuthManager.prototype._load = function () { try { return JSON.parse(localStorage.getItem(this._key()) || "[]"); } catch (e) { return []; } };
  AuthManager.prototype._save = function () { localStorage.setItem(this._key(), JSON.stringify(Array.from(this.trustedPeers))); };
  AuthManager.prototype.trust = function (peerId) { this.trustedPeers.add(peerId); this._save(); };
  AuthManager.prototype.isTrusted = function (peerId) { return this.trustedPeers.has(peerId); };
  AuthManager.prototype.buildHandshake = async function () {
    const s = this.supervisor;
    return {
      type: "handshake", appId: s.config.appId, deviceId: s.deviceId,
      deviceName: s.config.deviceName, createdAt: s.deviceCreatedAt, admins: s.modules.admin.list(),
      proof: await CryptoModule.encrypt({ ping: "sync-auto", ts: nowTs() }),
    };
  };
  AuthManager.prototype.verifyHandshake = async function (h) {
    if (!h || h.appId !== this.supervisor.config.appId) return false;
    try { const d = await CryptoModule.decrypt(h.proof); return d && d.ping === "sync-auto"; }
    catch (e) { return false; }
  };

  function DataPreparer(s) { this.supervisor = s; }
  DataPreparer.prototype._tsKey = function (c, peerId) { return `${RESERVED_PREFIX}lastts_${this.supervisor.config.appId}_${c}_${peerId}`; };
  DataPreparer.prototype.getLastSyncTs = function (c, peerId) { return parseInt(localStorage.getItem(this._tsKey(c, peerId)) || "0", 10); };
  DataPreparer.prototype.setLastSyncTs = function (c, peerId, ts) { localStorage.setItem(this._tsKey(c, peerId), String(ts)); };
  DataPreparer.prototype.getChangedRecords = function (collection, sinceTs) {
    const all = this.supervisor.config.getRecords(collection) || [];
    return all.filter((r) => (r.updatedAt || 0) > sinceTs);
  };
  DataPreparer.prototype.dedupe = function (records) {
    const map = new Map();
    for (const r of records) {
      const ex = map.get(r.id);
      if (!ex || (r.updatedAt || 0) > (ex.updatedAt || 0)) map.set(r.id, r);
    }
    return Array.from(map.values());
  };
  DataPreparer.prototype.compress = async function (obj) {
    if (typeof CompressionStream === "undefined") return { raw: obj, compressed: false };
    const enc = new TextEncoder().encode(JSON.stringify(obj));
    const cs = new CompressionStream("gzip");
    const w = cs.writable.getWriter(); w.write(enc); w.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return { raw: Array.from(new Uint8Array(buf)), compressed: true };
  };
  DataPreparer.prototype.decompress = async function (payload) {
    if (!payload.compressed) return payload.raw;
    const bytes = new Uint8Array(payload.raw);
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter(); w.write(bytes); w.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(buf));
  };
  // Marque chaque enregistrement modifié localement avec l'appareil responsable.
  // Un enregistrement reçu d'un autre appareil porte déjà sa propre attribution
  // (posée par l'appareil d'origine avant l'envoi), donc on ne l'écrase jamais :
  // on ne tamponne que si _modifiedAt ne correspond plus à updatedAt, ce qui
  // signifie que la donnée a été modifiée localement depuis le dernier passage.
  DataPreparer.prototype.stampOwnChanges = function (collection) {
    const s = this.supervisor;
    const records = s.config.getRecords(collection) || [];
    let changed = false;
    const stamped = records.map((r) => {
      if (r && typeof r === "object" && r.updatedAt && r._modifiedAt !== r.updatedAt) {
        changed = true;
        return { ...r, _modifiedAt: r.updatedAt, _modifiedBy: s.deviceId, _modifiedByName: s.config.deviceName };
      }
      return r;
    });
    if (changed) s.config.setRecords(collection, stamped);
    return changed;
  };

  function ConflictResolver() {}
  ConflictResolver.prototype.resolve = function (local, remote) {
    if (!local) return remote;
    if (!remote) return local;
    if ((remote.updatedAt || 0) > (local.updatedAt || 0)) return remote;
    if ((local.updatedAt || 0) > (remote.updatedAt || 0)) return local;
    return remote.deletedAt ? remote : local;
  };

  // ==========================================================================
  // ADMINISTRATEURS : les 2 premiers appareils du groupe ont seuls le droit
  // de supprimer. Le classement se base sur la date de création de chaque
  // appareil et se propage automatiquement à chaque nouvelle connexion —
  // même deux appareils qui ne se sont jamais connectés directement finissent
  // par se mettre d'accord via un appareil intermédiaire commun.
  // Limite à connaître : il n'y a pas de serveur central, donc ce classement
  // repose sur la bonne foi des appareils. Suffisant pour une petite équipe
  // de confiance, pas conçu pour résister à un utilisateur malveillant qui
  // modifierait son propre stockage local.
  // ==========================================================================

  function AdminManager(s) {
    this.supervisor = s;
    this.ledger = this._load();
    this._ensureSelf();
  }
  AdminManager.prototype._key = function () { return `${RESERVED_PREFIX}admins_${this.supervisor.config.appId}`; };
  AdminManager.prototype._load = function () {
    try { return JSON.parse(localStorage.getItem(this._key()) || "[]"); } catch (e) { return []; }
  };
  AdminManager.prototype._save = function () { localStorage.setItem(this._key(), JSON.stringify(this.ledger)); };
  AdminManager.prototype._ensureSelf = function () {
    const s = this.supervisor;
    if (!this.ledger.some((a) => a.id === s.deviceId)) {
      this.ledger.push({ id: s.deviceId, name: s.config.deviceName, createdAt: s.deviceCreatedAt });
    }
    this._normalize();
  };
  AdminManager.prototype._normalize = function () {
    const seen = new Map();
    for (const a of this.ledger) {
      if (a && a.id && (!seen.has(a.id) || a.createdAt < seen.get(a.id).createdAt)) seen.set(a.id, a);
    }
    this.ledger = Array.from(seen.values()).sort((a, b) => a.createdAt - b.createdAt).slice(0, 2);
    this._save();
  };
  AdminManager.prototype.mergeRemote = function (remoteLedger, peerInfo) {
    if (Array.isArray(remoteLedger)) for (const a of remoteLedger) if (a && a.id) this.ledger.push(a);
    if (peerInfo && peerInfo.id) this.ledger.push(peerInfo);
    this._normalize();
  };
  AdminManager.prototype.isAdmin = function (deviceId) {
    return this.ledger.some((a) => a.id === (deviceId || this.supervisor.deviceId));
  };
  AdminManager.prototype.list = function () { return this.ledger.slice(); };

  // ==========================================================================
  // JOURNAL DES SUPPRESSIONS : permet à un appareil admin de faire propager
  // ses suppressions aux autres appareils (indispensable car les apps de
  // Bertrand suppriment définitivement — filter() — donc rien ne signale
  // qu'un id a disparu sans ce journal explicite).
  // ==========================================================================

  function DeletionLog(s) { this.supervisor = s; }
  DeletionLog.prototype._key = function () { return `${RESERVED_PREFIX}deletions_${this.supervisor.config.appId}`; };
  DeletionLog.prototype._load = function () {
    try { return JSON.parse(localStorage.getItem(this._key()) || "[]"); } catch (e) { return []; }
  };
  DeletionLog.prototype._save = function (list) { localStorage.setItem(this._key(), JSON.stringify(list)); };
  DeletionLog.prototype.record = function (ref, id, ts) {
    const list = this._load();
    list.push({ ref, id, ts });
    if (list.length > 1000) list.splice(0, list.length - 1000);
    this._save(list);
  };
  DeletionLog.prototype.since = function (ref, sinceTs) {
    return this._load().filter((e) => e.ref === ref && e.ts > sinceTs).map((e) => e.id);
  };

  // ==========================================================================
  // GARDE DE SUPPRESSION : détecte quand un id présent au dernier passage a
  // disparu localement. Si l'appareil courant est admin, la suppression est
  // journalisée pour être propagée. Sinon, la donnée est restaurée.
  // ==========================================================================

  function DeletionGuard(s) { this.supervisor = s; }
  DeletionGuard.prototype._snapKey = function (ref) { return `${RESERVED_PREFIX}snap_${this.supervisor.config.appId}_${ref}`; };
  DeletionGuard.prototype._loadSnapshot = function (ref) {
    try { return JSON.parse(localStorage.getItem(this._snapKey(ref)) || "[]"); } catch (e) { return []; }
  };
  DeletionGuard.prototype._saveSnapshot = function (ref, records) {
    localStorage.setItem(this._snapKey(ref), JSON.stringify(records));
  };
  DeletionGuard.prototype.syncSnapshot = function (ref) {
    this._saveSnapshot(ref, this.supervisor.config.getRecords(ref) || []);
  };
  DeletionGuard.prototype.scan = function (ref) {
    const s = this.supervisor;
    const current = s.config.getRecords(ref) || [];
    const currentIds = new Set(current.map((r) => r.id));
    const snapshot = this._loadSnapshot(ref);
    const missing = snapshot.filter((r) => !currentIds.has(r.id));

    if (missing.length) {
      if (s.modules.admin.isAdmin()) {
        const now = nowTs();
        for (const r of missing) s.modules.deletionLog.record(ref, r.id, now);
      } else {
        const restored = current.concat(missing);
        s.config.setRecords(ref, restored);
        s._notify("error", `Suppression annulée dans "${ref}" — seuls les 2 premiers appareils peuvent supprimer`);
        this._saveSnapshot(ref, restored);
        return;
      }
    }
    this._saveSnapshot(ref, s.config.getRecords(ref) || []);
  };

  function SyncEngine(s) { this.supervisor = s; this.inProgress = new Set(); }
  SyncEngine.prototype.syncCollectionWithPeer = async function (peerId, collection) {
    const s = this.supervisor;
    const conn = s.modules.p2p.connections.get(peerId);
    if (!conn || conn.open === false) return;
    const key = collection + "|" + peerId;
    if (this.inProgress.has(key)) return;
    this.inProgress.add(key);
    try {
      const sinceTs = s.modules.dataPreparer.getLastSyncTs(collection, peerId);

      const deletedIds = s.modules.deletionLog.since(collection, sinceTs);
      if (deletedIds.length) {
        const encryptedIds = await CryptoModule.encrypt(deletedIds);
        s.modules.p2p.send(peerId, { type: "sync-delete", collection, payload: encryptedIds, ts: nowTs() });
      }

      const changes = s.modules.dataPreparer.dedupe(s.modules.dataPreparer.getChangedRecords(collection, sinceTs));
      const compressed = await s.modules.dataPreparer.compress(changes);
      const encrypted = await CryptoModule.encrypt(compressed);
      s.modules.p2p.send(peerId, { type: "sync-push", collection, payload: encrypted, ts: nowTs() });
      s.modules.dataPreparer.setLastSyncTs(collection, peerId, nowTs());
      s.modules.historyAgent.record({ collection, direction: "montante", peerId, count: changes.length });
    } catch (e) {
      s.modules.offlineQueue.push({ type: "sync-collection", collection, peerId });
    } finally {
      this.inProgress.delete(key);
    }
  };
  SyncEngine.prototype.handleIncomingPush = async function (fromPeerId, message) {
    const s = this.supervisor;
    try {
      const decrypted = await CryptoModule.decrypt(message.payload);
      const remoteRecords = await s.modules.dataPreparer.decompress(decrypted);
      const collection = message.collection;
      const localRecords = s.config.getRecords(collection) || [];
      const byId = new Map(localRecords.map((r) => [r.id, r]));
      let applied = 0;
      for (const remote of remoteRecords) {
        byId.set(remote.id, s.modules.conflictResolver.resolve(byId.get(remote.id), remote));
        applied++;
      }
      s.config.setRecords(collection, Array.from(byId.values()));
      s.modules.deletionGuard.syncSnapshot(collection);
      s.modules.historyAgent.record({ collection, direction: "descendante", peerId: fromPeerId, count: applied });
      const authors = Array.from(new Set(remoteRecords.map((r) => (r && r._modifiedByName) || null).filter(Boolean)));
      const authorTxt = authors.length ? ` — modifié par ${authors.join(", ")}` : "";
      s._notify("success", `"${collection}" synchronisé (${applied} élément(s))${authorTxt}`);
      s._onDataUpdated(collection);
    } catch (e) {
      s._notify("error", "Échec de synchronisation — données rejetées");
    }
  };
  SyncEngine.prototype.handleIncomingDelete = async function (fromPeerId, message) {
    const s = this.supervisor;
    if (!s.modules.admin.isAdmin(fromPeerId)) {
      s._notify("error", "Suppression ignorée — appareil non autorisé");
      return;
    }
    try {
      const ids = await CryptoModule.decrypt(message.payload);
      const collection = message.collection;
      const current = s.config.getRecords(collection) || [];
      const idSet = new Set(ids);
      const remaining = current.filter((r) => !idSet.has(r.id));
      if (remaining.length !== current.length) {
        s.config.setRecords(collection, remaining);
        s.modules.deletionGuard.syncSnapshot(collection);
        s._notify("info", `${current.length - remaining.length} élément(s) supprimé(s) dans "${collection}" (par un administrateur)`);
        s._onDataUpdated(collection);
      }
    } catch (e) {
      s._notify("error", "Échec de réception de suppression");
    }
  };

  function OfflineQueue(s) { this.supervisor = s; this.queue = this._load(); }
  OfflineQueue.prototype._key = function () { return `${RESERVED_PREFIX}queue_${this.supervisor.config.appId}`; };
  OfflineQueue.prototype._load = function () { try { return JSON.parse(localStorage.getItem(this._key()) || "[]"); } catch (e) { return []; } };
  OfflineQueue.prototype._save = function () { localStorage.setItem(this._key(), JSON.stringify(this.queue)); };
  OfflineQueue.prototype.push = function (task) { this.queue.push({ ...task, attempts: 0 }); this._save(); };
  OfflineQueue.prototype.flush = async function () {
    if (!this.supervisor.modules.network.online) return;
    const pending = [...this.queue]; this.queue = []; this._save();
    for (const task of pending) {
      if (task.attempts >= 5) continue;
      try { await this.supervisor.modules.syncEngine.syncCollectionWithPeer(task.peerId, task.collection); }
      catch (e) { task.attempts++; this.queue.push(task); }
    }
    this._save();
  };

  function HistoryAgent(s) { this.supervisor = s; }
  HistoryAgent.prototype._key = function () { return `${RESERVED_PREFIX}history_${this.supervisor.config.appId}`; };
  HistoryAgent.prototype.record = function (entry) {
    const list = this.getAll();
    list.push({ ...entry, date: new Date().toISOString() });
    if (list.length > 200) list.shift();
    localStorage.setItem(this._key(), JSON.stringify(list));
  };
  HistoryAgent.prototype.getAll = function () { try { return JSON.parse(localStorage.getItem(this._key()) || "[]"); } catch (e) { return []; } };

  function SecurityGuard() { this.rejected = new Map(); }
  SecurityGuard.prototype.recordRejection = function (peerId) {
    const c = (this.rejected.get(peerId) || 0) + 1;
    this.rejected.set(peerId, c);
    return c;
  };
  SecurityGuard.prototype.isBlocked = function (peerId) { return (this.rejected.get(peerId) || 0) >= 3; };

  function P2PLayer(s) { this.supervisor = s; this.peer = null; this.connections = new Map(); this.knownPeers = new Set(this._load()); }
  P2PLayer.prototype._key = function () { return `${RESERVED_PREFIX}peers_${this.supervisor.config.appId}`; };
  P2PLayer.prototype._load = function () { try { return JSON.parse(localStorage.getItem(this._key()) || "[]"); } catch (e) { return []; } };
  P2PLayer.prototype._save = function () { localStorage.setItem(this._key(), JSON.stringify(Array.from(this.knownPeers))); };
  P2PLayer.prototype.init = function () {
    const s = this.supervisor;
    if (typeof Peer === "undefined") {
      log(s, "error", "P2PLayer", "PeerJS indisponible");
      s._notify("error", "Bibliothèque PeerJS indisponible — vérifiez la connexion internet");
      return;
    }
    const roomName = s.config.autoSyncEnabled && s.config.syncName && s.config.syncName.trim();
    if (roomName) {
      this.roomSlots = buildRoomSlots(s.config.appId, roomName);
      s._notify("info", `Synchronisation automatique — recherche des appareils « ${roomName} »…`);
      this._claimRoomSlot(0);
    } else {
      this._openPeer(s.deviceId);
    }
  };
  // Attache les écouteurs communs à n'importe quel objet Peer retenu.
  P2PLayer.prototype._wirePeerEvents = function (peer) {
    const self = this;
    peer.on("connection", (conn) => self._handleIncoming(conn));
    peer.on("error", (err) => self._handlePeerError(err));
    peer.on("disconnected", () => setTimeout(() => peer.reconnect(), 3000));
  };
  // Une fois le Peer ouvert (mode manuel ou salle automatique) : reconnexion
  // aux pairs déjà connus, puis — en mode salle — tentative de connexion à
  // toutes les autres places de la salle, répétée périodiquement pour
  // retrouver les appareils qui rejoignent plus tard.
  P2PLayer.prototype._afterPeerOpen = function () {
    this._connectToKnown();
    if (this.roomSlots) {
      this._joinOtherSlots();
      if (!this._roomInterval) this._roomInterval = setInterval(() => this._joinOtherSlots(), 45000);
    }
  };
  // Mode manuel (ou repli) : ouvre le Peer directement sur l'identifiant donné.
  P2PLayer.prototype._openPeer = function (id) {
    this.peer = new Peer(id, {});
    this.mySlotId = id;
    this._wirePeerEvents(this.peer);
    this.peer.on("open", () => this._afterPeerOpen());
  };
  // Mode salle automatique : essaie de réserver la place N°index. Si elle
  // est déjà prise par un autre appareil, passe à la suivante. Si toutes
  // les places sont prises, l'appareil rejoint quand même la salle avec son
  // identifiant habituel (il pourra toujours se connecter aux autres places).
  P2PLayer.prototype._claimRoomSlot = function (index) {
    const s = this.supervisor;
    if (index >= this.roomSlots.length) { this._openPeer(s.deviceId); return; }
    const candidate = this.roomSlots[index];
    const probe = new Peer(candidate, {});
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { probe.destroy(); } catch (e) {}
      this._claimRoomSlot(index + 1);
    }, 2500);
    probe.on("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.peer = probe;
      this.mySlotId = candidate;
      this._wirePeerEvents(this.peer);
      this._afterPeerOpen();
    });
    probe.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { probe.destroy(); } catch (e) {}
      this._claimRoomSlot(index + 1);
    });
  };
  P2PLayer.prototype._joinOtherSlots = function () {
    if (!this.roomSlots) return;
    for (const slotId of this.roomSlots) {
      if (slotId === this.mySlotId) continue;
      this.connectTo(slotId);
    }
  };
  // "peer-unavailable" est normal et fréquent pendant la découverte de
  // salle (on essaie des places vides) — on ne le remonte pas à l'écran.
  P2PLayer.prototype._handlePeerError = function (err) {
    const s = this.supervisor;
    if (err && err.type === "peer-unavailable") return;
    log(s, "error", "P2PLayer", "Erreur PeerJS", { error: String(err) });
  };
  P2PLayer.prototype._connectToKnown = function () { for (const id of this.knownPeers) this.connectTo(id); };
  P2PLayer.prototype.connectTo = function (peerId) {
    if (this.connections.has(peerId) || peerId === this.supervisor.deviceId || peerId === this.mySlotId) return;
    const conn = this.peer.connect(peerId, { reliable: true });
    this._wire(conn);
  };
  P2PLayer.prototype._handleIncoming = function (conn) {
    if (this.supervisor.modules.security.isBlocked(conn.peer)) { conn.close(); return; }
    this._wire(conn);
  };
  P2PLayer.prototype._wire = function (conn) {
    const s = this.supervisor;
    conn.on("open", async () => {
      this.connections.set(conn.peer, conn);
      conn.send({ ...(await s.modules.auth.buildHandshake()), _meta: true });
    });
    conn.on("data", (msg) => this._route(conn, msg));
    conn.on("close", () => this.connections.delete(conn.peer));
    conn.on("error", (err) => log(s, "error", "P2PLayer", "Erreur connexion", { error: String(err) }));
  };
  P2PLayer.prototype._route = async function (conn, message) {
    const s = this.supervisor;
    if (message._meta && message.type === "handshake") {
      const ok = await s.modules.auth.verifyHandshake(message);
      if (ok) {
        s.modules.auth.trust(conn.peer);
        this.knownPeers.add(conn.peer); this._save();
        s.modules.admin.mergeRemote(message.admins, { id: message.deviceId, name: message.deviceName, createdAt: message.createdAt || nowTs() });
        s._notify("success", `Appareil connecté : ${message.deviceName || conn.peer}`);
        s.syncCollectionsWithPeer(conn.peer);
      } else {
        s.modules.security.recordRejection(conn.peer);
        conn.close();
      }
      return;
    }
    if (!s.modules.auth.isTrusted(conn.peer)) { s.modules.security.recordRejection(conn.peer); return; }
    if (message.type === "sync-push") s.modules.syncEngine.handleIncomingPush(conn.peer, message);
    if (message.type === "sync-delete") s.modules.syncEngine.handleIncomingDelete(conn.peer, message);
  };
  P2PLayer.prototype.send = function (peerId, message) {
    const conn = this.connections.get(peerId);
    if (conn && conn.open) conn.send(message);
  };

  function Scheduler(s) { this.supervisor = s; this.handle = null; }
  Scheduler.prototype.start = function (ms) {
    if (this.handle) clearInterval(this.handle);
    this.handle = setInterval(() => {
      if (this.supervisor.modules.network.online) this.supervisor.syncNow();
      this.supervisor.modules.offlineQueue.flush();
    }, ms || 60000);
  };

  function Supervisor(config) {
    this.config = config;
    this._logs = [];
    this.deviceId = this._loadOrCreateDeviceId(); // fixe aussi this.deviceCreatedAt
    this.modules = {};
    this.modules.network = new NetworkMonitor(this);
    this.modules.auth = new AuthManager(this);
    this.modules.dataPreparer = new DataPreparer(this);
    this.modules.conflictResolver = new ConflictResolver();
    this.modules.admin = new AdminManager(this);
    this.modules.deletionLog = new DeletionLog(this);
    this.modules.deletionGuard = new DeletionGuard(this);
    this.modules.syncEngine = new SyncEngine(this);
    this.modules.offlineQueue = new OfflineQueue(this);
    this.modules.historyAgent = new HistoryAgent(this);
    this.modules.security = new SecurityGuard();
    this.modules.p2p = new P2PLayer(this);
    this.modules.scheduler = new Scheduler(this);
  }
  Supervisor.prototype._loadOrCreateDeviceId = function () {
    const key = `${RESERVED_PREFIX}deviceid_${this.config.appId}`;
    const createdKey = `${RESERVED_PREFIX}devicecreated_${this.config.appId}`;
    let id = localStorage.getItem(key);
    if (!id) { id = genId(); localStorage.setItem(key, id); }
    if (!localStorage.getItem(createdKey)) localStorage.setItem(createdKey, String(nowTs()));
    this.deviceCreatedAt = parseInt(localStorage.getItem(createdKey), 10);
    return id;
  };
  Supervisor.prototype._notify = function (type, message) {
    if (this._uiNotify) this._uiNotify(type, message);
  };
  Supervisor.prototype._onDataUpdated = function (collection) {
    if (this._uiOnDataUpdated) this._uiOnDataUpdated(collection);
  };
  Supervisor.prototype.start = async function () {
    // En mode "Synchronisation automatique", le nom saisi remplace le code
    // d'appairage manuel comme secret de chiffrement partagé : deux appareils
    // avec exactement le même nom obtiennent automatiquement la même clé.
    const roomName = this.config.autoSyncEnabled && this.config.syncName && this.config.syncName.trim();
    const effectivePairingCode = roomName ? ("nomsync::" + roomName) : this.config.pairingCode;
    await CryptoModule.deriveKey(effectivePairingCode, this.config.appId);
    this.stampAll();
    this.modules.network.start();
    this.modules.p2p.init();
    this.modules.scheduler.start();
  };
  Supervisor.prototype.connectToPeer = function (peerId) { this.modules.p2p.connectTo(peerId); };
  Supervisor.prototype.syncCollectionsWithPeer = function (peerId) {
    this.stampAll();
    for (const c of this.config.collections) this.modules.syncEngine.syncCollectionWithPeer(peerId, c);
  };
  Supervisor.prototype.stampAll = function () {
    for (const c of this.config.collections) {
      this.modules.dataPreparer.stampOwnChanges(c);
      this.modules.deletionGuard.scan(c);
    }
  };
  Supervisor.prototype.syncNow = function () {
    this.stampAll();
    for (const peerId of this.modules.p2p.connections.keys()) this.syncCollectionsWithPeer(peerId);
    this.modules.offlineQueue.flush();
  };
  Supervisor.prototype.isAdmin = function (deviceId) { return this.modules.admin.isAdmin(deviceId); };

  // ==========================================================================
  // AUTO-DÉTECTION : appId, code d'appairage, collections disponibles
  // ==========================================================================

  function getAppId() {
    const key = RESERVED_PREFIX + "appid";
    let id = localStorage.getItem(key);
    if (!id) {
      id = (location.hostname + location.pathname).replace(/[^a-z0-9]/gi, "_").toLowerCase() || "app_locale";
      localStorage.setItem(key, id);
    }
    return id;
  }

  function getOrCreatePairingCode() {
    const key = RESERVED_PREFIX + "pairingcode_" + getAppId();
    let code = localStorage.getItem(key);
    if (!code) { code = genCode(); localStorage.setItem(key, code); }
    return code;
  }

  function setPairingCode(code) {
    localStorage.setItem(RESERVED_PREFIX + "pairingcode_" + getAppId(), code);
  }

  function getOrCreateDeviceName() {
    const key = RESERVED_PREFIX + "devicename_" + getAppId();
    let name = localStorage.getItem(key);
    if (!name) {
      name = "Appareil-" + Math.random().toString(36).slice(2, 6).toUpperCase();
      localStorage.setItem(key, name);
    }
    return name;
  }

  function setDeviceName(name) {
    localStorage.setItem(RESERVED_PREFIX + "devicename_" + getAppId(), name);
  }

  // ==========================================================================
  // SYNCHRONISATION AUTOMATIQUE PAR NOM : toggle + "Nom de synchronisation".
  // Deux appareils qui saisissent exactement le même nom se retrouvent tout
  // seuls (sans échange manuel d'identifiant) et partagent automatiquement
  // le même secret de chiffrement (dérivé du nom).
  // ==========================================================================

  function getAutoSyncEnabled() {
    return localStorage.getItem(RESERVED_PREFIX + "autosync_" + getAppId()) === "1";
  }
  function setAutoSyncEnabled(on) {
    localStorage.setItem(RESERVED_PREFIX + "autosync_" + getAppId(), on ? "1" : "0");
  }
  function getSyncName() {
    return localStorage.getItem(RESERVED_PREFIX + "syncname_" + getAppId()) || "";
  }
  function setSyncName(name) {
    localStorage.setItem(RESERVED_PREFIX + "syncname_" + getAppId(), name || "");
  }

  // Hachage déterministe simple (DJB2) — juste pour fabriquer un identifiant
  // de salle stable à partir du nom saisi, pas un usage cryptographique.
  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h = h & h; }
    return Math.abs(h).toString(36);
  }
  function sanitizeId(str) {
    return str.replace(/[^a-zA-Z0-9_]/g, "");
  }

  // Un même "Nom de synchronisation" doit permettre à plusieurs appareils de
  // se trouver sans serveur central. PeerJS n'offre pas d'annuaire de pairs,
  // donc on fabrique N identifiants de "salle" fixes et déterministes à
  // partir du nom. Chaque appareil essaie de réserver l'une de ces places
  // (le premier arrivé "habite" la place N°0, le suivant la N°1, etc.), puis
  // se connecte à toutes les autres places pour retrouver les appareils déjà
  // présents. Une fois connectés, les appareils s'ajoutent à leur liste de
  // pairs connus et se reconnectent automatiquement entre eux ensuite.
  const ROOM_SLOT_COUNT = 8;
  function buildRoomSlots(appId, syncName) {
    const base = sanitizeId("sar_" + hashString(appId) + "_" + hashString(syncName.trim()));
    const slots = [];
    for (let i = 0; i < ROOM_SLOT_COUNT; i++) slots.push(base + "_" + i);
    return slots;
  }

  function isSyncableItem(item) {
    return item && typeof item === "object" && "id" in item;
  }

  // Détecte deux formes de stockage :
  //  1) clé -> tableau direct d'objets avec id (ex: "ouvriers": [...])
  //  2) clé -> objet DB unique contenant plusieurs sous-listes
  //     (ex: buildmaster_data_v1: { chantiers:[...], ouvriers:[...], ... })
  //     Chaque sous-liste devient une collection, référencée "cle::propriete".
  function detectSyncableCollections() {
    const results = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || key.indexOf(RESERVED_PREFIX) === 0) continue;
      let val;
      try { val = JSON.parse(localStorage.getItem(key)); } catch (e) { continue; }

      if (Array.isArray(val) && val.length > 0 && val.every(isSyncableItem)) {
        results.push({ ref: key, label: key, count: val.length });
        continue;
      }

      if (val && typeof val === "object" && !Array.isArray(val)) {
        for (const prop in val) {
          const sub = val[prop];
          if (Array.isArray(sub) && sub.length > 0 && sub.every(isSyncableItem)) {
            results.push({ ref: key + "::" + prop, label: key + " → " + prop, count: sub.length });
          }
        }
      }
    }
    return results;
  }

  function getSelectedCollections() {
    try { return JSON.parse(localStorage.getItem(RESERVED_PREFIX + "selected_" + getAppId()) || "[]"); }
    catch (e) { return []; }
  }

  function setSelectedCollections(list) {
    localStorage.setItem(RESERVED_PREFIX + "selected_" + getAppId(), JSON.stringify(list));
  }

  function patchMissingTimestamps(ref) {
    try {
      let storeKey = ref, prop = null, obj = null, arr = null;
      if (ref.indexOf("::") !== -1) {
        [storeKey, prop] = ref.split("::");
        obj = JSON.parse(localStorage.getItem(storeKey) || "{}");
        arr = Array.isArray(obj[prop]) ? obj[prop] : null;
      } else {
        const raw = localStorage.getItem(storeKey);
        arr = raw ? JSON.parse(raw) : null;
      }
      if (!Array.isArray(arr)) return;

      let changed = false;
      const now = nowTs();
      const patched = arr.map((item) => {
        if (item && typeof item === "object" && !("updatedAt" in item)) {
          changed = true;
          return { ...item, updatedAt: now };
        }
        return item;
      });
      if (!changed) return;

      if (prop) { obj[prop] = patched; localStorage.setItem(storeKey, JSON.stringify(obj)); }
      else localStorage.setItem(storeKey, JSON.stringify(patched));
    } catch (e) { /* on ignore, ce n'est pas grave */ }
  }

  // ==========================================================================
  // INTERFACE UTILISATEUR : bouton flottant + panneau de réglages
  // ==========================================================================

  function injectStyles() {
    if (document.getElementById("sa-styles")) return;
    const style = document.createElement("style");
    style.id = "sa-styles";
    style.textContent = `
      .sa-fab{position:fixed;bottom:18px;right:18px;width:52px;height:52px;border-radius:50%;
        background:#1b6ef3;color:#fff;font-size:22px;display:flex;align-items:center;justify-content:center;
        box-shadow:0 4px 14px rgba(0,0,0,.35);z-index:999999;cursor:pointer;border:none;
        transition:transform .15s ease}
      .sa-fab:active{transform:scale(.92)}
      .sa-fab .sa-dot{position:absolute;top:2px;right:2px;width:12px;height:12px;border-radius:50%;
        background:#888;border:2px solid #0b1220}
      .sa-fab .sa-dot.on{background:#22c55e}
      .sa-fab .sa-dot.off{background:#ef4444}
      .sa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999998;display:none}
      .sa-overlay.open{display:block}
      .sa-panel{position:fixed;left:0;right:0;bottom:0;max-height:86vh;overflow-y:auto;
        background:#0f172a;color:#e2e8f0;border-radius:18px 18px 0 0;padding:18px;
        z-index:999999;transform:translateY(100%);transition:transform .25s ease;
        font-family:-apple-system,Segoe UI,Roboto,sans-serif;box-sizing:border-box}
      .sa-panel *{box-sizing:border-box}
      .sa-panel.open{transform:translateY(0)}
      .sa-panel h3{margin:0 0 12px;font-size:17px}
      .sa-panel h4{margin:16px 0 8px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
      .sa-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
      .sa-code{flex:1;background:#1e293b;border-radius:8px;padding:10px 12px;font-family:monospace;
        font-size:14px;letter-spacing:1px;word-break:break-all}
      .sa-btn{background:#1b6ef3;color:#fff;border:none;border-radius:8px;padding:10px 14px;
        font-size:13px;cursor:pointer;white-space:nowrap}
      .sa-btn.sa-secondary{background:#334155}
      .sa-input{flex:1;background:#1e293b;border:1px solid #334155;border-radius:8px;
        padding:10px 12px;color:#e2e8f0;font-size:13px;min-width:0}
      .sa-close{position:absolute;top:14px;right:14px;background:none;border:none;
        color:#94a3b8;font-size:22px;cursor:pointer;line-height:1}
      .sa-collection{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1e293b}
      .sa-collection label{flex:1;font-size:13px}
      .sa-collection .sa-count{color:#64748b;font-size:11px}
      .sa-log{max-height:120px;overflow-y:auto;font-size:11px;color:#94a3b8;
        background:#1e293b;border-radius:8px;padding:8px}
      .sa-log div{padding:3px 0;border-bottom:1px solid #0f172a}
      .sa-empty{color:#64748b;font-size:13px;font-style:italic}
      .sa-status{font-size:12px;color:#94a3b8;margin-bottom:6px}
      .sa-hint{font-size:11px;color:#64748b;margin:-4px 0 10px}
      .sa-switch{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
      .sa-switch input{opacity:0;width:0;height:0}
      .sa-switch .sa-slider{position:absolute;cursor:pointer;inset:0;background:#334155;
        border-radius:24px;transition:.2s}
      .sa-switch .sa-slider:before{content:"";position:absolute;height:18px;width:18px;left:3px;
        bottom:3px;background:#fff;border-radius:50%;transition:.2s}
      .sa-switch input:checked + .sa-slider{background:#22c55e}
      .sa-switch input:checked + .sa-slider:before{transform:translateX(20px)}
      .sa-autosync-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
      .sa-autosync-row span{font-size:13px}
    `;
    document.head.appendChild(style);
  }

  function addLog(els, type, message) {
    const line = document.createElement("div");
    const time = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    line.textContent = `[${time}] ${message}`;
    if (type === "error") line.style.color = "#f87171";
    if (type === "success") line.style.color = "#4ade80";
    els.log.prepend(line);
    while (els.log.children.length > 30) els.log.removeChild(els.log.lastChild);
  }

  function buildUI(supervisor) {
    injectStyles();

    const fab = document.createElement("button");
    fab.className = "sa-fab";
    fab.setAttribute("aria-label", "Synchronisation");
    fab.innerHTML = '⇅<span class="sa-dot off"></span>';
    document.body.appendChild(fab);

    const overlay = document.createElement("div");
    overlay.className = "sa-overlay";
    document.body.appendChild(overlay);

    const panel = document.createElement("div");
    panel.className = "sa-panel";
    panel.innerHTML = `
      <button class="sa-close">×</button>
      <h3>Synchronisation entre appareils</h3>
      <div class="sa-status" data-sa="status">Initialisation…</div>
      <div class="sa-status" data-sa="adminstatus"></div>

      <h4>Synchronisation automatique</h4>
      <div class="sa-autosync-row">
        <label class="sa-switch">
          <input type="checkbox" data-sa="autosync-toggle">
          <span class="sa-slider"></span>
        </label>
        <span>Activer</span>
      </div>
      <div class="sa-row">
        <input class="sa-input" data-sa="syncname-input" placeholder="Nom de synchronisation, ex : Chantier Ouaga">
      </div>
      <div class="sa-hint">Tous les appareils qui saisissent exactement le même nom se synchronisent automatiquement entre eux.</div>

      <h4>Mon identifiant (à partager)</h4>
      <div class="sa-row">
        <div class="sa-code" data-sa="deviceid"></div>
        <button class="sa-btn sa-secondary" data-sa="copy-deviceid">Copier</button>
      </div>

      <h4>Mon nom (affiché aux autres appareils)</h4>
      <div class="sa-row">
        <input class="sa-input" data-sa="devicename-input" placeholder="Ex: Amadou, Téléphone chantier…">
        <button class="sa-btn" data-sa="apply-devicename">Enregistrer</button>
      </div>

      <h4>Code d'appairage (identique sur les 2 appareils)</h4>
      <div class="sa-row">
        <div class="sa-code" data-sa="pairingcode"></div>
        <button class="sa-btn sa-secondary" data-sa="copy-pairingcode">Copier</button>
      </div>
      <div class="sa-row">
        <input class="sa-input" data-sa="pairingcode-input" placeholder="Coller le code de l'autre appareil">
        <button class="sa-btn" data-sa="apply-pairingcode">Appliquer</button>
      </div>

      <h4>Se connecter à un appareil</h4>
      <div class="sa-row">
        <input class="sa-input" data-sa="connect-input" placeholder="Identifiant de l'autre appareil">
        <button class="sa-btn" data-sa="connect-btn">Se connecter</button>
      </div>

      <h4>Données à synchroniser</h4>
      <div data-sa="collections"></div>

      <h4>Journal</h4>
      <div class="sa-log" data-sa="log"></div>
    `;
    document.body.appendChild(panel);

    const els = {
      fab, overlay, panel,
      status: panel.querySelector('[data-sa="status"]'),
      adminStatus: panel.querySelector('[data-sa="adminstatus"]'),
      autoSyncToggle: panel.querySelector('[data-sa="autosync-toggle"]'),
      syncNameInput: panel.querySelector('[data-sa="syncname-input"]'),
      deviceId: panel.querySelector('[data-sa="deviceid"]'),
      deviceNameInput: panel.querySelector('[data-sa="devicename-input"]'),
      pairingCode: panel.querySelector('[data-sa="pairingcode"]'),
      pairingInput: panel.querySelector('[data-sa="pairingcode-input"]'),
      connectInput: panel.querySelector('[data-sa="connect-input"]'),
      collections: panel.querySelector('[data-sa="collections"]'),
      log: panel.querySelector('[data-sa="log"]'),
      dot: fab.querySelector(".sa-dot"),
    };

    function openPanel() { overlay.classList.add("open"); panel.classList.add("open"); refreshCollections(); }
    function closePanel() { overlay.classList.remove("open"); panel.classList.remove("open"); }

    fab.addEventListener("click", openPanel);
    overlay.addEventListener("click", closePanel);
    panel.querySelector(".sa-close").addEventListener("click", closePanel);

    els.deviceId.textContent = supervisor.deviceId;
    els.deviceNameInput.value = supervisor.config.deviceName;
    els.pairingCode.textContent = supervisor.config.pairingCode;
    els.autoSyncToggle.checked = !!supervisor.config.autoSyncEnabled;
    els.syncNameInput.value = supervisor.config.syncName || "";

    els.autoSyncToggle.addEventListener("change", () => {
      setAutoSyncEnabled(els.autoSyncToggle.checked);
      addLog(els, "info", els.autoSyncToggle.checked
        ? "Synchronisation automatique activée — rechargement…"
        : "Synchronisation automatique désactivée — rechargement…");
      setTimeout(() => location.reload(), 500);
    });

    let syncNameDebounce = null;
    els.syncNameInput.addEventListener("input", () => {
      setSyncName(els.syncNameInput.value); // sauvegarde automatique à chaque frappe
      clearTimeout(syncNameDebounce);
      syncNameDebounce = setTimeout(() => {
        addLog(els, "info", "Nom de synchronisation appliqué — rechargement…");
        location.reload();
      }, 1200);
    });

    panel.querySelector('[data-sa="apply-devicename"]').addEventListener("click", () => {
      const name = els.deviceNameInput.value.trim();
      if (!name) return;
      setDeviceName(name);
      addLog(els, "info", "Nom enregistré — rechargement…");
      setTimeout(() => location.reload(), 500);
    });
    panel.querySelector('[data-sa="copy-deviceid"]').addEventListener("click", () => {
      navigator.clipboard?.writeText(supervisor.deviceId);
      addLog(els, "info", "Identifiant copié");
    });
    panel.querySelector('[data-sa="copy-pairingcode"]').addEventListener("click", () => {
      navigator.clipboard?.writeText(supervisor.config.pairingCode);
      addLog(els, "info", "Code d'appairage copié");
    });
    panel.querySelector('[data-sa="apply-pairingcode"]').addEventListener("click", () => {
      const code = els.pairingInput.value.trim();
      if (!code) return;
      setPairingCode(code);
      addLog(els, "info", "Nouveau code appliqué — rechargement…");
      setTimeout(() => location.reload(), 600);
    });
    panel.querySelector('[data-sa="connect-btn"]').addEventListener("click", () => {
      const id = els.connectInput.value.trim();
      if (!id) return;
      supervisor.connectToPeer(id);
      addLog(els, "info", "Tentative de connexion à " + id + "…");
      els.connectInput.value = "";
    });

    function refreshCollections() {
      const detected = detectSyncableCollections();
      const selected = new Set(getSelectedCollections());
      els.collections.innerHTML = "";
      if (detected.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sa-empty";
        empty.textContent = "Aucune donnée synchronisable détectée pour le moment.";
        els.collections.appendChild(empty);
        return;
      }
      for (const { ref, label: refLabel, count } of detected) {
        const row = document.createElement("div");
        row.className = "sa-collection";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(ref);
        cb.addEventListener("change", () => {
          const cur = new Set(getSelectedCollections());
          if (cb.checked) { cur.add(ref); patchMissingTimestamps(ref); } else { cur.delete(ref); }
          setSelectedCollections(Array.from(cur));
          addLog(els, "info", "Sélection mise à jour — rechargement…");
          setTimeout(() => location.reload(), 500);
        });

        const label = document.createElement("label");
        label.textContent = refLabel;

        const countEl = document.createElement("span");
        countEl.className = "sa-count";
        countEl.textContent = count + " élément(s)";

        row.appendChild(cb);
        row.appendChild(label);
        row.appendChild(countEl);
        els.collections.appendChild(row);
      }
    }

    function setStatus() {
      const n = supervisor.modules.p2p.connections.size;
      const online = supervisor.modules.network.online;
      els.dot.className = "sa-dot " + (n > 0 ? "on" : "off");
      els.status.textContent = online
        ? (n > 0 ? n + " appareil(s) connecté(s)" : "En ligne — en attente de connexion")
        : "Hors ligne";

      const admins = supervisor.modules.admin.list();
      const amAdmin = supervisor.isAdmin();
      const names = admins.map((a) => a.name || a.id).join(", ") || "aucun pour l'instant";
      els.adminStatus.textContent = amAdmin
        ? "✓ Vous pouvez supprimer des données (administrateur)"
        : `✕ Vous ne pouvez pas supprimer — droit réservé à : ${names}`;
      els.adminStatus.style.color = amAdmin ? "#4ade80" : "#f87171";
    }

    supervisor._uiNotify = (type, message) => { addLog(els, type, message); setStatus(); };
    supervisor._uiOnDataUpdated = () => { refreshCollections(); };

    setStatus();
    setInterval(setStatus, 4000);

    return els;
  }

  // ==========================================================================
  // DÉMARRAGE AUTOMATIQUE
  // ==========================================================================

  async function autoInit() {
    await ensurePeerJs();

    const appId = getAppId();
    const pairingCode = getOrCreatePairingCode();
    const deviceName = getOrCreateDeviceName();
    const collections = getSelectedCollections();
    const autoSyncEnabled = getAutoSyncEnabled();
    const syncName = getSyncName();

    for (const c of collections) patchMissingTimestamps(c);

    const config = {
      appId,
      pairingCode,
      deviceName,
      collections,
      autoSyncEnabled,
      syncName,
      getRecords(ref) {
        try {
          if (ref.indexOf("::") !== -1) {
            const [storeKey, prop] = ref.split("::");
            const obj = JSON.parse(localStorage.getItem(storeKey) || "{}");
            return Array.isArray(obj[prop]) ? obj[prop] : [];
          }
          return JSON.parse(localStorage.getItem(ref) || "[]");
        } catch (e) { return []; }
      },
      setRecords(ref, records) {
        if (ref.indexOf("::") !== -1) {
          const [storeKey, prop] = ref.split("::");
          let obj;
          try { obj = JSON.parse(localStorage.getItem(storeKey) || "{}"); } catch (e) { obj = {}; }
          obj[prop] = records;
          localStorage.setItem(storeKey, JSON.stringify(obj));
          return;
        }
        localStorage.setItem(ref, JSON.stringify(records));
      },
    };

    const supervisor = new Supervisor(config);
    buildUI(supervisor);
    engineReady = supervisor.start();
    await engineReady;

    global.SyncAuto = supervisor; // accès debug + API pour l'app (isAdmin, etc.)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit);
  } else {
    autoInit();
  }

})(window);
