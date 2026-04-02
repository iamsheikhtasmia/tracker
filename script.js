/* ════════════════════════════════════════════
   DISCIPLINE OS v2 — app.js
   Main application logic
   
   ARCHITECTURE:
   - Goals are containers; Tasks link to goals via goalId
   - No separate goal timers — progress = sum of linked task elapsed
   - Date-based timers (screen-off safe)
   - Punishment system auto-creates penalty tasks
   - Discipline Score: +10 complete, -5 fail, +5 streak/day
════════════════════════════════════════════ */
'use strict';

import { onAuthChange, signOutUser, getCurrentUser } from './firebase.js';
import { initDB, loadAllData, saveTasks, saveGoals, saveReports, saveProfile, loadStreak, persistStreak, deleteTaskCloud, deleteGoalCloud } from './db.js';

/* ════════════════════════════════════════════
   STATE
════════════════════════════════════════════ */
let tasks        = [];
let goals        = [];        // long-term goal containers
let reports      = [];
let profile      = {};        // { visionText, futureMessage, ... }
let timers       = {};        // { taskId: intervalId }
let timerAnchors = {};        // { taskId: { startedAt, baseElapsed } }
let activeFocusId   = null;
let activeFilter    = 'All';
let editingId       = null;
let editingGoalId   = null;
let currentUser     = null;

/* ════════════════════════════════════════════
   UTILITIES
════════════════════════════════════════════ */
const uid  = () => Math.random().toString(36).slice(2,9) + Date.now().toString(36);
const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const pad  = n  => String(n).padStart(2,'0');
const $    = id => document.getElementById(id);

function secs(s) {
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return h>0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function humanTime(s) {
  if (!s||s<=0) return '0m';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  if (h>0&&m>0) return `${h}h ${m}m`;
  if (h>0) return `${h}h`;
  return `${m}m`;
}

function todayISO()  { return new Date().toISOString().slice(0,10); }
function todayLong() { return new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}); }

function daysBetween(isoA, isoB) {
  return Math.ceil((new Date(isoB) - new Date(isoA)) / 86400000);
}

function catEmoji(c) { return {Skill:'⚡',Study:'📚',Health:'💪',Business:'💼',Personal:'🌱'}[c]||'📌'; }

/* ════════════════════════════════════════════
   AUTH GUARD
════════════════════════════════════════════ */
onAuthChange(async user => {
  if (!user) {
    window.location.replace('login.html');
    return;
  }
  currentUser = user;
  initDB(user.uid);
  await bootApp();
});

/* ════════════════════════════════════════════
   BOOT
════════════════════════════════════════════ */
async function bootApp() {
  showLoader(true);
  const data = await loadAllData();

  tasks   = (data.tasks   || []).map(normalizeTask);
  goals   = (data.goals   || []).map(normalizeGoal);
  reports = (data.reports || []);
  profile = data.profile  || {};

  // Prune reports > 30 days
  const cutoff = Date.now() - 30*86400000;
  reports = reports.filter(r => new Date(r.iso).getTime() >= cutoff);

  // Update user avatar / name in UI
  renderUserHeader();

  initVision();
  initFutureMessage();
  initDateDisplay();
  renderStreakUI();
  renderTasks();
  updateDashboard();
  renderGoals();
  checkAndApplyPenalties();

  setupEvents();
  scheduleAutoEndDay();   // auto end at midnight
  showLoader(false);
}

function showLoader(on) {
  const el = $('appLoader');
  if (el) el.style.display = on ? 'flex' : 'none';
}

/* ════════════════════════════════════════════
   DATA NORMALIZERS (schema migration safety)
════════════════════════════════════════════ */
function normalizeTask(t) {
  return {
    id:        t.id        || uid(),
    name:      t.name      || 'Untitled',
    minSecs:   Math.max(60, t.minSecs || 1800),  // minimum 1 min, never 0
    category:  t.category  || 'Skill',
    goalId:    t.goalId    || null,    // links to a Goal
    goal:      t.goal      || '',      // today's daily goal text
    comment:   t.comment   || '',
    elapsed:   t.elapsed   || 0,
    running:   false,
    isPenalty: t.isPenalty || false,
    createdAt: t.createdAt || Date.now(),
  };
}

function normalizeGoal(g) {
  return {
    id:           g.id           || uid(),
    title:        g.title        || 'Untitled Goal',
    desc:         g.desc         || '',
    startDate:    g.startDate    || todayISO(),
    deadline:     g.deadline     || '',
    category:     g.category     || 'Skill',
    totalElapsed: g.totalElapsed || 0,   // accumulated across all days
    createdAt:    g.createdAt    || Date.now(),
  };
}

/* ════════════════════════════════════════════
   GOAL HELPERS
   Progress = sum of elapsed from linked tasks
════════════════════════════════════════════ */
function getGoalProgress(goalId) {
  // Accumulated past days + today's live elapsed
  const goal       = getGoal(goalId);
  const past       = goal ? (goal.totalElapsed || 0) : 0;
  const todayLive  = tasks
    .filter(t => t.goalId === goalId)
    .reduce((sum, t) => sum + (t.elapsed || 0), 0);
  return past + todayLive;
}

function getDaysLeft(goal) {
  if (!goal.deadline) return null;
  return daysBetween(todayISO(), goal.deadline);
}

function getGoalTimePct(goal) {
  if (!goal.deadline || !goal.startDate) return 0;
  const total   = daysBetween(goal.startDate, goal.deadline);
  const elapsed = daysBetween(goal.startDate, todayISO());
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}

function getGoalLinkedTasks(goalId) {
  return tasks.filter(t => t.goalId === goalId);
}

/* ════════════════════════════════════════════
   DISCIPLINE SCORE SYSTEM
   +10 completed, -5 failed, +5 streak/day
════════════════════════════════════════════ */
function calcDailyScore(overrideTasks) {
  // overrideTasks lets endDay pass snapshot before reset
  const src        = overrideTasks || tasks;
  const completed  = src.filter(t => isCompleted(t)).length;
  const failed     = src.filter(t => isFailed(t)).length;
  const streak     = loadStreak().count;

  // No activity at all → score is 0, no streak bonus
  if (completed === 0 && failed === 0) return 0;

  // Streak bonus only applies when at least 1 task is completed
  const streakBonus = completed > 0 ? Math.min(streak * 5, 25) : 0;

  return (completed * 10) - (failed * 5) + streakBonus;
}

function getScoreTrend() {
  const weekReports = getLast7Reports();
  if (weekReports.length < 2) return null;
  const scores = weekReports.map(r => r.score || 0);
  const avg    = scores.reduce((a,b)=>a+b,0) / scores.length;
  const recent = scores.slice(0,3).reduce((a,b)=>a+b,0) / Math.min(3, scores.length);

  if (recent >= avg * 1.1) return { label: 'On Fire 🔥',      cls: 'trend-fire' };
  if (recent >= avg * 0.9) return { label: 'Consistent ⚡',   cls: 'trend-solid' };
  return                          { label: 'Slipping ⚠️',     cls: 'trend-slip' };
}

/* ════════════════════════════════════════════
   TASK STATUS
════════════════════════════════════════════ */
function taskStatus(t) {
  if (t.elapsed===0&&!t.running) return 'not-started';
  if (t.elapsed>=t.minSecs)      return 'completed';
  if (t.running)                  return 'running';
  if (t.elapsed>0)                return 'paused';
  return 'not-started';
}
function isCompleted(t) { return t.elapsed > 0 && t.elapsed >= t.minSecs; }
function isFailed(t)    { return t.elapsed > 0 && t.elapsed < t.minSecs && !t.running; }
function isNotStarted(t){ return t.elapsed === 0 && !t.running; }

/* ════════════════════════════════════════════
   PUNISHMENT SYSTEM
   Rule:
   • If task minSecs < 30 min → punishment = +10 min (small task)
   • If task minSecs ≥ 30 min → punishment = +5 min  (big task)
   • Adds penalty time directly to the SAME task's minSecs
   • Also creates a visible penalty note card
   • Stacks per failure (each new day it checks again)
════════════════════════════════════════════ */
function getPenaltyMins(minSecs) {
  return minSecs < 1800 ? 10 : 5; // <30 min → +10, ≥30 min → +5
}

