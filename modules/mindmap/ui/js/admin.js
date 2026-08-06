import {
  apiAddGroupMember,
  apiCreateGroup,
  apiCreateUser,
  apiDeleteUser,
  apiGetMyGroups,
  apiGetUsers,
  apiListGroupMembers,
  apiLogout,
  apiMe,
  apiRemoveGroupMember,
  apiSendEmailBlast,
  apiUpdateUser,
} from './api.js';
import { ensureAuthenticated } from './auth-gate.js';
import { shimmerCards, shimmerList, shimmerRows } from './ui/loading.js';

const state = {
  currentUser: null,
  users: [],
  groups: [],
  fallback: false,
};

const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function appUrl() {
  return new URL('./index.html', window.location.href).href;
}

function formatDate(value) {
  if (!value) return '—';
  const date = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function errorMessage(error) {
  const message = String(error?.message || error || 'Terjadi kesalahan.');
  if (message.includes('permission-denied')) return 'Akses admin belum aktif. Logout lalu login kembali.';
  if (message.includes('unauthenticated')) return 'Sesi berakhir. Silakan login kembali.';
  if (message.includes('not-found')) return 'Firebase Functions admin belum dideploy.';
  if (message.includes('email-already-in-use')) return 'Email sudah terdaftar.';
  if (message.includes('already-exists')) return 'Username sudah digunakan.';
  if (message.includes('weak-password')) return 'Password belum memenuhi kebijakan Firebase.';
  return message;
}

function setFormMessage(id, message, success = false) {
  const element = byId(id);
  if (!element) return;
  element.textContent = message;
  element.style.display = message ? 'block' : 'none';
  element.style.color = success ? 'var(--green)' : '#f87171';
}

function setPage(pageName) {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName);
  });
  document.querySelectorAll('.page').forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageName}`);
  });
  if (pageName === 'dashboard') void loadDashboard();
  if (pageName === 'users') void loadUsers();
  if (pageName === 'groups') void loadGroups();
  if (pageName === 'email-blast') void prepareEmailBlast();
}

function renderDashboard() {
  const activeUsers = state.users.filter(user => user.is_active !== false);
  const admins = state.users.filter(user => user.role === 'admin');
  byId('s-total-users').textContent = state.users.length;
  byId('s-active-users').textContent = activeUsers.length;
  byId('s-admins').textContent = admins.length;
  byId('s-inactive-users').textContent = state.users.length - activeUsers.length;
  byId('s-groups').textContent = state.groups.length;

  const body = byId('recent-logins-body');
  const recent = [...state.users]
    .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))
    .slice(0, 8);
  body.innerHTML = recent.length ? recent.map(user => `
    <tr>
      <td><strong>${escapeHtml(user.username || user.email)}</strong><br><span style="color:var(--text3)">${escapeHtml(user.email || '')}</span></td>
      <td><span class="badge ${user.role === 'admin' ? 'badge-admin' : 'badge-user'}">${escapeHtml(user.role || 'user')}</span></td>
      <td><span class="dot ${user.is_active === false ? 'dot-red' : 'dot-green'}"></span>${user.is_active === false ? 'Nonaktif' : 'Aktif'}</td>
    </tr>`).join('') : '<tr><td colspan="3" class="empty">Belum ada pengguna.</td></tr>';
}

function renderDashboardLoading() {
  ['s-total-users', 's-active-users', 's-admins', 's-inactive-users', 's-groups'].forEach(id => {
    byId(id).innerHTML = '<span class="wcf-shimmer-line is-heading" style="--shimmer-width:62%"></span>';
  });
  byId('recent-logins-body').innerHTML = shimmerRows(3, 5);
}

async function refreshData() {
  const [usersResult, groupsResult] = await Promise.all([apiGetUsers(), apiGetMyGroups()]);
  if (!usersResult.ok) throw new Error(usersResult.error || 'Daftar pengguna gagal dimuat.');
  if (!groupsResult.ok) throw new Error(groupsResult.error || 'Daftar grup gagal dimuat.');
  state.users = usersResult.users || [];
  state.groups = groupsResult.groups || [];
  state.fallback = Boolean(usersResult.fallback);
}

async function loadDashboard() {
  byId('recent-logins-body').innerHTML = shimmerRows(3, 5);
  try {
    await refreshData();
    renderDashboard();
  } catch (error) {
    byId('recent-logins-body').innerHTML = `<tr><td colspan="3" class="empty">${escapeHtml(errorMessage(error))}</td></tr>`;
  }
}

function userActions(user) {
  if (user.id === state.currentUser.id) return '<span style="color:var(--text3)">Akun aktif</span>';
  if (state.fallback) return '<span style="color:var(--text3)">Perlu Firebase Functions</span>';
  return `
    <button class="btn btn-ghost btn-xs" data-user-action="toggle" data-id="${escapeHtml(user.id)}">${user.is_active === false ? 'Aktifkan' : 'Nonaktifkan'}</button>
    <button class="btn btn-amber btn-xs" data-user-action="role" data-id="${escapeHtml(user.id)}">${user.role === 'admin' ? 'Jadikan User' : 'Jadikan Admin'}</button>
    <button class="btn btn-ghost btn-xs" data-user-action="password" data-id="${escapeHtml(user.id)}">Password</button>
    <button class="btn btn-red btn-xs" data-user-action="delete" data-id="${escapeHtml(user.id)}">Hapus</button>`;
}

function renderUsers() {
  const body = byId('users-body');
  if (!state.users.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Belum ada pengguna.</td></tr>';
    return;
  }
  body.innerHTML = state.users.map(user => `
    <tr>
      <td><span class="dot ${user.is_active === false ? 'dot-red' : 'dot-green'}"></span>${user.is_active === false ? 'Nonaktif' : 'Aktif'}</td>
      <td><strong>${escapeHtml(user.username || '—')}</strong></td>
      <td>${escapeHtml(user.email || '—')}</td>
      <td><span class="badge ${user.role === 'admin' ? 'badge-admin' : 'badge-user'}">${escapeHtml(user.role || 'user')}</span></td>
      <td>${escapeHtml(formatDate(user.created_at))}</td>
      <td style="display:flex;gap:5px;flex-wrap:wrap">${userActions(user)}</td>
    </tr>`).join('');
}

async function loadUsers() {
  byId('users-body').innerHTML = shimmerRows(6, 6);
  try {
    const result = await apiGetUsers();
    if (!result.ok) throw new Error(result.error);
    state.users = result.users || [];
    state.fallback = Boolean(result.fallback);
    byId('u-role').querySelector('option[value="admin"]').disabled = state.fallback;
    byId('u-role').title = state.fallback ? 'Role Admin memerlukan Firebase Functions yang aktif.' : '';
    renderUsers();
  } catch (error) {
    byId('users-body').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(errorMessage(error))}</td></tr>`;
  }
}

