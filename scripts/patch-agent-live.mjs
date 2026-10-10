// Adds the live view and steering hooks to the Claude Code and Codex connectors
// (@deepseek-ai/dsh-subagent-claude-code and dsh-subagent-codex, lib/index.js), so jev-router can
// show what each of their runs is doing as it does it (docs/live-agent-view.md Feature 1, the Live
// tab) and, in later builds, steer a running one or replace its turn (Feature 5). Version 2 also
// asks the Claude Agent SDK for fast mode for a Claude Code run started while Settings, Effort, Claude
// Code speed is Fast. The connectors have no hook of their own for any of it: a provider's start()
// takes the request and nothing else reaches its stream or its SDK options, so editing the installed
// file is the only way in.
//
// What it adds is inert beyond the tap. A run is changed only when its request carries the plugin's
// own fields: `kzhTap`, a function each SDK message or app-server notification is told to, and
// `kzhControl`, an object the hooks are put on. jev-router sends them only when this file's marker is
// in the installed connector (engine-patches.js). A request without them runs exactly as before:
// every helper is then the identity or does nothing.
//
// Runs on every start (Start-KzH.ps1) because npx reinstalls the connectors on a version change.
// Each package is patched or refused on its own, never half: the engine version is checked against
// the one this was written for, and every anchor below must match the installed file exactly once,
// or nothing is written to it and the reason is said. Before an unpatched file is patched it is
// copied to index.js.kzh-backup, with index.js.kzh-backup.json naming its package version, so the
// backup always holds the file installed now (with patch-codex-effort's lines in it when that patch
// ran first, which is meant). A file carrying another version of this patch is patched again from
// that backup when the backup is of the same package version, and refused otherwise.
//
// To revert: copy index.js.kzh-backup back over lib/index.js in each connector folder, and drop the
// patch-agent-live line from Start-KzH.ps1, or the next start patches them again.
//
// It writes $DSH_HOME/kzh-engine-patches.json, which the plugin reads for why live detail is off.
// It prints to stdout only, since PowerShell 5.1 under $ErrorActionPreference = 'Stop' turns a
// native command's stderr into an error, and it always exits 0: a missing live view must not stop
// the harness from starting.
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runAsScript } from './run-as-script.mjs'

// The version this patch was read against. Keep it equal to $DshVersion in Start-KzH.ps1.
export const WRITTEN_FOR = '0.1.5-rc.2'
// Present in a patched file and nowhere else; the number is this patch's version, which a change to
// what it adds must raise, so an older patched file is put back and patched again.
export const MARKER = '/* KZH_AGENT_LIVE 2: patched by Kz-harness scripts/patch-agent-live.mjs */'
const MARKED = /KZH_AGENT_LIVE (\d+)/
const VERSION = '2'
// The connectors, by the provider family the plugin knows them as.
export const PACKAGES = Object.freeze({ 'claude-code': 'dsh-subagent-claude-code', codex: 'dsh-subagent-codex' })
const NAMES = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' })

// The helpers are written here with two spaces a level and land with a tab a level, as the files
// they go into are indented.
const tabbed = (code) => code.replace(/^(?: {2})+/gm, (lead) => '\t'.repeat(lead.length / 2))

/**
 * What goes above the Claude Code provider class: hoisted functions the edited lines call. With no
 * kzh state (a request without the plugin's fields) each is the identity or does nothing.
 */
