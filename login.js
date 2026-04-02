/* ════════════════════════════════════════════
   DISCIPLINE OS — login.js
   Handles Google Sign-In and redirect
════════════════════════════════════════════ */
import { signInWithGoogle, onAuthChange } from './firebase.js';

const btn      = document.getElementById('googleBtn');
const errorMsg = document.getElementById('errorMsg');

/* If already logged in → go straight to app */
onAuthChange(user => {
  if (user) {
    window.location.replace('index.html');
  }
});

btn.addEventListener('click', async () => {
  btn.classList.add('loading');
  errorMsg.classList.remove('show');

  try {
    await signInWithGoogle();
    // onAuthChange will fire and redirect
  } catch (err) {
    btn.classList.remove('loading');
    errorMsg.textContent = friendlyError(err.code);
    errorMsg.classList.add('show');
  }
});

function friendlyError(code) {
  const map = {
    'auth/popup-closed-by-user':       'Sign-in was cancelled. Please try again.',
    'auth/network-request-failed':     'Network error. Check your connection.',
    'auth/popup-blocked':              'Popup blocked by browser. Allow popups for this site.',
    'auth/cancelled-popup-request':    'Another sign-in is in progress.',
  };
  return map[code] || 'Sign-in failed. Please try again.';
}