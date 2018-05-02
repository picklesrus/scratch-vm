const ArgumentType = require('../../extension-support/argument-type');
const Cast = require('../../util/cast');
const BlockType = require('../../extension-support/block-type');
const log = require('../../util/log');

/**
 * Url of icon to be displayed at the left edge of each extension block.
 * TODO: Find the final Icon. Replace it with the right format. data URI?
 * @type {string}
 */
const iconURI = 'https://www.gstatic.com/images/icons/material/system/1x/mic_white_24dp.png';

/**
 * Url of icon to be displayed in the toolbox menu for the extension category.
 * TODO: Find the final Icon. Replace it with the right format. data URI?
 * @type {string}
 */
const menuIconURI = 'https://www.gstatic.com/images/icons/material/system/1x/mic_grey600_24dp.png';

/**
 * The amount of time to wait between when we stop sending speech data to the server and when
 * we expect the transcription result marked with isFinal: true to come back from the server.
 * @type {int}
 */
const finalResponseTimeoutDurationMs = 3000;

/**
 * The amount of time to wait between when we stop sending speech data to the server and when
 * we expect the transcription result marked with isFinal: true to come back from the server.
 * Currently set to 10sec. This should not exceed the speech api limit (60sec) without redoing how
 * we stream the microphone data data.
 * @type {int}
 */
const listenAndWaitBlockTimeoutMs = 10000;

/**
 * The start and stop sounds, loaded as static assets.
 * @type {object}
 */
let assetData = {};
try {
    assetData = require('./manifest');
} catch (e) {
    // Non-webpack environment, don't worry about assets.
}

