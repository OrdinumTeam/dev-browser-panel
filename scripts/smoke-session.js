#!/usr/bin/env node
/*
 * Integration smoke test for the Session layer (no VS Code required).
 * Launches the real headless Chromium and exercises the v0.5.0 hardening:
 * tab lifecycle, history navigation, JS dialog auto-handling, last-tab guard,
 * multi-instance profile claiming, orphan reaping and clean shutdown.
 *
 * Run: node scripts/smoke-session.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { Session } = require(path.join(ROOT, 'out/session.js'));
const { claimProfileDir, profileDir } = require(path.join(ROOT, 'out/chromium.js'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function freshWorkspace(suffix) {
  const dir = path.join(os.tmpdir(), `dbp-smoke-${suffix}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  // ---------------------------------------------------------------- basics
  console.log('\n[1] start / tab lifecycle / history');
  const ws = freshWorkspace('a');
  const s = new Session({
    port: 9601,
    startUrl: 'about:blank',
    viewport: { width: 800, height: 600 },
    workspaceDir: ws,
  });
  await s.start();
  check('session starts, port allocated', s.allocatedPort >= 9601);
  check('instance port file written', fs.existsSync(path.join(ws, '.dev-browser-panel', 'port')));
  check('profile owner file written', fs.existsSync(path.join(s.profilePath, 'panel-owner.json')));
  check('one initial page target', s.listTabUrls().length === 1);

  const pageA = 'data:text/html,<title>A</title><h1>A</h1>';
  const pageB = 'data:text/html,<title>B</title><h1>B</h1>';

  const newId = await s.createNewTab(pageA);
  check('new tab becomes active', s.activeTargetId === newId);
  await waitFor(() => s.targets.get(newId)?.sessionId, 5000, 'tab attach');
  await sleep(800); // let the first navigation commit (else Chromium replaces the entry)

  async function h1Text() {
    const r = await s.getCDP().send(
      'Runtime.evaluate',
      { expression: "document.querySelector('h1') ? document.querySelector('h1').textContent : ''", returnByValue: true },
      s.targets.get(newId).sessionId,
    );
    return r.result.value;
  }

  await s.navigate(newId, pageB);
  await sleep(800);
  let nav = await s.getNavState(newId);
  check('canGoBack after navigation', nav.canGoBack === true, JSON.stringify(nav));

  await s.goBack(newId);
  await sleep(800);
  nav = await s.getNavState(newId);
  check('canGoForward after goBack', nav.canGoForward === true, JSON.stringify(nav));
  check('page content is A after goBack', (await h1Text()) === 'A');

  await s.goForward(newId);
  await sleep(800);
  nav = await s.getNavState(newId);
  check('canGoBack after goForward', nav.canGoBack === true, JSON.stringify(nav));
  check('page content is B after goForward', (await h1Text()) === 'B');

  // ------------------------------------------------------------- dialogs
  console.log('\n[2] JS dialogs never freeze a tab');
  const cdp = s.getCDP();
  const sid = s.targets.get(newId).sessionId;

  // alert: auto-accepted by the session itself
  const alertDone = cdp.send('Runtime.evaluate', { expression: "alert('hello'); 'after-alert'" , returnByValue: true }, sid);
  const alertResult = await Promise.race([alertDone, sleep(5000).then(() => null)]);
  check('alert auto-accepted (page unblocked)', !!alertResult && alertResult.result.value === 'after-alert');

  // confirm: emitted to the UI layer; we answer like the extension would
  let dialogEvent = null;
  s.once('dialog', (d, alreadyAnswered) => {
    dialogEvent = { d, alreadyAnswered };
    if (!alreadyAnswered) void s.answerDialog(d.sessionId, true);
  });
  const confirmDone = cdp.send('Runtime.evaluate', { expression: "confirm('sure?')", returnByValue: true }, sid);
  const confirmResult = await Promise.race([confirmDone, sleep(5000).then(() => null)]);
  check('confirm emitted to UI', !!dialogEvent && dialogEvent.d.dialogType === 'confirm');
  check('confirm answered true', !!confirmResult && confirmResult.result.value === true);

  // --------------------------------------------------------- last-tab guard
  console.log('\n[3] closing the last tab leaves a usable browser');
  const ids = Array.from(s.targets.keys());
  for (const id of ids) {
    await s.closeTab(id);
    await sleep(300);
  }
  await waitFor(() => s.listTabUrls().length >= 1, 5000, 'replacement tab');
  check('a fresh tab exists after closing all', s.listTabUrls().length >= 1, JSON.stringify(s.listTabUrls()));
  check('an active target remains', !!s.activeTargetId);

  // ------------------------------------------------- multi-window isolation
  console.log('\n[4] second window on the same workspace gets its own profile+port');
  const s2 = new Session({
    port: 9601,
    startUrl: 'about:blank',
    viewport: { width: 800, height: 600 },
    workspaceDir: ws,
  });
  await s2.start();
  check('different CDP ports', s2.allocatedPort !== s.allocatedPort, `${s.allocatedPort} vs ${s2.allocatedPort}`);
  check('different profiles', s2.profilePath !== s.profilePath, `${s.profilePath} vs ${s2.profilePath}`);
  check('first session still alive', s.isRunning());
  check('second session alive', s2.isRunning());
  await s2.stop();
  check('suffixed profile owner removed on stop', !fs.existsSync(path.join(s2.profilePath, 'panel-owner.json')));

  // ------------------------------------------------------------ stop clean
  console.log('\n[5] clean stop');
  let stopReasons = [];
  s.on('stopped', (reason) => stopReasons.push(reason));
  await s.stop();
  check("emits stopped once with 'stopped by user'", stopReasons.length === 1 && stopReasons[0] === 'stopped by user', JSON.stringify(stopReasons));
  check('instance port file removed', !fs.existsSync(path.join(ws, '.dev-browser-panel', 'port')));
  check('profile owner removed', !fs.existsSync(path.join(s.profilePath, 'panel-owner.json')));

  // ------------------------------------------------------- unexpected death
  console.log('\n[6] killed Chromium surfaces as a stopped event');
  const ws2 = freshWorkspace('b');
  const s3 = new Session({
    port: 9621,
    startUrl: 'about:blank',
    viewport: { width: 800, height: 600 },
    workspaceDir: ws2,
  });
  await s3.start();
  const stoppedPromise = new Promise((resolve) => s3.once('stopped', (reason) => resolve(reason)));
  // Simulate a crash: kill the browser out from under the session.
  const ownerInfo = JSON.parse(fs.readFileSync(path.join(s3.profilePath, 'panel-owner.json'), 'utf8'));
  process.kill(ownerInfo.chromiumPid, 'SIGKILL');
  const reason = await Promise.race([stoppedPromise, sleep(8000).then(() => 'TIMEOUT')]);
  check('stopped event fired with a reason', reason !== 'TIMEOUT' && typeof reason === 'string' && reason.length > 0, String(reason));
  check('port file cleaned up after crash', !fs.existsSync(path.join(ws2, '.dev-browser-panel', 'port')));

  // ---------------------------------------------------------- orphan reaping
  console.log('\n[7] orphan Chromium is reaped, busy profile is skipped');
  const ws3 = freshWorkspace('c');
  const base = profileDir(ws3);
  fs.mkdirSync(base, { recursive: true });

  // Marker process whose command line mentions the profile (argv survives in ps,
  // unlike `sh -c` which execs and drops comments).
  function markerProcess(profile) {
    return spawn(process.execPath, ['-e', 'setTimeout(function(){}, 600000)', profile], { detached: false });
  }

  // Fake an orphan: live "chromium", dead extension-host owner pid.
  const orphan = markerProcess(base);
  await sleep(300);
  fs.writeFileSync(path.join(base, 'panel-owner.json'), JSON.stringify({ chromiumPid: orphan.pid, ownerPid: 999999 }), 'utf8');
  const claimed = claimProfileDir(ws3);
  await sleep(300);
  check('orphaned profile reclaimed (base dir)', claimed === base, claimed);
  check('orphan process killed', orphan.exitCode !== null || orphan.killed || !isAlive(orphan.pid));
  try { orphan.kill('SIGKILL'); } catch { /* already dead */ }

  // Busy profile in a fresh workspace: live "chromium" owned by a live FOREIGN
  // process (the marker itself) → claim must skip to the suffixed dir.
  const ws4 = freshWorkspace('d');
  const base4 = profileDir(ws4);
  fs.mkdirSync(base4, { recursive: true });
  const busy = markerProcess(base4);
  await sleep(300);
  fs.writeFileSync(path.join(base4, 'panel-owner.json'), JSON.stringify({ chromiumPid: busy.pid, ownerPid: busy.pid }), 'utf8');
  const claimed2 = claimProfileDir(ws4);
  check('busy profile skipped → suffixed dir', claimed2 === `${base4}-2`, claimed2);
  check('busy chromium NOT killed', isAlive(busy.pid));
  busy.kill('SIGKILL');

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

main().catch((e) => {
  console.error('SMOKE CRASHED:', e);
  process.exit(1);
});
