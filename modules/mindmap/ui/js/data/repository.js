import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  ref,
  remove,
} from 'firebase/database';
import { firebaseServices } from '../firebase/client.js';

const revisions = new Map();
const CONTEXT_KEY = 'wan_mindmap:workspace-context';

export function workspaceContext() {
  let value = null;
  try {
    const raw = sessionStorage.getItem(CONTEXT_KEY);
    value = raw ? JSON.parse(raw) : null;
  } catch {}
  // Hapus format lama yang membuat workspace grup terbawa ke startup berikutnya.
  localStorage.removeItem(CONTEXT_KEY);
  return value?.type === 'group' && value.groupId
    ? value
    : { type: 'personal' };
}

export function setWorkspaceContext(context) {
  localStorage.removeItem(CONTEXT_KEY);
  if (context?.type === 'group' && context.groupId) {
    sessionStorage.setItem(CONTEXT_KEY, JSON.stringify({
        type: 'group',
        groupId: String(context.groupId),
        name: String(context.name || 'Group workspace'),
        role: context.role || 'viewer',
      }));
    return;
  }
  sessionStorage.removeItem(CONTEXT_KEY);
}

export function reloadMindmap() {
  if (window.mindmapHost?.reload) return window.mindmapHost.reload();
  window.location.reload();
  return Promise.resolve(true);
}

function activeUid(auth) {
  return auth?.currentUser?.uid || 'local-user';
}

