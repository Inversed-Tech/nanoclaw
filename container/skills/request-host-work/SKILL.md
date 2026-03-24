---
name: request-host-work
description: Request the HOST machine to perform privileged work (git commits, system config, installs) with user approval via a web UI.
---

# request-host-work

Use this skill when you need the **HOST** (outside the container) to perform
privileged work: git commits, system changes, installing software, etc.

## How to use

1. Prepare a clear `prompt` — write it as if instructing Claude on the host.
   Include full context: file paths, exact commands, expected outcome.
2. Set `cwd` to the working directory on the HOST where Claude should run.
3. Call the `request_host_work` MCP tool — it will write the request and notify the user.
4. The user will receive a link to review and approve. Once approved,
   Claude runs autonomously until the task is done.
5. You'll receive a notification with the result.

## What to include in the prompt

- Exact files to modify (absolute paths on host)
- Commands to run in order
- What "done" looks like (how to verify success)
- Any context from the current conversation

## Example

Title: "Commit and push branding rename"
CWD: /home/ubuntu/nanoclaw
Prompt:
  Your task is to commit and push recent changes:
  1. cd /home/ubuntu/nanoclaw
  2. git add src/container-runner.ts groups/global/CLAUDE.md groups/main/CLAUDE.md
  3. git commit -m "Rename Andy -> Verso in group prompts and container defaults"
  4. git push
  Verify with: git log --oneline -1
