/* ════════════════════════════════════════════
   DISCIPLINE OS — db.js
   Data layer: Firestore primary, localStorage fallback
   
   All reads/writes go through here.
   App code never touches firebase directly.
════════════════════════════════════════════ */
import {
  loadCollection, saveDoc, deleteDocument,
  batchSave, saveUserProfile, loadUserProfile
} from './firebase.js';

/* ── Keys (localStorage fallback) ── */
const LS = {
  TASKS:   'dos_tasks',
  REPORTS: 'dos_reports',
  GOALS:   'dos_goals',
  STREAK:  'dos_streak',
  PROFILE: 'dos_profile',
};

let _uid = null;   // set after login
let _useCloud = false;

export function initDB(uid) {
  _uid = uid;
  _useCloud = !!uid;
}

/* ════════════════════════════════════════════
   LOAD — on app start
════════════════════════════════════════════ */
export async function loadAllData() {
  if (_useCloud) {
    try {
      const [tasks, goals, reports, profile] = await Promise.all([
        loadCollection(_uid, 'tasks'),
        loadCollection(_uid, 'goals'),
        loadCollection(_uid, 'reports'),
        loadUserProfile(_uid),
      ]);
      return { tasks, goals, reports, profile };
    } catch (e) {
      console.warn('Firestore load failed, using localStorage:', e);
    }
  }
  return loadFromLocalStorage();
}

function loadFromLocalStorage() {
  const parse = (key, fallback=[]) => {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  };
  return {
    tasks:   parse(LS.TASKS),
    goals:   parse(LS.GOALS),
    reports: parse(LS.REPORTS),
    profile: parse(LS.PROFILE, {}),
  };
}

/* ════════════════════════════════════════════
   SAVE TASKS
════════════════════════════════════════════ */
export async function saveTasks(tasks) {
  // Always keep localStorage in sync (instant offline)
  const clean = tasks.map(t => ({ ...t, running: false }));
  localStorage.setItem(LS.TASKS, JSON.stringify(clean));

  if (_useCloud) {
    try { await batchSave(_uid, 'tasks', clean); }
    catch (e) { console.warn('Cloud save tasks failed:', e); }
  }
}

export async function deleteTaskCloud(taskId) {
  if (_useCloud) {
    try { await deleteDocument(_uid, 'tasks', taskId); }
    catch (e) { console.warn('Cloud delete task failed:', e); }
  }
}

/* ════════════════════════════════════════════
   SAVE GOALS
════════════════════════════════════════════ */
export async function saveGoals(goals) {
  localStorage.setItem(LS.GOALS, JSON.stringify(goals));

  if (_useCloud) {
    try { await batchSave(_uid, 'goals', goals); }
    catch (e) { console.warn('Cloud save goals failed:', e); }
  }
}

export async function deleteGoalCloud(goalId) {
  if (_useCloud) {
    try { await deleteDocument(_uid, 'goals', goalId); }
    catch (e) { console.warn('Cloud delete goal failed:', e); }
  }
}

/* ════════════════════════════════════════════
   SAVE REPORTS
════════════════════════════════════════════ */
export async function saveReports(reports) {
  localStorage.setItem(LS.REPORTS, JSON.stringify(reports));

  if (_useCloud) {
    try { await batchSave(_uid, 'reports', reports); }
    catch (e) { console.warn('Cloud save reports failed:', e); }
  }
}

/* ════════════════════════════════════════════
   PROFILE / STREAK / SCORE
════════════════════════════════════════════ */
export async function saveProfile(profile) {
  localStorage.setItem(LS.PROFILE, JSON.stringify(profile));

  if (_useCloud && _uid) {
    try { await saveUserProfile(_uid, profile); }
    catch (e) { console.warn('Cloud save profile failed:', e); }
  }
}

export function loadStreak() {
  try { return JSON.parse(localStorage.getItem(LS.STREAK)) || { count: 0, lastDate: '' }; }
  catch { return { count: 0, lastDate: '' }; }
}

export function persistStreak(s) {
  localStorage.setItem(LS.STREAK, JSON.stringify(s));
}