export const CLAUDE_HELPERS = tabbed(`//#region kzh: live view and steering hooks (scripts/patch-agent-live.mjs)
${MARKER}
/**
* Kz-harness: a run asked for with \`kzhTap\` tells it every SDK message the run reads, and one asked
* for with \`kzhControl\` gets hooks to steer the run through an input channel (\`kzhControl.channel\`),
* and runs in Claude's fast mode when jev-router started it with KZ_CLAUDE_FAST_MODE set to 1 (Settings,
* Effort, Claude Code speed), read here as the start begins, as the effort variable is.
* @param request - the shared subagent request, with the plugin's optional fields.
* @returns the run's own state, or undefined for a request with neither, which runs as before.
*/
function kzhStart(request) {
  const tap = typeof request.kzhTap === "function" ? request.kzhTap : void 0;
  const control = request.kzhControl !== null && typeof request.kzhControl === "object" ? request.kzhControl : void 0;
  if (tap === void 0 && control === void 0) return void 0;
  return {
    tap,
    control,
    channel: control?.channel === true ? kzhChannel() : void 0,
    fast: control !== void 0 && process.env.KZ_CLAUDE_FAST_MODE === "1",
    steered: 0,
    interrupting: false,
    pending: /* @__PURE__ */ new Map(),
    query: void 0,
    timer: void 0
  };
}
/** An input channel: the task as the SDK's own first message, then each message pushed, until it closes. */
function kzhChannel() {
  const queue = [];
  let wake;
  let open = true;
  return {
    get open() {
      return open;
    },
    push(message) {
      if (!open) return false;
      queue.push(message);
      wake?.();
      return true;
    },
    close() {
      open = false;
      wake?.();
    },
    async *messages(first) {
      yield first;
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        if (!open) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
        wake = void 0;
      }
    }
  };
}
/** The prompt the SDK is given: the task's text, or with a channel the channel's messages, the first exactly the SDK's own write of that text. */
function kzhPrompt(kzh, prompt) {
  if (kzh?.channel === void 0) return prompt;
  return kzh.channel.messages({
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: [{
        type: "text",
        text: prompt
      }]
    },
    parent_tool_use_id: null
  });
}
/**
* The SDK options, with the partial messages a tapped run streams its steps in, and fast mode as flag
* settings, the only way an SDK run opts in to it (a fastMode in Claude's own settings is not enough).
*/
function kzhOptions(kzh, options) {
  if (kzh === void 0 || (kzh.tap === void 0 && !kzh.fast)) return options;
  return {
    ...options,
    ...kzh.tap === void 0 ? {} : { includePartialMessages: true },
    ...kzh.fast ? { settings: { fastMode: true } } : {}
  };
}
/** Put the run's hooks on its control once its query exists; a stop of the run closes its channel. */
function kzhPublish(kzh, q, signal) {
  if (kzh === void 0) return;
  kzh.query = q;
  if (kzh.control !== void 0) {
    kzh.control.steer = (text, uuid) => kzhClaudeSteer(kzh, text, uuid);
    kzh.control.sendNow = (text, uuid) => kzhClaudeSendNow(kzh, text, uuid);
    kzh.control.thinkingDisplay = async (display) => q.setMaxThinkingTokens(null, display);
  }
  if (kzh.channel === void 0) return;
  if (signal.aborted) kzhClose(kzh);
  else signal.addEventListener("abort", () => {
    kzhClose(kzh);
  }, { once: true });
}
/**
* One SDK message of the run, told to the tap, which can never change the run. At a result, each
* message the channel gave that the turn took (\`user_message_uuids\`) is delivered, and the channel
* closes once nothing waits on it: at once when nothing is pending and no turn is queued, as the
* SDK's own string prompt ends its input at the first result; at once, with what is pending unknown,
* when the result names no uuids; otherwise at the next result, or once the run has said nothing for
* 30 s, so a turn still to come that runs for longer keeps it open while it works. A turn Send now
* interrupted keeps it open for the message that replaces it.
*/
function kzhSeen(kzh, message) {
  if (kzh === void 0) return;
  if (kzh.tap !== void 0) try {
    kzh.tap({
      provider: "claude-code",
      message
    });
  } catch {}
  if (kzh.timer !== void 0 && message.type !== "result") kzhWait(kzh);
  if (message.type !== "result" || kzh.channel === void 0 || !kzh.channel.open) return;
  const taken = Array.isArray(message.user_message_uuids) ? message.user_message_uuids : void 0;
  if (taken !== void 0) {
    for (const uuid of taken) if (kzh.pending.delete(uuid)) kzhOutcome(kzh, uuid, "delivered");
  }
  clearTimeout(kzh.timer);
  kzh.timer = void 0;
  const replaced = kzh.interrupting && kzhAborted(message);
  if (!replaced && kzh.pending.size === 0 && !(message.queued_turn_count > 0)) kzhClose(kzh);
  else if (!replaced && kzh.pending.size > 0 && taken === void 0) kzhClose(kzh);
  else kzhWait(kzh);
}
/** Close the channel 30 s from now, unless the run says something first, which starts the 30 s again. */
function kzhWait(kzh) {
  clearTimeout(kzh.timer);
  kzh.timer = setTimeout(() => {
    kzhClose(kzh);
  }, 3e4);
  kzh.timer.unref?.();
}
/** Whether a result is of a turn that was stopped as it streamed or ran its tools. */
function kzhAborted(message) {
  return (message.subtype !== "success" || message.is_error === true) && String(message.terminal_reason ?? "").startsWith("aborted_");
}
function kzhOutcome(kzh, uuid, outcome) {
  try {
    kzh.control?.onOutcome?.(uuid, outcome);
  } catch {}
}
/** Close the run's channel: a message it was given that no turn took is unknown. */
function kzhClose(kzh) {
  clearTimeout(kzh.timer);
  kzh.timer = void 0;
  kzh.channel?.close();
  for (const uuid of kzh.pending.keys()) kzhOutcome(kzh, uuid, "unknown");
  kzh.pending.clear();
}
/**
* Whether a result is passed over: once, the turn Send now interrupted; and, in a run steered into
* another turn, a turn that failed after one that answered, so that answer stands.
*/
function kzhSkipResult(kzh, message, answer) {
  if (kzh === void 0) return false;
  if (kzh.interrupting && kzhAborted(message)) {
    kzh.interrupting = false;
    return true;
  }
  return answer !== void 0 && kzh.steered > 0 && (message.subtype !== "success" || message.is_error === true);
}
/** The run's answer: its turn's own, or in a steered run each answering turn's, in order. */
function kzhAnswer(kzh, previous, next) {
  return previous === void 0 || !kzh?.steered ? next : previous + "\\n\\n---\\n\\n" + next;
}
function kzhNoChannel() {
  return Object.assign(/* @__PURE__ */ new Error("subagent-claude-code: this run has no open input channel"), { code: "kzh-no-channel" });
}
function kzhUserMessage(text, uuid) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "text",
        text
      }]
    },
    parent_tool_use_id: null,
    session_id: "",
    uuid
  };
}
/** Steer: a message for the running turn, which the CLI folds in between tool rounds or runs next. */
async function kzhClaudeSteer(kzh, text, uuid = randomUUID()) {
  if (kzh.channel === void 0 || !kzh.channel.open) throw kzhNoChannel();
  kzh.pending.set(uuid, "pending");
  kzh.steered += 1;
  kzh.channel.push(kzhUserMessage(text, uuid));
  return uuid;
}
/** Send now: the running turn is interrupted, and the message runs as the next one. */
async function kzhClaudeSendNow(kzh, text, uuid = randomUUID()) {
  if (kzh.channel === void 0 || !kzh.channel.open || kzh.query === void 0) throw kzhNoChannel();
  kzh.pending.set(uuid, "pending");
  kzh.steered += 1;
  kzh.interrupting = true;
  try {
    await kzh.query.interrupt();
  } catch (error) {
    kzh.pending.delete(uuid);
    kzh.steered -= 1;
    kzh.interrupting = false;
    throw error;
  }
  if (!kzh.channel.push(kzhUserMessage(text, uuid))) {
    kzh.pending.delete(uuid);
    throw kzhNoChannel();
  }
  return uuid;
}
//#endregion
`)

