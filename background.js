/**
 * Service worker: install onboarding + uninstall feedback.
 *
 * - On a fresh install, flag the first-run welcome splash (shown once by
 *   welcome.js) and open Claude so the user sees TokenLens working right
 *   away, instead of staring at an already-open tab that predates the install.
 * - Always register the uninstall survey, so we learn why people leave.
 */

const UNINSTALL_SURVEY_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSebfiCqmt3fijuJQe60k0HmC7HwpdWN2ruyx0AmpOckBHWg8g/viewform?usp=publish-editor';

// Runs every time the service worker starts, which keeps the URL registered
// across browser restarts and extension updates.
chrome.runtime.setUninstallURL(UNINSTALL_SURVEY_URL);

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason !== 'install') return;

  chrome.storage.local.set({
    cts_show_welcome: true,
    cts_installed_at: Date.now(),
  }, () => {
    chrome.tabs.create({ url: 'https://claude.ai/new' });
  });
});
