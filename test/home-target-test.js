'use strict';
// What the Home input opens, from Vetro's launcher settings.
const { Tv, homeTarget } = require('../homekit/tv');

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ': ' + JSON.stringify(got)));
};

eq('custom launcher', homeTarget('{"enabled":false,"customApp":"APLauncher.Home"}'), { kind: 'app', appId: 'APLauncher.Home' });
eq('Vetro launcher wins', homeTarget('{"enabled":true,"customApp":"APLauncher.Home"}'), { kind: 'vetro' });
eq('Vetro launcher', homeTarget('{"enabled":true,"customApp":null}'), { kind: 'vetro' });
eq('neither: Samsung', homeTarget('{"enabled":false,"customApp":null}'), { kind: 'samsung' });
eq('empty custom app', homeTarget('{"enabled":false,"customApp":""}'), { kind: 'samsung' });
eq('unreadable file', homeTarget(''), { kind: 'samsung' });
eq('app id that is not plain id characters', homeTarget('{"customApp":"a; reboot"}'), { kind: 'samsung' });

async function through(stdout, launchFails) {
  const calls = [];
  const tv = new Tv(() => Promise.resolve({ stdout, exit_code: 0 }));
  tv.key = (k) => { calls.push('key ' + k); return Promise.resolve(); };
  tv.launch = (a) => { calls.push('launch ' + a); return launchFails ? Promise.reject(new Error('x')) : Promise.resolve(); };
  await tv.home();
  return calls;
}

(async () => {
  eq('custom launcher: started directly', await through('{"customApp":"APLauncher.Home"}'), ['launch APLauncher.Home']);
  eq('custom launcher missing: key instead', await through('{"customApp":"APLauncher.Home"}', true), ['launch APLauncher.Home', 'key XF86Home']);
  eq('Vetro launcher: key', await through('{"enabled":true}'), ['key XF86Home']);
  eq('Samsung: key', await through('{"enabled":false,"customApp":null}'), ['key XF86Home']);
  console.log(fail ? fail + ' FAILED' : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})();