function checkAndApplyPenalties() {
  const yest    = new Date(); yest.setDate(yest.getDate()-1);
  const yestISO = yest.toISOString().slice(0,10);
  const yestReport = reports.find(r => r.iso === yestISO);

  if (!yestReport || yestReport.penaltiesApplied) return;

  const failedTasks = (yestReport.tasks || []).filter(t => t.failed);
  if (failedTasks.length === 0) { yestReport.penaltiesApplied = true; saveReports(reports); return; }

  let totalPenaltyMins = 0;

  failedTasks.forEach(ft => {
    const penaltyMins = getPenaltyMins(ft.minSecs || 1800);
    totalPenaltyMins += penaltyMins;

    // Find the matching live task and add time to it
    const liveTask = tasks.find(t => t.id === ft.id);
    if (liveTask) {
      liveTask.minSecs += penaltyMins * 60;
      liveTask.isPenalty = true;
    } else {
      // Task may have been deleted — recreate it with penalty
      tasks.push(normalizeTask({
        id:        ft.id + '_p',
        name:      `⚠ ${ft.name}`,
        minSecs:   (ft.minSecs || 1800) + (penaltyMins * 60),
        category:  ft.category,
        isPenalty: true,
        goalId:    ft.goalId || null,
        createdAt: Date.now(),
      }));
    }
  });

  yestReport.penaltiesApplied = true;
  saveTasks(tasks);
  saveReports(reports);
  renderTasks();

  // Show warning banner
  const banner = $('penaltyBanner');
  const txt    = $('penaltyText');
  if (banner && txt) {
    banner.classList.remove('hidden');
    txt.textContent = `⚠ You failed ${failedTasks.length} task${failedTasks.length>1?'s':''} yesterday. +${totalPenaltyMins} min penalty added. Earn it back today. 💪`;
  }
}

/* ════════════════════════════════════════════
   TIMER SYSTEM (Date-based, screen-off safe)
════════════════════════════════════════════ */
function _tickTask(id) {
  const t = getTask(id); if (!t) { clearInterval(timers[id]); return; }
  const anchor = timerAnchors[id]; if (!anchor) return;
  t.elapsed = Math.floor(anchor.baseElapsed + (Date.now() - anchor.startedAt) / 1000);
  updateTimerUI(id);
  if (t.elapsed % 30 === 0) saveTasks(tasks);
  if (activeFocusId === id) updateFocusUI(t);
}

function startTimer(id) {
  const t = getTask(id); if (!t || t.running) return;
  t.running = true;
  timerAnchors[id] = { startedAt: Date.now(), baseElapsed: t.elapsed };
  saveTasks(tasks); refreshCard(id); updateDashboard();
  timers[id] = setInterval(() => _tickTask(id), 500);
}

function pauseTimer(id) {
  const t = getTask(id); if (!t) return;
  const anchor = timerAnchors[id];
  if (anchor) { t.elapsed = Math.floor(anchor.baseElapsed + (Date.now() - anchor.startedAt) / 1000); delete timerAnchors[id]; }
  t.running = false;
  clearInterval(timers[id]); delete timers[id];
  saveTasks(tasks); refreshCard(id); updateDashboard();
}

function stopTimer(id) {
  clearInterval(timers[id]); delete timers[id]; delete timerAnchors[id];
  const t = getTask(id); if (t) t.running = false;
}

function resetTimer(id) {
  stopTimer(id);
  const t = getTask(id); if (!t) return;
  t.elapsed = 0; t.running = false;
  saveTasks(tasks); refreshCard(id); updateDashboard();
  if (activeFocusId === id) exitFocusMode();
}

function startTimerOnly(id) {
  const t = getTask(id); if (!t || t.running) return;
  t.running = true;
  timerAnchors[id] = { startedAt: Date.now(), baseElapsed: t.elapsed };
  saveTasks(tasks); refreshCard(id); updateDashboard();
  timers[id] = setInterval(() => _tickTask(id), 500);
}

/* ════════════════════════════════════════════
   TASK CRUD
════════════════════════════════════════════ */
function getTask(id) { return tasks.find(t => t.id === id); }

function addTask(name, totalSecs, category, goalId, goalText) {
  const t = normalizeTask({ id:uid(), name, minSecs:totalSecs, category, goalId:goalId||null, goal:goalText||'' });
  tasks.push(t);
  saveTasks(tasks); renderTasks(); updateDashboard(); renderGoals();
}

function editTask(id, name, totalSecs, category, goalId, goalText) {
  tasks = tasks.map(t => t.id!==id ? t : {...t, name, minSecs:totalSecs, category, goalId:goalId||null, goal:goalText||''});
  saveTasks(tasks); renderTasks(); updateDashboard(); renderGoals();
}

function deleteTask(id) {
  stopTimer(id);
  tasks = tasks.filter(t => t.id !== id);
  deleteTaskCloud(id);
  saveTasks(tasks); renderTasks(); updateDashboard(); renderGoals();
  toast('Task removed.', 'default');
}

function saveField(id, field, value) {
  const t = getTask(id); if (t) { t[field] = value; saveTasks(tasks); }
}

/* ════════════════════════════════════════════
   GOAL CRUD
════════════════════════════════════════════ */
function getGoal(id) { return goals.find(g => g.id === id); }

function addGoal(title, desc, startDate, deadline, category) {
  const g = normalizeGoal({ id:uid(), title, desc, startDate, deadline, category });
  goals.push(g);
  saveGoals(goals); renderGoals();
  toast('Goal created! 🎯', 'success');
}

function editGoal(id, title, desc, startDate, deadline, category) {
  goals = goals.map(g => g.id!==id ? g : {...g, title, desc, startDate, deadline, category});
  saveGoals(goals); renderGoals();
}

function deleteGoal(id) {
  // Unlink tasks from this goal
  tasks = tasks.map(t => t.goalId===id ? {...t, goalId:null} : t);
  goals = goals.filter(g => g.id !== id);
  deleteGoalCloud(id);
  saveTasks(tasks); saveGoals(goals);
  renderTasks(); renderGoals();
  toast('Goal removed.', 'default');
}

