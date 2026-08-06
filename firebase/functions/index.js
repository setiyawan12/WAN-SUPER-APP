'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { defineSecret } = require('firebase-functions/params');
const { HttpsError, onCall, onRequest } = require('firebase-functions/v2/https');
const { Resend } = require('resend');
const { z } = require('zod');

initializeApp();

const REGION = 'asia-southeast2';
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const db = getFirestore();
const auth = getAuth();
const realtime = getDatabase();

function requireUser(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Login diperlukan.');
  return request.auth.uid;
}

function requireAdmin(request) {
  const uid = requireUser(request);
  if (request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Akses admin diperlukan.');
  }
  return uid;
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpsError('invalid-argument', result.error.issues[0]?.message || 'Input tidak valid.');
  }
  return result.data;
}

async function audit(actorId, action, details = {}) {
  await db.collection('activityLogs').add({
    actorId,
    action,
    details,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function publicShareUrl(token) {
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/share/${token}` : `/share/${token}`;
}

const userInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  username: z.string().trim().min(3).max(40),
  role: z.enum(['admin', 'user']).default('user'),
});

exports.adminListUsers = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const page = await auth.listUsers(500);
  const profiles = await Promise.all(page.users.map(async (record) => {
    const snapshot = await db.doc(`users/${record.uid}`).get();
    const profile = snapshot.exists ? snapshot.data() : {};
    return {
      id: record.uid,
      uid: record.uid,
      email: record.email || '',
      username: profile.username || record.displayName || record.email || record.uid,
      role: record.customClaims?.admin === true ? 'admin' : 'user',
      is_active: !record.disabled,
      created_at: record.metadata.creationTime,
      last_login: record.metadata.lastSignInTime || null,
    };
  }));
  return { users: profiles };
});

exports.adminCreateUser = onCall({ region: REGION }, async (request) => {
  const actorId = requireAdmin(request);
  const input = parse(userInput, request.data);
  const usernameLower = input.username.toLowerCase();
  const reservation = db.doc(`usernames/${usernameLower}`);
  if ((await reservation.get()).exists) {
    throw new HttpsError('already-exists', 'Username sudah digunakan.');
  }
  const record = await auth.createUser({
    email: input.email.toLowerCase(),
    password: input.password,
    displayName: input.username,
    disabled: false,
    emailVerified: false,
  });
  try {
    await auth.setCustomUserClaims(record.uid, { admin: input.role === 'admin' });
    const batch = db.batch();
    batch.create(reservation, { uid: record.uid, createdAt: FieldValue.serverTimestamp() });
    batch.set(db.doc(`users/${record.uid}`), {
      uid: record.uid,
      email: input.email.toLowerCase(),
      username: input.username,
      usernameLower,
      role: input.role,
      active: true,
      onboardingDone: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    await auth.deleteUser(record.uid).catch(() => {});
    throw error;
  }
  await audit(actorId, 'admin.user.create', { targetUid: record.uid, role: input.role });
  return { id: record.uid };
});

const updateUserInput = z.object({
  uid: z.string().min(1),
  username: z.string().trim().min(3).max(40).optional(),
  role: z.enum(['admin', 'user']).optional(),
  is_active: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
});

exports.adminUpdateUser = onCall({ region: REGION }, async (request) => {
  const actorId = requireAdmin(request);
  const input = parse(updateUserInput, request.data);
  const patch = {};
  if (input.username) patch.displayName = input.username;
  if (typeof input.is_active === 'boolean') patch.disabled = !input.is_active;
  if (input.password) patch.password = input.password;
  if (Object.keys(patch).length) await auth.updateUser(input.uid, patch);
  if (input.role) await auth.setCustomUserClaims(input.uid, { admin: input.role === 'admin' });
  await db.doc(`users/${input.uid}`).set({
    ...(input.username ? { username: input.username, usernameLower: input.username.toLowerCase() } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(typeof input.is_active === 'boolean' ? { active: input.is_active } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await audit(actorId, 'admin.user.update', { targetUid: input.uid });
  return { updated: true };
});

exports.adminDeleteUser = onCall({ region: REGION }, async (request) => {
  const actorId = requireAdmin(request);
  const { uid } = parse(z.object({ uid: z.string().min(1) }), request.data);
  if (uid === actorId) throw new HttpsError('failed-precondition', 'Admin tidak dapat menghapus akun sendiri.');
  await auth.deleteUser(uid);
  await db.doc(`users/${uid}`).set({ active: false, deletedAt: FieldValue.serverTimestamp() }, { merge: true });
  await audit(actorId, 'admin.user.delete', { targetUid: uid });
  return { deleted: true };
});

exports.listActiveUsers = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const snapshot = await db.collection('users').where('active', '==', true).limit(500).get();
  return {
    users: snapshot.docs
      .filter((document) => document.id !== uid)
      .map((document) => ({
        id: document.id,
        username: document.data().username,
        email: document.data().email || '',
      })),
  };
});

exports.listMyGroups = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const memberships = await db.collectionGroup('members').where('uid', '==', uid).get();
  const groups = await Promise.all(memberships.docs.map(async (membership) => {
    const groupRef = membership.ref.parent.parent;
    if (!groupRef || groupRef.parent.id !== 'groups') return null;
    const group = await groupRef.get();
    if (!group.exists) return null;
    const data = group.data();
    return {
      id: group.id,
      name: data.name,
      description: data.description || '',
      role: membership.data().role || 'viewer',
      member_count: Number(data.memberCount || 0),
    };
  }));
  return { groups: groups.filter(Boolean) };
});

exports.getGroup = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const { groupId } = parse(z.object({ groupId: z.string().min(1) }), request.data);
  const [group, membership] = await Promise.all([
    db.doc(`groups/${groupId}`).get(),
    db.doc(`groups/${groupId}/members/${uid}`).get(),
  ]);
  if (!group.exists || (!membership.exists && request.auth.token.admin !== true)) {
    throw new HttpsError('permission-denied', 'Akses grup ditolak.');
  }
  return { group: { id: group.id, ...group.data(), role: membership.data()?.role || 'admin' } };
});

exports.getGroupActivity = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const { groupId } = parse(z.object({ groupId: z.string().min(1) }), request.data);
  const membership = await db.doc(`groups/${groupId}/members/${uid}`).get();
  if (!membership.exists && request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Akses grup ditolak.');
  }
  const snapshot = await db.collection('activityLogs')
    .where('details.groupId', '==', groupId)
    .orderBy('createdAt', 'desc')
    .limit(80)
    .get();
  return { activity: snapshot.docs.map((document) => ({ id: document.id, ...document.data() })) };
});

exports.listSharedWithMe = onCall({ region: REGION }, async (request) => {
  const uid = requireUser(request);
  const memberships = await db.collectionGroup('members').where('uid', '==', uid).get();
  const groupIds = memberships.docs
    .map((membership) => membership.ref.parent.parent)
    .filter((groupRef) => groupRef?.parent.id === 'groups')
    .map((groupRef) => groupRef.id);
  const direct = await db.collection('shares').where('targetId', '==', uid).get();
  const groupShares = await Promise.all(groupIds.map((groupId) =>
    db.collection('shares').where('targetId', '==', groupId).get()
  ));
  const documents = new Map();
  direct.docs.forEach((document) => documents.set(document.id, document));
  groupShares.flatMap((snapshot) => snapshot.docs).forEach((document) => documents.set(document.id, document));
  return {
    files: [...documents.values()].map((document) => {
      const data = document.data();
      return {
        id: document.id,
        file_id: data.fileId,
        file_name: data.fileName,
        owner_id: data.ownerId,
        owner_name: data.ownerName || 'WAN User',
        group_name: data.targetType === 'group' ? data.targetName : null,
        permission: data.permission,
      };
    }),
  };
});

const shareInput = z.object({
  fileId: z.string().min(1).max(500),
  fileName: z.string().max(500).optional(),
  targetUserId: z.string().min(1).optional().nullable(),
  targetGroupId: z.string().min(1).optional().nullable(),
  permission: z.enum(['read', 'write']).default('read'),
}).refine((value) => Boolean(value.targetUserId) !== Boolean(value.targetGroupId), {
  message: 'Pilih tepat satu target user atau group.',
});

exports.shareMindmap = onCall({ region: REGION }, async (request) => {
  const ownerId = requireUser(request);
  const input = parse(shareInput, request.data);
  const mindmapId = `${ownerId}--${Buffer.from(input.fileId).toString('base64url')}`;
  const metadata = await db.doc(`mindmaps/${mindmapId}`).get();
  if (!metadata.exists || metadata.data().ownerId !== ownerId) {
    throw new HttpsError('permission-denied', 'Hanya owner yang dapat membagikan mindmap.');
  }
  const targetType = input.targetUserId ? 'user' : 'group';
  const targetId = input.targetUserId || input.targetGroupId;
  let targetName = targetId;
  if (targetType === 'user') {
    const target = await db.doc(`users/${targetId}`).get();
    targetName = target.exists ? target.data().username || targetId : targetId;
  } else {
    const target = await db.doc(`groups/${targetId}`).get();
    targetName = target.exists ? target.data().name || targetId : targetId;
  }
  const shareId = `${mindmapId}--${targetType}--${targetId}`;
  const accessUsers = [];
  if (targetType === 'user') {
    accessUsers.push(targetId);
  } else {
    const members = await db.collection(`groups/${targetId}/members`).get();
    members.docs.forEach((member) => accessUsers.push(member.id));
  }
  await db.runTransaction(async (transaction) => {
    transaction.set(db.doc(`shares/${shareId}`), {
      id: shareId,
      mindmapId,
      fileId: input.fileId,
      fileName: input.fileName || input.fileId,
      ownerId,
      targetType,
      targetId,
      targetName,
      permission: input.permission,
      createdBy: ownerId,
      createdAt: FieldValue.serverTimestamp(),
    });
    for (const accessUid of accessUsers) {
      transaction.set(db.doc(`mindmaps/${mindmapId}/members/${accessUid}`), {
        uid: accessUid,
        permission: input.permission,
        addedBy: ownerId,
        addedAt: FieldValue.serverTimestamp(),
        sourceShareId: shareId,
      });
    }
  });
  await Promise.all(accessUsers.map((accessUid) =>
    realtime.ref(`mindmapAccess/${mindmapId}/${accessUid}`).set({
      read: true,
      write: input.permission === 'write',
      sourceShareId: shareId,
    })
  ));
  await audit(ownerId, 'mindmap.share', { mindmapId, targetType, targetId, permission: input.permission });
  return { id: shareId };
});

exports.unshareMindmap = onCall({ region: REGION }, async (request) => {
  const ownerId = requireUser(request);
  const { shareId } = parse(z.object({ shareId: z.string().min(1) }), request.data);
  const shareRef = db.doc(`shares/${shareId}`);
  const share = await shareRef.get();
  if (!share.exists || share.data().ownerId !== ownerId) {
    throw new HttpsError('permission-denied', 'Share tidak ditemukan atau bukan milik Anda.');
  }
  const data = share.data();
  const batch = db.batch();
  batch.delete(shareRef);
  const memberSnapshots = await db.collection(`mindmaps/${data.mindmapId}/members`)
    .where('sourceShareId', '==', shareId)
    .get();
  memberSnapshots.docs.forEach((member) => batch.delete(member.ref));
  await batch.commit();
  const accessSnapshot = await realtime.ref(`mindmapAccess/${data.mindmapId}`).get();
  if (accessSnapshot.exists()) {
    const removals = [];
    accessSnapshot.forEach((child) => {
      if (child.val()?.sourceShareId === shareId) removals.push(child.ref.remove());
    });
    await Promise.all(removals);
  }
  await audit(ownerId, 'mindmap.unshare', { shareId });
  return { deleted: true };
});

const publicInput = z.object({
  name: z.string().min(1).max(500),
  displayName: z.string().max(500).optional(),
});

exports.createPublicShare = onCall({ region: REGION }, async (request) => {
  const ownerId = requireUser(request);
  const input = parse(publicInput, request.data);
  const mindmapId = `${ownerId}--${Buffer.from(input.name).toString('base64url')}`;
  const metadata = await db.doc(`mindmaps/${mindmapId}`).get();
  if (!metadata.exists || metadata.data().ownerId !== ownerId) {
    throw new HttpsError('permission-denied', 'Mindmap tidak ditemukan.');
  }
  const token = require('node:crypto').randomBytes(24).toString('base64url');
  await db.doc(`publicShares/${token}`).set({
    token,
    mindmapId,
    displayName: input.displayName || input.name,
    enabled: true,
    createdBy: ownerId,
    createdAt: FieldValue.serverTimestamp(),
  });
  await audit(ownerId, 'mindmap.public.create', { mindmapId, token });
  return { token, url: publicShareUrl(token) };
});

exports.getPublicShare = onCall({ region: REGION }, async (request) => {
  const ownerId = requireUser(request);
  const { name } = parse(z.object({ name: z.string().min(1) }), request.data);
  const mindmapId = `${ownerId}--${Buffer.from(name).toString('base64url')}`;
  const snapshot = await db.collection('publicShares')
    .where('mindmapId', '==', mindmapId)
    .where('enabled', '==', true)
    .limit(1)
    .get();
  if (snapshot.empty) return { enabled: false };
  const data = snapshot.docs[0].data();
  return { enabled: true, token: data.token, url: publicShareUrl(data.token) };
});

exports.revokePublicShare = onCall({ region: REGION }, async (request) => {
  const ownerId = requireUser(request);
  const { name } = parse(z.object({ name: z.string().min(1) }), request.data);
  const mindmapId = `${ownerId}--${Buffer.from(name).toString('base64url')}`;
  const snapshot = await db.collection('publicShares').where('mindmapId', '==', mindmapId).get();
  const batch = db.batch();
  snapshot.docs.forEach((document) => batch.update(document.ref, { enabled: false, revokedAt: FieldValue.serverTimestamp() }));
  await batch.commit();
  await audit(ownerId, 'mindmap.public.revoke', { mindmapId });
  return { revoked: snapshot.size };
});

exports.publicShareData = onRequest({ region: REGION, cors: true }, async (request, response) => {
  response.set('Cache-Control', 'public, max-age=60');
  const token = String(request.path.split('/').filter(Boolean).pop() || '');
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) {
    response.status(400).json({ ok: false, error: 'Token tidak valid.' });
    return;
  }
  const share = await db.doc(`publicShares/${token}`).get();
  if (!share.exists || share.data().enabled !== true) {
    response.status(404).json({ ok: false, error: 'Link tidak ditemukan atau sudah dicabut.' });
    return;
  }
  const data = share.data();
  const snapshot = await realtime.ref(`mindmaps/${data.mindmapId}/snapshot`).get();
  response.json({
    ok: true,
    name: data.displayName,
    data: snapshot.exists() ? snapshot.val() : null,
  });
});

exports.sendEmailBlast = onCall({ region: REGION, secrets: [RESEND_API_KEY] }, async (request) => {
  const actorId = requireAdmin(request);
  const input = parse(z.object({
    recipients: z.array(z.string().email()).min(1).max(100),
    subject: z.string().min(1).max(150),
    html: z.string().min(1).max(100000),
  }), request.data);
  const resend = new Resend(RESEND_API_KEY.value());
  const from = process.env.RESEND_FROM || 'WAN Mindmap <onboarding@resend.dev>';
  const results = [];
  for (const recipient of input.recipients) {
    results.push(await resend.emails.send({ from, to: recipient, subject: input.subject, html: input.html }));
  }
  await audit(actorId, 'admin.email.blast', { recipients: input.recipients.length });
  return { sent: results.length };
});