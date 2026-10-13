"""Offline patch checks; optionally execute actual Go regressions from cached deps.

MOSDNS_UPSTREAM must be a clean-base git checkout of mosdns v5.3.4 (working
changes are ignored). Default uses the review checkout if present. No fetches,
dependency downloads or toolchain downloads are performed.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class HotReloadCacheTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="mosdns-hot-reload-test-")
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.source = Path(cls.tmp.name)
        upstream = Path(os.environ.get("MOSDNS_UPSTREAM", "/tmp/mosdns-review-upstream"))
        if not (upstream / ".git").exists():
            raise unittest.SkipTest("Set MOSDNS_UPSTREAM to an offline v5.3.4 git checkout")
        archive = cls.source / "upstream.tar"
        with archive.open("wb") as out:
            subprocess.run(["git", "-C", str(upstream), "archive", "HEAD"], stdout=out, check=True)
        with tarfile.open(archive) as tar:
            tar.extractall(cls.source, filter="data")
        archive.unlink()
        for patch in sorted((ROOT / "mosdns/patches").glob("*.patch")):
            with patch.open("rb") as inp:
                subprocess.run(["patch", "--batch", "--fuzz=0", "-s", "-p1"],
                               cwd=cls.source, stdin=inp, check=True)

    def read(self, name):
        return (self.source / name).read_text()

    def test_all_six_providers_publish_only_validated_matchers(self):
        providers = ["data_provider/domain_set/domain_set", "data_provider/ip_set/ip_set",
                     "data_provider/adblock_set/adblock_set", "executable/hosts/hosts",
                     "executable/arbitrary/arbitrary", "executable/redirect/redirect"]
        for provider in providers:
            text = self.read("plugin/" + provider + ".go")
            callback = text[text.index("utils.StartFileWatcher"):]
            self.assertEqual(callback.count("rule_state.Publish("), 1, provider)
            self.assertLess(callback.index("if err == nil"), callback.index("rule_state.Publish("))

    def test_all_cache_write_paths_are_generation_fenced(self):
        text = self.read("plugin/executable/cache/cache.go")
        self.assertEqual(text.count("saveRespToCache("), 1)
        self.assertIn("c.saveForGeneration(qCtx.RuleGeneration, msgKey, r)", text)
        self.assertIn("c.saveForGeneration(qCtxCopy.RuleGeneration, msgKey, r)", text)
        self.assertIn("c.saveForGeneration(generation, msgKey, r)", text)
        self.assertIn('"lazy:%d:%s"', text)
        self.assertIn('"prefetch:%d:%s"', text)
        context = self.read("pkg/query_context/context.go")
        self.assertIn("RuleGeneration: rule_state.Generation()", context)
        self.assertIn("d.RuleGeneration = ctx.RuleGeneration", context)

    def test_cache_lifecycle_and_dump_invalidation(self):
        text = self.read("plugin/executable/cache/cache.go")
        self.assertIn("rule_state.Register(func()", text)
        self.assertIn("p.backend.Flush()", text)
        self.assertIn("removeRegularDump(p.args.DumpFile)", text)
        self.assertIn("c.unregisterRules()", text)
        self.assertIn("gw.Comment = dumpRuleStamp(generation)", text)
        self.assertIn("generation != 0 && gr.Comment != dumpRuleStamp(generation)", text)
        self.assertIn("c.dumpMu.Lock()", text)
        self.assertIn("c.writeDumpLocked(f, generation)", text)

    def test_go_regressions_offline(self):
        go = os.environ.get("GO", shutil.which("go") or "go")
        probe = subprocess.run([go, "version"], capture_output=True, text=True)
        if probe.returncode or not probe.stdout.startswith("go version go"):
            self.skipTest("Go compiler unavailable; patch contracts passed, Go behavior unverified")
        env = dict(os.environ, GOPROXY="off", GOSUMDB="off", GOTOOLCHAIN="local")
        subprocess.run([go, "test", "-race", "./pkg/rule_state", "./plugin/executable/cache", "./coremain",
                        "-run", "TestHotReload|TestPublication|TestReadiness|TestReadyFile|TestStartupInvalidation", "-count=1"],
                       cwd=self.source, env=env, check=True)


if __name__ == "__main__":
    unittest.main()
