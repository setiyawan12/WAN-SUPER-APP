import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAuth,
  reauthenticateWithCredential,
  signOut,
  updatePassword,
  updateProfile,
} from 'firebase/auth';
import { deleteApp, initializeApp } from 'firebase/app';
import { collection, collectionGroup, doc, getDoc, getDocs, getFirestore, increment, query, serverTimestamp, setDoc, where, writeBatch } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { logout } from './auth-gate.js';
import { firebaseServices } from './firebase/client.js';
import {
  currentProfile,
  deleteGroupMindmap,
  deleteMindmap,
  listMyShares,
  listSharedWithMe,
  loadSharedMindmap,
  loadGroupMindmap,
  loadGroupWorkspaceTree,
  loadMindmap,
  loadWorkspaceTree,
  saveMindmap,
  saveGroupMindmap,
  saveGroupWorkspaceTree,
  saveWorkspaceTree,
  renameGroupMindmap,
  searchMindmaps,
} from './data/repository.js';

const ok = (extra = {}) => ({ ok: true, ...extra });
const unavailable = (feature) => ({ ok: false, error: `${feature} memerlukan Firebase backend production.` });

export function getToken() {
  return '';
}

export async function apiSave(data, name) {
  try {
    return ok(await saveMindmap(name, data));
  } catch (error) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
}

export async function apiLoad(name) {
  return ok({ data: await loadMindmap(name) });
}

export async function apiDelete(name) {
  await deleteMindmap(name);
  return ok();
}

export async function apiRename(oldName, newName) {
  const data = await loadMindmap(oldName);
  if (data) await saveMindmap(newName, data);
  await deleteMindmap(oldName);
  return ok();
}

export async function apiGetWorkspace() {
  return ok({ tree: await loadWorkspaceTree() });
}

export async function apiSaveWorkspace(tree) {
  await saveWorkspaceTree(tree);
  return ok();
}

export async function apiMe() {
  const user = await currentProfile();
  return user ? ok({ user }) : { ok: false, error: 'Belum login' };
}

