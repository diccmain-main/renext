---
name: renext
description: Next.js project optimization toolkit. Start with next-init for initial analysis. Use next-fetch to download specific Next.js docs.
disable-model-invocation: false
argument-hint: "[next-init|next-fetch <url>|next-search <file>|next-implement <task>]"
allowed-tools: Bash(node *), Read
---

Run the command below based on $ARGUMENTS.

## next-init

node .claude/skills/renext/commands/next-init.js

After execution, Read `.claude/index.md` and show the results to the user.

## next-fetch

Use when specific Next.js docs are needed. Extract the URL or path after `next-fetch` from $ARGUMENTS.

node .claude/skills/renext/commands/next-fetch.js <url-or-path> [--recursive]

- `--recursive` option: also download linked sub-docs
- Save location: `.claude/docs/`
- Example: `next-fetch /docs/app/getting-started --recursive`

After download, Read the file and use it in your response.

## next-plan

node .claude/skills/renext/commands/next-plan.js

After execution, Read `.claude/plan.md` and summarize the code structure for the user.

## next-implement

Extract the implementation request after `next-implement` from $ARGUMENTS.

### Step 1: Project context
1. Read `.claude/plan.md` — group structure, Similar Components, cross-group dependencies
2. Read relevant `.claude/group/{name}.md` files based on the implementation request
3. Read `.claude/index.md` — package manager, libraries, aliases

### Step 2: File context (REQUIRED)
- Run `next-search <file>` on every file you plan to modify or that is related to the task
- Check exports, importedBy, hooks, props from the search output
- Only Read the actual file content after understanding its context via search

### Step 3: Reuse analysis
- Check "Similar Components" section in plan.md
- Check related exports, props, type from search results
- If a reusable component exists, Read the source file to understand its structure

### Step 4: Implementation plan
- Draft a plan following CLAUDE.md code rules
- Distinguish new files vs modifications to existing files
- Present the plan to the user for approval before coding

### Step 5: Implement
- Follow CLAUDE.md rules (Server first, minimal "use client", named exports, etc.)
- Maximize reuse of existing components
- Create error.tsx, loading.tsx alongside page.tsx when adding routes

## next-search

node .claude/skills/renext/commands/next-search.js $ARGUMENTS

Display the search results to the user.

## Auto-invocation rules (when disable-model-invocation: false)

Before modifying or creating a file, use next-search to understand the file's context:
1. Run next-search to check metadata and 1-hop connected files
2. Only Read the actual file content when needed

When the user asks about a specific Next.js feature and related docs are not in `.claude/docs/`:
1. Download the doc with next-fetch
2. Read the downloaded doc and answer
