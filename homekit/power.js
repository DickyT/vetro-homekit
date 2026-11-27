'use strict';
// The power watcher: a root bash script that runs outside Vetro and follows
// the TV's power signals on D-Bus. It keeps working while this plugin's Node
// process is frozen (the TV suspends it), and it is the only place that sees
// a power-off the moment it starts.
//
// What it does, by "when the TV is off" mode:
//   remote    Tells the plugin about standby and resume, nothing else. The TV
//             sleeps fully; only the remote turns it on.
//   lowpower  Also reserves low power while the TV is on, so the next
//             power-off stops at low power (screen dark, system and network
//             up) instead of a full sleep, and Home can turn the TV on. With
//             a time limit it sends the TV on to a full sleep after that long.
//
// deviced calls used (path /Org/Tizen/System/DeviceD/Display):
//   SetEntryModeDirectLPM(1, pid)    reserve low power for the next power-off;
//                                    the reservation is used up by that power-off
//   UnSetEntryModeDirectLPM(1, pid)  drop a reservation
//   RequestAmbientPowerOff()         low power -> full sleep
//   GetPowerState()                  lcdon | standby | lowpower

const LOG = '/tmp/vetro-homekit-power.log';
const PID_FILE = '/tmp/vetro-homekit-lpm.pid';
const TIMER_FILE = '/tmp/vetro-homekit-timer';
const PATHS = 'PATH=/usr/bin:/bin:/usr/sbin:/sbin; ';
const DISPLAY = '--system --dest org.tizen.system.deviced --object-path /Org/Tizen/System/DeviceD/Display';
const DISPLAY_IF = 'org.tizen.system.deviced.display';

// Each pattern matches the running watcher (its script text names LOG) or its
// dbus-monitor, but not the command line that carries the pattern. The second
// one is the watcher of 0.4.1 and earlier.
const KILL = PATHS + "pkill -f 'vetro-homekit-[p]ower'; pkill -f 'vetro-homekit-[s]ps'; pkill -f '[E]nterStandby'; true";
const ALIVE = PATHS + "pgrep -f 'vetro-homekit-[p]ower' >/dev/null && echo alive; true";
const STATE = PATHS + 'gdbus call ' + DISPLAY + ' --method ' + DISPLAY_IF + '.GetPowerState 2>&1';