/* ════════════════════════════════════════════
   RENDER TASKS
════════════════════════════════════════════ */
function renderTasks() {
  const grid  = $('taskGrid');
  const empty = $('taskEmpty');
  if (!grid) return;
  grid.innerHTML = '';
  let filtered = activeFilter === 'All' ? tasks : tasks.filter(t => t.category === activeFilter);
  if (filtered.length === 0) { empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  filtered.forEach(t => grid.appendChild(buildCard(t)));
}

function buildCard(task) {
  const st   = taskStatus(task);
  const pct  = Math.min(100, Math.round(task.elapsed / task.minSecs * 100));
  const done = isCompleted(task);
  const fail = isFailed(task);
  const linkedGoal = task.goalId ? getGoal(task.goalId) : null;

  const div = document.createElement('div');
  div.className = `task-card ${st==='running'?'running':''} ${done?'completed':''} ${fail?'failed-card':''} ${task.isPenalty?'penalty-card':''}`;
  div.id = `card-${task.id}`;

  const statusLabels = {'not-started':'Not Started','running':'⏱ Running','paused':'⏸ Paused','completed':'✅ Done'};
  const statusClasses= {'not-started':'status-idle','running':'status-running','paused':'status-paused','completed':'status-completed'};

  div.innerHTML = `
    <div class="card-head">
      <div class="card-name-block">
        ${task.isPenalty ? '<span class="penalty-badge">⚠ PENALTY</span>' : ''}
        <span class="card-name">${esc(task.name)}</span>
        <span class="card-cat cat-${task.category}">${catEmoji(task.category)} ${task.category}</span>
        ${linkedGoal ? `<span class="card-goal-link">🎯 ${esc(linkedGoal.title)}</span>` : ''}
      </div>
      <div class="card-head-right">
        ${fail
          ? '<span class="card-status status-failed">❌ Failed</span>'
          : `<span class="card-status ${statusClasses[st]}" id="badge-${task.id}">${statusLabels[st]||'—'}</span>`
        }
        <div class="card-icon-btns">
          <button class="icon-btn" title="Edit" onclick="window._app.openEditModal('${task.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn del" title="Delete" onclick="window._app.deleteTask('${task.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      </div>
    </div>

    <div class="card-timer-block">
      <div class="card-elapsed" id="el-${task.id}">${secs(task.elapsed)}</div>
      <div class="card-timer-meta">
        <span>Min: ${humanTime(task.minSecs)}</span>
        <span class="card-pct" id="pct-${task.id}">${pct}%</span>
      </div>
    </div>

    <div class="card-progress">
      <div class="progress-track">
        <div class="progress-fill ${done?'done':''}" id="bar-${task.id}" style="width:${pct}%"></div>
      </div>
      <div class="progress-labels">
        <span id="lbl-${task.id}">${humanTime(task.elapsed)} elapsed</span>
        <span>${humanTime(task.minSecs)} target</span>
      </div>
    </div>

    <div class="card-controls">
      <button class="ctrl-btn ctrl-start" id="startBtn-${task.id}"
        style="${task.running?'display:none':''}"
        onclick="window._app.handleStart('${task.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Start
      </button>
      <button class="ctrl-btn ctrl-pause" id="pauseBtn-${task.id}"
        style="${!task.running?'display:none':''}"
        onclick="window._app.pauseTimer('${task.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Pause
      </button>
      <button class="ctrl-btn ctrl-reset" onclick="window._app.resetTimer('${task.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 1 1 9 9"/><path d="M3 7v5h5"/></svg>Reset
      </button>
    </div>

    <div class="card-fields">
      <div>
        <div class="card-field-label">Today's Goal</div>
        <input type="text" class="card-field-input" placeholder="What will you accomplish?"
          value="${esc(task.goal)}"
          oninput="window._app.saveField('${task.id}','goal',this.value)" />
      </div>
      <div>
        <div class="card-field-label">Reflection</div>
        <textarea class="card-field-input" rows="2"
          placeholder="How did it go?"
          oninput="window._app.saveField('${task.id}','comment',this.value)">${esc(task.comment)}</textarea>
      </div>
    </div>
  `;
  return div;
}

function refreshCard(id) {
  const t = getTask(id); const old = $(`card-${id}`);
  if (!t || !old) return;
  old.replaceWith(buildCard(t));
}

function updateTimerUI(id) {
  const t = getTask(id); if (!t) return;
  const pct  = Math.min(100, Math.round(t.elapsed / t.minSecs * 100));
  const done = isCompleted(t);
  const elEl = $(`el-${id}`), pctEl = $(`pct-${id}`), barEl = $(`bar-${id}`), lblEl = $(`lbl-${id}`);
  if (elEl)  elEl.textContent  = secs(t.elapsed);
  if (pctEl) pctEl.textContent = pct + '%';
  if (barEl) { barEl.style.width = pct + '%'; barEl.classList.toggle('done', done); }
  if (lblEl) lblEl.textContent  = humanTime(t.elapsed) + ' elapsed';
  if (done)  { refreshCard(id); updateDashboard(); renderGoals(); }
}

/* ════════════════════════════════════════════
   FOCUS MODE
════════════════════════════════════════════ */
function handleStart(id) { startTimer(id); enterFocusMode(id); }

function enterFocusMode(id) {
  const t = getTask(id); if (!t) return;
  activeFocusId = id;
  $('focusTaskName').textContent = t.name;
  $('focusCategory').textContent = catEmoji(t.category) + ' ' + t.category;
  $('focusCategory').className   = `focus-category-badge cat-${t.category}`;
  $('focusGoal').textContent     = t.goal || '';
  $('focusMinLabel').textContent = `Target: ${humanTime(t.minSecs)}`;
  updateFocusUI(t);
  $('focusOverlay').classList.remove('hidden');
}

function updateFocusUI(t) {
  $('focusTimer').textContent = secs(t.elapsed);
  const pct  = Math.min(1, t.elapsed / t.minSecs);
  const ring = $('ringFill');
  ring.style.strokeDashoffset = 2 * Math.PI * 54 * (1 - pct);
  ring.classList.toggle('done', isCompleted(t));
}

function exitFocusMode() { $('focusOverlay').classList.add('hidden'); activeFocusId = null; }

/* ════════════════════════════════════════════
   RENDER GOALS PAGE
   Goals = containers; progress = task time
════════════════════════════════════════════ */
function renderGoals() {
  const grid  = $('goalsGrid');
  const empty = $('goalsEmpty');
  if (!grid) return;
  grid.innerHTML = '';
  if (goals.length === 0) { empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  goals.forEach(g => grid.appendChild(buildGoalCard(g)));

  // Update dashboard hero
  renderGoalHero();
}

function buildGoalCard(g) {
  const daysLeft    = getDaysLeft(g);
  const timePct     = getGoalTimePct(g);
  const totalSecs   = getGoalProgress(g.id);
  const linkedTasks = getGoalLinkedTasks(g.id);
  const completedTasks = linkedTasks.filter(t => isCompleted(t)).length;
  const taskPct     = linkedTasks.length ? Math.round((completedTasks / linkedTasks.length) * 100) : 0;

  const urgency = daysLeft === null ? 'normal' :
                  daysLeft < 0      ? 'expired' :
                  daysLeft <= 7     ? 'danger'  :
                  daysLeft <= 14    ? 'warning' : 'normal';

  const urgencyLabel = daysLeft === null ? '—' :
                       daysLeft < 0      ? '⛔ Expired' :
                       daysLeft <= 7     ? `🔥 ${daysLeft}d left` :
                       daysLeft <= 14    ? `⚠️ ${daysLeft}d left` :
                                          `📅 ${daysLeft} days left`;

  const div = document.createElement('div');
  div.className = `goal-card ${urgency}`;
  div.id = `gcard-${g.id}`;

  div.innerHTML = `
    <div class="goal-card-head">
      <div>
        <div class="goal-card-title">${esc(g.title)}</div>
        ${g.desc ? `<div class="goal-card-desc">${esc(g.desc)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span class="card-cat cat-${g.category}" style="font-size:.7rem">${catEmoji(g.category)} ${g.category}</span>
        <div class="card-icon-btns">
          <button class="icon-btn" onclick="window._app.openEditGoalModal('${g.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn del" onclick="window._app.deleteGoal('${g.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Timeline bar -->
    <div class="goal-timeline">
      <div class="goal-timeline-labels">
        <span class="goal-date-label">📌 ${g.startDate||'—'}</span>
        <span class="goal-urgency ${urgency}">${urgencyLabel}</span>
        <span class="goal-date-label">🏁 ${g.deadline||'—'}</span>
      </div>
      <div class="goal-timeline-track">
        <div class="goal-timeline-fill" style="width:${timePct}%"></div>
        <div class="goal-timeline-marker" style="left:${Math.min(99,timePct)}%"></div>
      </div>
      <div class="goal-timeline-sub">
        <span>${timePct}% of time elapsed</span>
      </div>
    </div>

    <!-- Stats -->
    <div class="goal-stats-row">
      <div class="goal-stat">
        <span class="goal-stat-val">${humanTime(totalSecs)}</span>
        <span class="goal-stat-lbl">Time invested</span>
      </div>
      <div class="goal-stat">
        <span class="goal-stat-val">${completedTasks}/${linkedTasks.length}</span>
        <span class="goal-stat-lbl">Tasks done</span>
      </div>
      <div class="goal-stat">
        <span class="goal-stat-val">${taskPct}%</span>
        <span class="goal-stat-lbl">Task progress</span>
      </div>
    </div>

    <!-- Task progress bar -->
    <div>
      <div class="progress-labels" style="margin-bottom:4px">
        <span style="font-size:.75rem;color:var(--ink-dim)">Task completion</span>
        <span style="font-size:.75rem;font-family:var(--font-mono)">${taskPct}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${taskPct>=100?'done':''}" style="width:${taskPct}%"></div>
      </div>
    </div>

    <!-- Linked tasks mini list -->
    ${linkedTasks.length > 0 ? `
      <div class="goal-tasks-list">
        <div class="goal-tasks-label">Linked Tasks (${linkedTasks.length})</div>
        ${linkedTasks.slice(0,4).map(t => `
          <div class="goal-task-item ${isCompleted(t)?'done':isFailed(t)?'fail':''}">
            <span>${isCompleted(t)?'✅':isFailed(t)?'❌':'⏳'} ${esc(t.name)}</span>
            <span style="font-family:var(--font-mono);font-size:.7rem">${humanTime(t.elapsed)}</span>
          </div>
        `).join('')}
        ${linkedTasks.length > 4 ? `<div style="font-size:.72rem;color:var(--ink-dim);padding:4px 0">+${linkedTasks.length-4} more tasks</div>` : ''}
      </div>
    ` : `<div class="goal-no-tasks">No tasks linked yet. Create a task and assign this goal.</div>`}
  `;
  return div;
}

/* ════════════════════════════════════════════
   GOAL COUNTDOWN HERO (Dashboard)
════════════════════════════════════════════ */
function renderGoalHero() {
  const hero = $('goalHero');
  if (!hero) return;

  // Pick the most urgent active goal
  const activeGoals = goals.filter(g => g.deadline && getDaysLeft(g) >= 0);
  if (activeGoals.length === 0) { hero.classList.add('hidden'); return; }

  const g = activeGoals.sort((a,b) => getDaysLeft(a) - getDaysLeft(b))[0];
  const daysLeft = getDaysLeft(g);
  hero.classList.remove('hidden');

  hero.innerHTML = `
    <div class="goal-hero-eyebrow">🎯 Active Goal</div>
    <div class="goal-hero-title">${esc(g.title)}</div>
    <div class="goal-hero-countdown">
      <div class="goal-hero-days">${daysLeft}</div>
      <div class="goal-hero-days-label">days remaining</div>
    </div>
    <div class="goal-hero-time">⏱ ${humanTime(getGoalProgress(g.id))} invested so far</div>
    <div class="goal-hero-bar-wrap">
      <div class="progress-track" style="height:6px">
        <div class="progress-fill" style="width:${getGoalTimePct(g)}%"></div>
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════
   DASHBOARD
════════════════════════════════════════════ */
function updateDashboard() {
  const completed  = tasks.filter(t => isCompleted(t)).length;
  const failed     = tasks.filter(t => isFailed(t)).length;
  const notStarted = tasks.filter(t => isNotStarted(t)).length;
  const score      = calcDailyScore();
  const trend      = getScoreTrend();

  setText('dashCompleted',  completed);
  setText('dashFailed',     failed);
  setText('dashNotStarted', notStarted);
  // Score can be negative — show with sign
  const scoreEl = $('dailyScore');
  if (scoreEl) {
    scoreEl.textContent = score > 0 ? `+${score}` : String(score);
    scoreEl.style.color = score > 0 ? '' : score < 0 ? '#ef4444' : '';
  }

  // Trend label
  const trendEl = $('scoreTrend');
  if (trendEl && trend) {
    trendEl.textContent  = trend.label;
    trendEl.className    = `score-trend ${trend.cls}`;
  }

  // Today hours
  const todaySecs = tasks.reduce((s,t) => s + t.elapsed, 0);
  ['todayHours','anTodayHours'].forEach(id => setText(id, humanTime(todaySecs)));

  // Weekly average
  const weekReports = getLast7Reports();
  const weekAvg = weekReports.length
    ? Math.round(weekReports.reduce((a,r)=>a+(r.score||0),0) / weekReports.length)
    : score;
  setText('weeklyAvg', weekAvg);

  // Penalty banner (current day failures)
  const penalty = $('penaltyBanner'), penaltyTxt = $('penaltyText');
  if (penalty && failed > 0 && !penalty.textContent.includes('yesterday')) {
    penalty.classList.remove('hidden');
    if (penaltyTxt) penaltyTxt.textContent = `⚠ ${failed} task${failed>1?'s are':' is'} currently failing. Push through!`;
  }

  renderHeatmap();
  renderGoalHero();
}

function setText(id, val) { const el=$(id); if(el) el.textContent = val; }

/* ════════════════════════════════════════════
   END DAY
════════════════════════════════════════════ */
function endDay() {
  if (tasks.length === 0) { toast('No tasks to save!', 'warning'); return; }

  // ── Pause all running timers first ──
  tasks.forEach(t => { if (t.running) pauseTimer(t.id); });

  // ── Snapshot BEFORE reset ──
  const completed = tasks.filter(t => isCompleted(t));
  const failed    = tasks.filter(t => isFailed(t));

  // Score calculated from snapshot (completed/failed state right now)
  const score = calcDailyScore(tasks);

  const report = {
    id:               uid(),
    date:             todayLong(),
    iso:              todayISO(),
    score,
    completedCount:   completed.length,
    failedCount:      failed.length,
    penaltiesApplied: false,
    tasks: tasks.map(t => ({
      id:        t.id,
      name:      t.name,
      category:  t.category,
      goalId:    t.goalId,
      goal:      t.goal,
      comment:   t.comment,
      elapsed:   t.elapsed,
      minSecs:   t.minSecs,
      isPenalty: t.isPenalty || false,
      completed: isCompleted(t),
      failed:    isFailed(t)
    }))
  };

  reports = reports.filter(r => r.iso !== todayISO());
  reports.unshift(report);

  updateStreak();

  // ── Accumulate elapsed into goals BEFORE reset ──
  goals.forEach(g => {
    const todaySecs = tasks
      .filter(t => t.goalId === g.id)
      .reduce((sum, t) => sum + (t.elapsed || 0), 0);
    if (todaySecs > 0) {
      g.totalElapsed = (g.totalElapsed || 0) + todaySecs;
    }
  });
  saveGoals(goals);

  // ── Reset tasks for new day AFTER report saved ──
  tasks.forEach(t => { t.elapsed = 0; t.running = false; t.comment = ''; });
  tasks = tasks.filter(t => !t.isPenalty);

  // ── Apply penalties IMMEDIATELY to existing tasks ──
  // (failed tasks from today get penalty time added right now)
  let totalPenaltyMins = 0;
  failed.forEach(ft => {
    const penaltyMins = getPenaltyMins(ft.minSecs || 1800);
    totalPenaltyMins += penaltyMins;
    const liveTask = tasks.find(t => t.id === ft.id);
    if (liveTask) {
      liveTask.minSecs  += penaltyMins * 60;
      liveTask.isPenalty = true;
    }
  });

  // Mark today's report as penalties already applied (so checkAndApplyPenalties skips it)
  report.penaltiesApplied = true;

  saveTasks(tasks); saveReports(reports);

  // ── Re-render ──
  renderTasks(); updateDashboard(); renderReports(); updateAnalytics();

  // ── Toast ──
  let msg = score > 0
    ? `Day saved ✅  Score: +${score} pts — ${completed.length} done, ${failed.length} failed`
    : score < 0
    ? `Day saved. Score: ${score} pts — ${failed.length} task${failed.length>1?'s':''} failed. Do better tomorrow 💪`
    : `Day saved. Score: 0 pts`;

  if (totalPenaltyMins > 0) {
    msg += ` | ⚠ +${totalPenaltyMins} min penalty applied to failed tasks`;
  }

  toast(msg, score >= 0 ? 'success' : 'warning', 7000);

  // ── Show penalty banner if any failures ──
  if (totalPenaltyMins > 0) {
    const banner = $('penaltyBanner'), txt = $('penaltyText');
    if (banner && txt) {
      banner.classList.remove('hidden');
      txt.textContent = `⚠ ${failed.length} task${failed.length>1?'s':''} failed today. +${totalPenaltyMins} min penalty added to those tasks. Complete them tomorrow. 💪`;
    }
  }

  setTimeout(() => switchPage('reports'), 1600);
}

/* ════════════════════════════════════════════
   STREAK
════════════════════════════════════════════ */
function updateStreak() {
  let s = loadStreak();
  const today = todayISO();
  const yest  = new Date(); yest.setDate(yest.getDate()-1);
  const yestISO = yest.toISOString().slice(0,10);
  if (s.lastDate === yestISO) s.count++;
  else if (s.lastDate === today) {}
  else s.count = 1;
  s.lastDate = today;
  persistStreak(s);
  renderStreakUI();
}

function renderStreakUI() {
  const s = loadStreak();
  setText('sidebarStreak', s.count);
}

/* ════════════════════════════════════════════
   HEATMAP
════════════════════════════════════════════ */
function renderHeatmap() {
  const grid = $('heatmapGrid'); if (!grid) return;
  grid.innerHTML = '';
  const repMap = {};
  reports.forEach(r => { repMap[r.iso] = r; });
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate()-i);
    const iso = d.toISOString().slice(0,10);
    const rep = repMap[iso];
    const cell = document.createElement('div');
    cell.className = 'hm-cell';
    if (!rep) { cell.classList.add('grey'); }
    else {
      const tot = rep.completedCount + rep.failedCount;
      const pct = tot > 0 ? rep.completedCount / tot : 0;
      cell.classList.add(pct >= 0.7 ? 'green' : pct <= 0.3 ? 'red' : 'amber');
    }
    cell.title = iso + (rep ? ` — ✅${rep.completedCount} ❌${rep.failedCount} ⭐${rep.score}` : ' — No data');
    grid.appendChild(cell);
  }
}

/* ════════════════════════════════════════════
   REPORTS
════════════════════════════════════════════ */
function renderReports() {
  const c = $('reportsContainer'), empty = $('reportsEmpty');
  if (!c) return;
  c.innerHTML = '';
  if (reports.length === 0) { empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  reports.forEach(r => {
    const block = document.createElement('div');
    block.className = 'report-block';
    const rows = (r.tasks||[]).map(t => `
      <tr>
        <td>${esc(t.name)}${t.isPenalty?'<span class="penalty-badge" style="font-size:.65rem;margin-left:4px">PENALTY</span>':''}</td>
        <td><span class="card-cat cat-${t.category}" style="font-size:.7rem">${catEmoji(t.category)} ${t.category}</span></td>
        <td style="font-family:var(--font-mono)">${humanTime(t.elapsed)}</td>
        <td style="font-family:var(--font-mono)">${humanTime(t.minSecs)}</td>
        <td>${t.completed?'✅':'❌'}</td>
      </tr>`).join('');
    block.innerHTML = `
      <div class="report-block-header">
        <span class="report-date-label">${r.date}</span>
        <div class="report-pills">
          <span class="rpill green">✅ ${r.completedCount}</span>
          <span class="rpill red">❌ ${r.failedCount}</span>
          <span class="rpill score">⭐ ${r.score} pts</span>
        </div>
      </div>
      <div class="report-table-wrap">
        <table class="report-table">
          <thead><tr><th>Task</th><th>Category</th><th>Time Spent</th><th>Minimum</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    c.appendChild(block);
  });
}

/* ════════════════════════════════════════════
   ANALYTICS
════════════════════════════════════════════ */
function updateAnalytics() {
  const todaySecs = tasks.reduce((s,t) => s+t.elapsed, 0);
  setText('anTodayHours', humanTime(todaySecs));

  let weekSecs = todaySecs;
  getLast7Reports().forEach(r => { (r.tasks||[]).forEach(t => { weekSecs += t.elapsed; }); });
  setText('anWeekHours', humanTime(weekSecs));

  const sorted = [...tasks].filter(t=>t.elapsed>0).sort((a,b)=>b.elapsed-a.elapsed);
  setText('anBestTask', sorted[0]?.name || '—');
  setText('anWeakTask', sorted[sorted.length-1]?.name || '—');

  renderWeeklyBar();
  renderCatBreakdown();
}

function getLast7Reports() {
  const c = new Date(); c.setDate(c.getDate()-7);
  return reports.filter(r => new Date(r.iso) >= c);
}

function renderWeeklyBar() {
  const chart = $('weeklyBarChart'); if (!chart) return;
  chart.innerHTML = '';
  const days = [];
  for (let i=6;i>=0;i--) { const d=new Date(); d.setDate(d.getDate()-i); days.push({iso:d.toISOString().slice(0,10),label:d.toLocaleDateString('en-US',{weekday:'short'})}); }
  const repMap = {}; reports.forEach(r=>{repMap[r.iso]=r;});
  const scores = days.map(d => repMap[d.iso]?.score||0);
  const max = Math.max(...scores, 10);
  days.forEach((d,i) => {
    const score=scores[i], col=document.createElement('div');
    col.className='bar-col';
    col.innerHTML=`<div class="bar-score">${score}</div><div class="bar-fill" style="height:${(score/max*100).toFixed(1)}%"></div><div class="bar-label">${d.label}</div>`;
    chart.appendChild(col);
  });
}

function renderCatBreakdown() {
  const c = $('catBreakdown'); if (!c) return;
  c.innerHTML = '';
  const cats = ['Skill','Study','Health','Work','Personal'];
  const colors = {Skill:'var(--cat-skill)',Study:'var(--cat-study)',Health:'var(--cat-health)',Business:'var(--cat-business)',Personal:'var(--cat-personal)'};
  const totals = {}; cats.forEach(cat=>{totals[cat]=0;});
  tasks.forEach(t=>{if(totals[t.category]!==undefined)totals[t.category]+=t.elapsed;});
  getLast7Reports().forEach(r=>{(r.tasks||[]).forEach(t=>{if(totals[t.category]!==undefined)totals[t.category]+=t.elapsed;});});
  const maxVal = Math.max(...Object.values(totals), 1);
  cats.forEach(cat => {
    const val=totals[cat], pct=Math.round(val/maxVal*100);
    const row=document.createElement('div'); row.className='cat-row';
    row.innerHTML=`<div class="cat-row-head"><span class="cat-row-name">${catEmoji(cat)} ${cat}</span><span class="cat-row-val">${humanTime(val)}</span></div><div class="cat-bar"><div class="cat-bar-fill" style="width:${pct}%;background:${colors[cat]}"></div></div>`;
    c.appendChild(row);
  });
}

/* ════════════════════════════════════════════
   MODALS — TASK
════════════════════════════════════════════ */
function getModalSecs() {
  const hr=parseInt($('mTaskHr')?.value)||0, min=parseInt($('mTaskMin')?.value)||0;
  return (hr*3600)+(min*60);
}
function setModalTime(s) {
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  if($('mTaskHr'))  $('mTaskHr').value  = h||'';
  if($('mTaskMin')) $('mTaskMin').value = m||'';
  updateTimePreview();
}
function updateTimePreview() {
  const s=getModalSecs(), prev=$('timePreview'), txt=$('timePreviewText');
  if(prev&&txt){ if(s>0){prev.style.display='flex';txt.textContent=`Target: ${humanTime(s)}`;}else prev.style.display='none'; }
}

function populateGoalDropdown(selectedId) {
  const sel = $('mTaskGoalId'); if (!sel) return;
  sel.innerHTML = '<option value="">— No goal —</option>';
  goals.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id; opt.textContent = g.title;
    if (g.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function openAddModal() {
  editingId = null;
  setText('modalTitle','New Task');
  ['mTaskName','mTaskHr','mTaskMin','mTaskGoal'].forEach(id=>{const e=$(id);if(e)e.value='';});
  if($('mTaskCat')) $('mTaskCat').value='Skill';
  if($('timePreview')) $('timePreview').style.display='none';
  populateGoalDropdown(null);
  const m=$('taskModal'); m?.classList.remove('hidden'); m?.classList.add('open');
  setTimeout(()=>$('mTaskName')?.focus(),80);
}

function openEditModal(id) {
  const t = getTask(id); if (!t) return;
  editingId = id;
  setText('modalTitle','Edit Task');
  if($('mTaskName')) $('mTaskName').value = t.name;
  if($('mTaskCat'))  $('mTaskCat').value  = t.category;
  if($('mTaskGoal')) $('mTaskGoal').value = t.goal||'';
  setModalTime(t.minSecs);
  populateGoalDropdown(t.goalId);
  const m=$('taskModal'); m?.classList.remove('hidden'); m?.classList.add('open');
  setTimeout(()=>$('mTaskName')?.focus(),80);
}

function closeModal() {
  const m=$('taskModal'); m?.classList.add('hidden'); m?.classList.remove('open');
  editingId = null;
}

function saveModal() {
  const name     = $('mTaskName')?.value.trim();
  const totalSec = getModalSecs();
  const cat      = $('mTaskCat')?.value;
  const goalId   = $('mTaskGoalId')?.value || null;
  const goalTxt  = $('mTaskGoal')?.value.trim();
  if (!name)         { toast('Please enter a task name.','warning'); return; }
  if (totalSec < 60) { toast('Please set at least 1 minute.','warning'); return; }
  if (editingId) { editTask(editingId,name,totalSec,cat,goalId,goalTxt); toast('Task updated!','success'); }
  else           { addTask(name,totalSec,cat,goalId,goalTxt); toast('Task added!','success'); }
  closeModal();
}

/* ════════════════════════════════════════════
   MODALS — GOAL
════════════════════════════════════════════ */
function openAddGoalModal() {
  editingGoalId = null;
  setText('goalModalTitle','New Goal');
  ['gTitle','gDesc'].forEach(id=>{const e=$(id);if(e)e.value='';});
  if($('gStartDate')) $('gStartDate').value = todayISO();
  if($('gDeadline'))  $('gDeadline').value  = '';
  if($('gCat'))       $('gCat').value       = 'Skill';
  const m=$('goalModal'); m?.classList.remove('hidden'); m?.classList.add('open');
  setTimeout(()=>$('gTitle')?.focus(),80);
}

function openEditGoalModal(id) {
  const g = getGoal(id); if (!g) return;
  editingGoalId = id;
  setText('goalModalTitle','Edit Goal');
  if($('gTitle'))     $('gTitle').value     = g.title;
  if($('gDesc'))      $('gDesc').value      = g.desc||'';
  if($('gStartDate')) $('gStartDate').value = g.startDate;
  if($('gDeadline'))  $('gDeadline').value  = g.deadline||'';
  if($('gCat'))       $('gCat').value       = g.category;
  const m=$('goalModal'); m?.classList.remove('hidden'); m?.classList.add('open');
  setTimeout(()=>$('gTitle')?.focus(),80);
}

function closeGoalModal() {
  const m=$('goalModal'); m?.classList.add('hidden'); m?.classList.remove('open');
  editingGoalId = null;
}

function saveGoalModal() {
  const title     = $('gTitle')?.value.trim();
  const desc      = $('gDesc')?.value.trim();
  const startDate = $('gStartDate')?.value;
  const deadline  = $('gDeadline')?.value;
  const category  = $('gCat')?.value;
  if (!title)             { toast('Please enter a goal title.','warning'); return; }
  if (!deadline)          { toast('Please set a deadline.','warning'); return; }
  if (deadline<=startDate){ toast('Deadline must be after start date.','warning'); return; }
  if (editingGoalId) { editGoal(editingGoalId,title,desc,startDate,deadline,category); toast('Goal updated!','success'); }
  else               { addGoal(title,desc,startDate,deadline,category); }
  closeGoalModal();
}

/* ════════════════════════════════════════════
   VISION & FUTURE MESSAGE
════════════════════════════════════════════ */
function initVision() {
  const input = $('visionInput'), dot = $('visionSaveDot');
  if (!input) return;
  input.value = profile.visionText || '';
  let timer;
  input.addEventListener('input', () => {
    dot?.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => {
      profile.visionText = input.value.trim();
      saveProfile(profile);
      dot?.classList.remove('visible');
    }, 800);
  });
}

function initFutureMessage() {
  const input = $('futureInput'), dot = $('futureSaveDot');
  if (!input) return;
  input.value = profile.futureMessage || '';
  let timer;
  input.addEventListener('input', () => {
    dot?.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => {
      profile.futureMessage = input.value.trim();
      saveProfile(profile);
      dot?.classList.remove('visible');
    }, 800);
  });
}

/* ════════════════════════════════════════════
   USER HEADER
════════════════════════════════════════════ */
function renderUserHeader() {
  const nameEl   = $('userName');
  const avatarEl = $('userAvatar');
  if (!currentUser) return;
  if (nameEl)   nameEl.textContent = currentUser.displayName || 'User';
  if (avatarEl) {
    if (currentUser.photoURL) {
      avatarEl.style.backgroundImage = `url(${currentUser.photoURL})`;
      avatarEl.textContent = '';
    } else {
      avatarEl.textContent = (currentUser.displayName||'U')[0];
    }
  }
}

/* ════════════════════════════════════════════
   PAGE SWITCHING
════════════════════════════════════════════ */
function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const pg = $(`page-${name}`); if (pg) pg.classList.add('active');
  const nl = document.querySelector(`[data-page="${name}"]`); if (nl) nl.classList.add('active');
  if (window.innerWidth <= 860) $('sidebar')?.classList.remove('open');
  if (name==='analytics') updateAnalytics();
  if (name==='reports')   renderReports();
  if (name==='goals')     renderGoals();
  if (name==='monk')      renderMonkMode();
}

/* ════════════════════════════════════════════
   TOAST
════════════════════════════════════════════ */
function toast(msg, type='default', duration=3500) {
  const icons = {
    success:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
    warning:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/></svg>`,
    error:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    default:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
  };
  const el = document.createElement('div');
  el.className = `toast ${type!=='default'?type:''}`;
  el.innerHTML = `${icons[type]||icons.default}<span>${msg}</span>`;
  $('toastWrap')?.appendChild(el);
  setTimeout(() => { el.classList.add('hiding'); setTimeout(()=>el.remove(),250); }, duration);
}

/* ════════════════════════════════════════════
   DATE DISPLAY
════════════════════════════════════════════ */
function initDateDisplay() {
  const el = $('sidebarDate');
  if (el) el.textContent = new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
}


/* ════════════════════════════════════════════
   AUTO END DAY — midnight trigger
   Fires at 00:00 so goal day counts stay correct
   even if user never clicks "End Day"
════════════════════════════════════════════ */
function scheduleAutoEndDay() {
  const now      = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);               // next midnight
  const msUntilMidnight = midnight - now;

  setTimeout(() => {
    silentEndDay();                              // run at midnight
    setInterval(silentEndDay, 24 * 60 * 60 * 1000); // then every 24h
  }, msUntilMidnight);

  console.log(`⏰ Auto end-day scheduled in ${Math.round(msUntilMidnight/60000)} min`);
}

/* Silent end day — same as endDay() but no redirect, no toast spam */
function silentEndDay() {
  if (tasks.length === 0) return;

  tasks.forEach(t => { if (t.running) pauseTimer(t.id); });

  const completed = tasks.filter(t => isCompleted(t));
  const failed    = tasks.filter(t => isFailed(t));
  const score     = calcDailyScore(tasks);  // snapshot before reset

  const report = {
    id:               uid(),
    date:             todayLong(),
    iso:              todayISO(),
    score,
    completedCount:   completed.length,
    failedCount:      failed.length,
    penaltiesApplied: false,
    tasks: tasks.map(t => ({
      id:        t.id,
      name:      t.name,
      category:  t.category,
      goalId:    t.goalId,
      goal:      t.goal,
      comment:   t.comment,
      elapsed:   t.elapsed,
      minSecs:   t.minSecs,
      isPenalty: t.isPenalty || false,
      completed: isCompleted(t),
      failed:    isFailed(t)
    }))
  };

  // Don't duplicate same-day report
  reports = reports.filter(r => r.iso !== todayISO());
  reports.unshift(report);

  updateStreak();

  // ── Accumulate elapsed into goals BEFORE reset ──
  goals.forEach(g => {
    const todaySecs = tasks
      .filter(t => t.goalId === g.id)
      .reduce((sum, t) => sum + (t.elapsed || 0), 0);
    if (todaySecs > 0) g.totalElapsed = (g.totalElapsed || 0) + todaySecs;
  });
  saveGoals(goals);

  // Reset for new day
  tasks.forEach(t => { t.elapsed = 0; t.running = false; t.comment = ''; });
  tasks = tasks.filter(t => !t.isPenalty);

  saveTasks(tasks);
  saveReports(reports);
  renderTasks();
  updateDashboard();

  // Check penalties for new day
  checkAndApplyPenalties();

  toast(`🌙 Day auto-ended at midnight — Score: ${score} pts`, 'default', 5000);
}

/* ════════════════════════════════════════════
   EVENTS
════════════════════════════════════════════ */
function setupEvents() {
  // Add Task buttons
  ['addTaskBtn','addTaskBtnTasks','addTaskBtnEmpty'].forEach(id => {
    $(id)?.addEventListener('click', openAddModal);
  });

  // End Day
  $('endDayBtn')?.addEventListener('click', endDay);

  // Task modal
  $('modalSave')?.addEventListener('click', saveModal);
  $('modalCancel')?.addEventListener('click', closeModal);
  $('modalClose')?.addEventListener('click', closeModal);
  $('taskModal')?.addEventListener('click', e => { if(e.target===$('taskModal'))closeModal(); });
  ['mTaskName','mTaskHr','mTaskMin'].forEach(id => {
    $(id)?.addEventListener('keydown', e => { if(e.key==='Enter')saveModal(); });
  });
  $('mTaskHr')?.addEventListener('input', updateTimePreview);
  $('mTaskMin')?.addEventListener('input', () => {
    let min=parseInt($('mTaskMin').value)||0, hr=parseInt($('mTaskHr').value)||0;
    if(min>=60){hr+=Math.floor(min/60);min=min%60;$('mTaskHr').value=hr;$('mTaskMin').value=min;}
    updateTimePreview();
  });

  // Goal modal
  ['addGoalBtn','addGoalBtnEmpty'].forEach(id => { $(id)?.addEventListener('click', openAddGoalModal); });
  $('goalModalSave')?.addEventListener('click', saveGoalModal);
  $('goalModalCancel')?.addEventListener('click', closeGoalModal);
  $('goalModalClose')?.addEventListener('click', closeGoalModal);
  $('goalModal')?.addEventListener('click', e => { if(e.target===$('goalModal'))closeGoalModal(); });

  // Focus overlay
  $('focusExit')?.addEventListener('click', () => { if(activeFocusId)pauseTimer(activeFocusId); exitFocusMode(); });
  $('focusPause')?.addEventListener('click', () => {
    if(!activeFocusId) return;
    const t=getTask(activeFocusId);
    if(t?.running){ pauseTimer(activeFocusId); $('focusPause').innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Resume`; }
    else { startTimerOnly(activeFocusId); $('focusPause').innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Pause`; }
  });
  $('focusStop')?.addEventListener('click', () => { if(activeFocusId)pauseTimer(activeFocusId); exitFocusMode(); });

  // Nav
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => { e.preventDefault(); switchPage(link.dataset.page); });
  });

  // Filter
  $('filterStrip')?.addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn'); if(!btn) return;
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); activeFilter=btn.dataset.cat; renderTasks();
  });

  // Reports clear
  $('clearReportsBtn')?.addEventListener('click', () => {
    if (!reports.length){ toast('No reports to clear.','warning'); return; }
    if (confirm('Clear all reports?')){ reports=[]; saveReports(reports); renderReports(); renderHeatmap(); toast('Reports cleared.'); }
  });

  // Sign out
  $('signOutBtn')?.addEventListener('click', async () => {
    tasks.forEach(t => { if(t.running){ const a=timerAnchors[t.id]; if(a)t.elapsed=Math.floor(a.baseElapsed+(Date.now()-a.startedAt)/1000); stopTimer(t.id); }});
    await saveTasks(tasks);
    await signOutUser();
  });

  // Keyboard
  document.addEventListener('keydown', e => { if(e.key==='Escape'){ closeModal(); closeGoalModal(); }});

  // Sidebar hamburger
  $('hamburger')?.addEventListener('click', () => $('sidebar')?.classList.toggle('open'));

  // Mobile nav button
  const mBtn = document.createElement('button');
  mBtn.className = 'mobile-nav-btn';
  mBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
  document.body.appendChild(mBtn);
  mBtn.addEventListener('click', () => $('sidebar')?.classList.toggle('open'));
  document.addEventListener('click', e => {
    const sb=$('sidebar');
    if(window.innerWidth<=860&&sb?.classList.contains('open')&&!sb.contains(e.target)&&!mBtn.contains(e.target))
      sb.classList.remove('open');
  });

  // visibilitychange — re-sync timers on screen wake
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      tasks.forEach(t => { if(t.running&&timerAnchors[t.id]) _tickTask(t.id); });
    }
  });

  // Unload — commit elapsed
  window.addEventListener('beforeunload', () => {
    tasks.forEach(t => {
      const a=timerAnchors[t.id];
      if(a) t.elapsed=Math.floor(a.baseElapsed+(Date.now()-a.startedAt)/1000);
      if(t.running){ clearInterval(timers[t.id]); t.running=false; }
    });
    saveTasks(tasks);
  });
}


