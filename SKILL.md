---
name: renext
description: Next.js 프로젝트 최적화 도구 모음. next-init으로 프로젝트 초기 분석 시작. next-fetch로 특정 Next.js 문서를 다운로드
disable-model-invocation: false
argument-hint: "[next-init|next-fetch <url>|next-implement <task>]"
allowed-tools: Bash(node *), Read
---

$ARGUMENTS 에 따라 아래 커맨드를 실행하세요.

## next-init

node .claude/skills/renext/commands/next-init.js

실행 완료 후 `.claude/index.md`를 Read 도구로 읽어서 사용자에게 결과를 보여주세요.

## next-fetch

특정 Next.js 문서가 필요할 때 사용. $ARGUMENTS 에서 `next-fetch` 다음의 URL 또는 경로를 추출해서 실행.

node .claude/skills/renext/commands/next-fetch.js <url-or-path> [--recursive]

- `--recursive` 옵션: 해당 문서 내 링크된 하위 문서까지 함께 다운로드
- 저장 위치: `.claude/docs/` 하위
- 예시: `next-fetch /docs/app/getting-started --recursive`

문서 다운로드 완료 후 해당 파일을 Read 도구로 읽어서 답변에 활용하세요.

## next-plan

node .claude/skills/renext/commands/next-plan.js

실행 완료 후 `.claude/plan.md`를 Read 도구로 읽어서 사용자에게 코드 구조를 요약해 주세요.

## next-implement

$ARGUMENTS에서 `next-implement` 다음의 구현 요청을 추출.

### Step 1: Project context
1. Read `.claude/plan.md` — group structure, Similar Components, cross-group dependencies
2. Read relevant `.claude/group/{name}.md` files based on the implementation request
3. Read `.claude/index.md` — package manager, libraries, aliases

### Step 2: Reuse analysis
- Check "Similar Components" section in plan.md
- Check related exports, props, type in group/*.md
- If a reusable component exists, Read the source file to understand its structure

### Step 3: Implementation plan
- Draft a plan following CLAUDE.md code rules
- Distinguish new files vs modifications to existing files
- Present the plan to the user for approval before coding

### Step 4: Implement
- Follow CLAUDE.md rules (Server first, minimal "use client", named exports, etc.)
- Maximize reuse of existing components
- Create error.tsx, loading.tsx alongside page.tsx when adding routes

## 자동 호출 규칙 (disable-model-invocation: false 인 경우 적용)

사용자가 Next.js 특정 기능에 대해 질문하고 관련 문서가 `.claude/docs/` 에 없을 때:
1. next-fetch로 해당 문서 다운로드
2. 다운로드된 문서를 읽어서 답변
