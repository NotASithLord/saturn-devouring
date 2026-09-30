# Opening infection dispersion: seven-minute seed study

The opening rule is now tied to the crash site. At most sites, one initial
infection form stays per body in the crash room and the spare forms receive
vent destinations before their first actuator tick. The destinations start
with Medbay and fan across other quiet rooms. At the Port Capacitor Bank,
local feeding gets the first window; the strategic hive may send survivors
through the vents afterward. The site exception avoids starving an opening
that repeatedly performed poorly with immediate dispersion.

## Method

Each policy ran for **seven simulated minutes at 15 Hz** on the same seeded
ship layouts and crews. The exploratory set was `dispersion-01` through
`dispersion-12`; the untouched holdout was `holdout-01` through `holdout-12`.
We also tested six additional `capPort` and six `cargo2` seeds selected by
breach ID from `site-validation-001` onward. The study uses the headless solo
simulation with no player input. Crew casualties, active Flood forms, and
occupied rooms are useful pressure proxies, not a measure of player enjoyment
or a guarantee that players will encounter those forms.

`node sim/opening-dispersion-study.mjs --final holdout-01 holdout-02 ...`
repeats a paired comparison and emits full minute-by-minute JSON on stdout.
The `--holdout` mode compares fixed fractions and the rejected deck rule;
`--control` compares immediate and delayed vent dispatch.

## Results

In the exploratory set, the current body-matched count outperformed sending
most or all forms immediately through the vents. Keeping everything local
looked strongest on those 12 seeds, but did not replicate on the holdout.

| Opening policy | Mean casualties at 2m | Mean casualties at 7m | Mean active Flood at 7m |
| --- | ---: | ---: | ---: |
| Body-matched | 26.3 | 142.4 | 52.1 |
| All local | 26.8 | 154.3 | 62.3 |
| 25% to vents | 21.8 | 135.0 | 57.2 |
| 50% to vents | 18.1 | 129.2 | 62.7 |
| 75% to vents | 13.3 | 135.0 | 63.7 |
| All to vents | 13.8 | 95.3 | 45.3 |

On the separate 12-seed holdout, all-local produced only 79.1 mean casualties
and 29.3 active Flood at seven minutes. A deck-only rule produced 88.1 and
33.9. Both were worse than the body-matched split (121.9 and 53.1), so neither
became the default.

The shipped behavior let the corpse reflex run before the vent assignment.
The final site-aware rule improves the holdout average while preserving a
short local-first window at the Port Capacitor Bank:

| Holdout result, 12 paired seeds | Shipped timing | Site-aware timing |
| --- | ---: | ---: |
| Mean crew casualties at 2m / 4m / 7m | 21.0 / 42.9 / 109.9 | 22.1 / 55.2 / 124.4 |
| Mean active Flood at 7m | 49.3 | 54.9 |
| Mean rooms occupied by active Flood at 7m | 11.7 | 12.9 |
| Mean time to five casualties | 38.6s | 34.4s |
| Seeds with fewer than 50 casualties at 7m | 2 | 1 |
| Seeds with fewer than 20 active Flood at 7m | 1 | 2 |

The last row is a limitation: the new rule has a slightly worse low-mass tail
in this small holdout, despite stronger average pressure. Cargo Hold 2 was
mixed under both timings, so there is no hardcoded exception there. At the
Port Capacitor Bank, **all six** extra seeds favored delayed departure; mean
seven-minute casualties were 84.5 with local-first timing versus 26.3 with
immediate departure, and mean active Flood were 29.2 versus 11.2. That is the
only spawn-site exception included.

Counting only unburned crash-site bodies was tested separately. It sent more
forms to the vents, but reduced holdout mean seven-minute casualties from
124.4 to 110.8 and collapsed one previously strong seed (139 to 12). The
default continues to count all bodies in the breach room when deciding how
many forms stay local.