/**
 * What goes above the Codex wire class: hoisted functions the edited lines call. With neither of
 * the plugin's fields on the request each does nothing, and the wire reads every frame as before.
 */
export const CODEX_HELPERS = tabbed(`//#region kzh: live view and steering hooks (scripts/patch-agent-live.mjs)
${MARKER}
/** Tell the plugin's tap one frame of the run; a tap that throws changes nothing. */
function kzhTapSafe(tap, frame) {
  if (typeof tap !== "function") return;
  try {
    tap(frame);
  } catch {}
}
/** The name of one of the plugin's Codex variables, spelled in parts: patch-codex-effort looks for the whole name to tell whether it has run. */
function kzhVar(...parts) {
  return ["KZ", "CODEX", ...parts].join("_");
}
/**
* Kz-harness: a run asked for with \`kzhTap\` tells it every app-server notification and the
* thread/start response; one asked for with \`kzhControl\` keeps the effort and speed it started with
* for every turn it runs, and gets hooks to steer its running turn or replace it. Runs before the
* wire starts, so no frame is missed. The effort and speed are kept unset too, so that they override
* patch-codex-effort's lines before them, which read the variables again at each turn/start, as
* another run may have set them since; JSON leaves an unset one out.
*/
function kzhWire(wire, request) {
  wire.kzhTap = typeof request.kzhTap === "function" ? request.kzhTap : void 0;
  const control = request.kzhControl !== null && typeof request.kzhControl === "object" ? request.kzhControl : void 0;
  if (control === void 0) return;
  const effort = process.env[kzhVar("EFFORT")];
  const serviceTier = process.env[kzhVar("SERVICE", "TIER")];
  wire.kzhTurnExtras = {
    effort: effort || void 0,
    serviceTier: serviceTier || void 0
  };
  wire.kzhControl = control;
  wire.kzhDone = /* @__PURE__ */ new Set();
  control.steer = (text, clientId) => kzhCodexSteer(wire, text, clientId);
  control.sendNow = (text, clientId) => kzhCodexSendNow(wire, text, clientId);
}
/** Whether a notification is of a turn Send now replaced, which the wire no longer follows. */
function kzhStale(wire, params) {
  if (wire.kzhDone === void 0 || wire.kzhDone.size === 0 || params === null || typeof params !== "object") return false;
  return wire.kzhDone.has(params.turnId) || params.turn !== null && typeof params.turn === "object" && wire.kzhDone.has(params.turn.id);
}
function kzhTurnOpen(wire) {
  return wire.turnId !== void 0 && !wire.closed && !wire.terminalObserved;
}
function kzhNoTurn() {
  return Object.assign(/* @__PURE__ */ new Error("subagent-codex: this run has no turn running to steer"), { code: "kzh-no-turn" });
}
/** Steer: more input for the running turn (turn/steer), whose user message echoes \`clientId\`. */
async function kzhCodexSteer(wire, text, clientId) {
  if (!kzhTurnOpen(wire)) throw kzhNoTurn();
  return wire.transport.request("turn/steer", {
    threadId: wire.threadId,
    expectedTurnId: wire.turnId,
    input: [{
      type: "text",
      text,
      text_elements: []
    }],
    clientUserMessageId: clientId
  });
}
/**
* Send now: the running turn is interrupted, and the run goes on with this as its next turn on the
* same thread. Words sent now again before the interrupt has ended the turn go in that next turn
* too, after the first, and need no interrupt of their own.
*/
async function kzhCodexSendNow(wire, text, clientId) {
  if (!kzhTurnOpen(wire)) throw kzhNoTurn();
  if (wire.kzhNext !== void 0) {
    wire.kzhNext.texts.push(text);
    wire.kzhNext.clientIds.push(clientId);
    return;
  }
  wire.kzhNext = {
    texts: [text],
    clientIds: [clientId]
  };
  wire.interrupt();
}
/** The turn Send now interrupted is over: the run goes on with the next, its words in the order sent, at the effort it started with. */
async function kzhCodexContinue(wire, signal) {
  const next = wire.kzhNext;
  wire.kzhNext = void 0;
  wire.kzhDone.add(wire.turnId);
  wire.turnId = void 0;
  wire.pendingTurnId = void 0;
  wire.terminalObserved = false;
  wire.earlyTurnNotifications = [];
  wire.lastFinalAnswer = void 0;
  wire.lastUnphasedAnswer = void 0;
  for (const clientId of next.clientIds) try {
    wire.kzhControl?.onOutcome?.(clientId, "continued");
  } catch {}
  return wire.runTurn(next.texts, signal);
}
//#endregion
`)