async function handleUserAction(button) {
  const user = state.users.find(candidate => String(candidate.id) === button.dataset.id);
  if (!user) return;
  const action = button.dataset.userAction;
  let result;
  if (action === 'toggle') {
    if (!confirm(`${user.is_active === false ? 'Aktifkan' : 'Nonaktifkan'} akun ${user.username}?`)) return;
    result = await apiUpdateUser(user.id, { is_active: user.is_active === false });
  } else if (action === 'role') {
    const role = user.role === 'admin' ? 'user' : 'admin';
    if (!confirm(`Ubah role ${user.username} menjadi ${role}?`)) return;
    result = await apiUpdateUser(user.id, { role });
  } else if (action === 'password') {
    const password = prompt(`Password baru untuk ${user.username} (minimal 8 karakter):`);
    if (!password) return;
    result = await apiUpdateUser(user.id, { password });
  } else if (action === 'delete') {
    if (!confirm(`Hapus akun ${user.username}? Tindakan ini tidak dapat dibatalkan.`)) return;
    result = await apiDeleteUser(user.id);
  }
  if (!result?.ok) {
    alert(errorMessage(result?.error));
    return;
  }
  await loadUsers();
}

async function createUser() {
  const username = byId('u-username').value.trim();
  const email = byId('u-email').value.trim();
  const password = byId('u-password').value;
  const role = byId('u-role').value;
  setFormMessage('add-user-error', '');
  if (username.length < 3 || !email || password.length < 8) {
    setFormMessage('add-user-error', 'Isi username, email valid, dan password minimal 8 karakter.');
    return;
  }
  if (state.fallback && role === 'admin') {
    setFormMessage('add-user-error', 'Role Admin memerlukan Firebase Functions yang aktif.');
    return;
  }
  const button = byId('btn-add-user');
  button.disabled = true;
  try {
    const result = await apiCreateUser({ username, email, password, role });
    if (!result.ok) throw new Error(result.error);
    byId('u-username').value = '';
    byId('u-email').value = '';
    byId('u-password').value = '';
    byId('u-role').value = 'user';
    setFormMessage('add-user-error', `Pengguna ${username} berhasil dibuat.`, true);
    await loadUsers();
  } catch (error) {
    setFormMessage('add-user-error', errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

function groupCard(group) {
  return `
    <article class="group-card" data-group-id="${escapeHtml(group.id)}">
      <h3>${escapeHtml(group.name)}</h3>
      <p>${escapeHtml(group.description || 'Tanpa deskripsi')}</p>
      <div class="group-stats-box">
        <div class="gs-row"><span>Role</span><strong>${escapeHtml(group.role || 'owner')}</strong></div>
        <div class="gs-row"><span>Anggota</span><strong>${Number(group.member_count || 0)}</strong></div>
      </div>
      <button class="btn btn-ghost" data-group-action="members" style="margin-top:10px">Kelola Anggota</button>
      <div class="member-list" data-members style="margin-top:10px"></div>
    </article>`;
}

async function loadGroups() {
  const container = byId('groups-container');
  container.className = '';
  container.innerHTML = shimmerCards(4);
  try {
    const result = await apiGetMyGroups();
    if (!result.ok) throw new Error(result.error);
    state.groups = result.groups || [];
    container.className = state.groups.length ? 'group-grid' : '';
    container.innerHTML = state.groups.length
      ? state.groups.map(groupCard).join('')
      : '<div class="empty">Belum ada grup. Buat grup pertama melalui form di atas.</div>';
  } catch (error) {
    container.innerHTML = `<div class="empty">${escapeHtml(errorMessage(error))}</div>`;
  }
}

async function renderMembers(groupId, container) {
  container.innerHTML = shimmerList(3);
  const [membersResult, usersResult] = await Promise.all([apiListGroupMembers(groupId), apiGetUsers()]);
  if (!membersResult.ok || !usersResult.ok) {
    container.innerHTML = `<div class="empty" style="padding:12px">${escapeHtml(errorMessage(membersResult.error || usersResult.error))}</div>`;
    return;
  }
  const members = membersResult.members || [];
  const memberIds = new Set(members.map(member => String(member.id)));
  const available = (usersResult.users || []).filter(user => !memberIds.has(String(user.id)) && user.is_active !== false);
  container.innerHTML = `
    ${members.map(member => `
      <div class="member-row">
        <span>${escapeHtml(member.username)}</span>
        <span class="badge ${member.role === 'owner' ? 'badge-admin' : 'badge-read'}">${escapeHtml(member.role)}</span>
        ${member.role === 'owner' ? '' : `<button class="btn btn-red btn-xs" data-remove-member="${escapeHtml(member.id)}">Hapus</button>`}
      </div>`).join('') || '<div class="empty" style="padding:12px">Belum ada anggota.</div>'}
    <div class="add-member-row">
      <select data-member-user><option value="">Pilih user</option>${available.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.username)}</option>`).join('')}</select>
      <select data-member-role><option value="viewer">Viewer</option><option value="editor">Editor</option></select>
      <button class="btn btn-primary btn-xs" data-add-member ${available.length ? '' : 'disabled'}>Tambah</button>
    </div>`;
}

async function handleGroupAction(target) {
  const card = target.closest('[data-group-id]');
  if (!card) return;
  const groupId = card.dataset.groupId;
  const membersContainer = card.querySelector('[data-members]');
  if (target.matches('[data-group-action="members"]')) {
    await renderMembers(groupId, membersContainer);
  } else if (target.matches('[data-add-member]')) {
    const uid = card.querySelector('[data-member-user]').value;
    const role = card.querySelector('[data-member-role]').value;
    if (!uid) return;
    const result = await apiAddGroupMember(groupId, uid, role);
    if (!result.ok) return alert(errorMessage(result.error));
    await loadGroups();
  } else if (target.matches('[data-remove-member]')) {
    if (!confirm('Hapus anggota dari grup ini?')) return;
    const result = await apiRemoveGroupMember(groupId, target.dataset.removeMember);
    if (!result.ok) return alert(errorMessage(result.error));
    await loadGroups();
  }
}

async function createGroup() {
  const name = byId('g-name').value.trim();
  const description = byId('g-desc').value.trim();
  setFormMessage('add-group-error', '');
  if (name.length < 3) return setFormMessage('add-group-error', 'Nama grup minimal 3 karakter.');
  const button = byId('btn-add-group');
  button.disabled = true;
  try {
    const result = await apiCreateGroup({ name, description });
    if (!result.ok) throw new Error(result.error);
    byId('g-name').value = '';
    byId('g-desc').value = '';
    setFormMessage('add-group-error', `Grup ${name} berhasil dibuat.`, true);
    await loadGroups();
  } catch (error) {
    setFormMessage('add-group-error', errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

async function prepareEmailBlast() {
  const result = await apiGetMyGroups();
  if (result.ok) state.groups = result.groups || [];
  byId('blast-group-id').innerHTML = '<option value="">Pilih grup...</option>' + state.groups
    .map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`)
    .join('');
  updateBlastPreview();
}