export async function apiUpdateProfile(data) {
  const services = await firebaseServices();
  const user = services.auth?.currentUser;
  if (!services.configured || !user) return unavailable('Profil cloud');
  try {
    if (data.username) await updateProfile(user, { displayName: data.username });
    if (data.new_password) {
      const credential = EmailAuthProvider.credential(user.email, data.current_password || '');
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, data.new_password);
    }
    return ok();
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function apiLogout() {
  await logout();
  return ok();
}

async function callFunction(name, payload = {}) {
  const services = await firebaseServices();
  if (!services.configured || !services.functions) return unavailable(name);
  try {
    const result = await httpsCallable(services.functions, name)(payload);
    const data = result.data && typeof result.data === 'object' ? result.data : { data: result.data };
    return ok(data);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function listUsersFallback() {
  const services = await firebaseServices();
  if (!services.configured || !services.firestore) return unavailable('Daftar user');
  try {
    const snapshot = await getDocs(collection(services.firestore, 'users'));
    return ok({
      users: snapshot.docs.map(document => {
        const data = document.data();
        return {
          id: document.id,
          uid: document.id,
          email: data.email || '',
          username: data.username || data.email || document.id,
          role: data.role === 'admin' ? 'admin' : 'user',
          is_active: data.active !== false,
          created_at: data.createdAt || null,
          last_login: null,
        };
      }),
      fallback: true,
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function createUserFallback(data) {
  if (data.role === 'admin') {
    return {
      ok: false,
      error: 'Role Admin memerlukan Firebase Functions pada paket Blaze. Buat sebagai User terlebih dahulu.',
    };
  }
  const services = await firebaseServices();
  if (!services.configured || !services.app) return unavailable('Pembuatan user');
  const profile = await currentProfile().catch(() => null);
  if (profile?.role !== 'admin') {
    return { ok: false, error: 'Akses admin diperlukan untuk membuat pengguna.' };
  }
  const secondaryApp = initializeApp(services.app.options, `mindmap-admin-create-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const credential = await createUserWithEmailAndPassword(secondaryAuth, data.email, data.password);
    await updateProfile(credential.user, { displayName: data.username });
    await setDoc(doc(getFirestore(secondaryApp), 'users', credential.user.uid), {
      uid: credential.user.uid,
      email: data.email.toLowerCase(),
      username: data.username,
      usernameLower: data.username.toLowerCase(),
      role: 'user',
      active: true,
      onboardingDone: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ok({ id: credential.user.uid, fallback: true });
  } catch (error) {
    return { ok: false, error: error.message, errorCode: error.code };
  } finally {
    await signOut(secondaryAuth).catch(() => {});
    await deleteApp(secondaryApp).catch(() => {});
  }
}

export async function apiGetUsers() {
  const cloud = await callFunction('adminListUsers');
  return cloud.ok ? cloud : listUsersFallback();
}

export async function apiCreateUser(data) {
  const cloud = await callFunction('adminCreateUser', data);
  return cloud.ok ? cloud : createUserFallback(data);
}
export const apiUpdateUser = (id, data) => callFunction('adminUpdateUser', { uid: id, ...data });
export const apiDeleteUser = (id) => callFunction('adminDeleteUser', { uid: id });
async function listMyGroupsFallback() {
  const services = await firebaseServices();
  const uid = services.auth?.currentUser?.uid;
  if (!services.configured || !services.firestore || !uid) return unavailable('Daftar grup');
  try {
    const profile = await currentProfile().catch(() => null);
    if (profile?.role === 'admin') {
      const ownedGroups = await getDocs(query(
        collection(services.firestore, 'groups'),
        where('ownerId', '==', uid),
      ));
      return ok({
        groups: ownedGroups.docs.map(group => {
          const data = group.data();
          return {
            id: group.id,
            name: data.name,
            description: data.description || '',
            role: 'owner',
            member_count: Number(data.memberCount || 0),
          };
        }),
        fallback: true,
      });
    }
    let memberships = await getDocs(collection(services.firestore, 'users', uid, 'groupMemberships'));
    if (memberships.empty) {
      const legacy = await getDocs(query(collectionGroup(services.firestore, 'members'), where('uid', '==', uid)));
      if (!legacy.empty) {
        const migration = writeBatch(services.firestore);
        legacy.docs.forEach(membership => {
          const groupRef = membership.ref.parent.parent;
          if (!groupRef || groupRef.parent.id !== 'groups') return;
          migration.set(doc(services.firestore, 'users', uid, 'groupMemberships', groupRef.id), {
            groupId: groupRef.id,
            role: membership.data().role || 'viewer',
            joinedAt: membership.data().joinedAt || serverTimestamp(),
          });
        });
        await migration.commit();
        memberships = await getDocs(collection(services.firestore, 'users', uid, 'groupMemberships'));
      }
    }
    const groups = await Promise.all(memberships.docs.map(async membership => {
      const groupRef = doc(services.firestore, 'groups', membership.id);
      const group = await getDoc(groupRef);
      if (!group.exists()) return null;
      const data = group.data();
      return {
        id: group.id,
        name: data.name,
        description: data.description || '',
        role: membership.data().role || 'viewer',
        member_count: Number(data.memberCount || 0),
      };
    }));
    return ok({ groups: groups.filter(Boolean), fallback: true });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function apiGetMyGroups() {
  const cloud = await callFunction('listMyGroups');
  return cloud.ok ? cloud : listMyGroupsFallback();
}

export async function apiCreateGroup(data) {
  const services = await firebaseServices();
  const uid = services.auth?.currentUser?.uid;
  if (!services.configured || !services.firestore || !uid) return unavailable('Pembuatan grup');
  const profile = await currentProfile().catch(() => null);
  if (profile?.role !== 'admin') return { ok: false, error: 'Hanya Admin yang dapat membuat workspace grup.' };
  const name = String(data?.name || '').trim();
  const description = String(data?.description || '').trim();
  if (name.length < 3 || name.length > 80) return { ok: false, error: 'Nama grup harus 3-80 karakter.' };
  if (description.length > 240) return { ok: false, error: 'Deskripsi maksimal 240 karakter.' };
  try {
    const groupRef = doc(collection(services.firestore, 'groups'));
    const batch = writeBatch(services.firestore);
    batch.set(groupRef, {
      name,
      nameLower: name.toLowerCase(),
      description,
      ownerId: uid,
      createdBy: uid,
      memberCount: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(services.firestore, 'groups', groupRef.id, 'members', uid), {
      uid,
      role: 'owner',
      joinedAt: serverTimestamp(),
    });
    batch.set(doc(services.firestore, 'users', uid, 'groupMemberships', groupRef.id), {
      groupId: groupRef.id,
      role: 'owner',
      joinedAt: serverTimestamp(),
    });
    batch.set(doc(services.firestore, 'groups', groupRef.id, 'private', 'workspace'), {
      tree: { id: 'root', name: 'root', type: 'folder', expanded: true, children: [{ id: 'default', name: 'Default', type: 'file' }] },
      schemaVersion: 1,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
    return ok({ group: { id: groupRef.id, name, description, role: 'owner', member_count: 1 }, fallback: true });
  } catch (error) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
}

export async function apiListGroupMembers(groupId) {
  const services = await firebaseServices();
  if (!services.configured || !services.firestore) return unavailable('Daftar anggota grup');
  try {
    const snapshot = await getDocs(collection(services.firestore, 'groups', String(groupId), 'members'));
    const members = await Promise.all(snapshot.docs.map(async membership => {
      const profile = await getDoc(doc(services.firestore, 'users', membership.id));
      const data = profile.data() || {};
      return {
        id: membership.id,
        uid: membership.id,
        username: data.username || data.email || membership.id,
        email: data.email || '',
        role: membership.data().role || 'viewer',
      };
    }));
    return ok({ members });
  } catch (error) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
}

export async function apiAddGroupMember(groupId, uid, role = 'viewer') {
  const services = await firebaseServices();
  if (!services.configured || !services.firestore) return unavailable('Tambah anggota grup');
  if (!['viewer', 'editor'].includes(role)) return { ok: false, error: 'Role anggota tidak valid.' };
  try {
    const memberRef = doc(services.firestore, 'groups', String(groupId), 'members', String(uid));
    if ((await getDoc(memberRef)).exists()) return { ok: false, error: 'User sudah menjadi anggota grup.' };
    const batch = writeBatch(services.firestore);
    batch.set(memberRef, { uid: String(uid), role, joinedAt: serverTimestamp() });
    batch.set(doc(services.firestore, 'users', String(uid), 'groupMemberships', String(groupId)), {
      groupId: String(groupId),
      role,
      joinedAt: serverTimestamp(),
    });
    batch.update(doc(services.firestore, 'groups', String(groupId)), {
      memberCount: increment(1),
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
    return ok();
  } catch (error) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
}

export async function apiRemoveGroupMember(groupId, uid) {
  const services = await firebaseServices();
  if (!services.configured || !services.firestore) return unavailable('Hapus anggota grup');
  try {
    const batch = writeBatch(services.firestore);
    batch.delete(doc(services.firestore, 'groups', String(groupId), 'members', String(uid)));
    batch.delete(doc(services.firestore, 'users', String(uid), 'groupMemberships', String(groupId)));
    batch.update(doc(services.firestore, 'groups', String(groupId)), {
      memberCount: increment(-1),
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
    return ok();
  } catch (error) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
}
export const apiListUsers = () => callFunction('listActiveUsers');
export const apiGetSharedWithMe = async () => {
  const cloud = await callFunction('listSharedWithMe');
  if (cloud.ok) return cloud;
  return ok({ files: await listSharedWithMe() });
};
export const apiGetMyShares = async (fileId = null) => ok({ files: await listMyShares(fileId) });
export const apiShareFile = (fileId, fileName, targetUserId, targetGroupId, permission) =>
  callFunction('shareMindmap', { fileId, fileName, targetUserId, targetGroupId, permission });
export const apiUnshareFile = (shareId) => callFunction('unshareMindmap', { shareId });
export const apiLoadSharedFile = async (ownerId, fileId) => ok({ data: await loadSharedMindmap(ownerId, fileId) });
export async function apiGroupGetInfo(groupId) {
  const cloud = await callFunction('getGroup', { groupId });
  if (cloud.ok) return cloud;
  const services = await firebaseServices();
  const uid = services.auth?.currentUser?.uid;
  if (!services.configured || !services.firestore || !uid) return unavailable('Akses grup');
  try {
    const [group, membership] = await Promise.all([
      getDoc(doc(services.firestore, 'groups', String(groupId))),
      getDoc(doc(services.firestore, 'groups', String(groupId), 'members', uid)),
    ]);
    if (!group.exists()) return { ok: false, error: 'Workspace grup tidak ditemukan.' };
    const profile = await currentProfile().catch(() => null);
    if (!membership.exists() && profile?.role !== 'admin') {
      return { ok: false, error: 'Anda bukan anggota workspace grup ini.' };
    }
    return ok({
      group: {
        id: group.id,
        ...group.data(),
        role: membership.data()?.role || 'admin',
      },
      fallback: true,
    });
  } catch (error) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
}
export const apiGroupGetWorkspace = async (groupId) => ok({ tree: await loadGroupWorkspaceTree(groupId) });
export const apiGroupSaveWorkspace = async (groupId, tree) => {
  await saveGroupWorkspaceTree(groupId, tree);
  return ok();
};
export const apiGroupLoad = async (groupId, name) => ok({ data: await loadGroupMindmap(groupId, name) });
export async function apiGroupSave(groupId, data, name) {
  try {
    return ok(await saveGroupMindmap(groupId, name, data));
  } catch (error) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
}
export async function apiGroupDelete(groupId, name) {
  await deleteGroupMindmap(groupId, name);
  return ok();
}
export async function apiGroupRename(groupId, oldName, newName) {
  await renameGroupMindmap(groupId, oldName, newName);
  return ok();
}
export const apiListGroupMindmaps = async (groupId) => {
  const tree = await loadGroupWorkspaceTree(groupId);
  const projects = [];
  function visit(node) {
    if (!node) return;
    if (node.type === 'file') projects.push({ name: node.id, display_name: node.name });
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return ok({ projects });
};
export const apiGetGroupActivity = (groupId) => callFunction('getGroupActivity', { groupId });
export const apiGetPublicShare = (name) => callFunction('getPublicShare', { name });
export const apiEnablePublicShare = (name, displayName) => callFunction('createPublicShare', { name, displayName });
export const apiDisablePublicShare = (name) => callFunction('revokePublicShare', { name });
export const apiGetGroupPublicShare = async () => unavailable('Group public share');
export const apiEnableGroupPublicShare = async () => unavailable('Group public share');
export const apiDisableGroupPublicShare = async () => unavailable('Group public share');
export const apiAdminGetWorkspace = async () => unavailable('Admin workspace viewer');
export const apiAdminLoadMindmap = async () => unavailable('Admin workspace viewer');
export const apiGetComments = async () => ok({ comments: [] });
export const apiPostComment = async () => unavailable('Cloud comments');
export const apiGetNodeHistory = async () => ok({ history: [] });
export const apiGetFileHistory = async () => ok({ history: [] });

export async function apiSearchGlobal(query) {
  return ok({ results: await searchMindmaps(query) });
}
