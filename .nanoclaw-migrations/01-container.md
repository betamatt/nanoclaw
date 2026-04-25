# Container Changes

## Dockerfile additions

**Intent:** Add Rust toolchain, build tools, and GitHub CLI to the agent container.

**File:** `container/Dockerfile`

**How to apply:** After the existing `apt-get install` block that installs chromium and system deps, add these packages to the install list:
- `build-essential`
- `pkg-config`
- `libssl-dev`

Then add a Rust toolchain installation block after the apt cleanup:
```dockerfile
# Install Rust toolchain (minimal profile — rustc, cargo, rust-std only)
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    && chmod -R a+rX /usr/local/rustup /usr/local/cargo
```

Note: GitHub CLI installation may already exist in upstream Dockerfile (check first). If not, add:
```dockerfile
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*
```

## Agent runner — plugins support

**Intent:** Container agents can receive plugin paths from the host and pass them to the Claude Agent SDK.

**File:** `container/agent-runner/src/index.ts`

**How to apply:**

1. Add `plugins?: string[]` to the `ContainerInput` interface:
```typescript
interface ContainerInput {
  // ... existing fields ...
  plugins?: string[]; // Absolute container paths to plugin directories
}
```

2. Before the `query()` call, add plugin logging:
```typescript
if (containerInput.plugins?.length) {
  log(`Plugins: ${JSON.stringify(containerInput.plugins)}`);
}
```

3. In the `query()` options, add the plugins parameter:
```typescript
plugins: containerInput.plugins?.map(p => ({ type: 'local' as const, path: p })),
```

4. In the system/init message handler, log loaded plugins:
```typescript
if (message.type === 'system' && message.subtype === 'init') {
  const initMsg = message as Record<string, unknown>;
  if (initMsg.plugins) log(`Loaded plugins: ${JSON.stringify(initMsg.plugins)}`);
  if (initMsg.plugin_errors) log(`Plugin errors: ${JSON.stringify(initMsg.plugin_errors)}`);
}
```

## Container skills (new files — copy as-is)

Copy these directories from the main tree:
- `container/skills/agent-github/SKILL.md`
- `container/skills/agent-sdlc/SKILL.md`
- `container/skills/calendar/SKILL.md`
