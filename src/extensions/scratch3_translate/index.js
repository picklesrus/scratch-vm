const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
//const Translate = require('@google-cloud/translate');
const nets = require("nets")

const blockIconURI  = 'https://www.gstatic.com/images/icons/material/system/1x/translate_white_24dp.png';
const menuIconURI = 'https://www.gstatic.com/images/icons/material/system/1x/translate_grey600_24dp.png';

/**
 * Class for the translate-related blocks in Scratch 3.0
 * @param {Runtime} runtime - the runtime instantiating this block package.
 * @constructor
 */
class Scratch3TranslateBlocks {
    constructor (runtime, manager) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        // Extension manager - temp hack to get around the fact that dynamic
        // menus don't work yet.
        // TODO: remove when they do.
        this.manager = manager;

        // TEMP API KEY ************************
        this.API_KEY = this._parseApiKey();
        // ***************************************

        this.supportedLangauges = null;
        this.loadPromise = null;

        // The language that was most recently translated into.
        this.lastLangTranslated = '';
        // The text that was most recently translated.
        this.lastTextTranslated = '';

        // The result from the most recent translation.
        this.translatedText = '';

        // Fill the menu with supported languages.
        this._getSupportedLanguages();

    }

    _parseApiKey() {
    	var paramString = document.location.search;
    	var urlParams = new URLSearchParams(paramString);
    	var key = urlParams.get('eye');
    	return key;
    }

 	/**
     * The key to load & store a target's translate state.
     * @type {string}
     */
    static get STATE_KEY () {
        return 'Scratch.translate';
    }

    // TODO: base this on something other tahn just english. The scratch language?
    // The detected langauge of the block input?
    _getSupportedLanguages() {
    	
    	var url = 'https://translation.googleapis.com/language/translate/v2/languages?key=' + this.API_KEY;
    	
    	this.loadPromise = new Promise((resolve, reject) => {
    	nets({
                method: 'GET',
                url: url,
                json: {}
            }, (err, res, body) => {
                if (err) {
                	console.log(err);
                	return {text: '', value: '1'};
                }
                if (res.statusCode !== 200) {
                	console.log('error! ' + res);
                	return {text: '', value: '1'};
                }
                this.supportedLangauges =
                  body.data.languages.map((entry, index) => {
		            const obj = {};
            		obj.text = entry.language;
            		obj.value = String(index + 1);
            		return obj;
        		  });
        		resolve();
            });
	    });
	    var temp = this;
	this.loadPromise.then(() => {
  	  console.log(' time to replace the menu');
	  // TODO: replace this with a dynamic menu instead. this is a hack and probably
	  // will break if you load the extension twice.
	  var tempInfo = temp.getInfo();
	  var prepared = temp.manager._prepareExtensionInfo('extension.0.translate', tempInfo);
	  temp.runtime._refreshExtensionPrimitives(prepared);
	});
   }


    _buildLanguageMenu() {
    	if (!this.supportedLangauges) {
    		console.log('no response yet. blank menu');
    		return [{text:'', value: '1'}];
    	}
    	return this.supportedLangauges;
    }
    /**
     * @returns {object} metadata for this extension and its blocks.
     */
    getInfo () {
        return {
            id: 'translate',
            name: 'Translate',
            menuIconURI: menuIconURI,
            blockIconURI: blockIconURI,
            blocks: [
                {
                    opcode: 'getTranslate',
                    text: 'translate [WORDS] to [LANGUAGE]',
                    blockType: BlockType.REPORTER,
                    arguments: {
                    	WORDS: {
                    		type: ArgumentType.STRING,
                    		defaultValue: 'hi there'
                    	},
                    	LANGUAGE: {
                    		type: ArgumentType.STRING,
                    		menu: 'languages',
                    	}
                    }
                }
            ],
            menus: {
               languages: this._buildLanguageMenu(),
            }
        };
    }

    getTranslate(args) {
    	console.log('in get Translate');

    	if (this.lastTextTranslated == args.WORDS &&
			this.lastLangTranslated == args.LANGUAGE) {
    		console.log('already translated pair. reusing old value');
    		return this.translatedText;
    	}
		var urlBase = 'https://translation.googleapis.com/language/translate/v2?key=' + this.API_KEY;
		var lang = 'en'; // TODO: Find a better default
		if (args.LANGUAGE) {
			var lang = this.supportedLangauges[args.LANGUAGE - 1].text;
		}

		var jsonReq = {
		  'q': args.WORDS,
		  'target': lang
		};
		var tempThis = this;
		var translatePromise = new Promise((resolve, reject) => {
         nets({
                method: 'POST',
                url: urlBase,
                json: jsonReq
            }, (err, res, body) => {
                if (err) return reject(err);
                if (res.statusCode !== 200) {
                	console.log('error! ' + res);
                	return reject(body);
                } 
                var translated = body.data.translations[0].translatedText;
                console.log('translated: ' + translated);
                resolve(translated);
                tempThis.translatedText = translated;
                // Cache what we just translated so we don't keep making the
                // same call over and over.
                // TODO: figure out whether we need to do this.
                tempThis.lastTextTranslated = args.WORDS;
                tempThis.lastLangTranslated = args.LANGUAGE;
                return translated;
	        });

     	});
		translatePromise.then((translatedText) => {
			return translatedText;
		});
		return translatePromise;
    }
}
module.exports = Scratch3TranslateBlocks;

