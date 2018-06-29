This is a JavaScript library to "bake" [`ars-tracker`](https://github.com/AdmiralPotato/ars-tracker) songs into rendered samples, suitable for use as music or sound effects in the Web Audio APIs.

Example usage:

```js
// uncomment if your package management system is anything fancier than
//     <script src="et209.js"></script><script src="baker.js"></script>
//let bakeArsTrackerSong = require("ars-tracker-baker");
let baked = bakeArsTrackerSong(my_module, 0, {"headphones":headphones});
let buffer = audioContext.createBuffer(2, baked.sampleCount, baked.sampleRate);
if(buffer.copyToChannel) {
  buffer.copyToChannel(baked.left, 0);
  buffer.copyToChannel(baked.right, 1);
}
else {
  let leftData = baked.getChannelData(0);
  let rightData = baked.getChannelData(1);
  for(var n = 0; n < baked.sampleCount; ++n) {
    leftData[n] = baked.left[n];
    rightData[n] = baked.right[n];
  }
}
// buffer can now be used with one or more `AudioBufferSourceNode`s
```

The first parameter to `bakeArsTrackerSong` is the `ars-tracker` module itself, after having gone through `JSON.parse` or otherwise been turned into an object.

The second parameter is the index of the song within the module: 0 for the first song, 1 for the second, and so forth.

The third parameter is an optional object containing options.

Options:

- `loop` (boolean, default true): Whether to try to loop the song.
- `loopOverlapTime` (seconds, default 2): If looping, the amount of extra time to add to make sure the loop is clean.
- `loopFadeTime` (seconds, default 5): If looping, the amount of extra time to add to the end, so it can fade out nicely if you don't use the looping information.
- `startOrder` (index, default 0): The order index to start at. When in doubt, leave unset.
- `headphones` (boolean, default false): Whether to enable the "headphones filter".

`bakeArsTrackerSong` returns an object with the following keys:

- `sampleRate`: For convenience, this is `ET209.SAMPLE_RATE`.
- `loopLeft`: The sample number of the *beginning* of the loop.
- `loopRight`: The sample number of the *end* of the loop.
- `sampleCount`: The number of samples that were rendered.
- `left`: A `Float32Array` containing `sampleCount` samples for the *left stereo channel*.
- `right`: A `Float32Array` containing `sampleCount` samples for the *right stereo channel*.

Unsupported things:

- Actual Waveform sequences. We only use the first element of the Waveform sequence. (`tracklib` does the same thing.)
- Pitchbend / arpeggio / slides on the noise channel. (`tracklib` doesn't support these either.)
- Proper `Pxx` (pan) effect handling unless a note on happens at the same time.
- `Vxx` (waveform) effect if a note on happens at the same time.
