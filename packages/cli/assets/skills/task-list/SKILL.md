---
name: task-list
description: Use whenever the user asks to add, put or turn items into tasks on the task list. Writes each as a standalone plain-language task. Do NOT use for goal runs or tracking your own in-session steps.
---

# Task List

Turn what the user listed into tasks on the project task list. Each task is picked up later by a fresh agent that sees none of this chat, so its prompt is the only context it will ever have.

## Steps

1. **Split the request into items.** One task per thing the user asked for. Don't merge unrelated items or split one item into steps the user didn't ask for. If the user's list is unclear, add the parts that are clear and ask about the rest in one `ask_user` call.
2. **Collect the context yourself.** Before writing a prompt, read the relevant code so you can name the real files, functions, commands and current behaviour. Never ask the user for facts you can look up.
3. **Write each prompt in plain natural language.** Write it the way you'd brief a colleague: what to change, where it lives, why it matters, and what "done" looks like. Use sentences, not checklists or code.
4. **Make it standalone.** The prompt has to work on its own:
   - Never reference another task ("after task 2", "the task above", "as before", "same as the previous one"). If two tasks need the same background, write it out in both.
   - Never point back at this conversation ("as discussed", "the bug I mentioned"). Spell out what was meant.
   - State the starting point the agent will find, not the one you hope an earlier task leaves behind.
5. **End every prompt with this sentence, exactly as written:**

   > use steroids corpus tool implement working code. /commit when done and open a PR but before marking the task done. do not wait for CI to finish.

6. **Add the tasks.** Use the `tasks` tool with `action: "add"` once per task. If it isn't loaded, find it with `tool_search` first. `title` is a short label of about 10 words; `prompt` is the full text from steps 3 to 5. Add them in a sensible order (groundwork first), but keep each prompt independent.
7. **Report back.** Run `tasks` `list`, then reply with the titles you added. Don't start working on any of them unless the user asks.

## Self-check before each add

- Could an agent with only this prompt and the repo finish the work? If not, add the missing context.
- Does the prompt mention another task, "above", "previous" or "as discussed"? Rewrite it.
- Is it plain prose that ends with the required sentence, unchanged? If not, fix it.

## Example

User: "add tasks to fix the flaky login test and to add dark mode to settings."

Task 1, title "Fix flaky login test", prompt:
"The login test in packages/web/src/auth/login.test.ts fails about one run in five on CI because it waits a fixed 200 ms for the session cookie. Make it wait for the cookie to appear instead, and keep the assertions as they are. Run the test 20 times in a row to show it now passes every time. use steroids corpus tool implement working code. /commit when done and open a PR but before marking the task done. do not wait for CI to finish."

Task 2 gets its own full prompt about the settings screen. It never says "like the login task".