function safeId(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function mindmapId(uid, projectId) {
  return `${uid}--${safeId(projectId)}`;
}

function activeMindmapId(uid, projectId) {
  const context = workspaceContext();
  return context.type === 'group'
    ? `group-${context.groupId}--${safeId(projectId)}`
    : mindmapId(uid, projectId);
}

function localKey(uid, kind, id = '') {
  return `wan_mindmap:${uid}:${kind}${id ? `:${id}` : ''}`;
}

function localGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function localSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

async function syncPublicSnapshot(services, ownerType, ownerId, projectId, data) {
  if (!services.configured || !services.firestore || !services.auth?.currentUser) return false;
  const pointer = ownerType === 'group'
    ? doc(services.firestore, 'groups', String(ownerId), 'publicShares', safeId(projectId))
    : doc(services.firestore, 'users', String(ownerId), 'publicShares', safeId(projectId));
  try {
    const pointerSnapshot = await getDoc(pointer);
    const token = pointerSnapshot.data()?.token;
    if (!pointerSnapshot.exists() || !token) return false;
    await updateDoc(doc(services.firestore, 'publicShares', String(token)), {
      snapshot: JSON.parse(JSON.stringify(data)),
      updatedBy: services.auth.currentUser.uid,
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (error) {
    console.warn('[WCF] Public share belum tersinkron:', error);
    return false;
  }
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...value,
    nodes: value.nodes && typeof value.nodes === 'object' && !Array.isArray(value.nodes)
      ? value.nodes : {},
    connections: Array.isArray(value.connections) ? value.connections : [],
    groups: value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups)
      ? value.groups : {},
    stickies: value.stickies && typeof value.stickies === 'object' && !Array.isArray(value.stickies)
      ? value.stickies : {},
    frames: value.frames && typeof value.frames === 'object' && !Array.isArray(value.frames)
      ? value.frames : {},
    nextId: Number.isFinite(value.nextId) ? value.nextId : 1,
  };
}

function userProfile(user) {
  return {
    id: user.uid,
    uid: user.uid,
    username: user.displayName || user.email?.split('@')[0] || 'WAN User',
    email: user.email || '',
    role: 'user',
    active: true,
    is_active: true,
    onboarding_done: true,
  };
}

async function saveMindmapMetadata(services, id, metadata) {
  const user = services.auth?.currentUser;
  const projectId = services.app?.options?.projectId;
  if (!user || !projectId) throw new Error('Sesi Firebase tidak tersedia untuk metadata mindmap.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const token = await user.getIdToken();
    const fields = {
      id: { stringValue: metadata.id },
      name: { stringValue: metadata.name },
      nameLower: { stringValue: metadata.nameLower },
      ownerType: { stringValue: metadata.ownerType },
      ownerId: { stringValue: metadata.ownerId },
      createdBy: { stringValue: metadata.createdBy },
      updatedAt: { timestampValue: new Date().toISOString() },
      revision: { integerValue: String(metadata.revision) },
      schemaVersion: { integerValue: String(metadata.schemaVersion) },
      storageMode: { stringValue: metadata.storageMode },
    };
    const updateMask = new URLSearchParams();
    for (const field of Object.keys(fields)) updateMask.append('updateMask.fieldPaths', field);
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`
      + `/databases/(default)/documents/mindmaps/${encodeURIComponent(id)}?${updateMask}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      const error = new Error(result?.error?.message || `Firestore metadata gagal (${response.status}).`);
      error.code = result?.error?.status || `firestore-http-${response.status}`;
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function rtdbRequest(services, path, options = {}) {
  const user = services.auth?.currentUser;
  const databaseURL = services.app?.options?.databaseURL;
  if (!user || !databaseURL) throw new Error('Sesi Realtime Database tidak tersedia.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const token = await user.getIdToken();
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`${String(databaseURL).replace(/\/$/, '')}/${encodedPath}.json`);
    url.searchParams.set('auth', token);
    const response = await fetch(url, {
      ...options,
      headers: options.headers || {},
      signal: controller.signal,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      const error = new Error(result?.error || `Realtime Database gagal (${response.status}).`);
      error.code = response.status === 412 ? 'revision-conflict' : `database-http-${response.status}`;
      error.response = response;
      throw error;
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function currentProfile() {
  const services = await firebaseServices();
  if (!services.configured) {
    return {
      id: 'local-user',
      uid: 'local-user',
      username: 'Local Workspace',
      email: '',
      role: 'user',
      active: true,
      is_active: true,
      onboarding_done: true,
      local: true,
    };
  }
  const user = services.auth.currentUser;
  if (!user) return null;
  const profileRef = doc(services.firestore, 'users', user.uid);
  const snapshot = await getDoc(profileRef);
  const fallback = userProfile(user);
  const token = await user.getIdTokenResult().catch(() => null);
  const effectiveRole = token?.claims?.admin === true ? 'admin' : 'user';
  if (!snapshot.exists()) {
    await setDoc(profileRef, {
      ...fallback,
      usernameLower: fallback.username.toLowerCase(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { ...fallback, role: effectiveRole };
  }
  return { ...fallback, ...snapshot.data(), role: effectiveRole, id: user.uid, uid: user.uid };
}

export async function loadWorkspaceTree() {
  const services = await firebaseServices();
  const uid = activeUid(services.auth);
  const context = workspaceContext();
  if (!services.configured) {
    return context.type === 'personal' ? localGet(localKey(uid, 'workspace')) : null;
  }
  const target = context.type === 'group'
    ? doc(services.firestore, 'groups', context.groupId, 'private', 'workspace')
    : doc(services.firestore, 'users', uid, 'private', 'workspace');
  const snapshot = await getDoc(target);
  return snapshot.exists() ? snapshot.data().tree ?? null : null;
}

export async function saveWorkspaceTree(tree) {
  const services = await firebaseServices();
  const uid = activeUid(services.auth);
  const context = workspaceContext();
  if (context.type === 'personal') localSet(localKey(uid, 'workspace'), tree);
  if (!services.configured) {
    if (context.type === 'group') throw new Error('Workspace grup memerlukan Firebase.');
    return;
  }
  const target = context.type === 'group'
    ? doc(services.firestore, 'groups', context.groupId, 'private', 'workspace')
    : doc(services.firestore, 'users', uid, 'private', 'workspace');
  await setDoc(
    target,
    { tree, updatedAt: serverTimestamp(), schemaVersion: 1 },
    { merge: true }
  );
}

export async function loadGroupWorkspaceTree(groupId) {
  const services = await firebaseServices();
  if (!services.configured || !services.firestore) {
    throw new Error('Workspace grup memerlukan Firebase.');
  }
  const snapshot = await getDoc(doc(
    services.firestore,
    'groups', String(groupId), 'private', 'workspace',
  ));
  return snapshot.exists() ? snapshot.data().tree ?? null : null;
}

export async function saveGroupWorkspaceTree(groupId, tree) {
  const services = await firebaseServices();
  if (!services.configured || !services.firestore) {
    throw new Error('Workspace grup memerlukan Firebase.');
  }
  await setDoc(doc(
    services.firestore,
    'groups', String(groupId), 'private', 'workspace',
  ), {
    tree,
    updatedAt: serverTimestamp(),
    schemaVersion: 1,
  }, { merge: true });
}

export async function loadGroupMindmap(groupId, projectId) {
  const services = await firebaseServices();
  if (!services.configured || !services.firestore) {
    throw new Error('Workspace grup memerlukan Firebase.');
  }
  const snapshot = await getDoc(doc(
    services.firestore,
    'groups', String(groupId), 'mindmaps', safeId(projectId),
  ));
  return snapshot.exists() ? normalizeSnapshot(snapshot.data().snapshot) : null;
}

export async function saveGroupMindmap(groupId, projectId, data) {
  const services = await firebaseServices();
  const user = services.auth?.currentUser;
  if (!services.configured || !services.firestore || !user) {
    throw new Error('Workspace grup memerlukan sesi Firebase.');
  }
  const target = doc(
    services.firestore,
    'groups', String(groupId), 'mindmaps', safeId(projectId),
  );
  const current = await getDoc(target);
  const revision = Number(current.data()?.revision || 0) + 1;
  await setDoc(target, {
    projectId,
    revision,
    snapshot: JSON.parse(JSON.stringify(data)),
    updatedBy: user.uid,
    updatedAt: serverTimestamp(),
    schemaVersion: 1,
  });
  const publicSynced = await syncPublicSnapshot(services, 'group', groupId, projectId, data);
  return { revision, storage: 'firestore-group', publicSynced };
}

export async function deleteGroupMindmap(groupId, projectId) {
  const services = await firebaseServices();
  if (!services.configured || !services.firestore) {
    throw new Error('Workspace grup memerlukan Firebase.');
  }
  await deleteDoc(doc(
    services.firestore,
    'groups', String(groupId), 'mindmaps', safeId(projectId),
  ));
}

export async function renameGroupMindmap(groupId, oldProjectId, newProjectId) {
  const data = await loadGroupMindmap(groupId, oldProjectId);
  if (data) await saveGroupMindmap(groupId, newProjectId, data);
  await deleteGroupMindmap(groupId, oldProjectId);
}

export async function loadMindmap(projectId) {
  const services = await firebaseServices();
  const uid = activeUid(services.auth);
  const context = workspaceContext();
  const cacheKey = localKey(uid, 'mindmap', projectId);
  if (context.type === 'group') {
    if (!services.configured || !services.firestore) {
      throw new Error('Workspace grup memerlukan Firebase.');
    }
    const target = doc(
      services.firestore,
      'groups', context.groupId,
      'mindmaps', safeId(projectId),
    );
    const snapshot = await getDoc(target);
    return snapshot.exists() ? normalizeSnapshot(snapshot.data().snapshot) : null;
  }
  if (!services.configured || !services.database) {
    return normalizeSnapshot(localGet(cacheKey));
  }

  const id = activeMindmapId(uid, projectId);
  const response = await rtdbRequest(services, `mindmaps/${id}`);
  const value = await response.json();
  if (!value) return normalizeSnapshot(localGet(cacheKey));
  revisions.set(id, Number(value.revision || 0));
  const normalized = normalizeSnapshot(value.snapshot);
  if (normalized) localSet(cacheKey, normalized);
  return normalized;
}

export async function saveMindmap(projectId, data) {
  const services = await firebaseServices();
  const uid = activeUid(services.auth);
  const context = workspaceContext();
  const cacheKey = localKey(uid, 'mindmap', projectId);
  if (context.type === 'group') {
    if (!services.configured || !services.firestore) {
      throw new Error('Workspace grup memerlukan Firebase.');
    }
    const target = doc(
      services.firestore,
      'groups', context.groupId,
      'mindmaps', safeId(projectId),
    );
    const current = await getDoc(target);
    const revision = Number(current.data()?.revision || 0) + 1;
    await setDoc(target, {
      projectId,
      revision,
      snapshot: JSON.parse(JSON.stringify(data)),
      updatedBy: uid,
      updatedAt: serverTimestamp(),
      schemaVersion: 1,
    });
    const publicSynced = await syncPublicSnapshot(services, 'group', context.groupId, projectId, data);
    return { revision, storage: 'firestore-group', publicSynced };
  }
  if (context.type === 'personal') localSet(cacheKey, data);
  if (!services.configured || !services.database) {
    return { revision: 0, storage: 'local' };
  }

  const id = activeMindmapId(uid, projectId);
  let expectedRevision = revisions.get(id) ?? 0;
  let revision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentResponse = await rtdbRequest(services, `mindmaps/${id}`, {
      headers: { 'X-Firebase-ETag': 'true' },
    });
    const current = await currentResponse.json();
    const remoteRevision = Number(current?.revision || 0);
    if (remoteRevision !== expectedRevision) {
      if (current?.updatedBy === uid && remoteRevision > expectedRevision) {
        expectedRevision = remoteRevision;
      } else {
        const error = new Error('Data di cloud sudah berubah. Muat ulang sebelum menyimpan.');
        error.code = 'revision-conflict';
        throw error;
      }
    }

    const nextValue = {
      ownerId: context.type === 'group' ? context.groupId : uid,
      projectId,
      revision: expectedRevision + 1,
      updatedAt: Date.now(),
      updatedBy: uid,
      snapshot: JSON.parse(JSON.stringify(data)),
    };
    try {
      await rtdbRequest(services, `mindmaps/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': currentResponse.headers.get('etag') || 'null_etag',
        },
        body: JSON.stringify(nextValue),
      });
      revision = nextValue.revision;
      break;
    } catch (error) {
      if (error?.code !== 'revision-conflict' || attempt === 2) throw error;
    }
  }

  if (!revision) throw new Error('Realtime Database gagal menyimpan setelah beberapa percobaan.');
  revisions.set(id, revision);
  const publicSynced = await syncPublicSnapshot(services, 'user', uid, projectId, data);
  const metadata = {
    id,
    name: projectId,
    nameLower: String(projectId).toLowerCase(),
    ownerType: context.type === 'group' ? 'group' : 'user',
    ownerId: context.type === 'group' ? context.groupId : uid,
    createdBy: uid,
    updatedAt: serverTimestamp(),
    revision,
    schemaVersion: 1,
    storageMode: 'rtdb-snapshot',
  };
  try {
    await saveMindmapMetadata(services, id, metadata);
    return { revision, storage: 'firebase', metadataSynced: true, publicSynced };
  } catch (error) {
    console.warn('[WCF] Metadata Firestore belum tersinkron:', error);
    return {
      revision,
      storage: 'firebase',
      metadataSynced: false,
      publicSynced,
      metadataError: error?.message || String(error),
    };
  }
}

export async function deleteMindmap(projectId) {
  const services = await firebaseServices();
  const uid = activeUid(services.auth);
  const context = workspaceContext();
  if (context.type === 'group') {
    if (!services.configured || !services.firestore) return;
    await deleteDoc(doc(
      services.firestore,
      'groups', context.groupId,
      'mindmaps', safeId(projectId),
    ));
    return;
  }
  if (context.type === 'personal') localStorage.removeItem(localKey(uid, 'mindmap', projectId));
  if (!services.configured || !services.database) return;
  const id = activeMindmapId(uid, projectId);
  await rtdbRequest(services, `mindmaps/${id}`, { method: 'DELETE' });
  try {
    await updateDoc(doc(services.firestore, 'mindmaps', id), {
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch {
  }
  revisions.delete(id);
}

export async function searchMindmaps(query) {
  const services = await firebaseServices();
  const uid = activeUid(services.auth);
  const workspace = await loadWorkspaceTree();
  const matches = [];
  const needle = String(query || '').trim().toLowerCase();
  function visit(node) {
    if (!node) return;
    if (node.type === 'file' && String(node.name || '').toLowerCase().includes(needle)) {
      matches.push({ type: 'personal', file_id: node.id, file_name: node.name, owner_id: uid });
    }
    for (const child of node.children || []) visit(child);
  }
  visit(workspace);
  return matches;
}

export async function listSharedWithMe() {
  const services = await firebaseServices();
  const uid = activeUid(services.auth);
  if (!services.configured) return [];
  const snapshots = await getDocs(query(collection(services.firestore, 'shares'), where('targetId', '==', uid)));
  return snapshots.docs.map((snapshot) => {
    const data = snapshot.data();
    return {
      id: snapshot.id,
      file_id: data.fileId,
      file_name: data.fileName,
      owner_id: data.ownerId,
      owner_name: data.ownerName || 'WAN User',
      permission: data.permission,
      group_name: data.targetType === 'group' ? data.targetName : null,
    };
  });
}

export async function listMyShares(fileId = null) {
  const services = await firebaseServices();
  const uid = activeUid(services.auth);
  if (!services.configured) return [];
  const snapshots = await getDocs(query(collection(services.firestore, 'shares'), where('ownerId', '==', uid)));
  return snapshots.docs
    .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
    .filter((share) => !fileId || share.fileId === fileId)
    .map((share) => ({
      id: share.id,
      file_id: share.fileId,
      file_name: share.fileName,
      permission: share.permission,
      group_name: share.targetType === 'group' ? share.targetName : null,
      shared_with_name: share.targetType === 'user' ? share.targetName : null,
    }));
}

export async function loadSharedMindmap(ownerId, projectId) {
  const services = await firebaseServices();
  if (!services.configured || !services.database) return null;
  const id = mindmapId(ownerId, projectId);
  const response = await rtdbRequest(services, `mindmaps/${id}/snapshot`);
  return await response.json();
}