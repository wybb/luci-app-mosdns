"""Isolated shell integration tests, never starts services or touches /etc."""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
INIT = ROOT / 'luci-app-mosdns/root/etc/init.d/mosdns'

class Lifecycle(unittest.TestCase):
    def run_case(self, body):
        with tempfile.TemporaryDirectory() as d:
            source = INIT.read_text()
            # All absolute service data paths redirected into a disposable root.
            for path in ['/var/run/mosdns', '/var/etc', '/etc/mosdns', '/var/mosdns']:
                source = source.replace(path, d + path)
            script = pathlib.Path(d, 'init'); script.write_text(source)
            harness = r'''
set -u
. "$SCRIPT"
mkdir -p "$RUNDIR" "$(dirname "$GENERATED")" "$(dirname "$DUMP_FILE")"
EVENTS="$TEMP/events"; : > "$EVENTS"
log() { echo "$*" >> "$EVENTS"; }
load_settings() { enabled=1; CONF="$GENERATED"; listen_port=5335; listen_port_api=9091; redirect=0; local_dns_redirect=0; }
prepare_config() {
    log validate
    [ "${INVALID:-0}" = 0 ] || return 1
    load_settings
    echo new > "$RUNDIR/candidate.json"
    echo "${FINGERPRINT:-same}" > "$RUNDIR/fingerprint.next"
}
instance_pid() { [ "${RUNNING:-0}" = 0 ] || echo 12345; }
wait_stopped() { log stopped; [ "${STUCK:-0}" = 0 ]; }
wait_ready() { log ready; [ "${BAD_START:-0}" = 0 ]; }
redirect_setup() { log redirect; return 0; }
setcron() { return 0; }
activate_geodata() { log geodata; }
restore_geodata() { log restore-geodata; }
logger() { :; }
stop() { log stop; RUNNING=0; echo exit-dump > "$DUMP_FILE"; }
procd_open_instance() { :; }
procd_set_param() { :; }
procd_close_instance() { :; }
start() { log start; start_service; service_started; }
report_status() { log "status:$1:$2"; }
'''
            result = subprocess.run(['sh', '-c', harness + '\n' + body], env={**os.environ, 'SCRIPT': str(script), 'TEMP': d}, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return pathlib.Path(d, 'events').read_text()

    def test_apply_stops_before_dump_invalidation(self):
        events = self.run_case(r'''
RUNNING=1
reload_service || exit 1
[ ! -e "$DUMP_FILE" ] || exit 2
[ "$(cat "$GENERATED")" = new ] || exit 3
''')
        self.assertLess(events.index('validate'), events.index('\nstop\n'))
        self.assertLess(events.index('\nstopped\n'), events.index('\nstart\n'))
        self.assertIn('status:true:running', events)

    def test_validation_failure_does_not_stop_or_publish(self):
        events = self.run_case(r'''
echo previous > "$GENERATED"
echo cache > "$DUMP_FILE"
INVALID=1
reload_service && exit 1
[ "$(cat "$GENERATED")" = previous ] || exit 2
[ "$(cat "$DUMP_FILE")" = cache ] || exit 3
''')
        self.assertNotIn('\nstop\n', events)
        self.assertNotIn('\nstart\n', events)

    def test_stop_timeout_does_not_invalidate_or_publish(self):
        events = self.run_case(r'''
echo previous > "$GENERATED"
RUNNING=1; STUCK=1
reload_service && exit 1
[ "$(cat "$GENERATED")" = previous ] || exit 2
[ "$(cat "$DUMP_FILE")" = exit-dump ] || exit 3
''')
        self.assertNotIn('\nstart\n', events)
        self.assertIn('status:false:stopping', events)

    def test_unchanged_restart_keeps_dump(self):
        self.run_case(r'''
echo same > "$(dirname "$DUMP_FILE")/config.fingerprint"
stop
start || exit 1
[ "$(cat "$DUMP_FILE")" = exit-dump ] || exit 2
''')

    def test_changed_restart_invalidates_dump(self):
        self.run_case(r'''
echo old > "$(dirname "$DUMP_FILE")/config.fingerprint"
stop
start || exit 1
[ ! -e "$DUMP_FILE" ] || exit 2
''')

    def test_custom_yaml_snapshot_rollback_does_not_rewrite_saved_file(self):
        events = self.run_case(r'''
load_settings() {
 enabled=1; CONF="$TEMP/user.yaml"; listen_port=5335; listen_port_api=9091; redirect=0; local_dns_redirect=0
}
prepare_config() {
 load_settings; log validate
 cp "$CONF" "$RUNDIR/candidate-custom.yaml"
 echo same > "$RUNDIR/fingerprint.next"
}
procd_set_param() { log "$*"; }
echo good > "$TEMP/user.yaml"
start || exit 1
[ "$(cat "$RUNDIR/custom.runtime.yaml")" = good ] || exit 2
echo bad > "$TEMP/user.yaml"
BAD_START=1
reload_service && exit 3
[ "$(cat "$RUNDIR/custom.runtime.yaml")" = good ] || exit 4
[ "$(cat "$TEMP/user.yaml")" = bad ] || exit 5
''')
        self.assertIn('MOSDNS_INVALIDATE_CACHE=1', events)
        self.assertIn('status:false:startup', events)

    def test_failed_start_restores_previous_runtime(self):
        events = self.run_case(r'''
echo previous > "$GENERATED"
echo old > "$(dirname "$DUMP_FILE")/config.fingerprint"
BAD_START=1
reload_service && exit 1
[ "$(cat "$GENERATED")" = previous ] || exit 2
[ "$(cat "$(dirname "$DUMP_FILE")/config.fingerprint")" = old ] || exit 3
''')
        self.assertIn('status:false:startup', events)

if __name__ == '__main__':
    unittest.main()

class GeoStaging(unittest.TestCase):
    def test_validation_failure_keeps_live_files_and_activation_can_restore(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            source = INIT.read_text()
            for path in ['/var/run/mosdns', '/var/etc', '/etc/mosdns', '/var/mosdns', '/usr/share/mosdns/redirect.uc', '/var/log']:
                source = source.replace(path, d + path)
            script = root / 'init'; script.write_text(source)
            live = root / 'var/mosdns'; live.mkdir(parents=True)
            (live / 'geosite_cn.txt').write_text('old')
            check = root / 'usr/share/mosdns/redirect.uc'; check.parent.mkdir(parents=True)
            check.write_text('#!/bin/sh\nexit 0\n'); check.chmod(0o755)
            exporter = root / 'exporter'
            exporter.write_text('#!/bin/sh\n[ "$1" != v2dat_dump ] || echo new > "$MOSDNS_GEODATA_DIR/geosite_cn.txt"\nexit 0\n')
            exporter.chmod(0o755)
            compiler = root / 'compiler'
            compiler.write_text('#!/bin/sh\ncase "$1" in generate) [ "$INVALID" = 0 ] || exit 1; echo candidate;; manifest) echo "' + str(live / 'geosite_cn.txt') + '";; esac\n')
            compiler.chmod(0o755)
            body = r'''
. "$SCRIPT"
V2="$TEMP/compiler"; MOSDNS_SCRIPT="$TEMP/exporter"
load_settings() { enabled=1; CONF="$GENERATED"; }
export INVALID=1
prepare_config && exit 1
[ "$(cat "$TEMP/var/mosdns/geosite_cn.txt")" = old ] || exit 2
[ "$(cat "$RUNDIR/geodata.next/geosite_cn.txt")" = new ] || exit 3
export INVALID=0
prepare_config || exit 4
[ "$(cat "$TEMP/var/mosdns/geosite_cn.txt")" = old ] || exit 5
activate_geodata || exit 6
[ "$(cat "$TEMP/var/mosdns/geosite_cn.txt")" = new ] || exit 7
restore_geodata || exit 8
[ "$(cat "$TEMP/var/mosdns/geosite_cn.txt")" = old ] || exit 9
'''
            result = subprocess.run(['sh', '-c', body], env={**os.environ, 'SCRIPT':str(script), 'TEMP':d}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
