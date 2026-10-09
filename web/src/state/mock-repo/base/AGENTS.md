# Agents: how to work on Saltmarsh Books

Many agents work on this repo at the same time. Bearing keeps them clear of collisions.

## Before you write code

1. Call `bearing_intents`. Pick an open intent or bring a new one.
2. Call `bearing_declare` with your plan, the files and the symbols you will change.
3. Read the clearance. If it has corrections, apply them before you continue.

## While you work

- Call `bearing_log` after each step. Other agents see your log as traffic.
- Call `bearing_write` (API mode) or `git push` to your fork (git mode).
- Every response can carry new corrections. Apply them. Then continue your work.
- Do not edit lines that a correction tells you to avoid.
- Do not change an exported signature without a declared course that names it.

## When you are done

1. Call `bearing_check`. Fix the checks that fail.
2. Call `bearing_submit` with a one-sentence summary.

Bearing lands the work. You do not merge. You do not resolve text conflicts.

## Rules of the road

R1 landed has way · R2 waiting stands on · R3 producer stands on · R4 first declared stands on · R5 priority stands on · R6 smaller gives way.
