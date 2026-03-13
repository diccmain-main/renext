# Project Skill Guide
This document defines the development rules for this project.
All code generation and reviews must follow these rules.

> Stack: Next.js 16 (App Router) + React 19

## Project Context
> Read these files before starting any task to understand the current state of the project.

- `.claude/index.md` — project info (package manager, versions, libraries, aliases)
- `.claude/tree.txt` — file structure (updated on `/next-plan`)
- `.claude/git-log.md` — branch, changed files, recent commits (updated on `/next-plan`)
- `.claude/plan.md` — group index + cross-group dependencies (updated on `/next-plan`)
- `.claude/group/{name}.md` — per-group file details with exports/hooks/importedBy (updated on `/next-plan`)

## Code Style (Clean Code)

### General
- Use **TypeScript only**
- Prefer **named exports**
- Prefer **small reusable components**
- Follow **single responsibility principle**
- **No business logic in components** — logic lives in hooks, services, or server actions
- **Server first** — prefer server logic over client state when possible

### Naming
- Components: `PascalCase`
- Hooks: `useSomething`
- Functions: `camelCase`
- Constants: `camelCase`
- Types/Interfaces: `PascalCase`
- Props types: `ComponentNameProps` (e.g., `ButtonProps`, `CardProps`)

### Components
- Prefer **functional components**
- Avoid unnecessary wrappers
- Components must be **UI focused** — keep logic in hooks, services, or server
- **Recycle components** — check `.claude/plan.md` and `.claude/group/{name}.md` before creating new ones
- **Avoid barrel exports** (`index.ts`) for large folders — causes tree-shaking issues

## Next.js 16 Rules

### Server vs Client Components
- Default to **Server Components** — add `"use client"` only when necessary
- `"use client"` belongs on **leaf components** only (inputs, buttons, interactive UI)
- Never add `"use client"` to layout, page, or wrapper components unnecessarily
- Server Components: data fetching, DB access, heavy logic
- Client Components: state, event handlers, browser APIs, animations

### params / searchParams (Next.js 16)
- `params` and `searchParams` are plain objects — no `await` needed
- Types: `params: { slug: string }`, `searchParams: { q?: string }`

### Server Actions
- Prefer placing Server Actions in dedicated `actions/` directory for reuse and clarity
- Component-inline Server Actions are supported but only for one-off cases
- Use with React 19 `useActionState`: `const [state, action, isPending] = useActionState(fn, null)`

### Routing (App Router)
- Always create `error.tsx`, `not-found.tsx`, `loading.tsx` alongside `page.tsx`
- Use `layout.tsx` for shared UI — avoid repeating layout in pages

## Suspense & Streaming

- Wrap slow data components with **Suspense for streaming**
- `loading.tsx` is for full-page loading — use component-level Suspense for granular loading
- Place Suspense boundary **directly above the component that fetches data**
- Wrap independent data in **parallel Suspense** — slow ones won't block others
- Pass Promise from Server Component to Client Component without `await` → unwrap with `use(promise)`

## Data Fetching & Caching (Next.js 16)

- Fetch data in **Server Components** directly
- Never fetch in `useEffect` when a Server Component can do it instead
- fetch default: Static route → build cache, Dynamic route → no-store
- Time-based revalidation: `fetch(url, { next: { revalidate: 3600 } })`
- Tag-based revalidation: `fetch(url, { next: { tags: ['user'] } })`
- DB query memoization: `cache()` — prevents duplicate calls within the same request
- DB query caching: `unstable_cache()` — supports revalidate and tags
- Cache invalidation: `revalidateTag('user')`, `revalidatePath('/dashboard')`
- Client-side data fetching: use the project's configured library (react-query / swr)

## React 19 Features

- `useOptimistic` — optimistic UI update before server response
- `useFormStatus` — form submission pending state (`{ pending }`)
- `useActionState` — Server Action state management (`[state, action, isPending]`)
- `useTransition` — non-urgent state updates, prevents UI blocking

## TypeScript Rules

- Props: use `interface` — `interface ButtonProps {}`
- Utility types: use `type` — `type Status = 'idle' | 'loading' | 'error'`
- Use `export type` when exporting types only (no runtime value)

## Import Rules

- Prefer **absolute paths** (`@/`) — `./` for same directory only, never `../../`
- Import order: external packages → internal modules (`@/`) → types (`import type`)