/* ════════════════════════════════════════════
   MONK MODE
   - Date range commitment (start → end)
   - Daily rules: custom + preset
   - Daily yes/no checkin per rule
   - Guilt message if failed
   - Streak of clean days
════════════════════════════════════════════ */
const KEY_MONK = 'dos_monk';

function loadMonkData() {
  try { return JSON.parse(localStorage.getItem(KEY_MONK)) || null; } catch { return null; }
}
function saveMonkData(data) {
  localStorage.setItem(KEY_MONK, JSON.stringify(data));
  // also sync to cloud profile
  if (profile) { profile.monkMode = data; saveProfile(profile); }
}

function getMonkData() {
  // prefer cloud profile, fallback localStorage
  return (profile && profile.monkMode) || loadMonkData();
}

/* Default guilt messages */
const GUILT_MESSAGES = [
  "You broke your silence. The algorithm got you. Was it worth it?",
  "Every scroll you didn't need brought you further from who you want to be.",
  "The person you're becoming doesn't do this. Remember that tomorrow.",
  "You chose distraction over discipline. Own it. Fix it.",
  "Your future self is watching. Don't let them down again.",
];

function getGuiltMessage() {
  return GUILT_MESSAGES[Math.floor(Math.random() * GUILT_MESSAGES.length)];
}

