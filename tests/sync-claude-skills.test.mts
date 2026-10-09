import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve(".github/scripts/sync-claude-skills.sh");
const repository = "runethorbek/skills";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

type Fixture = {
  root: string;
  source: string;
  config: string;
  claude: string;
  skills: string;
  agents: string;
  manifest: string;
};

function createFixture(t: test.TestContext): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "sync-claude-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    source: path.join(root, "source"),
    config: path.join(root, "claude-skills.txt"),
    claude: path.join(root, "target", ".claude"),
    skills: path.join(root, "target", ".claude", "skills"),
    agents: path.join(root, "target", ".claude", "agents"),
    manifest: path.join(root, "target", ".claude", "skills-sync-manifest.txt"),
  };
}

function writeFile(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function writeSourceSkill(fixture: Fixture, name: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(fixture.source, "claude", "skills", name, file), content);
  }
}

function writeSourceAgent(fixture: Fixture, name: string, content: string) {
  writeFile(path.join(fixture.source, "claude", "agents", `${name}.md`), content);
}

function sync(fixture: Fixture, commit = commitA) {
  return spawnSync(
    "bash",
    [script, fixture.source, repository, commit, fixture.config, fixture.claude, fixture.manifest],
    { encoding: "utf8" },
  );
}

function read(file: string) {
  return readFileSync(file, "utf8");
}

test("copies selected skills, records the source commit, and leaves other skills alone", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready v1\n", "reference/notes.md": "notes\n" });
  writeSourceSkill(fixture, "draft-issue", { "SKILL.md": "draft-issue v1\n" });
  writeSourceSkill(fixture, "not-selected", { "SKILL.md": "not selected\n" });
  writeFile(fixture.config, "# comment\nagent-ready\n\n  draft-issue  # trailing comment\n");
  writeFile(path.join(fixture.skills, "project-skill", "SKILL.md"), "project specific\n");

  const result = sync(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(path.join(fixture.skills, "agent-ready", "SKILL.md")), "agent-ready v1\n");
  assert.equal(read(path.join(fixture.skills, "agent-ready", "reference", "notes.md")), "notes\n");
  assert.equal(read(path.join(fixture.skills, "draft-issue", "SKILL.md")), "draft-issue v1\n");
  assert.equal(existsSync(path.join(fixture.skills, "not-selected")), false);
  assert.equal(read(path.join(fixture.skills, "project-skill", "SKILL.md")), "project specific\n");
  assert.equal(
    read(fixture.manifest),
    [
      "# Managed by .github/workflows/sync-claude-skills.yml. Do not edit by hand.",
      `source=${repository}`,
      `commit=${commitA}`,
      "skill=agent-ready",
      "skill=draft-issue",
      "",
    ].join("\n"),
  );
});

test("re-running against unchanged skills changes nothing, even for a newer source commit", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready v1\n" });
  writeFile(fixture.config, "agent-ready\n");
  assert.equal(sync(fixture, commitA).status, 0);
  const manifestBefore = read(fixture.manifest);

  const result = sync(fixture, commitB);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No changes/);
  assert.equal(read(fixture.manifest), manifestBefore);
});

test("updates changed files, removes files deleted in the source, and records the new commit", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "v1\n", "old.md": "obsolete\n" });
  writeFile(fixture.config, "agent-ready\n");
  assert.equal(sync(fixture, commitA).status, 0);

  rmSync(path.join(fixture.source, "claude", "skills", "agent-ready", "old.md"));
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "v2\n" });
  const result = sync(fixture, commitB);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(path.join(fixture.skills, "agent-ready", "SKILL.md")), "v2\n");
  assert.equal(existsSync(path.join(fixture.skills, "agent-ready", "old.md")), false);
  assert.match(read(fixture.manifest), new RegExp(`^commit=${commitB}$`, "m"));
});

test("removes a previously synchronized skill that is no longer selected", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready\n" });
  writeSourceSkill(fixture, "draft-issue", { "SKILL.md": "draft-issue\n" });
  writeFile(path.join(fixture.skills, "project-skill", "SKILL.md"), "project specific\n");
  writeFile(fixture.config, "agent-ready\ndraft-issue\n");
  assert.equal(sync(fixture).status, 0);

  writeFile(fixture.config, "agent-ready\n");
  const result = sync(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(fixture.skills, "draft-issue")), false);
  assert.equal(existsSync(path.join(fixture.skills, "agent-ready", "SKILL.md")), true);
  assert.equal(read(path.join(fixture.skills, "project-skill", "SKILL.md")), "project specific\n");
  assert.doesNotMatch(read(fixture.manifest), /skill=draft-issue/);
});

