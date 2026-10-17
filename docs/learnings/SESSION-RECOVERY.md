# Sessions, identity and disconnection recovery

## Separate connection ownership from agent tooling

Repeatedly tying login to a short-lived helper made ordinary agent operations costly and fragile. The terminal process now owns one authenticated Showdown connection. MCP helpers control that same session through a Windows named pipe or Unix domain socket, with an exclusive session descriptor and local capability.

Closing or restarting an MCP helper does not inherently close the battle client. The client stays open between BO3s within the authorized batch. Batch-end shutdown is deliberate: preserve replays, metrics and useful evidence, finish the review and skill checkpoint, inspect retention, then stop and verify closure unless the user requested otherwise.

The local bridge also avoids opening a TCP listener and depending on local proxy or firewall routing. A leftover descriptor after a crash must be reconciled against the recorded process; blindly deleting it could create competing sessions.

Implementation: [terminal session](../../showdown/session.mjs), [local bridge](../../showdown/local-bridge.mjs), [bridge fixtures](../../showdown/local-bridge.test.mjs).

## A renamed room is not a disconnected battle

Showdown can change a room's privacy suffix while the battle remains live. Earlier control could lose the room identity and appear stuck, including when the new private ID arrived before its explicit rename notice.

The client handles trusted rename messages and exact one-to-one replacements in authoritative search state. It migrates ownership, parent/child links, history, sheets, sent-action reservations and pending readiness, forfeiture and replay state. Stale action tokens and grants are invalidated rather than reused under the new ID.

The numeric battle identity and format must still agree. Unrelated or ambiguous room mappings are refused. This restores control after an identity change without requiring a disconnect; it is not a general permission to adopt another room on the account.

Implementation and fixtures: [room migration](../../showdown/client.mjs), [session ownership](../../showdown/agent-session.mjs), [client tests](../../showdown/client.test.mjs), [session tests](../../showdown/agent-session.test.mjs).

## Reconcile real connection loss before doing more

A genuine socket close clears authentication and live grants and stops the agent session. There is no hidden reconnect loop or outbound action replay. A newly explicitly started session needs fresh challenge-bound authentication and fresh observed state; saved credentials make that login easier but do not make the old connection valid again.

Process restart loses in-memory send deduplication. Before any further action, inspect the known rooms, current requests, already-submitted choice evidence, official results and remaining authorized allowance. A pending local command is not proof that the server needs it again. Never reset the user's overall battle allowance merely because the process is new.

The earlier generic login failure and Windows runtime assertion did not prove one verified original cause. We improved diagnosis with redacted stage-specific errors, bounded network/helper waits, cancellation on changed connection context, and restoration of terminal input mode and listeners. These measures improve recovery and diagnosis; they do not eliminate network failures.

Operational reference: [failure and reconnect behavior](../../showdown/README.md#failure-and-reconnect-behavior).

## Keep credentials outside the agent's context

The optional Windows saved-login broker uses a Generic Credential for the approved account. Its helper reads that credential and performs the fixed login exchange; the model and MCP do not receive the password. Each new login still needs a fresh server challenge and identity confirmation.

The hidden terminal prompt remains an alternative. Credentials should not travel through chat, assistant stdin, arguments, logs or committed files. Saved login is platform-specific, and its availability grants no extra searches, roster changes or background reconnection.

Implementation and fixtures: [Windows broker](../../showdown/windows-credential-login.mjs), [broker tests](../../showdown/windows-credential-login.test.mjs), [terminal login](../../showdown/tty-login.mjs), [terminal login tests](../../showdown/tty-login.test.mjs).

## Preserve useful evidence without inventing lost state

Departing-player lifecycle messages can contain empty names. Those must not erase an already observed identity. Rejoined history must also be deduplicated rather than counted as another move or game.

Some sets end during preview, and a disconnect can remove the original private preview request. Recovery now requires corroborating owned state and the saved replay. Historical captures carry explicit operator attestation and retained integrity evidence. Neither route fabricates selected reserves, accepted choices or a missing action history. Repairing a report does not restore live control.

Keep compact canonical evidence, available private decision observations and verified replay links before removing redundant logs. A public replay alone cannot recover private selections or intent. Source updates also do not hot-load an existing client: inspect its advertised capabilities and adopt new behavior at the appropriate authorized startup.

Implementation: [player and protocol parsing](../../metrics/parser.mjs), [preview recovery](../../metrics/preview-terminal.mjs), [historical capture verification](../../metrics/historical-status.mjs), [retention](../../metrics/retention.mjs). Continue with [agent evidence and reflection](AGENT-CONTEXT-AND-REFLECTION.md) or return to the [learning index](README.md).
