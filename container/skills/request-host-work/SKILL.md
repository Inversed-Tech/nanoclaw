# request-host-work

Use this skill when you need privileged work done on the HOST machine:
git commits, config changes, installing software, new NanoClaw features, etc.

## How to use

1. Prepare a clear `prompt` — write it as instructions for Claude on the host.
   Include: exact file paths (absolute, host-side), commands in order,
   verification step, expected outcome.
2. Set `cwd` to the host working directory (e.g. /home/ubuntu/nanoclaw).
3. Call `request_host_work` with title, description, prompt, cwd.
4. The user gets a link to the Gateway to review and approve.
5. Once approved, Claude runs. You'll get a completion notification.

## Good prompts include

- Exact absolute paths on the host
- The complete sequence of commands
- How to verify success (e.g. `git log --oneline -1`)
- Any context needed (branch name, what changed and why)

## Example

Title: "Commit branding rename to main"
CWD: /home/ubuntu/nanoclaw
Prompt: |
  Your task is to commit and push recent changes to the NanoClaw repo.

  1. cd /home/ubuntu/nanoclaw
  2. git status (verify expected files are modified)
  3. git add src/container-runner.ts groups/global/CLAUDE.md groups/main/CLAUDE.md
  4. git commit -m "Rename Andy to Verso in group prompts and container defaults"
  5. git push
  6. Verify: git log --oneline -1
