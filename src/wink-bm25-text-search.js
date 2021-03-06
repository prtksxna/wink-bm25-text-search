//     wink-bm25-text-search
//     Configurable BM25 Text Search Engine with simple
//     semantic search support.
//
//     Copyright (C) 2017  GRAYPE Systems Private Limited
//
//     This file is part of “wink-bm25-text-search”.
//
//     “wink-bm25-search” is free software: you can redistribute it
//     and/or modify it under the terms of the GNU Affero
//     General Public License as published by the Free
//     Software Foundation, version 3 of the License.
//
//     “wink-bm25-text-search” is distributed in the hope that it will
//     be useful, but WITHOUT ANY WARRANTY; without even
//     the implied warranty of MERCHANTABILITY or FITNESS
//     FOR A PARTICULAR PURPOSE.  See the GNU Affero General
//     Public License for more details.
//
//     You should have received a copy of the GNU Affero
//     General Public License along with “wink-bm25-text-search”.
//     If not, see <http://www.gnu.org/licenses/>.

//
var helpers = require( 'wink-helpers' );

/* eslint guard-for-in: 0 */

// It is a BM25F In-memory Search engine for text and exposes following
// methods:
// 1. `definePrepTasks` allows to define field-wise (optional) pipeline of
// functions that will be used to prepare each input prior to *search/predict*
// and *addDoc/learn*.
// 2. `defineConfig` sets up the configuration for *field-wise weights*
// and *BM25F parameters*.
// 3. `addDoc/learn` adds a document using its unique id. The document is supplied
// as an Javascript object, where each property is the field of the document
// and its value is the text.
// 4. `consolidate` learnings prior to search/predict.
// 5. `search/predict` searches for the input text and returns the resultant
// document ids, sorted by their relevance along with the score. The number of
// results returned can be controlled via a limit argument that defaults to **10**.
// 6. `exportJSON` exports the learnings in JSON format.
// 7. `importJSON` imports the learnings from JSON that may have been saved on disk.
// 8. `reset` all the learnings except the preparatory tasks.
var bm25fIMS = function () {
  // Preparatory tasks that are executed on the `addDoc` & `search` input.
  var pTasks = [];
  // And its count.
  var pTaskCount;
  // Field level prep tasks.
  var flds = Object.create( null );
  // Returned!
  var methods = Object.create( null );
  // Term Frequencies & length of each document.
  var documents = Object.create( null );
  // Inverted Index for faster search
  var invertedIdx = Object.create( null );
  // IDF for each tokens
  var idf = Object.create( null );
  // Set true on first call to `addDoc/learn` to prevent changing config.
  var learned = false;
  // The `addDoc()predict()` function checks for this being true; set
  // in `consolidate()`.
  var consolidated = false;
  // Total documents added.
  var totalDocs = 0;
  // Total number of tokens across all documents added.
  var totalCorpusLength = 0;
  // Their average.
  var avgCorpusLength = 0;
  // BM25F Configuration; set up in `defineConfig()`.
  var config = null;

  // ### Private functions

  // #### Perpare Input

  // Prepares the `input` by executing the pipeline of tasks defined in the
  // `field` specific `pTasks` set via `definePrepTasks()`.
  // If `field` is not specified then default `pTasks` are used.
  // If the `field` specific `pTasks` are not defined then it automatically
  // switches to default `pTasks`.
  var prepareInput = function ( input, field ) {
    var processedInput = input;
    var pt = ( flds[ field ] && flds[ field ].pTasks ) || pTasks;
    var ptc = ( flds[ field ] && flds[ field ].pTaskCount ) || pTaskCount;
    for ( var i = 0; i < ptc; i += 1 ) {
      processedInput = pt[ i ]( processedInput );
    }
    return ( processedInput );
  }; // prepareInput()

  // #### Update Freq

  // Updates the `freq` of each term in the `text` after pre-processing it via
  // `prepareInput()`; while updating, it takes care of `field's` `weight`.
  var updateFreq = function ( id, text, weight, freq, field ) {
    // Tokenized `text`.
    var tkns = prepareInput( text, field );
    // Temp token holder.
    var t;
    for ( var i = 0, imax = tkns.length; i < imax; i += 1 ) {
      t = tkns[ i ];
      if ( freq[ t ] === undefined ) {
        freq[ t ] = weight;
        invertedIdx[ t ] = invertedIdx[ t ] || [];
        invertedIdx[ t ].push( id );
      } else {
        freq[ t ] += weight;
      }
    }
    // Length can not be negative!
    return ( tkns.length * Math.abs( weight ) );
  }; // updateFreq()

  // ### Exposed Functions

  // #### Define Prep Tasks

  // Defines the `tasks` required to prepare the input for `addDoc` and `search()`
  // The `tasks` should be an array of functions; using these function a simple
  // pipeline is built to serially transform the input to the output.
  // It validates the `tasks` before updating the `pTasks`.
  // If validation fails it throws an appropriate error.
  // Tasks can be defined separately for each field. However if the field is not
  // specified (i.e. `null` or `undefined`), then the `tasks` become default.
  // Note, `field = 'search'` is reserved for prep tasks for search string; However
  // if the same is not specified, the default tasks are used for pre-processing.
  var definePrepTasks = function ( tasks, field ) {
    if ( !helpers.array.isArray( tasks ) ) throw Error( 'winkBM25S: Tasks should be an array, instead found: ' + JSON.stringify( tasks ) );
    for ( var i = 0, imax = tasks.length; i < imax; i += 1 ) {
      if ( typeof tasks[ i ] !== 'function' ) throw Error( 'winkBM25S: Tasks should contain function, instead found: ' + ( typeof tasks[ i ] ) );
    }
    if ( field === undefined || field === null ) {
      pTasks = tasks;
      pTaskCount = tasks.length;
    } else {
      if ( typeof field !== 'string' ) throw Error( 'winkBM25S: Field should be string, instead found: ' + ( typeof field ) );
      flds[ field ] = flds[ field ] || Object.create( null );
      flds[ field ].pTasks = tasks;
      flds[ field ].pTaskCount = tasks.length;
    }
    return tasks.length;
  }; // definePrepTasks()

  // #### Define Config

  // Defines the configuration for BM25F using `fldWeights` and `bm25Params`
  // properties of `cfg` object.</br>
  // The `fldWeights` defines the weight for each field of the document. This gives
  // a semantic nudge to search and are used as a mutiplier to the count
  // (frequency) of each token contained in that field of the document. It should
  // be a JS object containing `field-name/value` pairs. If a field's weight is
  // not defined, that field is **ignored**. The field weights must be defined before
  // attempting to add a document via `addDoc()`; they can only be defined once.
  // If any document's field is not defined here then that field is **ignored**.
  // </br>
  // The `k`, `b` and `k1` properties of `bm25Params` object define the smoothing
  // factor for IDF, degree of normalization for TF, and saturation control factor
  // respectively for the BM25F. Their default values are **1**, **0.75**, and
  // **1.2**.
  var defineConfig = function ( cfg ) {
    if ( learned ) {
      throw Error( 'winkBM25S: config must be defined before learning/addition starts!' );
    }
    if ( !helpers.object.isObject( cfg ) ) {
      throw Error( 'winkBM25S: config must be a config object, instead found: ' + JSON.stringify( cfg ) );
    }
    // If `fldWeights` are absent throw error.
    if ( !helpers.object.isObject( cfg.fldWeights ) ) {
      throw Error( 'winkBM25S: fldWeights must be an object, instead found: ' + JSON.stringify( cfg.fldWeights ) );
    }
    // There should be at least one defined field!
    if ( ( helpers.object.keys( cfg.fldWeights ) ).length === 0 ) {
      throw Error( 'winkBM25S: Field config has no field defined.' );
    }
    // Setup configuration now.
    config = Object.create( null );
      // Field config for BM25**F**
    config.fldWeights = Object.create( null );
    config.bm25Params = Object.create( null );
    // **Controls TF part:**<br/>
    // `k1` controls saturation of token's frequency; higher value delays saturation
    // with increase in frequency.
    config.bm25Params.k1 = 1.2;
    // `b` controls the degree of normalization; **0** means no normalization and **1**
    // indicates complete normalization!
    config.bm25Params.b = 0.75;
    // **Controls IDF part:**<br/>
    // `k` acts as smoothing factor; should be >= 1 to ensure log does not result in
    // a **0** value!!
    config.bm25Params.k = 1;
    // Setup field weights.
    for ( var field in cfg.fldWeights ) {
      // The `null` check is required as `isNaN( null )` returns `false`!!
      if ( cfg.fldWeights[ field ] === null || isNaN( cfg.fldWeights[ field ] ) ) {
        throw Error( 'winkBM25S: Field weight should be number, instead found: ' + JSON.stringify( cfg.fldWeights[ field ] ) );
      }
      // Update config parameters from `cfg`.
      config.fldWeights[ field ] = ( +cfg.fldWeights[ field ] );
    }
    // Setup BM25F params.
    // Create `bm25Params` if absent in `cfg`.
    if ( !helpers.object.isObject( cfg.bm25Params ) ) cfg.bm25Params = Object.create( null );
    // Update config parameters from `cfg`.
    config.bm25Params.b = (
                            ( cfg.bm25Params.b === null ) ||
                            ( cfg.bm25Params.b === undefined ) ||
                            ( isNaN( cfg.bm25Params.b ) )
                          ) ? 0.75 : +cfg.bm25Params.b;

    // Update config parameters from `cfg`.
    config.bm25Params.k1 = (
                            ( cfg.bm25Params.k1 === null ) ||
                            ( cfg.bm25Params.k1 === undefined ) ||
                            ( isNaN( cfg.bm25Params.k1 ) )
                           ) ? 1.2 : +cfg.bm25Params.k1;

    // Update config parameters from `cfg`.
    config.bm25Params.k = (
                            ( cfg.bm25Params.k === null ) ||
                            ( cfg.bm25Params.k === undefined ) ||
                            ( isNaN( cfg.bm25Params.k ) )
                          ) ? 1 : +cfg.bm25Params.k;

    return true;
  }; // defineConfig()


  // #### Add Doc

  // Adds a document to the model using `updateFreq()` function.
  var addDoc = function ( doc, id ) {
    if ( config === null ) {
      throw Error( 'winkBM25S: Config must be defined before adding a document.' );
    }
    var fldWeights = config.fldWeights;
    // No point in adding/learning further in absence of consolidated.
    if ( consolidated ) {
      throw Error( 'winkBM25S: post consolidation adding/learning is not possible!' );
    }
    // Set learning/addition started.
    learned = true;
    var length;
    if ( documents[ id ] !== undefined ) {
      throw Error( 'winkBM25S: Duplicate document encountered: ' + JSON.stringify( id ) );
    }
    documents[ id ] = Object.create( null );
    documents[ id ].freq = Object.create( null );
    documents[ id ].length = 0;
    for ( var field in fldWeights ) {
      if ( doc[ field ] === undefined ) {
        throw Error( 'winkBM25S: Missing field in the document: ' + JSON.stringify( field ) );
      }
      length = updateFreq( id, doc[ field ], fldWeights[ field ], documents[ id ].freq, field );
      documents[ id ].length += length;
      totalCorpusLength += length;
    }
    totalDocs += 1;
    return ( totalDocs );
  }; // addDoc()

  // #### Consolidate

  // Consolidates the data structure of bm25 and computes the IDF. This must be
  // built before using the `search` function.
  var consolidate = function ( ) {
    if ( totalDocs < 3 ) {
      throw Error( 'winkBM25S: document collection is too small for consolidation; add more docs!' );
    }
    // Using the commonly used names but unfortunately they are very cryptic and
    // *short*. **Must not use these variable names elsewhere**.
    var b = config.bm25Params.b;
    var k1 = config.bm25Params.k1;
    var k = config.bm25Params.k;
    var freq, id, n, normalizationFactor, t;
    avgCorpusLength = totalCorpusLength / totalDocs;
    // Consolidate: update document frequencies.

    for ( id in documents ) {
      normalizationFactor = ( 1 - b ) + ( b * ( documents[ id ].length / avgCorpusLength ) );
      for ( t in documents[ id ].freq ) {
        freq = documents[ id ].freq[ t ];
        // Update frequency but ensure the sign is carefully preserved as the
        // magnitude of `k1` can jeopardize the sign!
        documents[ id ].freq[ t ] = Math.sign( freq ) * Math.abs( ( freq * ( k1 + 1 ) ) / ( ( k1 * normalizationFactor ) + freq ) );
        // To be uncommented to probe values!
        // console.log( '%s, %s, %d', id, t, documents[ id ].freq[ t ] );
      }
    }
    // Consolidate: compute idf.
    for ( t in invertedIdx ) {
      n = invertedIdx[ t ].length;
      idf[ t ] = Math.log( ( ( totalDocs - n ) / totalDocs ) + k );
      // To be uncommented to probe values!
      // console.log( '%s, %d, %d, %d, %d', t, totalDocs, n, k, idf[ t ] );
    }
    // Set `consolidated` as `true`.
    consolidated = true;
    return true;
  }; // consolidate()

  // #### Search

  // Searches the `text` and return `limit` results. If `limit` is not sepcified
  // then it will return a maximum of **10** results. The `result` is an array of
  // containing `doc id` and `score` pairs array. If the `text` is not found, an
  // empty array is returned. The `text` must be a string.
  var search = function ( text, limit ) {
    // Predict/Search only if learnings have been consolidated!
    if ( !consolidated ) {
      throw Error( 'winkBM25S: search is not possible unless learnings are consolidated!' );
    }
    if ( typeof text !== 'string' ) {
      throw Error( 'winkBM25S: search text should be a string, instead found: ' + ( typeof text ) );
    }
    // Tokenized `text`. Use search specific weights.
    var tkns = prepareInput( text, 'search' );
    // Search results go here as doc id/score pairs.
    var results = Object.create( null );
    // Helper variables.
    var id, ids, t;
    var i, imax, j, jmax;
    // Iterate for every token in the preapred text.
    for ( j = 0, jmax = tkns.length; j < jmax; j += 1 ) {
      t = tkns[ j ];
      // Use Inverted to look up - accelerates search!
      ids = invertedIdx[ t ];
      if ( ids !== undefined ) {
        // Means the token exists in the vocabulary!
        // Compute scores for every document.
        for ( i = 0, imax = ids.length; i < imax; i += 1 ) {
          id = ids[ i ];
          results[ id ] = ( documents[ id ].freq[ t ] * idf[ t ] ) + ( results[ id ] || 0 );
          // To be uncommented to probe values!
          /* console.log( '%s, %d, %d, %d', t, documents[ id ].freq[ t ], idf[ t ], results[ id ] ); */
        }
      }
    }
    // Convert to a table in `[ id, score ]` format; sort and slice required number
    // of resultant documents.
    return ( ( helpers.object.table( results ) )
                .sort( helpers.array.descendingOnValue )
                .slice( 0, Math.max( ( limit || 10 ), 1 ) )
           );
  }; // search()

  // #### Reset

  // Resets the BM25F completely by re-initializing all the learning
  // related variables, except the preparatory tasks.
  var reset = function () {
    // Reset values of variables that are associated with learning; Therefore
    // `pTasks` & `pTaskCount` are not re-initialized.
    // Term Frequencies & length of each document.
    documents = Object.create( null );
    // Inverted Index for faster search
    invertedIdx = Object.create( null );
    // IDF for each tokens
    idf = Object.create( null );
    // Set true on first call to `addDoc/learn` to prevent changing config.
    learned = false;
    // The `addDoc()predict()` function checks for this being true; set
    // in `consolidate()`.
    consolidated = false;
    // Total documents added.
    totalDocs = 0;
    // Total number of tokens across all documents added.
    totalCorpusLength = 0;
    // Their average.
    avgCorpusLength = 0;
    // BM25F Configuration; set up in `defineConfig()`.
    config = null;
    return true;
  }; // reset()

  // #### Export JSON

  // Returns the learnings, without any consolidation check, in JSON format.
  var exportJSON = function ( ) {
    var docStats = Object.create( null );
    docStats.totalCorpusLength = totalCorpusLength;
    docStats.totalDocs = totalDocs;
    return ( JSON.stringify( [ config, docStats, documents, invertedIdx ] ) );
  }; // exportJSON()

  // #### Import JSON

  // Imports the `json` in to learnings after validating the format of input JSON.
  // If validation fails then throws error; otherwise on success import it
  // returns `true`. Note, importing leads to resetting the classifier.
  var importJSON = function ( json ) {
    if ( !json ) {
      throw Error( 'winkBM25S: undefined or null JSON encountered, import failed!' );
    }
    // Validate json format
    var isOK = [
      helpers.object.isObject,
      helpers.object.isObject,
      helpers.object.isObject,
      helpers.object.isObject
    ];
    var parsedJSON = JSON.parse( json );
    if ( !helpers.array.isArray( parsedJSON ) || parsedJSON.length !== isOK.length ) {
      throw Error( 'winkBM25S: invalid JSON encountered, can not import.' );
    }
    for ( var i = 0; i < isOK.length; i += 1 ) {
      if ( !isOK[ i ]( parsedJSON[ i ] ) ) {
        throw Error( 'winkBM25S: invalid JSON encountered, can not import.' );
      }
    }
    // All good, setup variable values.
    // First reset everything.
    reset();
    // To prevent config change.
    learned = true;
    // Load variable values.
    config = parsedJSON[ 0 ];
    totalCorpusLength = parsedJSON[ 1 ].totalCorpusLength;
    totalDocs = parsedJSON[ 1 ].totalDocs;
    documents = parsedJSON[ 2 ];
    invertedIdx = parsedJSON[ 3 ];
    // Return success.
    return true;
  }; // importJSON()

  methods.definePrepTasks = definePrepTasks;
  methods.defineConfig = defineConfig;
  methods.addDoc = addDoc;
  methods.consolidate = consolidate;
  methods.search = search;
  methods.exportJSON = exportJSON;
  methods.importJSON = importJSON;
  methods.reset = reset;
  // Aliases to keep APIs uniform across.
  methods.learn = addDoc;
  methods.predict = search;

  return ( methods );
}; // bm25fIMS()

module.exports = bm25fIMS;
