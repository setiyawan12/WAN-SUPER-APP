import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  emulator: boolean;
}

let servicesPromise: Promise<FirebaseServices> | undefined;

function parseFirebaseConfig(raw: string): FirebaseOptions | null {
  try {
    const config = JSON.parse(raw) as FirebaseOptions;
    return config.apiKey && config.projectId && config.appId ? config : null;
  } catch {
    return null;
  }
}

async function loadFirebaseConfig(): Promise<FirebaseOptions> {
  const configured = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
  const fromEnv = configured ? parseFirebaseConfig(configured) : null;
  if (fromEnv) return fromEnv;

  const response = await fetch("/__/firebase/init.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Firebase configuration is unavailable for WAN Router Cloud.");
  const config = await response.json() as FirebaseOptions;
  if (!config.apiKey || !config.projectId || !config.appId) {
    throw new Error("Firebase configuration is incomplete for WAN Router Cloud.");
  }
  return config;
}

async function createServices(): Promise<FirebaseServices> {
  const config = await loadFirebaseConfig();
  const existing = getApps().find((candidate) => candidate.name === "wan-router-web");
  const app = existing ?? initializeApp(config, "wan-router-web");
  let auth: Auth;
  try {
    auth = initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    auth = getAuth(getApp("wan-router-web"));
  }

  const emulatorUrl = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST as string | undefined;
  if (emulatorUrl && !(auth as Auth & { __wanEmulatorConnected?: boolean }).__wanEmulatorConnected) {
    connectAuthEmulator(auth, emulatorUrl, { disableWarnings: true });
    (auth as Auth & { __wanEmulatorConnected?: boolean }).__wanEmulatorConnected = true;
  }

  return { app, auth, emulator: Boolean(emulatorUrl) };
}

export function firebaseServices(): Promise<FirebaseServices> {
  servicesPromise ??= createServices();
  return servicesPromise;
}

export async function firebaseAccessToken(): Promise<string> {
  const { auth } = await firebaseServices();
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to use WAN Router Cloud.");
  return user.getIdToken();
}

export async function signInEmail(email: string, password: string): Promise<User> {
  const { auth } = await firebaseServices();
  return (await signInWithEmailAndPassword(auth, email, password)).user;
}

export async function createAccount(email: string, password: string): Promise<User> {
  const { auth } = await firebaseServices();
  return (await createUserWithEmailAndPassword(auth, email, password)).user;
}

export async function signInGoogle(): Promise<User> {
  const { auth } = await firebaseServices();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return (await signInWithPopup(auth, provider)).user;
}

export async function sendReset(email: string): Promise<void> {
  const { auth } = await firebaseServices();
  await sendPasswordResetEmail(auth, email);
}

export async function signOutWan(): Promise<void> {
  const { auth } = await firebaseServices();
  await signOut(auth);
}