import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User
} from "firebase/auth";

export interface WebFirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  emulator: boolean;
}

let servicesPromise: Promise<WebFirebaseServices> | undefined;

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
  const fromEnvironment = configured ? parseFirebaseConfig(configured) : null;
  if (fromEnvironment) return fromEnvironment;

  const response = await fetch("/__/firebase/init.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Firebase configuration is unavailable for WAN SSH.");
  const config = await response.json() as FirebaseOptions;
  if (!config.apiKey || !config.projectId || !config.appId) {
    throw new Error("Firebase configuration is incomplete for WAN SSH.");
  }
  return config;
}

async function createServices(): Promise<WebFirebaseServices> {
  const config = await loadFirebaseConfig();
  const existing = getApps().find((candidate) => candidate.name === "wan-ssh-web");
  const app = existing ?? initializeApp(config, "wan-ssh-web");
  let auth: Auth;
  try {
    auth = initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence]
    });
  } catch {
    auth = getAuth(getApp("wan-ssh-web"));
  }

  const emulatorUrl = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST as string | undefined;
  if (emulatorUrl && !(auth as Auth & { __wanEmulatorConnected?: boolean }).__wanEmulatorConnected) {
    connectAuthEmulator(auth, emulatorUrl, { disableWarnings: true });
    (auth as Auth & { __wanEmulatorConnected?: boolean }).__wanEmulatorConnected = true;
  }

  return { app, auth, emulator: Boolean(emulatorUrl) };
}

export function webFirebaseServices(): Promise<WebFirebaseServices> {
  servicesPromise ??= createServices();
  return servicesPromise;
}

export async function signInWebSsh(email: string, password: string): Promise<User> {
  const { auth } = await webFirebaseServices();
  return (await signInWithEmailAndPassword(auth, email, password)).user;
}

export async function resetWebSshPassword(email: string): Promise<void> {
  const { auth } = await webFirebaseServices();
  await sendPasswordResetEmail(auth, email);
}

export async function signOutWebSsh(): Promise<void> {
  const { auth } = await webFirebaseServices();
  await signOut(auth);
}