/* ── Render Monk Mode page ── */
function renderMonkMode() {
  const page = $('page-monk');
  if (!page) return;

  const monk = getMonkData();
  const container = $('monkContainer');
  if (!container) return;

  if (!monk || !monk.active) {
    renderMonkSetup(container);
  } else {
    renderMonkDashboard(container, monk);
  }
}

/* ── Setup form (no active monk mode) ── */
function renderMonkSetup(container) {
  container.innerHTML = `
    <div class="monk-setup-card">
      <div class="monk-setup-icon">🧘</div>
      <h2 class="monk-setup-title">Enter Monk Mode</h2>
      <p class="monk-setup-sub">Commit to disappearing. No social media. No distractions. Just you and your work.</p>

      <div class="monk-form">
        <div class="field-row">
          <div class="field-group">
            <label class="field-label">Start Date</label>
            <input type="date" id="monkStart" class="field-input" value="${todayISO()}" />
          </div>
          <div class="field-group">
            <label class="field-label">End Date</label>
            <input type="date" id="monkEnd" class="field-input" />
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Preset Rules</label>
          <div class="monk-preset-rules">
            <label class="monk-rule-check"><input type="checkbox" value="no_instagram" checked /> 📵 No Instagram</label>
            <label class="monk-rule-check"><input type="checkbox" value="no_facebook" checked /> 📵 No Facebook</label>
            <label class="monk-rule-check"><input type="checkbox" value="no_tiktok" checked /> 📵 No TikTok</label>
            <label class="monk-rule-check"><input type="checkbox" value="no_posting" checked /> 🚫 No posting / No story</label>
            <label class="monk-rule-check"><input type="checkbox" value="no_youtube" /> 📺 No YouTube (entertainment)</label>
            <label class="monk-rule-check"><input type="checkbox" value="no_gaming" /> 🎮 No gaming</label>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Custom Rules <span style="color:var(--ink-dim);font-weight:400">(one per line)</span></label>
          <textarea id="monkCustomRules" class="field-input" rows="3" placeholder="No Netflix after 10pm&#10;Sleep by 11pm&#10;No junk food"></textarea>
        </div>

        <div class="field-group">
          <label class="field-label">Your Commitment Statement</label>
          <input type="text" id="monkCommitment" class="field-input" placeholder="I will disappear for 90 days to become who I need to be." />
        </div>

        <button class="btn-primary monk-start-btn" id="monkStartBtn" style="width:100%;margin-top:8px;padding:14px">
          🧘 Begin Monk Mode
        </button>
      </div>
    </div>
  `;

  $('monkStartBtn')?.addEventListener('click', startMonkMode);
}

