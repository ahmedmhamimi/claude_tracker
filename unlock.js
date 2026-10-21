/**
 * Unlock page (an extension page opened in a tab): where a buyer pastes the
 * Gumroad license key. It is an extension page on purpose: Chrome only lets
 * extension pages ask for the optional api.gumroad.com permission, and it must
 * be requested from a click. The actual Gumroad check runs in the service
 * worker (license-sw.js); this page only collects the key and shows the result.
 *
 * - (no exports) wires the Buy, Activate, Use-on-this-browser and Remove buttons and renders plan status from chrome.storage.
 *
 * @requires license-core.js
 */

(function () {
  'use strict';

  const Core = window.CTS_LicenseCore, CFG = Core.CONFIG;
  const $ = id => document.getElementById(id);

  const MESSAGES = {
    invalid: 'That key was not recognized. Copy it again from your Gumroad receipt email.',
    refunded: 'This purchase was refunded, so the key no longer unlocks Pro.',
    chargeback: 'This purchase was disputed, so the key no longer unlocks Pro.',
    limit: 'This key has already been activated ' + CFG.MAX_ACTIVATIONS + ' times. Reply to your Gumroad receipt email and I will sort it out.',
    permission: 'TokenLens needs permission to contact api.gumroad.com to check the key. Click Activate again and choose Allow.',
    network: 'Could not reach Gumroad. Check your connection and try again.',
    none: 'No license was found from your other browsers.',
    forbidden: 'Something went wrong. Reload this page and try again.',
  };

  const send = msg => new Promise(res => chrome.runtime.sendMessage(Object.assign({ cts: 'lic' }, msg), r => { void chrome.runtime.lastError; res(r || { ok: false, reason: 'network' }); }));
  const say = (text, kind) => { const m = $('msg'); m.textContent = text; m.className = 'msg' + (kind ? ' ' + kind : ''); };

  async function readState() {
    const [local, sync] = await Promise.all([
      chrome.storage.local.get(['cts_license', 'cts_trial']),
      chrome.storage.sync.get(['cts_trial', 'cts_license_key']).catch(() => ({})),
    ]);
    return { lic: local.cts_license || null, trial: Core.mergeTrial(local.cts_trial, sync.cts_trial), syncKey: sync.cts_license_key || '' };
  }

  async function render() {
    const { lic, trial, syncKey } = await readState();
    const s = Core.summarize(lic, trial, Date.now());
    $('price').textContent = CFG.PRICE_LABEL;
    $('plan').textContent = s.licensed ? 'Pro license active'
      : s.tier === 'trial' ? 'Free trial: day ' + s.trial.day + ' of ' + CFG.TRIAL_DAYS + '. Everything is unlocked.'
      : s.revoked ? 'Your previous license is no longer active.' : 'Free plan. Your trial has ended.';
    $('active').hidden = !s.licensed;
    $('buy').hidden = s.licensed;
    $('key-card').hidden = s.licensed;
    if (s.licensed) $('masked').textContent = Core.maskKey(lic.key);
    $('restore-box').hidden = s.licensed || !Core.keyLooksValid(syncKey);
  }

  // chrome.permissions.request must run straight from the click, before any other await.
  const askPermission = () => chrome.permissions.request({ origins: [CFG.HOST_ORIGIN] }).catch(() => false);

  async function finish(btn, r, okText) {
    btn.disabled = false;
    if (r && r.ok) { say(okText, 'ok'); await render(); return; }
    say(MESSAGES[(r && r.reason) || 'network'] || MESSAGES.network, 'bad');
  }

  $('buy-btn').addEventListener('click', () => { window.open(CFG.CHECKOUT_URL, '_blank', 'noopener'); say('After you pay, Gumroad emails you a license key. Paste it above.', ''); });

  $('activate').addEventListener('click', async e => {
    const btn = e.currentTarget, key = $('key').value.trim();
    if (!Core.keyLooksValid(key)) { say(MESSAGES.invalid, 'bad'); return; }
    btn.disabled = true; say('Checking your key…', '');
    const granted = await askPermission();
    if (!granted) { btn.disabled = false; say(MESSAGES.permission, 'bad'); return; }
    await finish(btn, await send({ op: 'activate', key }), 'Pro is unlocked. It is active in all your claude.ai tabs.');
  });
  $('key').addEventListener('keydown', e => { if (e.key === 'Enter') $('activate').click(); });

  $('restore').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true; say('Checking your license…', '');
    const granted = await askPermission();
    if (!granted) { btn.disabled = false; say(MESSAGES.permission, 'bad'); return; }
    await finish(btn, await send({ op: 'restore' }), 'Pro is unlocked on this browser.');
  });

  $('remove').addEventListener('click', async () => {
    if (!confirm('Remove the Pro license from this browser? You can activate it again with your key.')) return;
    await send({ op: 'deactivate' });
    say('', ''); await render();
  });

  chrome.storage.onChanged.addListener(() => render());
  render();
})();
