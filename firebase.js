/* ════════════════════════════════════════════
   DISCIPLINE OS — firebase.js
   Firebase config + Auth + Firestore helpers
   
   HOW TO SET UP:
   1. Go to https://console.firebase.google.com
   2. Create project → Enable Google Auth
   3. Enable Firestore Database
   4. Project Settings → Your apps → Web app
   5. Copy your firebaseConfig object below
════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  deleteDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ── 🔴 REPLACE THIS WITH YOUR FIREBASE CONFIG ── */
const firebaseConfig = {
  apiKey: "AIzaSyBen6-9b8bt78etkPslnMq7JOd4bYWLBJc",
  authDomain: "myproject-2cad8.firebaseapp.com",
  projectId: "myproject-2cad8",
  storageBucket: "myproject-2cad8.firebasestorage.app",
  messagingSenderId: "835713279627",
  appId: "1:835713279627:web:3a1f3dbb06ee0093d9968e",
  measurementId: "G-4DDTR6409H"
};
/* ─────────────────────────────────────────────── */

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const gProvider = new GoogleAuthProvider();

/* ════════════════════════════════════════════
   AUTH HELPERS
════════════════════════════════════════════ */
export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, gProvider);
  return result.user;
}

export async function signOutUser() {
  await signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export function getCurrentUser() {
  return auth.currentUser;
}

/* ════════════════════════════════════════════
   FIRESTORE HELPERS
   Path: users/{uid}/tasks, goals, reports
════════════════════════════════════════════ */

function userRef(uid) {
  return doc(db, 'users', uid);
}

function colRef(uid, colName) {
  return collection(db, 'users', uid, colName);
}

/* ── Generic load collection ── */
export async function loadCollection(uid, colName) {
  const snap = await getDocs(colRef(uid, colName));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ── Generic save single doc ── */
export async function saveDoc(uid, colName, docId, data) {
  const ref = doc(db, 'users', uid, colName, docId);
  await setDoc(ref, { ...data, _updatedAt: serverTimestamp() }, { merge: true });
}

/* ── Delete single doc ── */
export async function deleteDocument(uid, colName, docId) {
  const ref = doc(db, 'users', uid, colName, docId);
  await deleteDoc(ref);
}

/* ── Batch save entire array (replaces collection) ── */
export async function batchSave(uid, colName, items) {
  const batch = writeBatch(db);
  items.forEach(item => {
    const ref = doc(db, 'users', uid, colName, item.id);
    batch.set(ref, { ...item, _updatedAt: serverTimestamp() }, { merge: true });
  });
  await batch.commit();
}

/* ── User profile doc ── */
export async function saveUserProfile(uid, profile) {
  await setDoc(userRef(uid), { ...profile, _updatedAt: serverTimestamp() }, { merge: true });
}

export async function loadUserProfile(uid) {
  const snap = await getDoc(userRef(uid));
  return snap.exists() ? snap.data() : null;
}

export { auth, db };