function startMonkMode() {
  const start      = $('monkStart')?.value;
  const end        = $('monkEnd')?.value;
  const commitment = $('monkCommitment')?.value.trim();

  if (!start || !end)   { toast('Please set start and end date.', 'warning'); return; }
  if (end <= start)     { toast('End date must be after start date.', 'warning'); return; }

  // Collect preset rules
  const presetLabels = {
    no_instagram: '📵 No Instagram',
    no_facebook:  '📵 No Facebook',
    no_tiktok:    '📵 No TikTok',
    no_posting:   '🚫 No posting / No story',
    no_youtube:   '📺 No YouTube (entertainment)',
    no_gaming:    '🎮 No gaming',
  };
  const rules = [];
  document.querySelectorAll('.monk-preset-rules input[type=checkbox]:checked').forEach(cb => {
    rules.push({ id: cb.value, label: presetLabels[cb.value] || cb.value, preset: true });
  });

  // Custom rules
  const customText = $('monkCustomRules')?.value.trim();
  if (customText) {
    customText.split('\n').filter(l => l.trim()).forEach((line, i) => {
      rules.push({ id: `custom_${i}`, label: line.trim(), preset: false });
    });
  }

  if (rules.length === 0) { toast('Add at least one rule.', 'warning'); return; }

  const monk = {
    active:     true,
    start,
    end,
    commitment: commitment || '',
    rules,
    checkins:   {},   // { "2025-04-01": { ruleId: true/false, ... } }
    cleanStreak: 0,
  };

  saveMonkData(monk);
  toast('🧘 Monk Mode activated. Stay silent. Stay focused.', 'success', 5000);
  renderMonkMode();
}