async function resolveRecipients() {
  if (!state.users.length) {
    const result = await apiGetUsers();
    if (!result.ok) throw new Error(result.error);
    state.users = result.users || [];
  }
  if (byId('blast-target').value === 'all') {
    return state.users.filter(user => user.is_active !== false && user.email).map(user => user.email);
  }
  const groupId = byId('blast-group-id').value;
  if (!groupId) return [];
  const result = await apiListGroupMembers(groupId);
  if (!result.ok) throw new Error(result.error);
  return (result.members || []).map(member => member.email).filter(Boolean);
}

async function updateBlastPreview() {
  try {
    const recipients = await resolveRecipients();
    byId('blast-preview-count').textContent = `${new Set(recipients).size} penerima`;
  } catch (error) {
    byId('blast-preview-count').textContent = errorMessage(error);
  }
}

function messageToHtml(message) {
  return `<div style="font-family:Arial,sans-serif;line-height:1.65;color:#202522">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`;
}

async function sendBlast() {
  const subject = byId('blast-subject').value.trim();
  const message = byId('blast-message').value.trim();
  const resultBox = byId('blast-result');
  resultBox.style.display = 'none';
  if (!subject || !message) {
    resultBox.textContent = 'Subject dan isi pesan wajib diisi.';
    resultBox.className = 'blast-result error';
    resultBox.style.display = 'block';
    return;
  }
  const button = byId('btn-blast-send');
  button.disabled = true;
  try {
    const recipients = [...new Set(await resolveRecipients())].slice(0, 100);
    if (!recipients.length) throw new Error('Tidak ada penerima dengan email aktif.');
    const result = await apiSendEmailBlast(recipients, subject, messageToHtml(message));
    if (!result.ok) throw new Error(result.error);
    resultBox.textContent = `Email berhasil dikirim ke ${result.sent || recipients.length} penerima.`;
    resultBox.className = 'blast-result';
    resultBox.style.display = 'block';
  } catch (error) {
    resultBox.textContent = errorMessage(error);
    resultBox.className = 'blast-result error';
    resultBox.style.display = 'block';
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => setPage(item.dataset.page));
  });
  byId('btn-back-app').addEventListener('click', () => window.location.replace(appUrl()));
  byId('nav-back-app').addEventListener('click', () => window.location.replace(appUrl()));
  byId('btn-logout').addEventListener('click', async () => {
    if (!confirm('Keluar dari akun admin?')) return;
    await apiLogout();
    window.location.replace(appUrl());
  });
  byId('btn-add-user').addEventListener('click', createUser);
  byId('users-body').addEventListener('click', event => {
    const button = event.target.closest('[data-user-action]');
    if (button) void handleUserAction(button);
  });
  byId('btn-add-group').addEventListener('click', createGroup);
  byId('groups-container').addEventListener('click', event => void handleGroupAction(event.target));
  byId('blast-target').addEventListener('change', () => {
    byId('blast-group-row').style.display = byId('blast-target').value === 'group' ? 'block' : 'none';
    void updateBlastPreview();
  });
  byId('blast-group-id').addEventListener('change', () => void updateBlastPreview());
  byId('btn-blast-send').addEventListener('click', sendBlast);
}

async function boot() {
  renderDashboardLoading();
  await ensureAuthenticated();
  const me = await apiMe();
  if (!me.ok || me.user?.role !== 'admin') {
    alert('Akses admin diperlukan.');
    window.location.replace(appUrl());
    return;
  }
  state.currentUser = me.user;
  byId('top-username').textContent = me.user.username || me.user.email || 'Admin';
  bindEvents();
  await loadDashboard();
}

boot().catch(error => {
  alert(errorMessage(error));
  window.location.replace(appUrl());
});