class Scratch3SpeechBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        /**
         * An array of phrases from the [when I hear] hat blocks.
         * The list of phrases in the when I hear hat blocks.  This list is sent
         * to the speech api to seed the recognition engine and for deciding
         * whether the transcription results match.
         * @type {Array}
         * @private
         */
        this._phraseList = [];

        /**
         * The most recent transcription result received from the speech API.
         * This is the value returned by the reporter block.
         * @type {String}
         * @private
         */
        this._currentUtterance = null;

        // TODO: rename and jsdoc this!
        // using this to test out hat blocks that edge trigger.  The reporter block
        // uses _currentUtterance and we probably? don't want to reset the value unless
        // we have new transcription results.  But, in order to detect someone saying
        // the same thing twice in two subsequent liten and wait blocks
        // and still trigger the hat, we need this to go from
        // '' at the beginning of the listen to '<transcription value' at the end.
        this.temp_speech = null;

        /**
         * The list of queued `resolve` callbacks for 'Listen and Wait' blocks.
         * We only listen to for one utterance at a time.  We may encounter multiple
         * 'Listen and wait' blocks that tell us to start listening. If one starts
         * and hasn't receieved results back yet, when we encounter more, any further ones
         * will all resolve when we get the next acceptable transcription result back.
         * @type {!Array}
         */
        this._speechPromises = [];

        /**
         * The id of the timeout that will run if we start listening and don't get any
         * transcription results back. e.g. because we didn't hear anything.
         * @type {number}
         */
        this._speechTimeoutId = null;

        /**
         * The id of the timeout that will run to wait for after we're done listening but
         * are still waiting for a potential isFinal:true transcription result to come back.
         * @type {number}
         */
        this._speechFinalResponseTimeout = null;

        // The ScriptProcessorNode hooked up to the audio context.
        this._scriptNode = null;

        // The socket to send microphone data over.
        this._socket = null;
        // The AudioContext used to manage the microphone
        this._context = null;
        // MediaStreamAudioSourceNode to handle microphone data.
        this._sourceNode = null;

        // A Promise whose fulfillment handler receives a MediaStream object when the microphone has been obtained.
        this._audioPromise = null;

        // Audio buffers for sounds to indicate that listending has started and ended.
        this._startSoundBuffer = null;
        this._endSoundBuffer = null;


        // At what point is no match declared (0.0 = perfection, 1.0 = very loose).
        this.Match_Threshold = 0.3;
        // How far to search for a match (0 = exact location, 1000+ = broad match).
        // A match this many characters away from the expected location will add
        // 1.0 to the score (0.0 is a perfect match).
        this.Match_Distance = 1000;

        // The number of bits in an int.
        this.Match_MaxBits = 32;

        // Come back and figure out which of these I really need.
        this._startListening = this._startListening.bind(this);
        this.startRecording = this.startRecording.bind(this);
        this._newWebsocket = this._newWebsocket.bind(this);
        this._newSocketCallback = this._newSocketCallback.bind(this);
        this._setupSocketCallback = this._setupSocketCallback.bind(this);
        this._socketMessageCallback = this._socketMessageCallback.bind(this);
        this._startByteStream = this._startByteStream.bind(this);
        this._processAudioCallback = this._processAudioCallback.bind(this);
        this._onTranscriptionFromServer = this._onTranscriptionFromServer.bind(this);
        this._timeOutListening = this._timeOutListening.bind(this);
        this._resetActiveListening = this._resetActiveListening.bind(this);

        this.runtime.on('PROJECT_STOP_ALL', this._resetListening.bind(this));

        // Load in the start and stop listening indicator sounds.
        this._loadUISounds();
    }

    //  MATCH FUNCTIONS

    /**
   * Locate the best instance of 'pattern' in 'text' near 'loc'.
   * @param {string} text The text to search.
   * @param {string} pattern The pattern to search for.
   * @param {number} loc The location to search around.
   * @return {number} Best match index or -1.
   */
    match_main (text, pattern, loc) {
    // Check for null inputs.
        if (text == null || pattern == null || loc == null) {
            throw new Error('Null input. (match_main)');
        }

        loc = Math.max(0, Math.min(loc, text.length));
        if (text == pattern) {
            // Shortcut (potentially not guaranteed by the algorithm)
            return 0;
        } else if (!text.length) {
            // Nothing to match.
            return -1;
        } else if (text.substring(loc, loc + pattern.length) == pattern) {
            // Perfect match at the perfect spot!  (Includes case of null pattern)
            return loc;
        }
        // Do a fuzzy compare.
        return this.match_bitap_(text, pattern, loc);
    
    }


    /**
   * Locate the best instance of 'pattern' in 'text' near 'loc' using the
   * Bitap algorithm.
   * @param {string} text The text to search.
   * @param {string} pattern The pattern to search for.
   * @param {number} loc The location to search around.
   * @return {number} Best match index or -1.
   * @private
   */
    match_bitap_ (text, pattern, loc) {
        if (pattern.length > this.Match_MaxBits) {
            throw new Error('Pattern too long for this browser.');
            // console.log('Too long for match algorithm');
            // return -1;
        }

        // Initialise the alphabet.
        const s = this.match_alphabet_(pattern);

        const dmp = this; // 'this' becomes 'window' in a closure.

        /**
     * Compute and return the score for a match with e errors and x location.
     * Accesses loc and pattern through being a closure.
     * @param {number} e Number of errors in match.
     * @param {number} x Location of match.
     * @return {number} Overall score for match (0.0 = good, 1.0 = bad).
     * @private
     */
        function match_bitapScore_ (e, x) {
            const accuracy = e / pattern.length;
            const proximity = Math.abs(loc - x);
            if (!dmp.Match_Distance) {
                // Dodge divide by zero error.
                return proximity ? 1.0 : accuracy;
            }
            return accuracy + (proximity / dmp.Match_Distance);
        }

        // Highest score beyond which we give up.
        let score_threshold = this.Match_Threshold;
        // Is there a nearby exact match? (speedup)
        let best_loc = text.indexOf(pattern, loc);
        if (best_loc != -1) {
            score_threshold = Math.min(match_bitapScore_(0, best_loc), score_threshold);
            // What about in the other direction? (speedup)
            best_loc = text.lastIndexOf(pattern, loc + pattern.length);
            if (best_loc != -1) {
                score_threshold =
            Math.min(match_bitapScore_(0, best_loc), score_threshold);
            }
        }

        // Initialise the bit arrays.
        const matchmask = 1 << (pattern.length - 1);
        best_loc = -1;

        let bin_min, bin_mid;
        let bin_max = pattern.length + text.length;
        let last_rd;
        for (let d = 0; d < pattern.length; d++) {
            // Scan for the best match; each iteration allows for one more error.
            // Run a binary search to determine how far from 'loc' we can stray at this
            // error level.
            bin_min = 0;
            bin_mid = bin_max;
            while (bin_min < bin_mid) {
                if (match_bitapScore_(d, loc + bin_mid) <= score_threshold) {
                    bin_min = bin_mid;
                } else {
                    bin_max = bin_mid;
                }
                bin_mid = Math.floor((bin_max - bin_min) / 2 + bin_min);
            }
            // Use the result from this iteration as the maximum for the next.
            bin_max = bin_mid;
            let start = Math.max(1, loc - bin_mid + 1);
            const finish = Math.min(loc + bin_mid, text.length) + pattern.length;

            const rd = Array(finish + 2);
            rd[finish + 1] = (1 << d) - 1;
            for (let j = finish; j >= start; j--) {
                // The alphabet (s) is a sparse hash, so the following line generates
                // warnings.
                const charMatch = s[text.charAt(j - 1)];
                if (d === 0) { // First pass: exact match.
                    rd[j] = ((rd[j + 1] << 1) | 1) & charMatch;
                } else { // Subsequent passes: fuzzy match.
                    rd[j] = (((rd[j + 1] << 1) | 1) & charMatch) |
                  (((last_rd[j + 1] | last_rd[j]) << 1) | 1) |
                  last_rd[j + 1];
                }
                if (rd[j] & matchmask) {
                    const score = match_bitapScore_(d, j - 1);
                    // This match will almost certainly be better than any existing match.
                    // But check anyway.
                    if (score <= score_threshold) {
                        // Told you so.
                        score_threshold = score;
                        best_loc = j - 1;
                        if (best_loc > loc) {
                            // When passing loc, don't exceed our current distance from loc.
                            start = Math.max(1, 2 * loc - best_loc);
                        } else {
                            // Already passed loc, downhill from here on in.
                            break;
                        }
                    }
                }
            }
            // No hope for a (better) match at greater error levels.
            if (match_bitapScore_(d + 1, loc) > score_threshold) {
                break;
            }
            last_rd = rd;
        }
        return best_loc;
    }


    /**
   * Initialise the alphabet for the Bitap algorithm.
   * @param {string} pattern The text to encode.
   * @return {!object} Hash of character locations.
   * @private
   */
    match_alphabet_ (pattern) {
        const s = {};
        for (var i = 0; i < pattern.length; i++) {
            s[pattern.charAt(i)] = 0;
        }
        for (var i = 0; i < pattern.length; i++) {
            s[pattern.charAt(i)] |= 1 << (pattern.length - i - 1);
        }
        return s;
    }

    /**
     * Decode the UI sounds.
     */
    _loadUISounds () {
        const startSoundBuffer = assetData['speech-rec-start.mp3'].buffer;
        this._decodeSound(startSoundBuffer).then(buffer => {
            this._startSoundBuffer = buffer;
        });

        const endSoundBuffer = assetData['speech-rec-end.mp3'].buffer;
        this._decodeSound(endSoundBuffer).then(buffer => {
            this._endSoundBuffer = buffer;
        });
    }

    /**
     * Decode a sound and return a promise with the audio buffer.
     * @param  {ArrayBuffer} soundBuffer - a buffer containing the encoded audio.
     * @return {Promise} - a promise which will resolve once the sound has decoded.
     */
    _decodeSound (soundBuffer) {
        const context = this.runtime.audioEngine && this.runtime.audioEngine.audioContext;

        if (!context) {
            return Promise.reject(new Error('No Audio Context Detected'));
        }

        // Check for newer promise-based API
        if (context.decodeAudioData.length === 1) {
            return context.decodeAudioData(soundBuffer);
        } else { // eslint-disable-line no-else-return
            // Fall back to callback API
            return new Promise((resolve, reject) =>
                context.decodeAudioData(soundBuffer,
                    buffer => resolve(buffer),
                    error => reject(error)
                )
            );
        }
    }

    /**
     * Download and decode a sound.
     * @param {string} fileName - the audio file name.
     * @return {Promise} - a promise which will resolve once the sound has loaded.
     */
    _loadSound (fileName) {
        if (!this.runtime.storage) return;
        if (!this.runtime.audioEngine) return;
        if (!this.runtime.audioEngine.audioContext) return;
        return this.runtime.storage.load(this.runtime.storage.AssetType.Sound, fileName, 'mp3')
            .then(soundAsset => {
                const context = this.runtime.audioEngine.audioContext;
                // Check for newer promise-based API
                if (context.decodeAudioData.length === 1) {
                    return context.decodeAudioData(soundAsset.data.buffer);
                } else { // eslint-disable-line no-else-return
                    // Fall back to callback API
                    return new Promise((resolve, reject) =>
                        context.decodeAudioData(soundAsset.data.buffer,
                            buffer => resolve(buffer),
                            error => reject(error)
                        )
                    );
                }
            });
    }
  
    /**
     * The key to load & store a target's speech-related state.
     * @type {string}
     */
    static get STATE_KEY () {
        return 'Scratch.speech';
    }

    /**
     * Resolves all the speech promises we've accumulated so far and empties out the list.
     * @private
     */
    _resolveSpeechPromises () {
        console.log('resetting ' + this._speechPromises.length + ' promises');
        for (let i = 0; i < this._speechPromises.length; i++) {
            const resFn = this._speechPromises[i];
            resFn();
        }
        this._speechPromises = [];
    }

    // Resets all things related to listening. Called on Red Stop sign button.
    //   - suspends audio context
    //   - closes socket with speech socket server
    //   - clears out any remaining speech blocks that think they need to run.
    _resetListening () {
        console.log('_resetListening.');
        // Check whether context has been set up yet. This can get called before
        // We ever tried to listen for anything. e.g. on Green Flag click.
        if (this._context) {
            this._context.suspend.bind(this._context);
        }
        // TODO: test multiple listen and wait blocks + stop button.
        // I think this messes up the socket.
        this._closeWebsocket();
        this._resolveSpeechPromises();
    }

    // Called to reset a single instance of listening.  If there are utterances
    // expected in the queue, kick off the next one.
    // TODO figure out if/why this is different from resetListening.
    _resetActiveListening () {
        console.log('resetting active listening');
        // TODO: Do I need to test for this?
        if (this._speechPromises.length > 0) {
            // Pause the mic and close the web socket.
            this._context.suspend.bind(this._context);
            this._closeWebsocket();
            this._resolveSpeechPromises();
        }
    }

    // Callback when ready to setup a new socket connection with speech server.
    _newSocketCallback (resolve, reject) {
        console.log('creating a new web socket');
        // TODO: Stop hardcoding localhost and port
        // var server = 'ws://localhost:8080';
        const server = 'wss://speech.scratch.mit.edu';
        this._socket = new WebSocket(server);
        this._socket.addEventListener('open', resolve);
        this._socket.addEventListener('error', reject);
    }

    _stopTranscription () {
        // what should actually get stopped here???
        if (this._socket) {
            this._context.suspend.bind(this._context);
            if (this._scriptNode) {
                this._scriptNode.disconnect();
            }
            this._socket.send('stopTranscription');
            // Give it a couple seconds to response before giving up and assuming nothing.
            this._speechFinalResponseTimeout = setTimeout(this._resetActiveListening, finalResponseTimeoutDurationMs);
        }
    }

    // Callback to handle initial setting up of a socket.
    // Currently we send a setup message (only contains sample rate) but might
    // be useful to send more data so we can do quota stuff.
    _setupSocketCallback (values) {
        this._micStream = values[0];
        this._socket = values[1].target;

        // TODO: go look at the serve and see if it implements this.
        this._socket.addEventListener('close', e => {
            console.log('socket close listener..');
        });
        this._socket.addEventListener('error', e => {
            console.log('Error from websocket', e);
        });

        // Send the initial configuration message. When the server acknowledges
        // it, start streaming the audio bytes to the server and listening for
        // transcriptions.
        this._socket.addEventListener('message', this._socketMessageCallback, {once: true});
        console.log(`sending phrase list: ${this._phraseList}`);
        this._socket.send(JSON.stringify(
            {sampleRate: this._context.sampleRate,
                phrases: this._phraseList
            }
        ));
    }
    
    /**
     * Scans all the 'When I hear' hat blocks for each sprite and pulls out the text.  The list
     * is sent off to the speech recognition server as hints.  This *only* reads the value out of
     * the hat block shadow.  If a block is dropped on top of the shadow, it is skipped.
     * @returns {Array} list of strings from the hat blocks in the project.
     * @private
     */
    _scanBlocksForPhraseList () {
        const words = [];
        // For each each target, walk through the top level blocks and check whether
        // they are speech hat/when I hear blocks.
        this.runtime.targets.forEach(target => {
            target.blocks._scripts.forEach(id => {
                const b = target.blocks.getBlock(id);
                if (b.opcode === 'speech.whenIHearHat') {
                    // Grab the text from the hat block's shadow.
                    const inputId = b.inputs.PHRASE.block;
                    const inputBlock = target.blocks.getBlock(inputId);
                    // Only grab the value from text blocks. This means we'll
                    // miss some. e.g. values in variables or other reporters.
                    if (inputBlock.opcode === 'text') {
                        const word = target.blocks.getBlock(inputId).fields.TEXT.value;
                        words.push(word);
                    }
                }
            });
        });
        return words;
    }

    // Setup listening for socket.
    _socketMessageCallback (e) {
        console.log('socket message callback');
        this._socket.addEventListener('message', this._onTranscriptionFromServer);
        this._startByteStream(e);
    }

    // Setup so we can start streaming mic data
    _startByteStream (e) {
        // Hook up the scriptNode to the mic
        this._sourceNode = this._context.createMediaStreamSource(this._micStream);
        this._sourceNode.connect(this._scriptNode);
        this._scriptNode.connect(this._context.destination);
    }

    // Called when we're ready to start listening and want to open a socket.
    _newWebsocket () {
        console.log('setting up new socket and setting up block timeout.');
        const websocketPromise = new Promise(this._newSocketCallback);
        Promise.all([this._audioPromise, websocketPromise]).then(
            this._setupSocketCallback)
            .catch(console.log.bind(console));
    }

    // Called when we're done listening and want to close the web socket server.
    // Stops listening to the mic and whatnot as well.
    _closeWebsocket () {
        console.log('closing socket');
        // This is called on green flag to reset things that may never have existed
        // in the first place. Do a bunch of checks.
        if (this._scriptNode) {
            this._scriptNode.disconnect();
        }
        if (this._sourceNode) this._sourceNode.disconnect();
        if (this._socket && this._socket.readyState === this._socket.OPEN) {
            console.log('sending close socket message');
            this._socket.close();
        }
    }

    // Called when a listen block times out without detecting an end of
    // utterance message during transcription.
    _timeOutListening () {
        console.log('timeout fired. Resetting listening');
        // this._currentUtterance = '';  // should this be NULL OR empty?
        //  this.temp_speech = ''; // should this be null or empty?
        //    this._resetActiveListening();
        this._stopTranscription();
        // this._playSound(this._endSoundBuffer);
    }

    // When we get a transcription result, save the result to _currentUtterance,
    // resolve the current promise.
    _onTranscription (result) {
        let transcriptionResult = result.alternatives[0].transcript;
        // Confidence seems to be 0 when a result has isFinal: true
        transcriptionResult = Cast.toString(transcriptionResult).toLowerCase();
        // facilitate matches by removing some punctuation: . ? !
        transcriptionResult = transcriptionResult.replace(/[.?!]/g, '');
        // trim off any white space
        transcriptionResult = transcriptionResult.trim();

        // this._computeMatch(transcriptionResult);

        const phrases = this._phraseList.join(' ');
        let matchResult = null;
        const match = this._computeMatch(transcriptionResult, phrases);

        if (match !== -1) {
            console.log('partial match.');
            matchResult = transcriptionResult.substring(match, match + phrases.length);
            console.log(`match result: ${matchResult}`);
        }
        const shouldKeepMatch = match !== -1 && result.stability > .85; // don't keep matches if the stability is low.

        // if (!result.isFinal && result.stability < .85 && !this._phraseList.includes(transcriptionResult) && match == -1) {
        if (!result.isFinal && !this._phraseList.includes(transcriptionResult) && !shouldKeepMatch) {
            this._possible_result = transcriptionResult;
            console.log(`not good enough yet transcriptionResult: ${transcriptionResult}`);
            return;
        }

        if (matchResult) {
            this._currentUtterance = matchResult;
        } else {
            this._currentUtterance = transcriptionResult;
        }

        this.temp_speech = transcriptionResult;
        console.log(`current utterance set to: ${this._currentUtterance}`);
        this._resolveSpeechPromises();
        // this._playSound(this._endSoundBuffer);
        // Pause the mic and close the web socket.
        this._context.suspend.bind(this._context);
        this._closeWebsocket();
        // We got results so don't bother with the timeout.
        if (this._speechTimeoutId) {
            clearTimeout(this._speechTimeoutId);
            this._speechTimeoutId = null;
        }
        // timeout for waiting for last result.
        if (this._speechFinalResponseTimeout) {
            clearTimeout(this._speechFinalResponseTimeout);
            this._speechFinalResponseTimeout = null;
        }
    }

    _computeMatch (text, pattern) {
        // var text = this._phraseList.join(' ');

        // Don't bother matching if any are null.
        if (!pattern || !text) {
            return -1;
        }

        const loc = 0;

        const match = this.match_main(text, pattern, loc);
        if (match == -1) {
            // console.log('no match');
        } else {
            const quote = text.substring(match, match + text.length);
            //     console.log(' match found at character  ' + match + ' ' + quote);
        }
        return match;
    }

    // Disconnect all the audio stuff on the client.
    _suspendListening () {
        console.log('suspending listenting');
        // this gets called on green flag when context may not exist yet.
        if (this._context) {
            console.log('suspending audio context.');
            this._context.suspend.bind(this._context);
            this._scriptNode.disconnect();
        }
        if (this._sourceNode) this._sourceNode.disconnect();
    }

    // This needs a new name - currently handles all messages fromt the socket
    // server. Even the init message and the "end of utterance message";
    _onTranscriptionFromServer (e) {
        console.log(`transcription ${e.data}`);
        if (e.data === 'got the configuration message') {
            console.log('received initial response from socket server.');
            return;
        } else if (e.data === 'end of utterance') {
            // End of utterance is a message we get, but it doesn't mean we've got
            // the final results yet.  So for now, ignore?
            console.log('Got an end of utterance message. Ignoring it though.');
            return;
        }

        // This is an actual transcription result.
        let result = null;
        try {
            result = JSON.parse(e.data);
        } catch (ex) {
            console.log(`problem parsing json. continuing: ${ex}`);
            // TODO: stop stuff?
            return;
        }
        // Throw a transcription event that we'll catch later and decice whether to
        // resolve the promise.
        //      this.runtime.emit('TRANSCRIPTION', result);
        this._onTranscription(result);
    }

    // Called when we have data from the Microphone. Takes that data and ships
    // it off to the speech server for transcription.
    _processAudioCallback (e) {
        if (this._socket.readyState === WebSocket.CLOSED ||
        this._socket.readyState === WebSocket.CLOSING) {
            console.log(`Not sending data because not in ready state. State: ${this._socket.readyState}`);
            return;
        }
        const MAX_INT = Math.pow(2, 16 - 1) - 1;
        const floatSamples = e.inputBuffer.getChannelData(0);
        // The samples are floats in range [-1, 1]. Convert to 16-bit signed
        // integer.
        this._socket.send(Int16Array.from(floatSamples.map(n => n * MAX_INT)));
    }

    // Called to setup the AudioContext and its callbacks.
    initWebSocket () {
    // Create a node that sends raw bytes across the websocket
        this._scriptNode = this._context.createScriptProcessor(4096, 1, 1);
        // Need the maximum value for 16-bit signed samples, to convert from float.
        this._scriptNode.addEventListener('audioprocess', this._processAudioCallback);
        this._newWebsocket();
    }

    // Called when we're ready to start recording from the microphone and sending
    // that data to the speech server.
    startRecording () {
        if (this._context) {
            console.log('Already did the setup. Trying to resume.');
            this._context.resume.bind(this._context);
            this._newWebsocket();
            return;
        }
        console.log('starting recording');
        // All the setup for reading from microphone.
        this._context = new AudioContext();
        // TODO: put these constants elsewhere
        const SAMPLE_RATE = 16000;
        const SAMPLE_SIZE = 16;
        this._audioPromise = navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                channelCount: 1,
                sampleRate: {
                    ideal: SAMPLE_RATE
                },
                sampleSize: SAMPLE_SIZE
            }
        });
        const tempContext = this._context;
        let analyser;
        this._audioPromise.then(micStream => {
            const microphone = tempContext.createMediaStreamSource(micStream);
            analyser = tempContext.createAnalyser();
            microphone.connect(analyser);
        }).catch(console.log.bind(console));
        this.initWebSocket();
    }


    /**
   * @returns {object} metadata for this extension and its blocks.
   */
    getInfo () {
        return {
            id: 'speech',
            name: 'Google Speech',
            menuIconURI: menuIconURI,
            blockIconURI: iconURI,
            blocks: [
                {
                    opcode: 'listenAndWait',
                    text: 'Listen and Wait',
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'whenIHearHat',
                    text: 'When I hear [PHRASE]',
                    blockType: BlockType.HAT,
                    arguments: {
                        PHRASE: {
                            type: ArgumentType.STRING,
                            defaultValue: 'cat'
                        }
                    }
                },
                {
                    opcode: 'getSpeech',
                    text: 'speech',
                    blockType: BlockType.REPORTER
                }
            ]
        };
    }

    _speechMatches (pattern, text) {
        let input = Cast.toString(pattern).toLowerCase();
        // facilitate matches by removing some punctuation: . ? !
        input = input.replace(/[.?!]/g, '');
        // trim off any white space
        input = input.trim();

        const match = this._computeMatch(text, pattern);
        return match !== -1;
    // if (haystack && haystack.indexOf(input) != -1) {
    //   return true;
    // }
    // return false;
    }


    /**
     * An edge triggered hat block to listen for a specific phrase.
     * @param {object} args - the block arguments.
     * @return {boolean} true if the phrase matches what was transcribed.
     */
    whenIHearHat (args) {
        return this._speechMatches(args.PHRASE, this.temp_speech);
    }

    /**
     * Start the listening process if it isn't already in progress, playing a sound to indicate
     * when it starts and stops.
     * @return {Promise} A promise that will resolve when listening is complete.
     */
    listenAndWait () {
        // look into the timing of when to start the sound.  There currently seems
        // to be some lag between when the sound starts and when the socket message
        // callback is received.
        // TODO: Only play the sound if listening isn't already in progress?
        return this._playSound(this._startSoundBuffer).then(() => {
            this._phraseList = this._scanBlocksForPhraseList();
            this.temp_speech = '';
            const speechPromise = new Promise(resolve => {
                const listeningInProgress = this._speechPromises.length > 0;
                this._speechPromises.push(resolve);
                if (!listeningInProgress) {
                    this._startListening();
                }
            });
            return speechPromise.then(() => this._playSound(this._endSoundBuffer));
        });
    }

    /**
     * Play the given sound.
     * @param {}
     * @returns {Promise}
     * @private
     */
    _playSound (buffer) {
        if (this.runtime.audioEngine === null) return;
        const context = this.runtime.audioEngine.audioContext;
        const bufferSource = context.createBufferSource();
        bufferSource.buffer = buffer;
        bufferSource.connect(this.runtime.audioEngine.input);
        bufferSource.start();
        return new Promise(resolve => {
            bufferSource.onended = () => {
                resolve();
            };
        });
    }

    /**
     * Kick off the listening process.
     * // TODO: maybe fold this into startRecording?
     * @private
     */
    _startListening () {
        this.startRecording();
        this._speechTimeoutId = setTimeout(this._timeOutListening, listenAndWaitBlockTimeoutMs);
    }

    // Reporter for the last heard phrase/utterance.
    getSpeech () {
        return this._currentUtterance;
    }
}
module.exports = Scratch3SpeechBlocks;
