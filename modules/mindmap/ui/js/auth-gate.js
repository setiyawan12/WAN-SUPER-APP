import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { firebaseServices } from './firebase/client.js';

function waitForUser(auth) {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (user) => {
      off();
      resolve(user);
    });
  });
}

function authShell() {
  const shell = document.createElement('div');
  shell.id = 'wan-auth-gate';
  shell.innerHTML = `
    <div class="wan-auth-stage" aria-live="polite">
      <section class="wan-auth-brand">
        <span class="wan-auth-kicker">WAN KNOWLEDGE SYSTEM</span>
        <h1>Map complex work.<br><strong>See the whole system.</strong></h1>
        <p>Workspace visual untuk strategi, arsitektur, dan keputusan tim dengan sinkronisasi cloud yang aman.</p>
        <div class="wan-auth-signals">
          <span><i></i> Encrypted session</span>
          <span><i></i> Realtime-ready</span>
          <span><i></i> Offline cache</span>
        </div>
      </section>
      <form class="wan-auth-panel" id="wan-auth-form">
        <div class="wan-auth-panel-head">
          <span class="wan-auth-mark">W</span>
          <div><small>WAN SUPER APP</small><h2>Mindmap access</h2></div>
        </div>
        <label>Email<input id="wan-auth-email" type="email" autocomplete="email" required placeholder="name@company.com"></label>
        <label>Password<input id="wan-auth-password" type="password" autocomplete="current-password" minlength="6" required placeholder="Minimum 6 characters"></label>
        <p id="wan-auth-error" class="wan-auth-error" role="alert"></p>
        <button id="wan-auth-submit" type="submit">Sign in securely</button>
        <div class="wan-auth-actions">
          <button id="wan-auth-create" type="button">Create account</button>
          <button id="wan-auth-reset" type="button">Reset password</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(shell);
  return shell;
}

function messageFor(error) {
  const code = error?.code || '';
  if (code.includes('invalid-credential')) return 'Email atau password tidak sesuai.';
  if (code.includes('email-already-in-use')) return 'Email sudah terdaftar.';
  if (code.includes('weak-password')) return 'Password terlalu lemah.';
  if (code.includes('network-request-failed')) return 'Tidak dapat terhubung ke Firebase.';
  return error?.message || 'Autentikasi gagal.';
}

async function showAuthGate(services) {
  const shell = authShell();
  const form = shell.querySelector('#wan-auth-form');
  const email = shell.querySelector('#wan-auth-email');
  const password = shell.querySelector('#wan-auth-password');
  const error = shell.querySelector('#wan-auth-error');
  const submit = shell.querySelector('#wan-auth-submit');

  function setBusy(busy, label = 'Sign in securely') {
    submit.disabled = busy;
    submit.textContent = busy ? 'Connecting...' : label;
  }

  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      setBusy(true);
      try {
        const credential = await signInWithEmailAndPassword(services.auth, email.value.trim(), password.value);
        shell.remove();
        resolve(credential.user);
      } catch (authError) {
        error.textContent = messageFor(authError);
        setBusy(false);
      }
    });

    shell.querySelector('#wan-auth-create').addEventListener('click', async () => {
      error.textContent = '';
      if (!email.value.trim() || password.value.length < 6) {
        error.textContent = 'Isi email dan password minimal 6 karakter.';
        return;
      }
      setBusy(true, 'Create account');
      try {
        const credential = await createUserWithEmailAndPassword(services.auth, email.value.trim(), password.value);
        await updateProfile(credential.user, { displayName: email.value.split('@')[0] });
        await sendEmailVerification(credential.user).catch(() => {});
        shell.remove();
        resolve(credential.user);
      } catch (authError) {
        error.textContent = messageFor(authError);
        setBusy(false);
      }
    });

    shell.querySelector('#wan-auth-reset').addEventListener('click', async () => {
      error.textContent = '';
      if (!email.value.trim()) {
        error.textContent = 'Isi email terlebih dahulu.';
        return;
      }
      try {
        await sendPasswordResetEmail(services.auth, email.value.trim());
        error.textContent = 'Email reset password sudah dikirim.';
        error.classList.add('is-success');
      } catch (authError) {
        error.textContent = messageFor(authError);
      }
    });
  });
}

export async function ensureAuthenticated() {
  const services = await firebaseServices();
  if (!services.configured) return { uid: 'local-user', displayName: 'Local Workspace', local: true };
  const existing = await waitForUser(services.auth);
  return existing || showAuthGate(services);
}

export async function logout() {
  const services = await firebaseServices();
  if (services.configured) await signOut(services.auth);
}