test("fails without changing anything when a selected skill is missing from the source", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready\n" });
  writeFile(fixture.config, "agent-ready\nridge\n");

  const result = sync(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skill not found in runethorbek\/skills: claude\/skills\/ridge/);
  assert.equal(existsSync(fixture.skills), false);
  assert.equal(existsSync(fixture.manifest), false);
});

test("refuses to overwrite a project-specific skill with the same name", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "from source\n" });
  writeFile(path.join(fixture.skills, "agent-ready", "SKILL.md"), "project specific\n");
  writeFile(fixture.config, "agent-ready\n");

  const result = sync(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not managed by this sync/);
  assert.equal(read(path.join(fixture.skills, "agent-ready", "SKILL.md")), "project specific\n");
  assert.equal(existsSync(fixture.manifest), false);
});

test("rejects skills that contain symlinks", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready\n" });
  symlinkSync("/etc/passwd", path.join(fixture.source, "claude", "skills", "agent-ready", "link"));
  writeFile(fixture.config, "agent-ready\n");

  const result = sync(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
  assert.equal(existsSync(fixture.skills), false);
});

test("rejects skill names that could escape the skills directory", (t) => {
  const fixture = createFixture(t);
  mkdirSync(path.join(fixture.source, "claude", "skills"), { recursive: true });
  writeFile(fixture.config, "../outside\n");

  const result = sync(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid name/);
});

test("rejects a source commit that is not a full SHA", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready\n" });
  writeFile(fixture.config, "agent-ready\n");

  const result = sync(fixture, "main");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /full 40-character SHA/);
});

test("copies selected agents, removes deselected ones, and leaves project agents alone", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "build-slice", { "SKILL.md": "build-slice\n" });
  writeSourceAgent(fixture, "slice-implementer", "implementer v1\n");
  writeSourceAgent(fixture, "slice-reviewer", "reviewer v1\n");
  writeSourceAgent(fixture, "not-selected", "not selected\n");
  writeFile(path.join(fixture.agents, "project-agent.md"), "project specific\n");
  writeFile(fixture.config, "build-slice\nagent:slice-implementer\nagent:slice-reviewer\n");

  const first = sync(fixture, commitA);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(read(path.join(fixture.agents, "slice-implementer.md")), "implementer v1\n");
  assert.equal(read(path.join(fixture.agents, "slice-reviewer.md")), "reviewer v1\n");
  assert.equal(existsSync(path.join(fixture.agents, "not-selected.md")), false);
  assert.match(read(fixture.manifest), /^agent=slice-implementer$/m);
  assert.match(read(fixture.manifest), /^agent=slice-reviewer$/m);

  const rerun = sync(fixture, commitB);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /No changes/);

  writeSourceAgent(fixture, "slice-implementer", "implementer v2\n");
  writeFile(fixture.config, "build-slice\nagent:slice-implementer\n");
  const updated = sync(fixture, commitB);

  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(read(path.join(fixture.agents, "slice-implementer.md")), "implementer v2\n");
  assert.equal(existsSync(path.join(fixture.agents, "slice-reviewer.md")), false);
  assert.equal(read(path.join(fixture.agents, "project-agent.md")), "project specific\n");
  assert.match(read(fixture.manifest), new RegExp(`^commit=${commitB}$`, "m"));
});

test("fails without changing anything when a selected agent is missing from the source", (t) => {
  const fixture = createFixture(t);
  writeSourceSkill(fixture, "build-slice", { "SKILL.md": "build-slice\n" });
  writeFile(fixture.config, "build-slice\nagent:slice-implementer\n");

  const result = sync(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agent not found in runethorbek\/skills: claude\/agents\/slice-implementer.md/);
  assert.equal(existsSync(fixture.skills), false);
  assert.equal(existsSync(fixture.manifest), false);
});

test("refuses to overwrite a project-specific agent with the same name", (t) => {
  const fixture = createFixture(t);
  writeSourceAgent(fixture, "slice-reviewer", "from source\n");
  writeFile(path.join(fixture.agents, "slice-reviewer.md"), "project specific\n");
  writeFile(fixture.config, "agent:slice-reviewer\n");

  const result = sync(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not managed by this sync/);
  assert.equal(read(path.join(fixture.agents, "slice-reviewer.md")), "project specific\n");
});