// Every edit, in file order per package, each `from` quoted exactly as the pinned file has it (`\t`
// a tab) and named, so a mismatch can say which one went. The two tables of the design are these
// (docs/live-agent-view.md, Engine patch).
export const EDITS = Object.freeze({
  'claude-code': Object.freeze([
    {
      id: 'C2',
      name: 'consume loop head',
      from: 'async function consumeClaudeQuery(query, onPermissionDenied, onResult) {\n\tlet answer;\n\tfor await (const message of query) {',
      to: 'async function consumeClaudeQuery(query, onPermissionDenied, onResult, kzh) {\n\tlet answer;\n\tfor await (const message of query) {\n\t\tkzhSeen(kzh, message);',
    },
    {
      id: 'C3',
      name: 'result selection',
      from: '\t\tonResult?.();\n\t\tanswer = successfulResult(message);',
      to: '\t\tonResult?.();\n\t\tif (kzhSkipResult(kzh, message, answer)) continue;\n\t\tanswer = kzhAnswer(kzh, answer, successfulResult(message));',
    },
    {
      id: 'C4',
      name: 'per-run KzH state',
      from: '\tconst prompt = textTask(request.prompt);',
      to: '\tconst prompt = textTask(request.prompt);\n\tconst kzh = kzhStart(request);',
    },
    {
      id: 'C5',
      name: 'query start',
      from: '\t\tquery$1 = query({\n\t\t\tprompt,\n\t\t\toptions: claudeQueryOptions(spec, controller, captureChild, capturePermissionDiagnostic)\n\t\t});',
      to: '\t\tquery$1 = query({\n\t\t\tprompt: kzhPrompt(kzh, prompt),\n\t\t\toptions: kzhOptions(kzh, claudeQueryOptions(spec, controller, captureChild, capturePermissionDiagnostic))\n\t\t});',
    },
    {
      id: 'C6',
      name: 'published query',
      from: '\tconst publishedQuery = query$1;',
      to: '\tconst publishedQuery = query$1;\n\tkzhPublish(kzh, publishedQuery, request.signal);',
    },
    {
      id: 'C7',
      name: 'consume call',
      from: '\t\t\t\t}), publishedProcessFailure]);',
      to: '\t\t\t\t}, kzh), publishedProcessFailure]);',
    },
    {
      id: 'C1',
      name: 'provider class (the helpers go above it)',
      from: 'var ClaudeCodeProvider = class {',
      to: `${CLAUDE_HELPERS}var ClaudeCodeProvider = class {`,
    },
  ]),
  codex: Object.freeze([
    {
      id: 'X1',
      name: 'wire class (the helpers go above it)',
      from: 'var CodexAppServerWire = class {',
      to: `${CODEX_HELPERS}var CodexAppServerWire = class {`,
    },
    {
      id: 'X2',
      name: 'single notification entry',
      from: '\t\tthis.transport.onNotification((method, params) => {\n\t\t\ttry {\n\t\t\t\tthis.handleNotification(method, params);',
      to: '\t\tthis.transport.onNotification((method, params) => {\n\t\t\tkzhTapSafe(this.kzhTap, { provider: "codex", method, params });\n\t\t\tif (kzhStale(this, params)) return;\n\t\t\ttry {\n\t\t\t\tthis.handleNotification(method, params);',
    },
    {
      id: 'X3',
      name: 'thread/start request',
      from: '\t\tconst thread = object(object(await this.guarded(this.transport.request("thread/start", {',
      to: '\t\tconst kzhStarted = object(await this.guarded(this.transport.request("thread/start", {',
    },
    {
      id: 'X4',
      name: 'thread/start response',
      from: '\t\t}, signal), signal), "thread/start response").thread, "thread/start thread");',
      to: '\t\t}, signal), signal), "thread/start response");\n\t\tkzhTapSafe(this.kzhTap, { provider: "codex", method: "kzh/thread-start-response", params: kzhStarted });\n\t\tconst thread = object(kzhStarted.thread, "thread/start thread");',
    },
    {
      id: 'X5',
      name: 'turn/start extras',
      from: '\t\t\t\tinput: texts.map((text) => ({',
      to: '\t\t\t\t...this.kzhTurnExtras,\n\t\t\t\tinput: texts.map((text) => ({',
    },
    {
      id: 'X6',
      name: 'Send now continues the thread',
      from: '\t\tconst status = terminal.status;',
      to: '\t\tconst status = terminal.status;\n\t\tif (status === "interrupted" && this.kzhNext !== void 0) return kzhCodexContinue(this, signal);',
    },
    {
      id: 'X7',
      name: 'wire construction',
      from: '\tconst wire = new CodexAppServerWire(child.stdout, child.stdin, spec.permissionMode, spec.model);',
      to: '\tconst wire = new CodexAppServerWire(child.stdout, child.stdin, spec.permissionMode, spec.model);\n\tkzhWire(wire, request);',
    },
  ]),
})