/* ── Active Monk Mode dashboard ── */
function renderMonkDashboard(container, monk) {
  const today      = todayISO();
  const daysLeft   = daysBetween(today, monk.end);
  const totalDays  = daysBetween(monk.start, monk.end);
  const daysDone   = daysBetween(monk.start, today);
  const timePct    = Math.min(100, Math.max(0, Math.round((daysDone / totalDays) * 100)));
  const isExpired  = daysLeft < 0;
  const todayCheckin = monk.checkins[today] || {};
  const allDoneToday = monk.rules.every(r => todayCheckin[r.id] === true);
  const anyFailToday = monk.rules.some(r => todayCheckin[r.id] === false);

  // Count clean days (all rules passed)
  const cleanDays = Object.entries(monk.checkins).filter(([date, checks]) =>
    monk.rules.every(r => checks[r.id] === true)
  ).length;

  container.innerHTML = `
    <!-- Header -->
    <div class="monk-hero ${isExpired ? 'expired' : ''}">
      <div class="monk-hero-top">
        <div>
          <div class="monk-hero-eyebrow">🧘 MONK MODE ${isExpired ? '— COMPLETED' : '— ACTIVE'}</div>
          <div class="monk-hero-days">${isExpired ? '0' : daysLeft}</div>
          <div class="monk-hero-days-label">days remaining</div>
        </div>
        <div class="monk-hero-right">
          <div class="monk-stat-box">
            <span class="monk-stat-val">${cleanDays}</span>
            <span class="monk-stat-lbl">Clean days</span>
          </div>
          <div class="monk-stat-box">
            <span class="monk-stat-val">${timePct}%</span>
            <span class="monk-stat-lbl">Progress</span>
          </div>
        </div>
      </div>

      ${monk.commitment ? `<div class="monk-commitment">"${esc(monk.commitment)}"</div>` : ''}

      <!-- Timeline -->
      <div class="monk-timeline">
        <div class="progress-track" style="height:6px;margin:12px 0 6px">
          <div class="progress-fill" style="width:${timePct}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:.7rem;color:rgba(255,255,255,.4)">
          <span>📌 ${monk.start}</span>
          <span>${daysDone} days in of ${totalDays}</span>
          <span>🏁 ${monk.end}</span>
        </div>
      </div>

      ${isExpired ? `
        <div class="monk-completed-msg">
          🏆 You completed Monk Mode. ${cleanDays}/${totalDays} clean days. That's discipline.
        </div>
        <button class="btn-ghost" onclick="window._app.resetMonkMode()" style="margin-top:12px;width:100%">Start a New Monk Mode</button>
      ` : ''}
    </div>

    <!-- Today's Checkin -->
    ${!isExpired ? `
    <div class="monk-checkin-card">
      <div class="monk-checkin-header">
        <h3>Today's Checkin</h3>
        <span class="monk-date-badge">${today}</span>
      </div>

      <div class="monk-rules-list" id="monkRulesList">
        ${monk.rules.map(rule => {
          const val = todayCheckin[rule.id];
          return `
            <div class="monk-rule-row ${val===true?'pass':val===false?'fail':''}">
              <span class="monk-rule-label">${esc(rule.label)}</span>
              <div class="monk-rule-btns">
                <button class="monk-btn yes ${val===true?'active':''}"
                  onclick="window._app.monkCheckin('${rule.id}', true)">✓ Yes</button>
                <button class="monk-btn no ${val===false?'active':''}"
                  onclick="window._app.monkCheckin('${rule.id}', false)">✗ No</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      ${anyFailToday ? `
        <div class="monk-guilt-box">
          <div class="monk-guilt-icon">⚠️</div>
          <div class="monk-guilt-msg">${getGuiltMessage()}</div>
        </div>
      ` : allDoneToday ? `
        <div class="monk-success-box">
          ✅ Clean day! You stayed focused. Keep going.
        </div>
      ` : ''}
    </div>
    ` : ''}

    <!-- Past checkin log -->
    <div class="monk-log-card">
      <h3 style="font-size:.85rem;font-weight:700;margin-bottom:12px">Daily Log</h3>
      <div class="monk-log-grid">
        ${generateMonkLogGrid(monk)}
      </div>
    </div>

    ${!isExpired ? `
    <div style="text-align:center;margin-top:16px">
      <button class="btn-ghost-danger" onclick="window._app.resetMonkMode()" style="font-size:.75rem">
        Exit Monk Mode
      </button>
    </div>` : ''}
  `;
}

function generateMonkLogGrid(monk) {
  const totalDays = daysBetween(monk.start, monk.end);
  const days = [];
  for (let i = 0; i <= Math.min(totalDays, 90); i++) {
    const d = new Date(monk.start);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const checkin = monk.checkins[iso];
    let cls = 'monk-log-day grey';
    let title = iso + ' — no checkin';
    if (checkin) {
      const allPass = monk.rules.every(r => checkin[r.id] === true);
      const anyFail = monk.rules.some(r => checkin[r.id] === false);
      if (allPass)       { cls = 'monk-log-day green'; title = iso + ' — ✅ Clean day'; }
      else if (anyFail)  { cls = 'monk-log-day red';   title = iso + ' — ❌ Failed'; }
      else               { cls = 'monk-log-day amber';  title = iso + ' — partial'; }
    }
    days.push(`<div class="${cls}" title="${title}"></div>`);
  }
  return days.join('');
}

/* ── Checkin handler ── */
function monkCheckin(ruleId, passed) {
  const monk = getMonkData(); if (!monk) return;
  const today = todayISO();
  if (!monk.checkins[today]) monk.checkins[today] = {};
  monk.checkins[today][ruleId] = passed;
  saveMonkData(monk);
  renderMonkMode();

  if (!passed) {
    // Show guilt message via toast
    toast(getGuiltMessage(), 'warning', 6000);
  }
}

function resetMonkMode() {
  if (!confirm('Exit Monk Mode? All your progress will be saved but mode will be deactivated.')) return;
  const monk = getMonkData();
  if (monk) { monk.active = false; saveMonkData(monk); }
  renderMonkMode();
  toast('Monk Mode ended.', 'default');
}

/* ════════════════════════════════════════════
   EXPOSE TO HTML onclick handlers
════════════════════════════════════════════ */
window._app = {
  openEditModal, deleteTask, handleStart, pauseTimer, resetTimer, saveField,
  openEditGoalModal, deleteGoal,
  monkCheckin, resetMonkMode,
};