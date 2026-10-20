Short: Add projects and spaces from the CLI

`dev3 projects add <path>` and `dev3 projects clone <url>` register a repo on the board without the app UI, optionally placing it in spaces (`--space`, `--new-space`, `--no-space`); `dev3 spaces list|create|set|add|remove` manage memberships, and `dev3 projects list` now shows each project's spaces. Cloning from the app also refuses a URL or a path typed as the repository folder name instead of cloning into a folder named after the URL.
