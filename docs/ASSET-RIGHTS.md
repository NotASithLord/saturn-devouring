# Asset-rights review before wider distribution

Reviewed 2026-09-29. This records evidence and open questions, not legal clearance.
MIT for original code and a Halo disclaimer do not resolve the following items.

| Material | Repository evidence | Required follow-up |
| --- | --- | --- |
| CE rifle mesh/textures | game/assets/rifle/NOTICE.txt says carried from first-strike | Establish original acquisition method and permission for standalone redistribution. |
| H2/H3 characters | scripts/convert-h3-assets.mjs converts Blackandfan/H3EK-Tags source art | Confirm the source art's governing terms and whether use outside MCC is permitted. Availability in a modding repository is not permission. |
| Flood carrier | Sketchfab upload attributed to jameslucino117, reported CC BY 4.0 | Verify the license and uploader's authority over the included material; retain attribution and modification notice. |
| WAV recordings | game/audio.js calls them supplied Halo recordings | Record source game, origin, rightsholder, and permission per file, including unused WAVs still shipped. |
| Vendored code | Three.js, Rapier, THREE.Fire, peerd browser bundle | Complete a dependency notice audit and retain full applicable license texts in distributions. |

Microsoft's [Game Content Usage Rules](https://www.xbox.com/en-us/developers/rules)
limit asset extraction and distinguish audio permissions. The
[MCC EULA](https://store.steampowered.com/eula/976730_eula_0) also addresses
redistribution of game material and mods. Do not assume the general fan-content
rules override the terms applicable to an editing kit or a particular asset.
Seek specific permission where needed, or replace material with independently
created assets with documented rights. Even original Halo-inspired assets may
still depend on permission for Microsoft's underlying IP.

The repository's old rifle notice asserted that assets were sourced under the
rules. That assertion alone is not a permission record. Keep the required fan
notice visible, but do not describe this review as Microsoft approval.

## Distribution and promotion

Keep the assembled fan game free and without in-game advertising. Optional
unconditional donations are addressed separately in Microsoft's rules; a paid
build, paid access, or paid gameplay benefit is not the same thing. Do not use
Halo material to advertise a commercial peerd product without permission, or
place the fan game on a page selling other products/services. Technical peerd
compatibility is distinct from a commercial endorsement campaign.

Retain the project title rather than presenting it as an official Halo release.
Do not use official Halo logos as the project's own branding. Include the
Microsoft notice and rules link wherever the game is distributed, and carry
third-party credits into generated packages.

Before merging the MIT grant, confirm that the maintainer can license all
original contributions under MIT. Git history contains more than one author
identity; commit authorship alone does not establish copyright ownership.
