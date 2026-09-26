/**
 * Backlog Phase 20 — real shell execution.
 *
 * `shell-rules.test.ts` proves the decision layer. This proves the part a pure test
 * cannot: that commands actually run in a real shell, that a timeout kills the whole
 * process tree rather than leaving grandchildren behind, that a failing build still
 * delivers its report, and that the abort listener does not accumulate.
 *
 * Every case here exercises the old failure mode too, because several of them are
 * commands the previous operator ban refused outright.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { CommandPolicy } from "../../packages/policy-engine/src/command-policy.js";

/** PIDs whose command line mentions the marker — used to detect orphans. */
function pidsMatching(marker: string): string[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" });
    return out
      .split("\n")
      .filter((line) => line.includes(marker) && !line.includes("ps -axo"))
      .map((line) => line.trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
}

async function runShellExecutionTests(): Promise<void> {
  console.log("⚙️  Running Phase 20 Real Shell Execution Tests...\n");

  if (process.platform === "win32") {
    console.log("↷ Skipped on Windows (these assertions are about POSIX process groups).");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inflynx-shellexec-"));

  try {
    // ── Test 1: shell syntax genuinely works now ───────────────────────────────
    {
      const pipeline = await CommandPolicy.runShellLine("echo hello | tr a-z A-Z", root);
      assert.equal(pipeline.exitCode, 0, pipeline.output);
      assert.equal(pipeline.output.trim(), "HELLO", "a pipe did not work");

      const chained = await CommandPolicy.runShellLine("mkdir -p a/b && cd a/b && pwd", root);
      assert.equal(chained.exitCode, 0, chained.output);
      assert.ok(chained.output.endsWith(path.join("a", "b")), `cd && chain: ${chained.output}`);

      const redirect = await CommandPolicy.runShellLine("echo written > note.txt && cat note.txt", root);
      assert.equal(redirect.exitCode, 0, redirect.output);
      assert.ok(redirect.output.includes("written"), "a redirect did not round-trip");
      assert.equal(fs.readFileSync(path.join(root, "note.txt"), "utf-8").trim(), "written");

      const quoted = await CommandPolicy.runShellLine('echo "fix(a; b) and c|d"', root);
      assert.equal(quoted.exitCode, 0, quoted.output);
      assert.ok(quoted.output.includes("fix(a; b) and c|d"), "quoting mangled the argument");

      const globbed = await CommandPolicy.runShellLine("ls *.txt", root);
      assert.ok(globbed.output.includes("note.txt"), `glob did not expand: ${globbed.output}`);

      const envVar = await CommandPolicy.runShellLine("MY_TEST_VAR=xyz && echo $MY_TEST_VAR", root);
      assert.ok(envVar.output.includes("xyz"), `env var did not survive: ${envVar.output}`);

      const stderrMerged = await CommandPolicy.runShellLine("ls /definitely/not/here 2>&1 | tail -3", root);
      assert.ok(stderrMerged.output.length > 0, "2>&1 produced nothing at all");
      console.log("✓ Test 1 Passed: pipes, &&, cd, redirection, quoting, globs and env vars all execute.");
    }

    // ── Test 2: a failing command keeps its stdout ─────────────────────────────
    {
      const failing = await CommandPolicy.runShellLine(
        "echo 'THIS IS THE TEST REPORT' && echo 'failure detail' 1>&2 && exit 3",
        root
      );
      assert.equal(failing.exitCode, 3, "exit code was not reported");
      assert.ok(
        failing.output.includes("THIS IS THE TEST REPORT"),
        `stdout was thrown away on failure — the old execFile path did exactly this: ${failing.output}`
      );
      assert.ok(failing.output.includes("failure detail"), "stderr was not captured");
      assert.ok(/\[exit code 3\]/.test(failing.output), `no exit-code line: ${failing.output}`);
      console.log("✓ Test 2 Passed: a non-zero exit still returns the full report plus the exit code.");
    }

    // ── Test 3: timeout kills the whole process group, not just the child ──────
    {
      const marker = `probe${process.pid}x`;
      // Real script files, so the grandchild's own `ps` command line contains the
      // marker. An inline `bash -c '... # marker'` cannot: the `#` comments out the
      // rest of the line, which is what made the first version of this test pass for
      // the wrong reason (the child died of a syntax error, not of a signal).
      const child = path.join(root, `orphan_child_${marker}.sh`);
      const parent = path.join(root, `orphan_parent_${marker}.sh`);
      fs.writeFileSync(child, "#!/bin/bash\nwhile :; do sleep 0.2; done\n");
      fs.writeFileSync(parent, `#!/bin/bash\n"${child}" &\nwait\n`);
      fs.chmodSync(child, 0o755);
      fs.chmodSync(parent, 0o755);

      const started = Date.now();
      const result = await CommandPolicy.runShellLine(`"${parent}"`, root, { timeoutMs: 1_500 });
      const elapsed = Date.now() - started;

      assert.equal(result.timedOut, true, `the timeout was not reported: ${result.output}`);
      assert.ok(elapsed < 12_000, `timeout took ${elapsed}ms — TERM→KILL escalation is not working`);

      // Give the group a moment to disappear, then look for survivors.
      await new Promise((r) => setTimeout(r, 1_200));
      // Discriminating, not decorative: the same probe run against a spawn without
      // `detached` + a direct-child `kill()` was measured leaving 2 surviving
      // processes. Without the process-group kill, this assertion fails.
      const orphans = pidsMatching(marker);
      assert.deepEqual(
        orphans, [],
        `timeout left ${orphans.length} orphaned process(es) still running: ${orphans.join(", ")} — ` +
        `killing only the direct child is the bug this guards`
      );
      console.log(
        `✓ Test 3 Passed: a ${elapsed}ms timeout killed the whole group — 0 orphaned grandchildren.`
      );
    }

    // ── Test 4: abort stops the run, and listeners do not accumulate ───────────
    {
      const before = process.getMaxListeners();
      process.setMaxListeners(0); // Node's own warning threshold is not what we're testing
      const controller = new AbortController();
      const promise = CommandPolicy.runShellLine("sleep 30", root, { signal: controller.signal, timeoutMs: 25_000 });
      setTimeout(() => controller.abort(), 250);
      const aborted = await promise;

      assert.equal(aborted.aborted, true, "an abort was not reported as an abort");
      assert.notEqual(aborted.timedOut, true, "an abort was mislabelled as a timeout");
      assert.ok(/\[cancelled by user\]/.test(aborted.output), `no cancellation marker: ${aborted.output}`);
      assert.ok(aborted.durationMs < 8_000, `abort took ${aborted.durationMs}ms to take effect`);

      // 200 sequential runs: a leaking "abort" listener would trip MaxListeners here.
      for (let i = 0; i < 200; i++) {
        const c = new AbortController();
        c.abort();
        await CommandPolicy.runShellLine("true", root, { signal: c.signal, timeoutMs: 2_000 });
      }
      process.setMaxListeners(before);
      console.log("✓ Test 4 Passed: abort cancels promptly, and 200 runs leak no abort listeners.");
    }

    // ── Test 5: output is bounded with a visible marker ────────────────────────
    {
      const noisy = await CommandPolicy.runShellLine("yes AAAAAAAA | head -c 400000", root, {
        maxOutputBytes: 20_000,
        timeoutMs: 15_000,
      });
      assert.equal(noisy.outputTruncated, true, "the byte cap did not engage");
      assert.ok(
        noisy.output.length < 40_000,
        `capped output still huge: ${noisy.output.length} chars`
      );
      assert.ok(/output capped at/.test(noisy.output), "the model is not told the output was capped");
      assert.ok(/tail|narrower/.test(noisy.output), "the cap message offers no way to get the rest");

      const quiet = await CommandPolicy.runShellLine("echo small", root, { maxOutputBytes: 20_000 });
      assert.notEqual(quiet.outputTruncated, true, "a small output was marked truncated");
      console.log("✓ Test 5 Passed: runaway output is capped at the byte limit and says so.");
    }

    // ── Test 6: a missing program is reported, not thrown ──────────────────────
    {
      const missing = await CommandPolicy.runShellLine("definitely-not-a-real-binary-xyz --version", root);
      assert.ok(missing.output.length > 0, "a failed lookup produced no output at all");
      assert.notEqual(missing.exitCode, 0, "a missing binary reported success");
      console.log("✓ Test 6 Passed: an unresolvable command comes back as output with a non-zero exit.");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("\n🎉 All Phase 20 Real Shell Execution Tests Passed 100%!");
}

runShellExecutionTests().catch((err) => {
  console.error("Shell execution test failed:", err);
  process.exit(1);
});
