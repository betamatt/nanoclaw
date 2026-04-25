# Core Source Modifications

## src/config.ts

**Intent:** Increase default container pool to 10 and add credential proxy host config.

**How to apply:**
1. Change `MAX_CONCURRENT_CONTAINERS` default from `'5'` to `'10'`
2. Add `CREDENTIAL_PROXY_HOST` to the env reading list and propagate to `process.env`

## src/container-runner.ts

**Intent:** Pass GitHub credentials to containers, support plugins, route SDLC groups to default OneCLI agent.

**How to apply:**

1. Add `plugins?: string[]` to the `ContainerInput` interface
2. Add GitHub token/repo injection — read `GITHUB_TOKEN` and `GH_REPO` from env, pass as `-e` flags to containers
3. OneCLI: remove the `agent` parameter from `applyContainerConfig()` — OneCLI v1.14+ uses default agent config:
```typescript
const onecliApplied = await onecli.applyContainerConfig(args, {
  addHostMapping: false,
  // Don't pass agent identifier — OneCLI v1.14+ uses default agent config
});
```
4. SDLC group routing: groups with `sdlc-` prefix folder use default agent (same as main group), not custom agents

## src/db.ts

**Intent:** Initialize SDLC schema and add message content lookup.

**How to apply:**
1. Import and call `initSdlcSchema(database)` at the end of `createSchema()`
2. Add `getMessageContentById(id, chatJid)` function

## src/group-queue.ts

**Intent:** Prioritize interactive messages over background tasks (SDLC stages).

**How to apply:**

1. In `drainGroup()`, process messages BEFORE tasks:
```typescript
// Messages first (chat, issue comments — interactive, latency-sensitive)
if (state.pendingMessages) {
  this.runForGroup(groupJid, 'drain')...
  return;
}
// Then pending tasks (SDLC stages — background, latency-tolerant)
if (state.pendingTasks.length > 0) { ... }
```

2. In `drainWaiting()`, scan for message-pending groups first:
```typescript
const msgIdx = this.waitingGroups.findIndex((jid) => {
  const s = this.getGroup(jid);
  return s.pendingMessages;
});
const pickIdx = msgIdx >= 0 ? msgIdx : 0;
```

3. Add `getActiveCount(): number` method exposing `this.activeCount`

4. Update test: rename to "drains messages before tasks" and flip assertions

## src/index.ts

**Intent:** Conditionally start the SDLC pipeline system.

**How to apply:** After `startIpcWatcher()`, add:
```typescript
if (SDLC_ENABLED) {
  const { startSdlcSystem } = await import('./sdlc/pipeline.js');
  startSdlcSystem({
    queue,
    registeredGroups: () => registeredGroups,
    registerGroup: (jid, group) => { registeredGroups[jid] = group; },
    getSessions: () => sessions,
    setSession: (folder, id) => { sessions[folder] = id; },
    onProcess: (jid, proc, name, folder) => { /* register process */ },
    sendNotification: async (text) => { /* send to main channel */ },
  });
}
```

Import `SDLC_ENABLED` from `./sdlc/config.js`. Wire `onSdlcResult` into IPC deps.

## src/ipc.ts

**Intent:** Handle SDLC stage result files and calendar IPC requests.

**How to apply:**

1. Add `onSdlcResult?: (sourceGroup: string, data: SdlcStageResult) => void` to `IpcDeps`
2. In the IPC file processing loop, scan for `sdlc` subdirectory:
```typescript
const sdlcDir = path.join(ipcBaseDir, sourceGroup, 'sdlc');
if (fs.existsSync(sdlcDir)) {
  // Read result-*.json files, call deps.onSdlcResult(), delete processed files
}
```
3. Add calendar request handling (main group only): read `calendar/*.json`, call `handleCalendarRequest()`, write response

## package.json

**Intent:** Add channel dependencies and update OneCLI SDK.

**How to apply:**
- Update `@onecli-sh/sdk` to `^0.3.1`
- Add: `@slack/bolt` `^4.3.0`, `@slack/types` `^2.15.0`
- Add: `@whiskeysockets/baileys` `^6.17.16`
- Add: `qrcode` `^1.5.4`, `qrcode-terminal` `^0.12.0`
