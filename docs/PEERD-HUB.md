# peerd hub integration

The Saturn Devouring hub package is emitted at `dist/dwapp/hub/` and mirrored to
`dwapp/hub/` for direct import.

## Manifest

`peerd.json` declares a schema-1 `dwapp`, `index.html` as the entry, the `dweb`
capability, and a bound "Saturn Devouring game developer" actor. The actor contract adds
game-specific system context and selects the developer profile's code surface.
Its `app_code` entry point exposes bounded `app.observe()`, `app.act()`, and
`app.wait()` calls, allowing a short script to compose a playtest step. File
inspection/editing remain separate code-writing tools. Opening the app binds the actor to that exact tab.
Runtime calls are relayed only to handlers the packaged game explicitly exposes
and return bounded JSON.
The dweb capability allows the runner to attach the narrow parent bridge; none
of these contracts expose raw extension APIs to the app.

## Runner constraints

peerd composes app files into an opaque-origin sandbox. Raw networking,
top-level navigation, and extension access are unavailable. Saturn Devouring's build
therefore:

- flattens every JavaScript module into one ESM bundle;
- keeps the hub bundle readable because it is the actor's runnable source;
- copies texture and audio files byte-for-byte as binary App assets;
- routes Three/DOM media through `peerd.assets.url()` and WebAudio through
  `peerd.assets.bytes()`, retaining ordinary relative-URL fallbacks on the web;
- leaves no relative dynamic import in the final bundle;
- ships the hub stylesheet as an app file for peerd to inline;
- delegates all distributed operations and microphone access to the trusted
  parent bridge.

The imported bundle is larger than peerd's model-created-file ceiling. peerd's
App actor can search it by exact query/offset and apply a bounded anchored patch
without re-emitting the file. That makes the play/edit/reload loop operate on
the code that actually runs, while new files retain the smaller authoring cap.

## Bridge operations

Saturn Devouring uses the current core bridge operations:

```text
hello
join / leave
presence / announce
subscribe / publish
retain / history
dm-send
```

The current Peerd bridge v0 exposes the core operations through `dm-send`; it
does not expose `capacity` or any `voice-*` operation. Saturn Devouring reads an explicit
`hello.operations` list before using optional calls. With bridge v0 it assigns a
neutral capacity score (so authority falls back to deterministic DID order) and
hides the voice control. Future bridges can advertise `capacity` and the complete
voice operation set to enable those paths without changing Saturn Devouring's adapter API.
Room grants are scoped to the app's content identity and exact room id. Multiple
explicit Quick Match lobbies can share one physical public discovery room
without sharing game state.

Each frame instance uses a random client epoch and random request ids. Consent-
gated room joins have no artificial short timeout; leaving or replacing the
join sends request cancellation plus whole-client disposal, and late responses
from another epoch are ignored. Agent join actions return the tracked pending
operation immediately so `app_code` can wait and observe without holding one
tool call open across user consent. Agent match-start actions use the same
fire-and-observe operation model, so the proposal/receipt barrier never holds an
`app.act()` call open past the runner deadline.

## Standalone browser adapter

`npm run vendor:peerd` bundles only peerd's browser-facing identity, room,
gossip/topic-sync, presence, direct-message, and WebRTC dependencies into
`multiplayer/peerd-browser.js`. The source is the sibling peerd checkout by
default; set `PEERD_SOURCE` to another compatible checkout when testing a peerd
change.

Voice signaling/media behavior is maintained as Saturn Devouring source in
`multiplayer/voice.js`; it is not imported from a stale Peerd bundle. The vendor
step executes the generated browser module after bundling and asserts every
required primitive, catching codec wrapper failures at build time.

The dwapp build contains the adapter as an unreachable fallback, but peerd's
runner denies raw WebRTC. A successful bridge handshake always selects the
trusted `BridgeSession` path.

## Build checks

`npm run build:dwapp` prints package size against peerd's live loader caps,
asserts both asset bridge paths, and emits the deterministic import envelope
`dwapp/saturn-devouring.peerd`. The checked-in hub currently has four top-level files
and 54 binary/text asset files (58 total), with no image/audio data URI baked
into `bundle.js`. `npm run check:dwapp` rebuilds in a temporary directory and
requires byte-for-byte parity with both the hub folder and envelope. A Peerd
compatibility probe opens the envelope through Peerd's real importer.

Run that cross-repository probe with
`PEERD_SOURCE=/path/to/peerd npm run check:peerd-compat`.
