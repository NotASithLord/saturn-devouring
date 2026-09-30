# Multiplayer protocol

Saturn Devouring protocol version 20 presents the same core room API inside peerd and on
the standalone web page. peerd keeps identity and WebRTC handles in the trusted
parent; the website bundles the corresponding peerd primitives. Optional
capacity and voice surfaces are capability-detected rather than assumed.

## Lobby and deployment

1. Join the live `charon:quickplay:v20` public discovery room or a private room whose
   address is SHA-256-derived from an invite code. Mesh presence removes stale
   peers; a stable discovery room avoids stranding players on opposite time epochs.
   Private lobby messages require a DID-bound HMAC proof, so an overlay peer
   that learns the derived room address cannot impersonate an invite holder.
2. Quick Match asks for open logical lobbies, joins the fullest one with room,
   or creates and advertises a public lobby when none answers. Private hosts
   advertise only inside the invite-derived room. Admission is a nonce-bound
   provisional accept: the requester and every current member confirm the same
   proposed roster before the owner commits it. The committed admission remains
   provisional until the requester acknowledges that exact nonce/proposal. A
   retained timeout cancel can then revision-remove only that unacknowledged
   admission; reordered acknowledgements, duplicates, and cancels from an older
   rejoin token are harmless. Every survivor applies the retained finalization.
   If the owner dies while a survivor missed it, the requester reproves the
   exact finalized token in the new term; the successor holds old-term cancels
   during a bounded resolution window and rolls back only when no proof arrives.
   Expired, stale, reordered, or unsolicited packets cannot create a logical member. Simultaneous public
   singletons periodically converge on the lower random lobby id.
3. The owner accepts up to four members. Every roster carries a monotonically
   revisioned term. On owner departure, eligible committed members exchange
   membership observations, elect the lowest live DID, and publish a recoverable
   takeover in the next term. At two or more, that lobby owner may
   start immediately or keep waiting; Quick Match never auto-starts.
4. Publish `ready` with a bounded authority-capacity sample when the adapter
   exposes one. The standalone adapter combines available outgoing bitrate/RTT
   with coarse CPU/memory and Network Information fallbacks. A Peerd bridge
   without the optional operation publishes a neutral score, making DID order
   the deterministic tie-breaker.
5. The owner ranks simulation-authority candidates by capacity score, then DID,
   and freezes that complete order in the revisioned proposal. Lobby ownership
   remains with the creator; followers validate the frozen permutation instead
   of recomputing it from asynchronously delivered capacity samples.
6. The lobby owner proposes an exact roster, isolated random match room, seed,
   and complete authority failover order.
7. Every member must acknowledge the same term, revision, and attempt. The owner
   retains and retransmits the decision until every member returns an explicit
   commit receipt, then retains and retransmits `go` until every peer returns a
   go receipt. Only then does it retain and retransmit a final `launch`. A peer
   that missed the live decision recovers it from topic history. A departed
   decision owner is replaced, after a grace period, in the frozen member order.
   Failed attempts explicitly abort, advance the lobby revision, and re-advertise.
8. Only after final `launch`, each member leaves the lobby, joins the match room with the same identity,
   removes lobby listeners, and pins voice recipients to the committed roster.

The match room remains a full WebRTC mesh. Electing an authority does not tear
down peer-to-peer connections and does not turn Saturn Devouring into a star network.

## Authority and failover

Only the elected authority advances the 15 Hz ship simulation. This avoids four
independent AI worlds consuming four times the CPU and eventually disagreeing.
Every player owns a distinct deterministic ODST agent and escort squad.

All peers fan out their 10 Hz pose/input stream and bounded actions to the
committed mesh. The authority validates and applies combat actions. It sends 5
Hz delta checkpoints and a full checkpoint every two seconds. Checkpoints carry
entity presentation/lifecycle state; full checkpoints also refresh RNG time,
doors, outcome, armory, and statistics. Direct sends are serialized per peer so
packet sequence cannot overtake signing.

Every guest retains the latest checkpoint. Peers allow the selected authority a
bounded arrival grace; if it never joins, or if an observed authority departs,
all remaining peers permanently choose the first connected DID in the committed
failover order. Each election advances a monotonically increasing term tied to
that frozen order. A late original authority cannot preempt the term, and a
reconnecting older partition adopts the higher canonical term before accepting
more actions or checkpoints. The promoted peer starts ticking its retained
state and immediately emits a full checkpoint.

## Game packets

Every direct packet has `{ v, kind, from, name, seq, ...payload }`. Saturn Devouring
rejects mismatched authenticated/claimed senders, non-members, replayed
sequences, malformed arrays, out-of-world values, and excess action rates.
Continuous values use deterministic 1/1000 fixed-point integers because peerd's
cross-engine signed canonical form intentionally rejects floating-point JSON.

- `state`: player world position, deck, yaw, and health intent.
- `shot`: bounded world-space trace; the host retains it briefly to validate a
  following hit against the target volume.
- `hit`: target id and bounded damage, accepted only by the authority after a
  recent geometrically compatible shot.
- `explosion`: bounded deck/position/radius/damage, accepted only near the
  sender and at a capped rate.
- `snapshot`: host-only delta or full checkpoint.

Gossip is limited to low-rate lobby consensus. Gameplay and media signaling use
direct authenticated WebRTC messages and therefore do not consume peerd's
gossip token bucket or flood unrelated base-mesh peers. Voice itself is RTP
media and does not travel through application data channels.

## Voice

Voice begins only after an explicit user gesture. The current Peerd bridge v0
does not expose its optional voice operations, so the Saturn Devouring dwapp hides that
control. A future bridge must advertise the complete voice operation set before
Saturn Devouring enables it. A sandboxed dwapp never receives a MediaStream, AudioContext,
device label, raw RTCStats, or networking handle.

The standalone browser adapter uses dedicated audio-only `RTCPeerConnection`
media sessions. It negotiates Opus, caps speech bitrate, and owns RTP packetization,
jitter buffering, acoustic echo cancellation, noise suppression, and automatic
gain control. A deterministic offerer prevents glare. Authenticated direct
messages carry only bounded, versioned ready/SDP/ICE/hangup signaling with
session correlation, rate limits, and allocation caps. Capture cancellation
stops a stream even when permission resolves after the user leaves. Reserved
media signaling never crosses the trusted bridge into the dwapp.

## Failure and trust boundaries

- Bridge fallback occurs only when the bridge is unavailable, never after a
  user denies peerd consent or a joined bridge fails.
- Leaving closes subscriptions, presence, audio tracks/context, direct
  messaging, gossip, and the room.
- Losing a lobby peer removes it from that explicit lobby and cancels in-flight
  consensus. Losing the lobby owner promotes the lowest remaining DID. Losing the match authority
  promotes the next connected committed candidate.
- Rendezvous is discovery/signaling only; established peer links survive its
  outage.
- Public matchmaking includes strangers. Authentication proves packet origin,
  not benevolence, so all input remains bounded and authority-validated.
- Saturn Devouring sends no microphone audio or simulation state to a gameplay server.
