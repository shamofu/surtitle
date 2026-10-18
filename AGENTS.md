# Repository instructions

## Repository simplicity

- Prefer standard Dev Containers and tool capabilities for startup, initialization, validation, and publishing. Add custom scripts only for necessary project-specific behavior that those tools do not provide.
- Keep shared container configuration compatible with developers choosing Docker or wslc. Select the backend locally and follow the explicit container-operation instructions for the current PC.
- Use a single authoritative definition for versions and dependency inputs. Reuse already acquired upstream sources instead of adding duplicate copies or unnecessary transfer steps.
- Test product behavior and meaningful build and distribution requirements. Avoid tests that merely restate implementation or configuration, and avoid independently judging the same test results twice.
- Before removing files or processes, check their current purpose and consumers. Preserve required functionality and update affected code, configuration, tests, and documentation together. Reducing file counts is not a goal in itself.

## Documentation

- Prefer updating existing documentation over creating new files.
- Create a new document only when it has a clear ongoing audience and purpose, or the user explicitly requests it.
- Keep maintained documentation concise, consistent with the implementation, and free of duplicated explanations. Focus on usage, maintenance, specifications, and the reasons for important decisions.
- By default, keep routine plans, progress updates, and completion reports in the chat or pull request rather than creating repository documents.
- Keep routine logs, screenshots, and validation reports out of version control; write them to ignored local directories or CI artifacts.
- Retain regression test inputs and expected results, necessary reproduction materials, corresponding sources, and license documents where they have a concrete ongoing purpose. Honor explicitly requested deliverables.

## Git operations

- Before creating any commit, tag, or pull request, present its proposed content as a draft and obtain the user's explicit approval for that specific creation. Repeat this for every creation; approval for an earlier creation does not carry over.
- Close, reopen, or merge a pull request only when the user explicitly requests that specific action.
- Requests to implement changes, fix CI, or check whether a PR was requested do not authorize pull-request actions. Do not infer permission to change a PR's state as a way to correct an earlier unrequested action.
