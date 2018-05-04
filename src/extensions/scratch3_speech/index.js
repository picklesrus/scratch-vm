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
 * The url of the speech server.
 * @type {string}
 */
const serverURL = 'wss://speech.scratch.mit.edu';

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
         * @private
         */
        this._speechPromises = [];

        /**
         * The id of the timeout that will run if we start listening and don't get any
         * transcription results back. e.g. because we didn't hear anything.
         * @type {number}
         * @private
         */
        this._speechTimeoutId = null;

        /**
         * The id of the timeout that will run to wait for after we're done listening but
         * are still waiting for a potential isFinal:true transcription result to come back.
         * @type {number}
         * @private
         */
        this._speechFinalResponseTimeout = null;

        /**
         * The ScriptProcessorNode hooked up to the audio context.
         * @type {ScriptProcessorNode}
         * @private
         */
        this._scriptNode = null;

        /**
         * The socket used to communicate with the speech server to send microphone data
         * and recieve transcription results.
         * @type {WebSocket}
         * @private
         */
        this._socket = null;

        /**
         * The AudioContext used to manage the microphone.
         * @type {AudioContext}
         * @private
         */
        this._context = null;

        /**
         * MediaStreamAudioSourceNode to handle microphone data.
         * @type {MediaStreamAudioSourceNode}
         * @private
         */
        this._sourceNode = null;

        /**
         * A Promise whose fulfillment handler receives a MediaStream object when the microphone has been obtained.
         * @type {Promise}
         * @private
         */
        this._audioPromise = null;

        /**
         * Audio buffer for sound to indicate that listending has started.
         * @type {bufferSourceNode}
         * @private
         */
        this._startSoundBuffer = null;

        /**
         * Audio buffer for sound to indicate that listending has ended.
         * @type {bufferSourceNode}
         * @private
         */
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
        this._startRecording = this._startRecording.bind(this);
        this._newWebsocket = this._newWebsocket.bind(this);
        this._newSocketCallback = this._newSocketCallback.bind(this);
        this._setupSocketCallback = this._setupSocketCallback.bind(this);
        this._socketMessageCallback = this._socketMessageCallback.bind(this);
        this._startByteStream = this._startByteStream.bind(this);
        this._processAudioCallback = this._processAudioCallback.bind(this);
        this._onTranscriptionFromServer = this._onTranscriptionFromServer.bind(this);
        this._timeOutListening = this._timeOutListening.bind(this);
        this._resetListening = this._resetListening.bind(this);


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
     * Load the UI sounds played when listening starts and stops.
     * @private
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
     * @private
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
     * Play the given sound.
     * @param {ArrayBuffer} buffer The audio buffer to play.
     * @returns {Promise} A promise that resoloves when the sound is done playing.
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
     * Resolves all the speech promises we've accumulated so far and empties out the list.
     * @private
     */
    _resolveSpeechPromises () {
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

    _stopTranscription () {
        // This can get called (e.g. on)
        if (this._socket) {
            this._context.suspend.bind(this._context);
            if (this._scriptNode) {
                this._scriptNode.disconnect();
            }
            this._socket.send('stopTranscription');
            // Give it a couple seconds to response before giving up and assuming nothing.
            this._speechFinalResponseTimeout = setTimeout(this._resetListening, finalResponseTimeoutDurationMs);
        }
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

    /**
     * Called when a listen block times out without getting a transcription result.
     * This could happen because nobody said aything or of the quality of results are poor.
     */
    _timeOutListening () {
        this._stopTranscription();
    }

    /**
     * Decides whether to keep a given transcirption result.
     * @param {number} fuzzyMatchIndex Index of the fuzzy match or -1 if there is no match.
     * @param {object} result The json object representing the transcription result.
     * @param {string} normalizedTranscript The transcription text used for matching (i.e. lowercased, no punctuation).
     * @returns {boolean} true If a result is good enough to be kept.
     * @private
     */
    _shouldKeepResult (fuzzyMatchIndex, result, normalizedTranscript) {
        // The threshold above which we decide transcription results are unlikely to change again.
        // See https://cloud.google.com/speech-to-text/docs/basics#streaming_responses.
        const stabilityThreshold = .85;

        // For responsiveness of the When I Hear hat blocks, sometimes we want to keep results that are not
        // yet marked 'isFinal' by the speech api.  Here are some signals we use.

        // If the result from the speech api isn't very stable and we only had a fuzzy match, we don't want to use it.
        const shouldKeepFuzzyMatch = fuzzyMatchIndex !== -1 && result.stability > stabilityThreshold;

        // If the result is in the phraseList (i.e. it matches one of the 'When I Hear' blocks), we keep it.
        // This might be aggressive... but so far seems to be a good thing.
        const shouldKeepPhraseListMatch = this._phraseList.includes(normalizedTranscript);

        if (!result.isFinal && !shouldKeepPhraseListMatch && !shouldKeepFuzzyMatch) {
            log.info(`not good enough yet transcriptionResult: ${result}`);
            return false;
        }
        return true;
    }

    /**
     * Normalizes text a bit to facilitate matching.  Lowercases, removes some punctuation and whitespace.
     * @param {string} text The text to normalzie
     * @returns {string} The normalized text.
     * @private
     */
    _normalizeText (text) {
        text = Cast.toString(text).toLowerCase();
        text = text.replace(/[.?!]/g, '');
        text = text.trim();
        return text;
    }

    /**
     * Call into diff match patch library to compute whether there is a fuzzy match.
     * @param {string} text The text to search in.
     * @param {string} pattern The pattern to look for in text.
     * @returns {number} The index of the match or -1 if there isn't one.
     */
    _computeFuzzyMatch (text, pattern) {
        // Don't bother matching if any are null.
        if (!pattern || !text) {
            return -1;
        }

        const loc = 0; // start looking for the match at the beginning of the string.
        return this.match_main(text, pattern, loc);
    }
    /**
     * Processes the results we get back from the speech server.  Decides whether the results
     * are good enough to keep. If they are, resolves the 'Listen and Wait' blocks promise and cleans up.
     * @param {object} result The transcription result.
     * @private
     */
    _processTranscriptionResult (result) {
        const transcriptionResult = this._normalizeText(result.alternatives[0].transcript);
  
        
        // Waiting for an exact match is not satisfying.  It makes it hard to catch
        // things like homonyms or things that sound similar "let us" vs "lettuce".  Using the fuzzy matching helps
        // more aggressively match the phrases that are in the "When I hear" hat blocks.
        const phrases = this._phraseList.join(' ');
        const fuzzyMatchIndex = this._computeFuzzyMatch(transcriptionResult, phrases);

        let fuzzyMatchResult = null;
        if (fuzzyMatchIndex !== -1) {
            fuzzyMatchResult = transcriptionResult.substring(fuzzyMatchIndex, fuzzyMatchIndex + phrases.length);
            log.info(`partial match result: ${fuzzyMatchResult}`);
        }

        // If the result isn't good enough yet, return without saving and resolving the promises.
        if (!this._shouldKeepResult(fuzzyMatchIndex, result, transcriptionResult)) {
            log.info(`not good enough yet transcriptionResult: ${transcriptionResult}`);
            return;
        }

        // TODO: Decide whether this is the right thing.
        // This sets the currentUtterance (which is returned by the reporter) to the fuzzy match if we had one.
        // That means it'll often get set to a phrase from one of the 'when I hear' blocks instead of the
        // full phrase that the user said.
        if (fuzzyMatchResult) {
            this._currentUtterance = fuzzyMatchResult;
        } else {
            this._currentUtterance = transcriptionResult;
        }

        this.temp_speech = transcriptionResult;
        // We're done listening so resolove all the promises and reset everying so we're ready for next time.
        this._resetListening();
        
        // We got results so clear out the timeouts.
        if (this._speechTimeoutId) {
            clearTimeout(this._speechTimeoutId);
            this._speechTimeoutId = null;
        }
        if (this._speechFinalResponseTimeout) {
            clearTimeout(this._speechFinalResponseTimeout);
            this._speechFinalResponseTimeout = null;
        }
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

    /**
     * Handle a message from the socket. It contains transcription results.
     * @param {MessageEvent} e The message event containing data from speech server.
     * @private
     */
    _onTranscriptionFromServer (e) {
        let result = null;
        try {
            result = JSON.parse(e.data);
        } catch (ex) {
            log.error(`Problem parsing json. continuing: ${ex}`);
            // TODO: stop stuff?
            return;
        }
        this._processTranscriptionResult(result);
    }

  
    _speechMatches (pattern, text) {
        let input = Cast.toString(pattern).toLowerCase();
        // facilitate matches by removing some punctuation: . ? !
        input = input.replace(/[.?!]/g, '');
        // trim off any white space
        input = input.trim();

        const match = this._computeFuzzyMatch(text, pattern);
        return match !== -1;
    // if (haystack && haystack.indexOf(input) != -1) {
    //   return true;
    // }
    // return false;
    }

    /**
     * Kick off the listening process.
     * @private
     */
    _startListening () {
        // If we've already setup the context, we can resume instead of doing all the setup again.
        if (this._context) {
            // TODO: rename to resumeListening?
            this._resumeRecording();
        } else {
            // TODO: rename to initRecording. Or initListening?
            this._startRecording();
        }
        // Force the block to timeout if we don't get any results back/the user didn't say anything.
        this._speechTimeoutId = setTimeout(this._timeOutListening, listenAndWaitBlockTimeoutMs);
    }

    /**
     * Resume listening for audio and re-open the socket to send data.
     * @private
     */
    _resumeRecording () {
        this._context.resume.bind(this._context);
        this._newWebsocket();
    }

    /**
     * Does all setup to get microphone data and initializes the web socket.
     * that data to the speech server.
     * @private
     */
    _startRecording () {
        this._initializeMicrophone();
        this._initScriptNode();
        this._newWebsocket();
    }

    /**
     * Initialize the audio context and connect the microphone.
     * @private
     */
    _initializeMicrophone () {
        this._context = new AudioContext();
        this._audioPromise = navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                channelCount: 1,
                sampleRate: {
                    ideal: 16000
                },
                sampleSize: 16
            }
        });

        const tempContext = this._context;
        this._audioPromise.then(micStream => {
            const microphone = tempContext.createMediaStreamSource(micStream);
            const analyser = tempContext.createAnalyser();
            microphone.connect(analyser);
        }).catch(e => {
            log.error(`Problem connecting to microphone:  ${e}`);
        });
    }

    /**
     * Sets up the script processor and the web socket.
     * @private
     *
     */
    _initScriptNode () {
        // Create a node that sends raw bytes across the websocket
        this._scriptNode = this._context.createScriptProcessor(4096, 1, 1);
        // Need the maximum value for 16-bit signed samples, to convert from float.
        this._scriptNode.addEventListener('audioprocess', this._processAudioCallback);
    }

    /**
     * Callback called when it is time to setup the new web socket.
     * @param {Function} resolve - function to call when the web socket opens succesfully.
     * @param {Function} reject - function to call if opening the web socket fails.
     */
    _newSocketCallback (resolve, reject) {
        this._socket = new WebSocket(serverURL);
        this._socket.addEventListener('open', resolve);
        this._socket.addEventListener('error', reject);
    }

    /**
     * Callback called once we've initially established the web socket is open and working.
     * Sets up the callback for subsequent messages (i.e. transcription results)  and
     * connects to the script node to get data.
     * @private
     */
    _socketMessageCallback () {
        this._socket.addEventListener('message', this._onTranscriptionFromServer);
        this._startByteStream();
    }

    /**
     * Sets up callback for when socket and audio are initialized.
     * @private
     */
    _newWebsocket () {
        const websocketPromise = new Promise(this._newSocketCallback);
        Promise.all([this._audioPromise, websocketPromise]).then(
            this._setupSocketCallback)
            .catch(e => {
                log.error(`Problem with setup:  ${e}`);
            });
    }

    /**
     * Callback to handle initial setting up of a socket.
     * Currently we send a setup message (only contains sample rate) but might
     * be useful to send more data so we can do quota stuff.
     * @param {Array} values The
     */
    _setupSocketCallback (values) {
        this._micStream = values[0];
        this._socket = values[1].target;

        // TODO: go look at the server and see if it implements this.
        this._socket.addEventListener('close', e => {
            log.info(`socket close listener..${e}`);
        });
        this._socket.addEventListener('error', e => {
            log.error(`Error from web socket: ${e}`);
        });

        // Send the initial configuration message. When the server acknowledges
        // it, start streaming the audio bytes to the server and listening for
        // transcriptions.
        this._socket.addEventListener('message', this._socketMessageCallback, {once: true});
        log.info(`sending phrase list: ${this._phraseList}`);
        this._socket.send(JSON.stringify(
            {
                sampleRate: this._context.sampleRate,
                phrases: this._phraseList
            }
        ));
    }

    /**
     * Do setup so we can start streaming mic data.
     * @private
     */
    _startByteStream () {
        // Hook up the scriptNode to the mic
        this._sourceNode = this._context.createMediaStreamSource(this._micStream);
        this._sourceNode.connect(this._scriptNode);
        this._scriptNode.connect(this._context.destination);
    }

    /**
     * Called when we have data from the microphone. Takes that data and ships
     * it off to the speech server for transcription.
     * @param {audioProcessingEvent} e The event with audio data in it.
     * @private
     */
    _processAudioCallback (e) {
        if (this._socket.readyState === WebSocket.CLOSED ||
        this._socket.readyState === WebSocket.CLOSING) {
            log.error(`Not sending data because not in ready state. State: ${this._socket.readyState}`);
            return;
        }
        const MAX_INT = Math.pow(2, 16 - 1) - 1;
        const floatSamples = e.inputBuffer.getChannelData(0);
        // The samples are floats in range [-1, 1]. Convert to 16-bit signed
        // integer.
        this._socket.send(Int16Array.from(floatSamples.map(n => n * MAX_INT)));
    }

    /**
     * The key to load & store a target's speech-related state.
     * @type {string}
     */
    static get STATE_KEY () {
        return 'Scratch.speech';
    }

    /**
     * @returns {object} Metadata for this extension and its blocks.
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
     * An edge triggered hat block to listen for a specific phrase.
     * @param {object} args - the block arguments.
     * @return {boolean} true if the phrase matches what was transcribed.
     */
    whenIHearHat (args) {
        return this._speechMatches(args.PHRASE, this.temp_speech);
    }

    /**
     * Reporter for the last heard phrase/utterance.
     * @return {string} The lastest thing we heard from a listen and wait block.
     */
    getSpeech () {
        return this._currentUtterance;
    }
}
module.exports = Scratch3SpeechBlocks;
