"use strict";

var bakeArsTrackerSong;

{
    const SAMPLES_PER_FRAME = ET209.SAMPLE_RATE / 60; // do not round!
    const NUM_CHANNELS = 8;
    const NOISE_CHANNEL_INDEX = 7;
    const BASE_FREQ = 440;
    const BASE_NOTE = 57;
    // Converts a MIDI note number (60 = C4) to an ET209 voice rate.
    let noteToFreq = function noteToFreq(note) {
        return Math.floor(BASE_FREQ * Math.pow(2,(note - BASE_NOTE)/12)
                          * 65536 / ET209.SAMPLE_RATE + 0.5) - 1;
    };
    // Decompresses an RLE-compressed pattern.
    let deRLE = function deRLE(pattern) {
        if(pattern === undefined) {
            return [];
        }
        let ret = [];
        for(let n = 0; n < pattern.length; ++n) {
            let cur = JSON.parse(JSON.stringify(pattern[n]));
            let repeatCount;
            if(cur.repeat) {
                repeatCount = cur.repeat;
                cur.repeat = null;
            }
            else {
                repeatCount = 1;
            }
            for(let m = 0; m < repeatCount; ++m) {
                // Since we're not going to edit it, we can reuse the same
                // object over multiple repeated rows.
                ret.push(cur);
            }
        }
        return ret;
    }
    ///////////////////////////////////////////////////////////////////////////
    // `SequenceState`
    ///////////////////////////////////////////////////////////////////////////
    //
    // A particular instance of a `Sequence` in playback.
    //
    ///////////////////////////////////////////////////////////////////////////
    let SequenceState = function SequenceState(seq) {
        this.seq = seq;
        this.nextIndex = 0;
        this.sustain = true;
    };
    // Returns the next value for this sequence. Handles looping, etc.
    SequenceState.prototype.next = function next() {
        let ret = this.seq.values[this.nextIndex];
        ++this.nextIndex;
        if(this.sustain && this.nextIndex >= this.seq.loopRight) {
            this.nextIndex = this.seq.loopLeft;
        }
        if(this.nextIndex >= this.seq.values.length) {
            this.nextIndex = this.seq.values.length - 1;
        }
        return ret;
    };
    // Releases the "piano key". The sequence will stop looping.
    SequenceState.prototype.release = function release() {
        this.sustain = false;
    };
    ///////////////////////////////////////////////////////////////////////////
    // `Sequence`
    ///////////////////////////////////////////////////////////////////////////
    //
    // Encapsulates a sequence from an ars-tracker instrument; volume,
    // arpeggio, pitch, etc.
    //
    ///////////////////////////////////////////////////////////////////////////
    let Sequence = function Sequence(source, def) {
        if(source === null || source === undefined)
            source = def;
        this.loopLeft = null;
        this.loopRight = null;
        let split = source.split(" ");
        this.values = [];
        for(let n = 0; n < split.length; ++n) {
            let element = split[n];
            if(element == "") {
                // do nothing
            }
            else if(element == "|") {
                this.loopLeft = this.values.length;
            }
            else if(element == "/") {
                this.loopRight = this.values.length;
            }
            else {
                this.values.push(parseInt(element));
            }
        }
        if(this.values.length == 0)
            throw "Invalid sequence";
        if(this.loopLeft === null)
            this.loopLeft = this.values.length - 1;
        if(this.loopRight === null)
            this.loopRight = this.values.length;
    };
    // Returns a new `SequenceState` object for this sequence.
    Sequence.prototype.begin = function begin() {
        return new SequenceState(this);
    };
    ///////////////////////////////////////////////////////////////////////////
    // `InstrumentState`
    ///////////////////////////////////////////////////////////////////////////
    //
    // A particular instance of an `Instrument` in playback, playing a
    // particular note.
    //
    ///////////////////////////////////////////////////////////////////////////
    let InstrumentState = function InstrumentState(ins, note) {
        this.ins = ins;
        this.note = note;
        this.volume = ins.volume.begin();
        this.arpeggio = ins.arpeggio.begin();
        this.pitch = ins.pitch.begin();
        this.waveform = ins.waveform.begin();
        this.bentPitch = 0;
        this.fresh = true;
    };
    // Executes one frame of the instrument on a particular voice channel.
    InstrumentState.prototype.frobVoice = function frobVoice(et209, channel, volume, hwslide, pan) {
        let note = this.note + this.arpeggio.next();
        // The playback engine has a flaw where if you bend the pitch far
        // enough in one direction, it eventually wraps around.
        this.bentPitch = (this.bentPitch + this.pitch.next()) & 0xFFFF;
        let freq = (noteToFreq(note) + this.bentPitch) & 0xFFFF;
        if(freq >= 16384) {
            // The bent pitch is either strongly negative or strongly positive.
            // We guess which using the same method the real playback engine
            // does.
            if((this.bentPitch & 0x8000) != 0) {
                freq = 0;
            }
            else {
                freq = 16383;
            }
        }
        let seqVolume = this.volume.next();
        let maskedSeqVolume = seqVolume & 15;
        let overrideReset = (maskedSeqVolume & ET209.VOLUME_RESET_FLAG) != 0;
        seqVolume = (volume * maskedSeqVolume) >> 2;
        if(this.fresh != overrideReset) {
            seqVolume |= ET209.VOLUME_RESET_FLAG;
        }
        et209.write_voice_volume(channel, seqVolume);
        et209.write_voice_rate(channel, freq | hwslide);
        if(this.fresh) {
            let waveform = this.waveform.next() | pan;
            et209.write_voice_waveform(channel, waveform);
        }
        this.fresh = false;
    };
    // Executes one frame of the instrument on the noise channel.
    InstrumentState.prototype.frobNoise = function frobNoise(et209, volume) {
        let note = this.note;
        let seqVolume = this.volume.next();
        let maskedSeqVolume = seqVolume & 15;
        let overrideReset = (maskedSeqVolume & ET209.VOLUME_RESET_FLAG) != 0;
        seqVolume = (volume * maskedSeqVolume) >> 2;
        if(this.fresh != overrideReset) {
            seqVolume |= ET209.VOLUME_RESET_FLAG;
        }
        et209.write_noise_volume(seqVolume);
        et209.write_noise_period(note);
        if(this.fresh) {
            et209.write_noise_waveform(this.waveform.next());
        }
        this.fresh = false;
    };
    // Releases the "piano key". Sequence will stop looping.
    InstrumentState.prototype.release = function release() {
        this.volume.release();
        this.arpeggio.release();
        this.pitch.release();
        this.waveform.release();
    };
    ///////////////////////////////////////////////////////////////////////////
    // `Instrument`
    ///////////////////////////////////////////////////////////////////////////
    //
    // Encapsulates an ars-tracker instrument.
    //
    ///////////////////////////////////////////////////////////////////////////
    let Instrument = function Instrument(source) {
        this.name = source.name;
        this.volume = new Sequence(source.volume, "| 15 / 0");
        this.arpeggio = new Sequence(source.arpeggio, "0");
        this.pitch = new Sequence(source.pitch, "0");
        this.waveform = new Sequence(source.waveform, "0");
    };
    // Returns a new `InstrumentState` object for this instrument. Used every
    // time there is a note on event on a channel.
    Instrument.prototype.begin = function begin(note) {
        return new InstrumentState(this, note);
    };
    ///////////////////////////////////////////////////////////////////////////
    // `PlaybackState`
    ///////////////////////////////////////////////////////////////////////////
    //
    // A fresh instance of the playback engine for a given song.
    //
    // `song` is an index into the `songs` array of an ars-tracker module,
    // `module` is the module itself, and `options` is an optional object
    // containing options.
    //
    // Options:
    // - loop (boolean, default true): Whether to try to loop the song.
    // - loopOverlapTime (seconds, default 2): If looping, the amount of extra
    // time to add to make sure the loop is clean.
    // - loopFadeTime (seconds, default 5): If looping, the amount of extra
    // time to add to the end, so it can fade out nicely if you don't use the
    // looping information.
    // - startOrder (index, default 0): The order index to start at. When in
    // doubt, leave unset.
    // - headphones (boolean, default false): Whether to enable the "headphones
    // filter".
    //
    ///////////////////////////////////////////////////////////////////////////
    let PlaybackState = function PlaybackState(module, song, options) {
        this.et209 = new ET209();
        this.song = song;
        this.module = module;
        this.instruments = [];
        this.options = options;
        this.speed = song.speed === undefined ? 6 : song.speed;
        this.tempo = song.tempo === undefined ? 150 : song.tempo;
        this.outSamplesLeft = [];
        this.outSamplesRight = [];
        this.sampleCount = 0;
        this.curPatterns = [];
        this.orderCookie = 0;
        this.spilloverSamples = 0;
        this.framesUntilNextTick = 1;
        this.ticksUntilNextRow = 1;
        this.channels = [];
        for(var n = 0; n < NOISE_CHANNEL_INDEX; ++n) {
            this.channels[n] = {"slide":0, "pan":0, "volume":15, "instrument":null};
        }
        this.channels[NOISE_CHANNEL_INDEX] = {"volume":15, "instrument":null};
        this.switchOrder(options.startOrder);
    };
    PlaybackState.prototype.switchOrder = function switchOrder(newOrderIndex) {
        ++this.orderCookie;
        this.curOrderIndex = newOrderIndex % this.song.orders.length;
        this.curOrder = this.song.orders[this.curOrderIndex];
        this.nextRowIndex = 0;
        for(let n = 0; n < NUM_CHANNELS; ++n) {
            this.curPatterns[n] = deRLE(this.song.patterns[n][this.curOrder[n]]);
        }
    };
    PlaybackState.prototype.handleFx = function handleFx(channel, channelIndex, fx) {
        if(fx === null || fx === undefined)
            return;
        switch(fx.type) {
        case "waveform":
            if(channelIndex == NOISE_CHANNEL_INDEX)
                et209.set_noise_waveform(fx.value);
            else
                et209.set_voice_waveform(channelIndex, fx.value);
            break;
        case "hwslide":
            if(channelIndex == NOISE_CHANNEL_INDEX)
                throw "hwslide effect is invalid on the noise channel";
            channel.slide = (fx.value&3) << 14;
            break;
        case "branch":
            this.switchOrder(fx.value % this.song.orders.length);
            break;
        case "pan":
            if(channelIndex == NOISE_CHANNEL_INDEX)
                throw "pan effect is invalid on the noise channel";
            channel.pan = 0;
            if((fx.value & 0x0F) != 0) {
                channel.pan |= ET209.WAVEFORM_PAN_RIGHT;
            }
            if((fx.value & 0xF0) != 0) {
                channel.pan |= ET209.WAVEFORM_PAN_LEFT;
            }
            break;
        case "fastness":
            // equivalent to "tempo" or "speed", depending on the value
            // (this effect is a remnant of ye olde days of ProTracker modules)
            if(fx.value >= 64) {
                this.tempo = fx.value;
            }
            else {
                this.speed = fx.value;
            }
            break;
        case "tempo":
            this.tempo = fx.value;
            break;
        case "speed":
            this.speed = fx.value;
            break;
        case "halt":
            // the next time processOneRow gets called, the song will HALT!
            this.halting = true;
            break;
        }
    };
    PlaybackState.prototype.processOneRow = function processOneRow() {
        if(this.halting) {
            this.halted = true;
            // this actually isn't implemented in tracklib yet, but we're
            // assuming this will cut off all notes when it does occur
            return;
        }
        // Set aside these values so we continue processing the same row even
        // if we hit a `Bxx` (branch) effect.
        let curPatterns = this.curPatterns;
        let rowIndex = this.nextRowIndex++;
        for(let channelIndex = 0; channelIndex < NUM_CHANNELS; ++channelIndex) {
            let channel = this.channels[channelIndex];
            let row = curPatterns[channelIndex][rowIndex];
            if(row !== null && row !== undefined) {
                // If this row contains an instrument command, set the
                // instrument
                if(row.instrument !== null && row.instrument !== undefined) {
                    if(this.instruments[row.instrument] === undefined
                       && this.module.instruments[row.instrument] !== undefined) {
                        this.instruments[row.instrument] = new Instrument(this.module.instruments[row.instrument]);
                    }
                    channel.instrument = this.instruments[row.instrument];
                    // possibly undefined
                }
                // If this row contains fx commands, process them
                if(row.fx !== null && row.fx !== undefined) {
                    for(let fxIndex = 0; fxIndex < row.fx.length; ++fxIndex) {
                        let fx = row.fx[fxIndex];
                        this.handleFx(channel, channelIndex, fx);
                    }
                }
                // If this row contains a volume command, set the volume
                if(row.volume !== null && row.volume !== undefined) {
                    channel.volume = row.volume;
                }
                // If this row contains a note command...
                if(row.note !== undefined) {
                    if(row.note === false) {
                        // false -> note OFF
                        if(channel.instrumentState)
                            channel.instrumentState.release();
                    }
                    else if(row.note === null) {
                        // null -> note CUT
                        channel.instrumentState = null;
                        if(channelIndex == NOISE_CHANNEL_INDEX)
                            this.et209.write_noise_volume(0);
                        else
                            this.et209.write_voice_volume(channelIndex, 0);
                    }
                    else if(channel.instrument === null
                            || channel.instrument === undefined) {
                        // if there's no instrument set, ignore note ons
                    }
                    else {
                        // note on!
                        channel.instrumentState = channel.instrument.begin(row.note);
                    }
                }
            }
        }
        if(this.nextRowIndex >= this.song.rows) {
            this.switchOrder(this.curOrderIndex+1);
        }
    };
    PlaybackState.prototype.processOneTick = function processOneTick() {
        --this.ticksUntilNextRow;
        if(this.ticksUntilNextRow <= 0) {
            this.processOneRow();
            this.ticksUntilNextRow = this.speed;
        }
    };
    PlaybackState.prototype.renderFrame = function renderFrame() {
        --this.framesUntilNextTick;
        if(this.framesUntilNextTick <= 0) {
            this.processOneTick();
            this.framesUntilNextTick += 150 / this.tempo;
        }
        if(this.halted)
            return;
        for(let n = 0; n < NUM_CHANNELS; ++n) {
            let channel = this.channels[n];
            if(channel.instrumentState) {
                if(n == NOISE_CHANNEL_INDEX) {
                    channel.instrumentState.frobNoise(this.et209,
                                                      channel.volume);
                }
                else {
                    channel.instrumentState.frobVoice(this.et209, n,
                                                      channel.volume,
                                                      channel.slide,
                                                      channel.pan);
                }
            }
        }
        let samplesToRender = this.spilloverSamples + SAMPLES_PER_FRAME;
        let actualCount = Math.floor(samplesToRender);
        // any extra fraction of a sample spills over to next frame
        this.spilloverSamples = samplesToRender - actualCount;
        let leftBuffer = new Float32Array(actualCount);
        let rightBuffer = new Float32Array(actualCount);
        if(this.options.headphones) {
            this.et209.generate_headphone_arrays(leftBuffer, rightBuffer,
                                                 actualCount);
        }
        else {
            this.et209.generate_stereo_arrays(leftBuffer, rightBuffer,
                                              actualCount);
        }
        this.sampleCount += actualCount;
        this.outSamplesLeft.push(leftBuffer);
        this.outSamplesRight.push(rightBuffer);
    };
    PlaybackState.prototype.renderOrder = function renderOrder() {
        let oldCookie = this.orderCookie;
        do {
            this.renderFrame();
        } while(this.orderCookie == oldCookie);
    };
    PlaybackState.prototype.cookSamples = function cookSamples(insamples, fadeStart, fadeEnd) {
        let ret;
        if(fadeStart !== null && fadeEnd !== null && fadeEnd < this.sampleCount) {
            ret = new Float32Array(fadeEnd);
        }
        else {
            ret = new Float32Array(this.sampleCount);
        }
        let o = 0;
        for(let frameIndex = 0; frameIndex < insamples.length && o < ret.length; ++frameIndex) {
            let frame = insamples[frameIndex];
            for(let i = 0; i < frame.length && o < ret.length; ++i) {
                ret[o++] = frame[i];
            }
        }
        if(fadeStart !== null && fadeEnd !== null) {
            for(o = fadeStart; o < fadeEnd && o < ret.length; ++o) {
                ret[o] = ret[o] * (1 - (o-fadeStart) / (fadeEnd-fadeStart));
            }
        }
        return ret;
    };
    PlaybackState.prototype.cookLeftSamples = function cookLeftSamples(fs,fe) {
        return this.cookSamples(this.outSamplesLeft, fs, fe);
    };
    PlaybackState.prototype.cookRightSamples = function cookRightSamples(fs,fe) {
        return this.cookSamples(this.outSamplesRight, fs, fe);
    };
    const DEFAULT_OPTIONS = {
        "loop": true,
        "loopOverlapTime": 2,
        "loopFadeTime": 5,
        "startOrder": 0,
        "headphones": false,
    };
    bakeArsTrackerSong = function bakeArsTrackerSong(module,
                                                     songIndex,
                                                     options) {
        if(songIndex === undefined) songIndex = 0;
        if(songIndex >= module.songs.length)
            throw "Invalid song index";
        let song = module.songs[songIndex];
        if(options === undefined) options = {};
        for(const opt in DEFAULT_OPTIONS) {
            if(options[opt] === undefined)
                options[opt] = DEFAULT_OPTIONS[opt];
        }
        let playbackState = new PlaybackState(module, song, options)
        let orderStartSamples = [];
        while(playbackState.curOrderIndex < song.orders.length
              && orderStartSamples[playbackState.curOrderIndex] === undefined
              && !playbackState.halted) {
            orderStartSamples[playbackState.curOrderIndex] = playbackState.sampleCount;
            playbackState.renderOrder();
        }
        let ret = {
            "sampleRate": ET209.SAMPLE_RATE
        };
        let fadeStart;
        let fadeEnd;
        if(options.loop && !playbackState.halted) {
            // TODO: Improve handling of halt, particularly when looping is
            // requested. Add an option to "force loop".
            let loopLeft = orderStartSamples[playbackState.curOrderIndex];
            let loopRight = playbackState.sampleCount;
            loopLeft = Math.floor(loopLeft + options.loopOverlapTime * ET209.SAMPLE_RATE + 0.5);
            loopRight = Math.floor(loopRight + options.loopOverlapTime * ET209.SAMPLE_RATE + 0.5);
            ret.loopLeft = loopLeft;
            ret.loopRight = loopRight;
            fadeStart = loopRight;
            fadeEnd = Math.floor(fadeStart + options.loopFadeTime * ET209.SAMPLE_RATE + 0.5);
            while(playbackState.sampleCount < fadeEnd
                  && !playbackState.halted) {
                playbackState.renderFrame();
            }
        }
        else {
            fadeStart = null;
            fadeEnd = null;
        }
        ret.left = playbackState.cookLeftSamples(fadeStart, fadeEnd);
        ret.right = playbackState.cookRightSamples(fadeStart, fadeEnd);
        ret.sampleCount = ret.left.length;
        return ret;
    };
}
