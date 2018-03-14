const ArgumentType = require('../../extension-support/argument-type');
const Cast = require('../../util/cast');
const BlockType = require('../../extension-support/block-type');
const color = require('../../util/color');
const log = require('../../util/log');

/**
 * Icon svg to be displayed at the left edge of each extension block, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const iconURI = 'https://www.gstatic.com/images/icons/material/system/1x/mic_white_24dp.png'
const menuIconURI = 'https://www.gstatic.com/images/icons/material/system/1x/mic_grey600_24dp.png'

class Scratch3SpeechBlocks {
	constructor (runtime) {
    /**
     * The runtime instantiating this block package.
     * @type {Runtime}
     */
    this.runtime = runtime;

    // For seeding the recognition engine and for deciding whether to accept results.
    // TODO: pull these values out of the hat blocks inste of hard coding them.
    this._phrase_list = [];

    /**
     * The most recent result received from the speech API transcription.
     * @type {String}
     */
    this.current_utterance = null;

    // using this to test out hat blocks that edge trigger.  The reporter block
    // uses current_utterance and we probably? don't want to reset the value unless
    // we have new transcription results.  But, in order to detect someone saying
    // the same thing twice in two subsequent liten and wait blocks 
    // and still trigger the hat, we need this to go from
    // '' at the beginning of the listen to '<transcription value' at the end.
    this.temp_speech = null;

    /**
     * The list of queued `resolve` callbacks for speech'.
     * @type {!Array}
     */
    // Note. This a list because each block used to have its own chance to listen
    // e.g. each block listenend for an utterance.  I've switched it back so that
    // if two listen blocks try to start running at the same time,
    // there is only 1 utterance detected
    this._speechList = [];

    this._alreadyListening = false;

    this._speechTimeout = null;

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

    this._loadUISounds();

    // Come back and figure out which of these I really need.
    this.startRecording = this.startRecording.bind(this);
    this._newWebsocket = this._newWebsocket.bind(this);
    this._newSocketCallback = this._newSocketCallback.bind(this);
    this._setupSocketCallback = this._setupSocketCallback.bind(this);
    this._socketMessageCallback = this._socketMessageCallback.bind(this);
    this._startByteStream = this._startByteStream.bind(this);
    this._processAudioCallback = this._processAudioCallback.bind(this);
    this._onTranscriptionFromServer = this._onTranscriptionFromServer.bind(this);
    this._timeOutListening = this._timeOutListening.bind(this);
    this._startNextListening = this._startNextListening.bind(this);
    this._resetActiveListening = this._resetActiveListening.bind(this);


    this.runtime.on('TRANSCRIPTION', this._onTranscription.bind(this));
    this.runtime.on('PROJECT_STOP_ALL', this._resetListening.bind(this));
  }


    /**
     * Download and decode the UI sounds.
     */
    _loadUISounds () {
        this._loadSound('speech-rec-start').then(buffer => {
            this._startSoundBuffer = buffer;
        });
        this._loadSound('speech-rec-end').then(buffer => {
            this._endSoundBuffer = buffer;
        });
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

  // Resets all things related to listening. Called on Red Stop sign button.
  //   - suspends audio context
  //   - closes socket with speech socket server
  //   - clears out any remaining speech blocks that think they need to run.
  _resetListening() {
    console.log("_resetListening.");
    // Check whether context has been set up yet. This can get called before
 	  // We ever tried to listen for anything. e.g. on Green Flag click.
 	  if (this._context) {
 		  this._context.suspend.bind(this._context);
 	  }
 	  this._closeWebsocket();
 	  if (this._speechList.length > 0) {
 		  console.log('resetting so resolving everything');
   	    for (var i = 0; i < this._speechList.length; i++) {
	  	    var resFn = this._speechList[i];
	  	    resFn();
 	  	  }
 		  this._speechList = [];  // TODO does this actually resolve anything?
 	  }
  }

	// Called to reset a single instance of listening.  If there are utterances
	// expected in the queue, kick off the next one.
  _resetActiveListening() {
    console.log('resetting active listening');
    if (this._speechList.length > 0) {
      var resolve = this._speechList.shift();
   		// Pause the mic and close the web socket.
      this._context.suspend.bind(this._context);
      this._closeWebsocket();
      resolve();
      for (var i = 0; i < this._speechList.length; i++) {
        var resFn = this._speechList[i];
        resFn();
      }

   	  this._speechList = []; // reset list. CHECK WITH PROMISE IS RESOLVED
   	  this._alreadyListening = false;
    }
  }

  // Callback when ready to setup a new socket connection with speech server.
  _newSocketCallback(resolve, reject) {
    console.log('creating a new web socket');
  	// TODO: Stop hardcoding localhost and port
    //var server = 'ws://scratch-speech-prod.us-east-1.elasticbeanstalk.com';
    var server = 'ws://localhost:8080';
    this._socket = new WebSocket(server);
    this._socket.addEventListener('open', resolve);
    this._socket.addEventListener('error', reject);
  }

  _stopTranscription() {
    // what should actually get stopped here???
    if (this._socket) {
      this._context.suspend.bind(this._context);
      if (this._scriptNode) {
        this._scriptNode.disconnect();        
      }
      this._socket.send('stopPlease');
    }
  }
	// Callback to handle initial setting up of a socket.
	// Currently we send a setup message (only contains sample rate) but might
	// be useful to send more data so we can do quota stuff.
	_setupSocketCallback(values) {
    this._micStream = values[0];
    this._socket = values[1].target;

      // TODO: go look at the serve and see if it implements this.
      this._socket.addEventListener('close', function(e) {
        console.log('socket close listener..');
      });
      this._socket.addEventListener('error', function(e) {
        console.log('Error from websocket', e);
      });

      // Send the initial configuration message. When the server acknowledges
      // it, start streaming the audio bytes to the server and listening for
      // transcriptions.
      this._socket.addEventListener('message', this._socketMessageCallback, {once: true});
      console.log('sending phrase list: ' + this._phrase_list);
      this._socket.send(JSON.stringify(
        {sampleRate: this._context.sampleRate,
         phrases: this._phrase_list,
        }
      ));
  }
	
  _scanBlocksForPhraseList() {
    var words = [];
    // For each each target, walk through the top level blocks and check whether
    // they are speech hat/when I hear blocks.
    this.runtime.targets.forEach(function(target) {
      target.blocks._scripts.forEach(function(id) {
        var b = target.blocks.getBlock(id);
        if (b.opcode === 'speech.whenIHearHat') {
          // Grab the text from the hat block's shadow.
          var inputId = b.inputs.PHRASE.block;
          var inputBlock = target.blocks.getBlock(inputId);
          var word = target.blocks.getBlock(inputId).fields.TEXT.value;
          words.push(word);          
        }
      })
    });
    this._phrase_list = words;
  }
	// Setup listening for socket.
	_socketMessageCallback(e) {
    console.log('socket message callback');
    this._socket.addEventListener('message', this._onTranscriptionFromServer);
    this._startByteStream(e);
  }

	// Setup so we can start streaming mic data
	_startByteStream(e) {
		// Hook up the scriptNode to the mic
    this._sourceNode = this._context.createMediaStreamSource(this._micStream);
    this._sourceNode.connect(this._scriptNode);
    this._scriptNode.connect(this._context.destination);
  }

	// Called when we're ready to start listening and want to open a socket.
	_newWebsocket() {
		console.log('setting up new socket and setting up block timeout.');
		var websocketPromise = new Promise(this._newSocketCallback); 
      Promise.all([this._audioPromise, websocketPromise]).then(
        this._setupSocketCallback).catch(console.log.bind(console));
	}
	
	// Called when we're done listening and want to close the web socket server.
	// Stops listening to the mic and whatnot as well.
	_closeWebsocket() {
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
 _timeOutListening() {
 	  console.log('timeout fired. Resetting listening');
    //this.current_utterance = '';  // should this be NULL OR empty?
  //  this.temp_speech = ''; // should this be null or empty?
// 	  this._resetActiveListening();
  this._stopTranscription();
  this._playSound(this._endSoundBuffer);
 }

 // When we get a transcription result, save the result to current_utterance,
 // resolve the current promise.  
 _onTranscription (result) {
 	  var text = result.alternatives[0].transcript
    // Confidence seems to be 0 when a result has isFinal: true
 	  text = Cast.toString(text).toLowerCase();
    // facilitate matches by removing some punctuation: . ? !
    text = text.replace(/[.?!]/g, '');
    // trim off any white space
    text = text.trim();



    if (!result.isFinal && result.stability < .85 && !this._phrase_list.includes(text)) {
      this._possible_result = text;
      console.log('not good enough yet text: ' + text);
      return;
    }

 	  var resolve = this._speechList[0];
 	  this.current_utterance = text;
    this.temp_speech = text;
 	  console.log('current utterance set to: ' + text);
 	  for (var i = 0; i < this._speechList.length; i++) {
  	  var resFn = this._speechList[i];
  	  resFn();
 	  }
    this._playSound(this._endSoundBuffer);
 	  // Pause the mic and close the web socket.
 	  this._context.suspend.bind(this._context);
 	  this._closeWebsocket();

 	  this._speechList = [];
 	  this._alreadyListening = false;
    if (this._speechTimeout) {
      clearTimeout(this._speechTimeout);
      this._speechTimeout = null;
    }
 }


 // Disconnect all the audio stuff on the client.
 _suspendListening() {
 	  console.log('suspending listenting');
 	  // this gets called on green flag when context may not exist yet.
 	  if (this._context) {
 	  	  console.log('suspending audio context.')
   	  this._context.suspend.bind(this._context);
 		  this._scriptNode.disconnect();
 	  }
    if (this._sourceNode) this._sourceNode.disconnect();
 }

 // This needs a new name - currently handles all messages fromt the socket 
 // server. Even the init message and the "end of utterance message";
  _onTranscriptionFromServer(e) {
    console.log('transcription ' + e.data);
    if (e.data == 'got the configuration message') {
    	console.log('received initial response from socket server.');
    	return;
    } else if (e.data == 'end of utterance') {
    	// End of utterance is a message we get, but it doesn't mean we've got
    	// the final results yet.  So for now, ignore?
    	console.log('Got an end of utterance message. Ignoring it though.');
    	return;
    }

    // This is an actual transcription result.
    try {
    	var result = JSON.parse(e.data);
    } catch (ex) {
    	console.log ('problem parsing json. continuing: ' + ex);
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
  _processAudioCallback(e) {
    if (this._socket.readyState == WebSocket.CLOSED ||
        this._socket.readyState == WebSocket.CLOSING) {
      console.log('Not sending data because not in ready state. State: ' + this._socket.readyState);
      return;
    }
    const MAX_INT = Math.pow(2, 16 - 1) - 1;
    var floatSamples = e.inputBuffer.getChannelData(0);
   	// The samples are floats in range [-1, 1]. Convert to 16-bit signed
    // integer.
    this._socket.send(Int16Array.from(floatSamples.map(function(n) {
      return n * MAX_INT;
     })));
  }

  // Called to setup the AudioContext and its callbacks.
  initWebSocket() {
    // Create a node that sends raw bytes across the websocket
    this._scriptNode = this._context.createScriptProcessor(4096, 1, 1);
    // Need the maximum value for 16-bit signed samples, to convert from float.
    this._scriptNode.addEventListener('audioprocess', this._processAudioCallback);
    this._newWebsocket();
  }

  // Called when we're ready to start recording from the microphone and sending
  // that data to the speech server.
  startRecording() {
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
		var tempContext = this._context;
		var analyser;
	    this._audioPromise.then(function(micStream) {
	      var microphone = tempContext.createMediaStreamSource(micStream);
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
                    blockType: BlockType.COMMAND,
                },
                {
                    opcode: 'whenIHearHat',
                    text: 'When I hear [PHRASE]',
                    blockType: BlockType.HAT,
                    arguments : {
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
                },
            ],
        };
  }
	
  _speechMatches(needle, haystack) {
    let input = Cast.toString(needle).toLowerCase();
    // facilitate matches by removing some punctuation: . ? !
    input = input.replace(/[.?!]/g, '');
    // trim off any white space
    input = input.trim();

    if (haystack && haystack.indexOf(input) != -1) {
      return true;
    }
    return false;
  }

	
  whenIHearHat(args) {
    return this._speechMatches(args.PHRASE, this.temp_speech);
  }

  _showIndicator() {
    console.log('i should show a thing');
  }

	listenAndWait(args) {
     this._playSound(this._startSoundBuffer);
     this._showIndicator();
      this._scanBlocksForPhraseList();
      this.temp_speech = '';
      var speechPromise = new Promise(resolve => {
         var listeningInProgress = this._speechList.length > 0;
         this._speechList.push(resolve);
         if (!listeningInProgress) {
         	this._startNextListening();
         }
      });
      return speechPromise;
    }


  _playSound(buffer) {
    if (this.runtime.audioEngine === null) return;
        const context = this.runtime.audioEngine.audioContext;
        const bufferSource = context.createBufferSource();
        bufferSource.buffer = buffer;
        bufferSource.connect(this.runtime.audioEngine.input);
        bufferSource.start();
    }

  // Kick off listening for the next block waiting in the queue.
  _startNextListening() {
    console.log('start listening');
    if (this._speechList.length > 0) {
        this.startRecording();
        this._alreadyListening = true;
      // 10 second timeout for listening.
      this._speechTimeout = setTimeout(this._timeOutListening, 10000);
    } else {
      	console.log('trying to start listening but for no reason?');
    }
  }

  // Reporter for the last heard phrase/utterance.
  getSpeech(args) {
    return this.current_utterance;
  }
};
module.exports = Scratch3SpeechBlocks;
