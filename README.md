# OEIS Audio Sequencer

An in-browser DAW that turns integer sequences from the [OEIS](https://oeis.org) into sound. Fetch a sequence by ID, choose a mapping mode, and play. Stack multiple sequences for polyrhythmic textures. Allows you to export the final product to WAV.

## Quick Start

Theres a live version available here:[audioeis.live](https://audioeis.live)

The live version is a direct mirror of this repo, so any changes pushed here should propagate up to production.

For playing around locally, its as simple as:

```
python3 proxy.py
# then open http://localhost:8080
```

`proxy.py` serves the static files **and** proxies OEIS requests, so you don't need the Cloudflare Worker running locally. Do not use `python -m http.server`  as it won't handle the `/api/oeis` calls and you'll get 404s on Fetch.

## Mapping Modes
To handle the mapping between integers and frequencies, there are a variety of approaches supported by the app.

### MIDI
Each term `n` maps to MIDI note `|n| mod 128`, converted to frequency via equal temperament. Covers the full piano range; sequences starting near zero produce low notes.

### Diatonic
Maps term `n` to a scale degree within a chosen key and scale. The degree is `n mod scale_length` (so it handles negatives correctly), and the octave rises as `n` grows. Keeps output within a recognisable key, and a lot more "melodic" sounding.

Available scales: major, minor, dorian, phrygian, lydian, mixolydian, locrian, pentatonic.

### Microtonal
Uses the ratio of consecutive terms `a[n+1] / a[n]` as a frequency multiplier against the root. Produces genuinely microtonal intervals derived from the sequence's own structure. Very large or very small ratios are log-compressed to stay audible. Zero terms are treated as 1 to avoid division by zero. Probably the most interesting from a mathematical structure perspective.

## Interesting Sequences

Some ideas to get started. Feel free to submit a PR with additional interesting sequences!

| ID | Name | Notes |
|---|---|---|
| A000045 | Fibonacci | Ratios converge to golden ratio, so the diatonic mode sounds calm in short bursts. Microtonal is sorta funny if you realize how Fibonacci works |
| A000040 | Primes | Irregular gaps in the primes give the MIDI mode bizzare jagged leaps |
| A005132 | Recaman | All the negative terms get strange, try microtonal mode |
| A000108 | Catalan numbers | Fast growth, use microtonal for compressed glissando effect |
| A001006 | Motzkin | Moderate growth and meanders pleasantly in diatonic minor |
| A000110 | Bell numbers | Explosive growth! Microtonal or MIDI both interesting (but mostly unlistenable) |

## Export

Set the **Bars** count in the transport bar, then click **Export WAV**. The export renders the full duration at 44.1 kHz stereo. For long exports (64 bars at slow BPM) rendering may take a few seconds. The WAV file generation is done entirely in client-side JavaScript, so there's no library dependencies!

## Reference
[Theres a companion blog I wrote]() if you are interested in learning a bit more. A bit of a shameless plug. Enjoy!
