import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
} from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

let servicesPromise;

async function loadConfig() {
  if (window.mindmapHost?.getFirebaseConfig) {
    const result = await window.mindmapHost.getFirebaseConfig();
    return result?.configured ? result.config : null;
  }
  const raw = import.meta.env.VITE_FIREBASE_CONFIG || localStorage.getItem('wan_firebase_config');
  if (raw) {
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }
  if (!['http:', 'https:'].includes(window.location.protocol)) return null;
  try {
    const response = await fetch('/__/firebase/init.json', { cache: 'no-store' });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function createServices() {
  const config = await loadConfig();
  if (!config?.apiKey || !config?.projectId || !config?.appId) {
    return { configured: false, app: null, auth: null, firestore: null, database: null, functions: null };
  }

  const existing = getApps().find((candidate) => candidate.name === 'mindmap');
  const app = existing || initializeApp(config, 'mindmap');
  let auth;
  try {
    auth = initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
    });
  } catch {
    auth = getAuth(getApp('mindmap'));
  }

  return {
    configured: true,
    app,
    auth,
    firestore: getFirestore(app),
    database: config.databaseURL ? getDatabase(app) : null,
    functions: getFunctions(app, 'asia-southeast2'),
  };
}

export function firebaseServices() {
  if (!servicesPromise) servicesPromise = createServices();
  return servicesPromise;
}