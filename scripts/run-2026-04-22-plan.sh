#!/bin/bash
# Headless executor for the 2026-04-22 04:30 plan.
# Triggered via macOS `at`. Output captured to /tmp/2026-04-22-claude-execute.log.
#
# Plan path is intentionally absolute so this script doesn't depend on cwd.

set -u

LOG=/tmp/2026-04-22-claude-execute.log
PLAN_PATH=docs/superpowers/plans/2026-04-22-v0.1.2-and-gemini-alignment.md
REPO=/Users/bing/-Code-/minimax-plugin-cc
CLAUDE=/Users/bing/.local/bin/claude

{
  echo "=========================================="
  echo "Plan execution start: $(date)"
  echo "Repo: $REPO"
  echo "Plan: $PLAN_PATH"
  echo "Claude: $CLAUDE"
  echo "=========================================="

  cd "$REPO" || { echo "FATAL: cannot cd to $REPO"; exit 1; }

  # Pre-flight sanity (mirror plan's own pre-flight)
  echo "--- pre-flight ---"
  git status --porcelain
  git log -1 --oneline
  git tag --list | grep v0.1.1 || echo "WARN: v0.1.1 tag missing"

  # Headless plan execution
  PROMPT="Read and execute the implementation plan at $PLAN_PATH per the superpowers:executing-plans skill. The plan is fully self-contained — no need to ask me for clarification. Follow each task's steps exactly in order, run all verification commands, commit after each task as the plan dictates. Execute Part A (v0.1.2 patch — 6 tasks) FIRST, ship v0.1.2 with tag + push + gh release. Then execute Part B (Gemini alignment response, 5 tasks). STOP IMMEDIATELY if any pre-flight or test verification fails — do not proceed past a failed gate. Use the executing-plans skill exactly. End by reporting which tasks completed and the v0.1.2 release URL."

  echo "--- claude -p start: $(date) ---"
  "$CLAUDE" -p "$PROMPT" \
    --dangerously-skip-permissions \
    --add-dir "$REPO" 2>&1
  CLAUDE_EXIT=$?
  echo "--- claude -p exit: $CLAUDE_EXIT @ $(date) ---"

  echo "--- post-flight git state ---"
  git log --oneline -10
  git tag --list | grep v0.1
  git status --porcelain

  echo "=========================================="
  echo "Plan execution end: $(date)"
  echo "=========================================="
} >>"$LOG" 2>&1

exit ${CLAUDE_EXIT:-1}
