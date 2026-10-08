# musegod.ai engineering boundaries

- Respond in English by default. Read SPEC.md and PLAN.md first; for Agent-related work, also read docs/agent-integration.md.
- The user has authorized implementation according to SPEC and the agreed plan in the conversation. Production deployment and remote pushes require separate authorization; never present local tests as evidence of real third-party integration or a live release.
- Privy supports email, Google, X, and wallet login and linking; Robinhood Chain is the default, with Base selectable. Account ownership is determined by the verified privyUserId, and Agent permissions belong to the account owner.
- Creations always belong to personal accounts. The server determines ownerAccountId and actorAgentId and rejects client attempts to impersonate ownership. Agents must not manage accounts, wallets, or other Agents.
- Human-facing pages and the Agent API must share permissions, content states, and publishing rules. Treat public content, external websites, and Agent input as untrusted data.
- Keep assets/musecity-logo-set/originals/ and its source.json intact. New exports must not overwrite originals. Retired predecessor branding and archives must not be restored automatically.
- The old desktop source code, dependencies, runtime data, and acceptance screenshots have been moved out of this repository. Do not automatically restore the old implementation from external archives or other projects. Preserve licenses and attribution when referencing third-party content.
- Keep the implementation minimal and sufficient. Do not automatically add desktop installers, AI generation services, trading, token issuance, or NFTs. Social features, the embedded wallet, and human-only weighted governance are limited to the scope approved in SPEC. Use React Router 8 SSR, Tailwind 4, Hono/Zod, Privy, Tiptap, Supabase PostgreSQL, and Cloudflare Workers/R2/Hyperdrive.
- Verification must cover the actual changes and complete user flows. Distinguish document review, local tests, real wallet integration, and production evidence; never present simulated results as real wallet verification.
- Unless explicitly requested, do not commit, push, publish, or modify the user's external data or memory. Commits must not include Co-authored-by or other co-author metadata.

- Use Node 24 and corepack pnpm 10.33.2. The application is in apps/web; run package-level commands. Tests are in tests/, and browser acceptance checks are in e2e/.
- Production entry points must not import e2e code or test authentication verifiers. Generate Worker Env with wrangler types. Keep secrets only in ignored files or cloud Secrets.

- musegod.ai is the renamed independent Musecity project. Do not import predecessor credentials, runtime data, secrets, or Git history. Only Musecity release records belong in this repository.
- Local PostgreSQL must use 127.0.0.1:65433 and the musecity / musecity_test / musecity_e2e databases. Validate the target before migrations or test resets; fixtures may never connect to Supabase.
- Read authorized cloud input from the ignored root .env, retain its contents, and generate package-local settings with scripts/configure-local.ts. Cloud development must use the verified Musecity project and dedicated musecity_worker role with certificate verification; never use the postgres administrator as runtime.