// o: { mode: 'remote' | 'lowpower', deepSleepMin: 0 | minutes, api: 'http://127.0.0.1:<port>/plugins/homekit/api' }
function watcherScript(o) {
  const low = o.mode === 'lowpower';
  const secs = low ? Math.max(0, Math.round(o.deepSleepMin || 0)) * 60 : 0;
  return [
    '#!/bin/bash',
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    'L=' + LOG,
    'PF=' + PID_FILE,
    'TF=' + TIMER_FILE,
    'MODE=' + (low ? 'lowpower' : 'remote'),
    'DS=' + secs,
    'URL=' + o.api,
    'D="' + DISPLAY + '"',
    'I=' + DISPLAY_IF,
    'log() { echo "$(date +%H:%M:%S) $*" >> $L; }',
    'g() { gdbus call $D --method $I.$1 2>/dev/null | tr -d "(),\' "; }',
    'post() { local k; for k in 1 2 3; do curl -s -m 3 -X POST "$URL/$1" >/dev/null 2>&1 && return; sleep 1; done; }',
    // The reservation names this script's pid; $$ is the same in subshells.
    'arm() { echo $$ > $PF; log "low power reserved for the next power-off ($(gdbus call $D --method $I.SetEntryModeDirectLPM 1 $$ 2>&1 | tr -d "(), "))"; }',
    'disarm() { [ -f $PF ] || return; log "earlier low power reservation dropped ($(gdbus call $D --method $I.UnSetEntryModeDirectLPM 1 $(cat $PF) 2>&1 | tr -d "(), "))"; rm -f $PF; }',
    // The time limit: a counter in a file. A sleeping timer acts only if the
    // counter is still its own, so a power-on (or a newer timer) cancels it.
    'tick() { echo $(( $(cat $TF 2>/dev/null || echo 0) + 1 )) > $TF; cat $TF; }',
    'timer() { [ "$DS" -gt 0 ] || return; local n; n=$(tick)',
    '  ( sleep $DS; [ "$(cat $TF 2>/dev/null)" = "$n" ] || exit; [ "$(g GetPowerState)" = lowpower ] || exit',
    '    log "off for $((DS / 60)) min: going to full sleep"; gdbus call $D --method $I.RequestAmbientPowerOff >/dev/null 2>&1 ) & }',
    // A lit wake reaches lcdon within a second; a dark one stays in low power.
    'resume() { local i=0 s; s=$(g GetPowerState)',
    '  while [ "$s" != lcdon ] && [ $i -lt 6 ]; do sleep 0.5; i=$((i + 1)); s=$(g GetPowerState); done',
    '  log "resume (wake reason $1): ${s:-unknown}"',
    '  if [ "$s" = lcdon ]; then tick >/dev/null; [ $MODE = lowpower ] && arm; fi',
    '  post "power/${s:-unknown}/$1"; }',
    'tail -n 40 $L > $L.tmp 2>/dev/null; mv -f $L.tmp $L 2>/dev/null',
    'log "watching power; when off: ' + (low ? 'stay in low power' + (secs ? ', full sleep after ' + (secs / 60) + ' min' : '') : 'full sleep') + '"',
    'disarm',
    'S0=$(g GetPowerState)',
    'if [ $MODE = lowpower ]; then [ "$S0" = lcdon ] && arm; [ "$S0" = lowpower ] && timer; fi',
    'while :; do',
    '  dbus-monitor --system "type=\'signal\',interface=\'org.tizen.system.deviced.PowerOff\',member=\'EnterStandby\'" \\',
    '    "type=\'signal\',interface=\'org.tizen.system.deviced.power\',member=\'SystemResume\'" 2>/dev/null |',
    '  while read -r line; do',
    '    case "$line" in',
    '      *member=EnterStandby*) log "standby"; post standby & [ $MODE = lowpower ] && timer ;;',
    '      *member=SystemResume*) read -r arg; resume "${arg##* }" & ;;',
    '    esac',
    '  done',
    '  log "dbus-monitor stopped; restarting"',
    '  sleep 5',
    'done',
    '',
  ].join('\n');
}

// The root command that starts the script. It is passed inline to bash -c: the
// TV refuses to run unsigned script files ("[uep] the file is NOT signed").
// It runs in a scope of its own (systemd-run --scope), outside the root agent's
// cgroup, which the TV can kill on resume. --scope also leaves the script's $
// alone, where a service unit would expand them. Falls back to a plain start if
// systemd-run does not leave a watcher running. Prints "armed scope" or "armed".
function startCommand(script) {
  return PATHS + 'S="$(echo ' + Buffer.from(script).toString('base64') + ' | base64 -d)" || exit 1; '
    + '(setsid nohup systemd-run --scope --quiet /usr/bin/bash -c "$S" </dev/null >/dev/null 2>&1 &); '
    + "for i in 1 2 3 4 5 6; do sleep 0.5; pgrep -f 'vetro-homekit-[p]ower' >/dev/null && break; done; "
    + "if pgrep -f 'vetro-homekit-[p]ower' >/dev/null; then echo armed scope; else "
    + '(setsid nohup /usr/bin/bash -c "$S" </dev/null >/dev/null 2>&1 &); sleep 1; '
    + "pgrep -f 'vetro-homekit-[p]ower' >/dev/null && echo armed; fi";
}

// 'lcdon' | 'standby' | 'lowpower' | ... from the output of STATE, or null.
function parseState(stdout) {
  const m = /\('([a-z]+)',\)/.exec(String(stdout || ''));
  return m ? m[1] : null;
}

module.exports = { LOG, KILL, ALIVE, STATE, watcherScript, startCommand, parseState };
