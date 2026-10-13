# Validation record

## Passed on the final source tree

- 48 Python-discovered tests, with no skips: native ucode generator/migration, real libuci parser/serialization/CLI fixtures, real loopback DNS engine tests, lifecycle shell fixtures, safe dnsmasq snapshot/restore, and all-core-patch zero-fuzz application.
- The aggregate suite runs actual Go race regressions for rule state, cache and core readiness. Related-package full race tests and repeated hot-reload concurrency tests were also run during development.
- Native ucode RPC compile and fault injection: atomic rule writes, private geodata staging, missing-only adlist preparation, log path/type/size/descriptor-race safety. “Downloading” messages in the host log come from mocked native fixtures, not requests to those example domains.
- Node UI-schema/atomic-save tests and RPC fault-injection tests.
- JavaScript syntax, init/installer shell syntax and `git diff --check`.
- Real target LuCI+Bootstrap browser fixture flows. See [browser validation](../tests/browser/README.md) for the exact passed cases, screenshot and limits.

The aggregate console output is [host-tests.log](validation/host-tests.log). A final readiness HTTP exit-status check was additionally followed by the complete eight-case lifecycle suite and shell syntax check.

## Toolchain and sources

- ucode: exact LEDE-pinned `b885dd0fe1e974551fb1233ca5f3aa74d80b74d9`, with native fs and UCI module.
- Official OpenWrt libuci/libubox, built in an isolated prefix. Real UCI tests are mandatory when `REQUIRE_NATIVE_UCI=1`.
- Go 1.26.9 official toolchain, SHA-256 verified before extraction; isolated dependency/build caches.
- MosDNS core v5.3.4 `b7323188bab1ea742538aeccb31b692bc4967d1b` plus every repository patch, including new 227–230.
- LuCI `cae27bd8ad448b7d6216c581cd2852ffa971b1c5` libraries and Bootstrap assets for browser fixtures.

## Not claimed

- No OpenWrt SDK/package build, package installation or physical-router validation.
- No real procd/rpcd daemon test on OpenWrt; service lifecycle tests use isolated mocks and verified target rc.common semantics.
- Browser RPCs are fixture-backed. Standard Save & Apply UI was exercised, but it does not prove real router activation. Automated headless suite and physical drag reorder were not conclusively verified; details are in its report.
- No verified remote publication is implied by local validation or commit.

## Review closure

Independent review findings were reproduced and addressed: stale/repeated group choices, missing-file form failure, legacy default-group selection, log path/FD safety, unsafe custom API bind template, custom dump invalidation, redirect continuation, double mapping on cache hit, exit-dump races, pre-validation geo publication, PID readiness and restoration of dnsmasq on stop.

Remaining documented boundaries: custom YAML is administrator-controlled engine configuration; runtime snapshots do not roll back external includes/rule files; legacy redirect locks cannot reconstruct server entries destroyed by previous versions; mobile theme testing used Bootstrap because the user's theme is unknown.

## UDP retransmission test refinement

The native UDP transport retries unanswered datagrams every second using the same peer and transaction ID. An earlier test counted raw datagrams, producing an intermittent failure without enough identity data to retrospectively classify that run. The fixture now retains transaction IDs, peers and timestamps, verifies exactly one logical upstream exchange and cache query/hit counters of 3/2, and preserves exact DNS-answer assertions. A deliberate 1.15-second first-response delay proves retransmissions remain one exchange with two subsequent cache hits. Ten repeated mapping runs (30 subcases, including 10 forced retries) passed; production behavior was not weakened or changed for this test.
