import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import { firebaseServices } from '../firebase/client.js';

const COLORS = ['#7c6dfa', '#f43f5e', '#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#06b6d4'];
const SESSION_STALE_MS = 45_000;
const LOCK_TTL_MS = 45_000;

function safeKey(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function colorFor(value) {
  let hash = 0;
  for (const char of String(value)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...value,
    nodes: value.nodes && typeof value.nodes === 'object' && !Array.isArray(value.nodes) ? value.nodes : {},
    connections: Array.isArray(value.connections) ? value.connections : [],
    groups: value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups) ? value.groups : {},
    stickies: value.stickies && typeof value.stickies === 'object' && !Array.isArray(value.stickies) ? value.stickies : {},
    frames: value.frames && typeof value.frames === 'object' && !Array.isArray(value.frames) ? value.frames : {},
    nextId: Number.isFinite(value.nextId) ? value.nextId : 1,
  };
}

function timestampMillis(value) {
  if (value?.toMillis) return value.toMillis();
  return Number(value || 0);
}

export async function createGroupRealtime(options) {
  const services = await firebaseServices();
  const user = services.auth?.currentUser;
  if (!services.configured || !services.firestore || !user) {
    throw new Error('Firebase Firestore belum tersedia.');
  }

  const firestore = services.firestore;
  const groupId = String(options.groupId);
  const sessionId = crypto.randomUUID();
  const username = String(options.username || user.displayName || user.email || 'WAN User');
  const color = colorFor(`${user.uid}:${sessionId}`);
  const canWrite = options.canWrite !== false;
  const groupRef = doc(firestore, 'groups', groupId);
  const sessionRef = doc(groupRef, 'collaborationSessions', sessionId);
  const eventRef = doc(groupRef, 'collaborationEvents', sessionId);
  const cleanup = [];
  const projectCleanup = [];
  const presence = new Map();
  const remoteCursors = new Map();
  const remoteLocks = new Map();
  const eventSequences = new Map();
  const ownedLocks = new Map();
  const startedAt = Date.now();
  let currentProject = null;
  let currentProjectKey = null;
  let cursorRef = null;
  let heartbeat = null;
  let sequence = 0;
  let stopped = false;
  let lastCursorSent = 0;
  let lastPositionSent = 0;
  let lastCursorPayload = null;
  let pendingCanvas = null;

  const emitPresence = () => {
    const cutoff = Date.now() - SESSION_STALE_MS;
    const users = [...presence.entries()]
      .filter(([, value]) => timestampMillis(value.updatedAt) >= cutoff)
      .map(([id, value]) => ({ sessionId: id, ...value }));
    options.onPresence?.(users);
  };

  const sweepTransientState = () => {
    const now = Date.now();
    for (const [id, value] of remoteCursors) {
      if (timestampMillis(value.updatedAt) >= now - SESSION_STALE_MS) continue;
      remoteCursors.delete(id);
      options.onCursor?.(id, null);
    }
    for (const [id, value] of remoteLocks) {
      if (timestampMillis(value.expiresAt) >= now) continue;
      remoteLocks.delete(id);
      options.onLock?.(id, null);
    }
  };

  const writePresence = () => setDoc(sessionRef, {
    uid: user.uid,
    username,
    color,
    fileId: currentProject || '',
    updatedAt: serverTimestamp(),
  });

  const sendEvent = async (type, payload = {}) => {
    if (stopped || !currentProject || !canWrite) return;
    sequence += 1;
    await setDoc(eventRef, {
      uid: user.uid,
      sessionId,
      username,
      color,
      fileId: currentProject,
      type,
      sequence,
      sentAt: serverTimestamp(),
      payload,
    });
  };

  cleanup.push(onSnapshot(collection(groupRef, 'collaborationSessions'), snapshot => {
    for (const change of snapshot.docChanges()) {
      if (change.doc.id === sessionId) continue;
      if (change.type === 'removed') {
        presence.delete(change.doc.id);
        options.onCursor?.(change.doc.id, null);
        options.onSessionLeft?.(change.doc.id);
      } else {
        presence.set(change.doc.id, change.doc.data());
      }
    }
    emitPresence();
  }, error => options.onError?.(error)));

  cleanup.push(onSnapshot(collection(groupRef, 'collaborationEvents'), snapshot => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'removed' || change.doc.id === sessionId || change.doc.metadata.hasPendingWrites) continue;
      const message = change.doc.data();
      if (!message || message.fileId !== currentProject) continue;
      const nextSequence = Number(message.sequence || 0);
      if (nextSequence <= (eventSequences.get(change.doc.id) || 0)) continue;
      eventSequences.set(change.doc.id, nextSequence);
      const sentAt = timestampMillis(message.sentAt);
      if (sentAt && sentAt < startedAt - 3_000) continue;
      const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
      const actor = {
        sessionId: message.sessionId || change.doc.id,
        uid: message.uid,
        username: message.username || 'WAN User',
        color: message.color || '#7c6dfa',
      };
      if (message.type === 'node_pos') options.onNodePosition?.(payload, actor);
      if (message.type === 'node_text') options.onNodeText?.(payload, actor);
      if (message.type === 'node_typing') options.onTyping?.(payload, actor);
    }
  }, error => options.onError?.(error)));

  cleanup.push(onSnapshot(doc(groupRef, 'private', 'workspace'), snapshot => {
    if (!snapshot.exists() || snapshot.metadata.hasPendingWrites) return;
    options.onWorkspace?.(snapshot.data().tree ?? null);
  }, error => options.onError?.(error)));

  heartbeat = setInterval(() => {
    if (stopped) return;
    void updateDoc(sessionRef, { updatedAt: serverTimestamp(), fileId: currentProject || '' })
      .catch(error => options.onError?.(error));
    if (cursorRef && lastCursorPayload) {
      void setDoc(cursorRef, { ...lastCursorPayload, updatedAt: serverTimestamp() })
        .catch(error => options.onError?.(error));
    }
    const expiresAt = Timestamp.fromMillis(Date.now() + LOCK_TTL_MS);
    for (const lockRef of ownedLocks.values()) {
      void updateDoc(lockRef, { updatedAt: serverTimestamp(), expiresAt }).catch(() => {});
    }
    emitPresence();
    sweepTransientState();
  }, 15_000);

  async function clearProject() {
    while (projectCleanup.length) projectCleanup.pop()?.();
    const lockDeletes = [...ownedLocks.values()].map(lockRef => deleteDoc(lockRef).catch(() => {}));
    ownedLocks.clear();
    if (cursorRef) await deleteDoc(cursorRef).catch(() => {});
    cursorRef = null;
    lastCursorPayload = null;
    for (const id of remoteCursors.keys()) options.onCursor?.(id, null);
    for (const id of remoteLocks.keys()) options.onLock?.(id, null);
    remoteCursors.clear();
    remoteLocks.clear();
    pendingCanvas = null;
    await Promise.all(lockDeletes);
  }

  async function setProject(projectId) {
    const nextProject = String(projectId || '');
    if (nextProject === currentProject) return;
    await clearProject();
    currentProject = nextProject || null;
    currentProjectKey = currentProject ? safeKey(currentProject) : null;
    await updateDoc(sessionRef, { fileId: currentProject || '', updatedAt: serverTimestamp() });
    if (!currentProject) return;

    const fileRef = doc(groupRef, 'collaborationFiles', currentProjectKey);
    cursorRef = doc(fileRef, 'cursors', sessionId);
    projectCleanup.push(onSnapshot(collection(fileRef, 'cursors'), snapshot => {
      for (const change of snapshot.docChanges()) {
        if (change.doc.id === sessionId) continue;
        const value = change.type === 'removed' ? null : change.doc.data();
        if (!value || timestampMillis(value.updatedAt) < Date.now() - SESSION_STALE_MS) {
          remoteCursors.delete(change.doc.id);
          options.onCursor?.(change.doc.id, null);
        } else {
          remoteCursors.set(change.doc.id, value);
          options.onCursor?.(change.doc.id, value);
        }
      }
    }, error => options.onError?.(error)));

    projectCleanup.push(onSnapshot(collection(fileRef, 'locks'), snapshot => {
      for (const change of snapshot.docChanges()) {
        const value = change.type === 'removed' ? null : change.doc.data();
        if (value?.sessionId === sessionId) continue;
        if (!value || timestampMillis(value.expiresAt) < Date.now()) {
          remoteLocks.delete(change.doc.id);
          options.onLock?.(change.doc.id, null);
        } else {
          remoteLocks.set(change.doc.id, value);
          options.onLock?.(change.doc.id, value);
        }
      }
    }, error => options.onError?.(error)));

    projectCleanup.push(onSnapshot(doc(groupRef, 'mindmaps', safeKey(currentProject)), snapshot => {
      if (!snapshot.exists() || snapshot.metadata.hasPendingWrites) return;
      const canvas = normalizeSnapshot(snapshot.data().snapshot);
      if (!canvas) return;
      if (options.onCanvas?.(canvas) === false) pendingCanvas = canvas;
      else pendingCanvas = null;
    }, error => options.onError?.(error)));
  }

  async function lockNode(nodeId) {
    if (!currentProjectKey || !canWrite) return false;
    const nodeKey = safeKey(nodeId);
    if (ownedLocks.has(nodeKey)) return true;
    const lockRef = doc(groupRef, 'collaborationFiles', currentProjectKey, 'locks', nodeKey);
    const acquired = await runTransaction(firestore, async transaction => {
      const current = await transaction.get(lockRef);
      const currentData = current.data();
      const expired = timestampMillis(currentData?.expiresAt) < Date.now();
      if (current.exists() && currentData?.sessionId !== sessionId && !expired) return false;
      transaction.set(lockRef, {
        uid: user.uid,
        sessionId,
        nodeId: String(nodeId),
        username,
        color,
        updatedAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + LOCK_TTL_MS),
      });
      return true;
    });
    if (!acquired) return false;
    ownedLocks.set(nodeKey, lockRef);
    return true;
  }

  async function unlockNode(nodeId) {
    if (!currentProjectKey) return;
    const nodeKey = safeKey(nodeId);
    const lockRef = ownedLocks.get(nodeKey);
    ownedLocks.delete(nodeKey);
    if (lockRef) await deleteDoc(lockRef).catch(() => {});
  }

  function sendCursor(x, y) {
    const now = performance.now();
    if (!cursorRef || now - lastCursorSent < 250) return;
    lastCursorSent = now;
    lastCursorPayload = {
      uid: user.uid,
      sessionId,
      username,
      color,
      x,
      y,
    };
    void setDoc(cursorRef, { ...lastCursorPayload, updatedAt: serverTimestamp() })
      .catch(error => options.onError?.(error));
  }

  function sendNodePosition(nodeId, x, y) {
    const now = performance.now();
    if (!canWrite || now - lastPositionSent < 70) return;
    lastPositionSent = now;
    void sendEvent('node_pos', { nodeId: String(nodeId), x, y }).catch(error => options.onError?.(error));
  }

  function sendNodeText(nodeId, text) {
    if (!canWrite) return;
    void sendEvent('node_text', { nodeId: String(nodeId), text: String(text).slice(0, 20_000) })
      .catch(error => options.onError?.(error));
  }

  function sendTyping(nodeId) {
    if (!canWrite) return;
    void sendEvent('node_typing', { nodeId: String(nodeId) }).catch(error => options.onError?.(error));
  }

  function flushPending() {
    if (!pendingCanvas) return;
    if (options.onCanvas?.(pendingCanvas) !== false) pendingCanvas = null;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    await clearProject();
    while (cleanup.length) cleanup.pop()?.();
    await Promise.allSettled([deleteDoc(sessionRef), deleteDoc(eventRef)]);
    presence.clear();
  }

  await writePresence();
  options.onStatus?.(true);
  return {
    sessionId,
    color,
    canWrite,
    setProject,
    sendCursor,
    sendNodePosition,
    sendNodeText,
    sendTyping,
    lockNode,
    unlockNode,
    flushPending,
    stop,
  };
}