/**
 * One connector's source with every edit applied, or why not: `{ ok: true, out }` or
 * `{ ok: false, reason }`. Pure. `version` is the installed package's own; `marker` is the line
 * that marks the file patched (a test gives another version's). Line ends stay the file's own.
 */
export function patchSource(pkg, src, version, marker = MARKER) {
  const edits = EDITS[pkg]
  if (!edits) return { ok: false, reason: `no edits for ${pkg}` }
  // Another engine version is other code, and matching anchors blindly into it is how a patch ends
  // up half applied, so the version is checked before any anchor is.
  if (version !== WRITTEN_FOR) return { ok: false, reason: `${PACKAGES[pkg]} ${version ?? '(version unknown)'} is installed, and this patch was written for ${WRITTEN_FOR}` }
  const nl = src.includes('\r\n') ? '\r\n' : '\n'
  const eol = (text) => text.replace(/\r?\n/g, nl)
  let out = src
  for (const edit of edits) {
    const from = eol(edit.from)
    const at = out.indexOf(from)
    if (at === -1) return { ok: false, reason: `anchor not found: ${edit.id} ${edit.name}` }
    // Two matches would make the edit a coin toss, so that fails too.
    if (out.indexOf(from, at + 1) !== -1) return { ok: false, reason: `anchor matched more than once: ${edit.id} ${edit.name}` }
    out = out.slice(0, at) + eol(edit.to.replace(MARKER, marker)) + out.slice(at + from.length)
  }
  return { ok: true, out }
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
// Written beside and renamed over, so a write cut short never leaves a half-written connector, and
// one that fails (a file held open on Windows) leaves nothing beside it either.
function writeWhole(file, text) {
  const tmp = `${file}.kzh-tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Patch the connector of `pkg` under one @deepseek-ai folder. Returns `{ result, reason, file,
 * version }`: `missing` when it is not installed there, `applied` when this patch is in it already,
 * `patched`, `upgraded` (another version of this patch put back from its backup and patched again),
 * or `refused` with the reason; a refused file is left as it was.
 */
export function patchPackage(root, pkg) {
  const dir = join(root, PACKAGES[pkg])
  const file = join(dir, 'lib', 'index.js')
  if (!existsSync(file)) return { result: 'missing', reason: 'it is not installed', file, version: null }
  const version = readJson(join(dir, 'package.json'))?.version ?? null
  const src = readFileSync(file, 'utf8')
  const backup = `${file}.kzh-backup`
  const record = `${file}.kzh-backup.json`
  const mark = MARKED.exec(src)
  if (mark?.[1] === VERSION) return { result: 'applied', reason: null, file, version }
  let unpatched = src
  if (mark) {
    // Patched by another version of this script: start again from the file that one patched, which
    // its backup holds when the backup says it is of this same package version.
    const kept = readJson(record)
    if (!existsSync(backup) || kept?.version !== version) return { result: 'refused', reason: `it carries version ${mark[1]} of this patch, and no backup of ${PACKAGES[pkg]} ${version ?? '(version unknown)'} to start again from`, file, version }
    unpatched = readFileSync(backup, 'utf8')
    if (MARKED.test(unpatched)) return { result: 'refused', reason: `it carries version ${mark[1]} of this patch, and its backup is patched too`, file, version }
  }
  const patched = patchSource(pkg, unpatched, version)
  if (!patched.ok) return { result: 'refused', reason: patched.reason, file, version }
  // The backup is refreshed from the unpatched file each time one is patched, so it always holds the
  // file installed now; a file patched again from its backup leaves the backup as it is.
  if (!mark) {
    copyFileSync(file, backup)
    writeFileSync(record, `${JSON.stringify({ package: `@deepseek-ai/${PACKAGES[pkg]}`, version, at: new Date().toISOString() }, null, 2)}\n`)
  }
  writeWhole(file, patched.out)
  return { result: mark ? 'upgraded' : 'patched', reason: null, file, version }
}

/** The DSH home: $DSH_HOME, else ~/.dsh. */
const dshHomeOf = (env) => env.DSH_HOME?.trim() || join(homedir(), '.dsh')

/** Every @deepseek-ai folder this harness may be running from: the engine's profiles first (web the first of them), then the npx cache. */
export function roots(env = process.env) {
  const out = []
  const profiles = join(dshHomeOf(env), 'profiles')
  if (existsSync(profiles)) for (const d of readdirSync(profiles).sort((a, b) => (a === 'web' ? -1 : b === 'web' ? 1 : a.localeCompare(b)))) out.push(join(profiles, d, 'node_modules', '@deepseek-ai'))
  const cache = env.npm_config_cache
    || (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache') : join(homedir(), '.npm'))
  const npx = join(cache, '_npx')
  if (existsSync(npx)) for (const d of readdirSync(npx)) out.push(join(npx, d, 'node_modules', '@deepseek-ai'))
  return out.filter(existsSync)
}

/**
 * Patch both connectors in every folder they are installed in, record what came of each in
 * $DSH_HOME/kzh-engine-patches.json, and return the lines to print. A package's entry is the web
 * profile's copy, the one the harness runs and the Live tab reads, else the first copy refused, else
 * the first one found; a copy refused beside the entry is said on a line of its own. Each package is
 * patched or refused on its own, so one that cannot be leaves the other working.
 */
export function patchAll(env = process.env) {
  const status = { writtenFor: WRITTEN_FOR, at: new Date().toISOString() }
  const lines = []
  const added = []
  const where = roots(env)
  const web = join(dshHomeOf(env), 'profiles', 'web', 'node_modules', '@deepseek-ai')
  // A copy that cannot even be read is refused with the reason, as one the patch does not fit is.
  const tryPatch = (root, pkg) => { try { return patchPackage(root, pkg) } catch (err) { return { result: 'refused', reason: `it could not be patched (${err.message})`, file: join(root, PACKAGES[pkg], 'lib', 'index.js'), version: null } } }
  for (const pkg of Object.keys(PACKAGES)) {
    const found = where.map((root) => tryPatch(root, pkg)).filter((r) => r.result !== 'missing')
    const runs = found.find((r) => r.file === join(web, PACKAGES[pkg], 'lib', 'index.js'))
    const entry = runs ?? found.find((r) => r.result === 'refused') ?? found[0] ?? { result: 'missing', reason: `it is not installed (looked in ${join(dshHomeOf(env), 'profiles')})`, file: null, version: null }
    status[pkg] = entry
    if (found.some((r) => r.result === 'patched' || r.result === 'upgraded')) added.push(NAMES[pkg])
    if (entry.reason) lines.push(`patch-agent-live: NOT APPLIED to ${NAMES[pkg]}: ${entry.reason}. Its runs work as before; the Live tab says live detail is off.`)
    // Another profile's copy, or one an older engine left in the npx cache, is none the Live tab reads.
    for (const r of found) if (r !== entry && r.result === 'refused') lines.push(`patch-agent-live: NOT APPLIED to ${NAMES[pkg]} at ${r.file}: ${r.reason}. That copy works as before; the Live tab reads the web profile's.`)
  }
  const file = join(dshHomeOf(env), 'kzh-engine-patches.json')
  // Without it the Live tab cannot say why live detail is off, though what was patched still works.
  try { writeWhole(file, `${JSON.stringify(status, null, 2)}\n`) } catch (err) { lines.push(`patch-agent-live: could not save ${file} (${err.code ?? err.message}), so the Live tab cannot say why live detail is off.`) }
  if (added.length) lines.unshift(`patch-agent-live: live view and steering hooks added to ${added.join(' and ')}`)
  return { status, lines }
}

if (runAsScript(import.meta.url)) {
  try {
    for (const line of patchAll().lines) console.log(line)
  } catch (err) {
    console.log(`patch-agent-live: NOT APPLIED: ${err?.message ?? err}. Claude Code and Codex runs work as before; the Live tab says live detail is off.`)
  }
  process.exit(0)
}
