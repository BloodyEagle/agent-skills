# automateskill

[Русская версия](README.ru.md)

> Requires ZCode: CronCreate and the .zcode/agents subagent pool. Not installable in Hermes or Claude Code.

Turns a free-form message like "at 03:00 run this task: in repository X analyze the code with model Y, save a report and write a fix plan, then execute the plan with model Z in branch Q — each item a separate commit, push to git" into two artifacts: a plan file with frontmatter in `tasks/input/<slug>/` of the runner repository, and a dedicated `CronCreate` automation that executes the plans of its folder with registered subagents.

## How it works

1. **Extract the parameters** from the text: schedule, repeat (one-shot unless a repeat is stated), target repository, path of the local copy, phase executors (models), the fallback model, the branch (default `obs/<plan-name>`), the essence of the work. Executor models are taken only from the user's text; a missing or disabled model — the full model list is offered via `ListModels`, and without a choice the skill does not continue. The fallback (including "no fallback") is asked separately from the phase executors.
2. **Check the environment:** the runner repository with a confirmed `main` (the templates support only `main`; another base branch — stop and ask), the executor definitions in `.zcode/agents/` of the current workspace, and push rights to the target repository — all before the plan is created. Without push rights the skill asks for authorization first, then offers a fork only with consent; work via a fork stays in the fork, a PR to the upstream is made manually.
3. **Write the plan file** `tasks/input/<slug>/00-<short-name>.md` with frontmatter (`repo`/`repo-path`, `worktree`, `executor`, `branch`) and commit and push it to the runner.
4. **Create the automation** via `CronCreate`: `delayMinutes` for a relative delay ("in 2 hours"), `intervalUnit` + `interval` (1–200) for "every N minutes/hours/days/…", a cron in the machine's local timezone for calendar repeats, and a pinned calendar date with `recurring: false` for a one-shot absolute time ("November 18 at 03:00") — the date is agreed with the user when it is ambiguous.
5. **Verify and report:** `CronList` shows the status `active` and the next run time; the answer names the automation id, the next run, the plan file path, the executors and the folder where reports land (`tasks/done` of the target repository by default).

## Notes

- The automation title keeps the user's time wording; the model of the automation itself is the host default and is fixed in the Automations UI.
- `CronCreate` itself does not archive, report, commit or merge — those steps must be prescribed in the executor agent definitions; a wrong branch contract stops the plan before publication.
- A push failure during a nightly run stops the plan (STOPPED) with a report; that is why push rights are checked before the plan is created.
- The mechanism limit is 10 plans per run; a phase chain must not loop (a plan spawning a plan spawning a plan…).
- Do not delete the workspace the automation is bound to.
