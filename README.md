# Saturn Devouring

Saturn Devouring is a browser-native systemic survival game aboard the UNSC
frigate of the same name. The ship simulation continues with or without the player: marines
sweep, civilians panic, radios fail, and the Flood changes tactics as bodies
and safe routes disappear.

The main experience is a peerd-compatible hub with solo play, authenticated
WebRTC co-op, invite-only fireteams, Quick Match, live fireteam voice, an About
page, and developer documentation. The same hub runs as an ordinary website;
that build carries the required peerd identity, room, gossip, presence, direct
message, and WebRTC primitives itself.

## Run locally

```sh
npm install
npm run serve
# open http://localhost:8000/
```

Localhost is a secure browser context, so microphone capture works there.
Production web hosting must use HTTPS for WebCrypto, WebRTC, and microphone
access.

The public game is at [saturn-devouring.arieldeschapell.workers.dev/game/](https://saturn-devouring.arieldeschapell.workers.dev/game/).
The former `charon.arieldeschapell.workers.dev` address redirects page visits
while continuing to serve assets and TURN requests for already-open tabs.

| Route | Surface |
|---|---|
| `/` or `/game/` | Saturn Devouring hub, solo game, co-op lobby, About, and docs |
| `/sim/` | Top-down deterministic simulation harness |
| `/vat/` | WebGPU crowd-rendering harness |
| `/fused/` | Live simulation feeding the VAT renderer |

## Multiplayer

Saturn Devouring has two adapters over one application protocol:

Multiplayer room identifiers retain their historical `charon:` namespace so
players on either link and existing peerd packages remain compatible.

- In peerd, the dwapp calls the consent-gated parent bridge. Identity,
  authenticated room membership, gossip, presence, and direct messages stay on
  peerd's always-on base WebRTC mesh. The current bridge does not expose voice
  or raw capacity statistics; Saturn Devouring capability-detects both and hides voice
  when unavailable. The opaque app frame receives no raw network primitive.
- On the web, `multiplayer/peerd-browser.js` is a generated browser bundle of
  those same peerd primitives. It establishes authenticated `did:key` WebRTC
  links through peerd's cold-start rendezvous and then communicates peer to
  peer.

Quick Match discovers the fullest open public lobby and creates one only when
none answers. A nonce-bound admission is not startable until the requester
acknowledges exact commit delivery; its retained timeout cancel can rollback
only that unacknowledged token. Finalized requesters reprove that token after
owner failover, so an old cancel cannot delete them from a successor's roster.
Once a second player joins, the lobby creator
may deploy or wait for up to four. A proposal/ack/commit barrier freezes membership, then the
fireteam leaves the lobby for its own match room. Private rooms use high-entropy, unlisted invite
codes: the room address is a one-way derivation of the code and every lobby
message must carry a DID-bound HMAC proof. Payload identities must match their
authenticated envelopes.

Every fireteam keeps its full peer mesh. Where the adapter supports it, peers
advertise a coarse capacity score derived from outgoing bandwidth/RTT and local
CPU/memory hints; otherwise deterministic DID order chooses the authority. The
best candidate advances the 15 Hz ship simulation. Inputs fan out directly to the
mesh, while the authority sends ordered delta checkpoints at 5 Hz and periodic
full checkpoints. If it disconnects, the next ranked, already-connected peer
continues from its retained checkpoint. The standalone web adapter's voice uses browser-native WebRTC RTP
with Opus, acoustic echo cancellation, noise suppression, automatic gain, and
the browser jitter buffer; only bounded SDP/ICE signaling uses direct messages.

See [docs/NETWORKING.md](docs/NETWORKING.md) for the protocol and threat model.

### Direct connections and optional TURN fallback

Game data and voice start with direct WebRTC (host, IPv6 and public STUN).
TURN credentials are requested only when a connection fails or has not connected
within five seconds. A single ICE restart then adds TURN while retaining direct
candidates; successful direct connections never request TURN credentials.

Set the optional Cloudflare Worker secrets `TURN_KEY_ID` and `TURN_KEY_TOKEN`
to enable relay fallback. The master key stays on the Worker; browsers receive
short-lived credentials. Without the secrets, direct connections still work,
but peers behind incompatible NATs or restrictive firewalls may not connect.

## peerd hub package

```sh
npm run vendor:peerd   # refresh the standalone web primitive bundle
npm run build:dwapp    # produce dist/dwapp/{hub,sim,fused}
```

`dist/dwapp/hub/` is a complete schema-1 dwapp:

```text
index.html       hub and game document
launcher.css     hub stylesheet
bundle.js        readable, self-contained JavaScript module graph
assets/          byte-identical textures and audio exposed by peerd.assets
peerd.json       dweb capability and attached game-developer actor contract
```

Import the deterministic `dwapp/saturn-devouring.peerd` artifact into peerd, or use
the folder while developing locally. The hub is larger
than peerd's interactive authoring ceiling because it carries the game's source,
textures, and audio, but remains within the import/publish package cap. Binary
assets remain separate from readable code and resolve through `peerd.assets` in
the opaque-origin runner. Opening the dwapp also
binds its app-scoped game-developer actor. The manifest grants only bounded
observe/action playtesting primitives through a code-first `app_code` surface,
so one short script can act, wait, and inspect the result without granting raw
DOM, network, microphone, or extension access.

The checked-in `dwapp/hub/` folder and `dwapp/saturn-devouring.peerd` are generated
from the same bytes; `npm run check:dwapp` rejects stale release output.
See [docs/PEERD-HUB.md](docs/PEERD-HUB.md) for the contract and bridge surface.

## Verify

```sh
npm run check
npm run build:dwapp
```

`npm run check` covers multiplayer protocol invariants, deterministic replay,
the fixed-step physics layer, ragdoll stability, and the simulation command
queue. Changes to the peerd bridge are checked in the sibling peerd repository:

```sh
cd ../peerd
bun test ./tests/peerd-distributed/bridge.test.ts
bun run typecheck
```

## Architecture

```text
game/          hub launcher, first-person game, 3D world, HUD, audio
multiplayer/   peerd/web sessions, lobby protocol, game sync, room voice
sim/           deterministic 15 Hz ship simulation and command queue
shared/        simulation/render boundary, seeded RNG, parameters
engine/        renderer, physics, effects, bundled browser dependencies
scripts/       peerd primitive vendoring and dwapp packaging
docs/          network and package integration reference
```

The simulation writes a packed `AgentBuffer`; renderers consume it without
owning ship state. Seeded randomness and tick-stamped commands keep replay
behavior inspectable and reproducible.

## Controls

- `WASD` move, mouse look, click fire
- `E` is the single action key: it picks up or uses ammunition, health, armor,
  and weapons, uses ladders or stairs, and reloads when no interaction is nearby
- `F` melees
- `M` tactical map, `G` throw a frag, `T` give a magazine to a fireteam member
- `1` follow, `2` hold, `3` advance

Standard Xbox/XInput controllers use Halo 3's core layout: left stick move,
right stick look, `A` jump, `RT` fire, `LT` frag, `RB` action/reload, `B`
melee, and `Y` swap weapons. The contextual `RB` action handles every pickup
(ammunition, health, armor, and weapons) plus ladders; it reloads only when no
contextual action is available. `L3` sprints, `View` opens the tactical map,
and the D-pad issues fireteam orders. Supported controllers pulse lightly when
the player takes damage. The launcher, lobby, briefing, tactical map, end
screens, and contextual prompts are controller-aware.

The launcher and developer docs are keyboard and controller navigable. Voice
can be muted in the lobby or from the in-game network HUD.

## License and Halo notice

Original project code and technical documentation are licensed under the
[MIT License](LICENSE), subject to the scope in
[Third-party notices](THIRD_PARTY_NOTICES.md). Halo content, game assets, and
third-party dependencies are excluded from that grant. The assembled fan game
is not licensed as an unrestricted commercial MIT game.

Halo: Combat Evolved, Halo 2, and Halo 3 © Microsoft Corporation.
Saturn Devouring was created under Microsoft's
[Game Content Usage Rules](https://www.xbox.com/en-us/developers/rules)
using assets from Halo: Combat Evolved, Halo 2, and Halo 3, and it is not
endorsed by or affiliated with Microsoft.

Asset provenance and redistribution permissions still need verification;
see the [asset-rights review](docs/ASSET-RIGHTS.md). This notice is not a claim
of Microsoft approval or a substitute for asset permissions.
