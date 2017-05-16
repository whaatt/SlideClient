/*
 * File: index.js
 * Type: Module Index
 * Exports the SlideClient.
 *
 * Note: There is NO validation of
 * function parameters in the client
 * API. Passing invalid parameters or
 * not passing parameters will result
 * in UNDEFINED behavior.
 *
 * Additional Note: A Promise-based
 * interface is available by leaving
 * off any trailing callback parameters
 * and calling functionAsync instead of
 * function for any given function name.
 */

// For sanity.
'use strict';

// Locator prefixes.
const LOGIN_PREFIX = 'login/';
const STREAM_PREFIX = 'stream/';
const LOCKED_PREFIX = 'locked/';
const QUEUE_PREFIX = 'queue/';
const AUTOPLAY_PREFIX = 'autoplay/';
const SUGGESTION_PREFIX = 'suggestion/';

// RPC agent endpoints.
const EDIT_STREAM_SETTINGS = 'edit-stream-settings';
const KEEP_STREAM_ALIVE = 'keep-stream-alive';
const REGISTER_WITH_STREAM = 'register-with-stream';

// Various intervals.
const LOGIN_TIMEOUT = 3000;
const KEEP_ALIVE_INTERVAL = 15000;

// Error objects.
const Errors = {
  already: new Error('You are already logged in to Slide.'),
  auth: new Error('You must authenticate a user first.'),
  busy: new Error('You cannot stream and join a stream at the same time.'),
  callbacks: new Error('Could not instantiate client callbacks.'),
  dead: new Error('You are not part of an active stream.'),
  login: new Error('Could not login with supplied credentials.'),
  permission: new Error('Insufficient permissions to use stream.'),
  stream: new Error('Reinitialization of the stream failed.')
};

// The SlideClient is basically a nice shim over this.
const Deepstream = require('deepstream.io-client-js');

// Used to export promise-compatibility.
const Promise = require('bluebird');

/**
 * Constructor for SlideClient. Takes in a
 * server URI, and instantiates SlideClient.
 *
 * @constructor
 * @param {string} serverURI - The URI of the Deepstream server.
 */
function SlideClient(serverURI) {
  this.client = Deepstream(serverURI);
  this.authenticated = false;
  this.hostingStream = false;
  this.joinedStream = null;
  this.streamPing = null;
  this.username = null;

  // Generic connection error handler (private).
  this.errorHandler = function(error, event, topic) {
    // For now: just print error.
    console.log('Error:', error);
    console.log('Event:', event);
    console.log('Topic:', topic);
  };

  // Instantiate error handler.
  this.client.on('error', this.errorHandler);

  // Data callbacks for view.
  this.streamDataCB = null;
  this.lockedCB = null;
  this.queueCB = null;
  this.autoplayCB = null;
  this.suggestionCB = null;
  this.trackCBS = {};
}

/**
 * Gets the current state of the SlideClient.
 */
SlideClient.prototype.state = function() {
  let clientObject = this;
  return {
    connected: true, // TODO.
    username: clientObject.username,
    authenticated: clientObject.authenticated,
    hostingStream: clientObject.hostingStream,
    joinedStream: clientObject.joinedStream
  };
};

/**
 * Sets view callbacks on the data of a stream.
 *
 * @param {string} stream - The stream in question.
 * @param {map<function>} dataCallbacks - A map from properties to callbacks.
 * @param {function} callback - Node-style callback for result.
 */
SlideClient.prototype.streamCallbacks = function(stream, dataCallbacks,
  callback) {
  // In this and all subsequent functions, we use this as a fallback.
  if (callback === undefined) callback = (error, data) => false;
  let clientObject = this;

  // Auto-determine stream.
  if (stream === null) {
    stream = clientObject.hostingStream ? clientObject.username
                                        : clientObject.joinedStream;
    // No running stream.
    if (stream === null) {
      callback(Errors.dead, null);
      return;
    }
  }

  // Locator names for convenience.
  const streamLocator = STREAM_PREFIX + stream;
  const lockedLocator = LOCKED_PREFIX + stream;
  const queueLocator = QUEUE_PREFIX + stream;
  const autoplayLocator = AUTOPLAY_PREFIX + stream;
  const suggestionLocator = SUGGESTION_PREFIX + stream;

  // The stream record is necessary to fetch the other records.
  const streamRecord = clientObject.client.record.getRecord(streamLocator);

  // Wait for record to be ready.
  streamRecord.whenReady((sRecord) => {
    // Get rid of stream data callback.
    if (this.streamDataCB !== null) {
      sRecord.unsubscribe(this.streamDataCB);
      this.streamDataCB = null;
      sRecord.discard();
    }

    // Install the new one if we can.
    if (dataCallbacks.streamData) {
      this.streamDataCB = (data) => {
        // TODO: More stuff goes here.
        dataCallbacks.streamData(data);
      };

      // Re-add the callback and trigger it.
      sRecord.subscribe(this.streamDataCB, true);
    }

    // Queue, locked, and autoplay are only
    // visible if the stream is not limited.
    if (sRecord.get('limited') === false) {
      // Do the same process for each of the subsidiary lists.
      const lockedRecord = clientObject.client.record.getList(lockedLocator);
      lockedRecord.whenReady((lRecord) => {
        // Get rid of locked callback.
        if (this.lockedCB !== null) {
          lRecord.unsubscribe(this.lockedCB);
          this.lockedCB = null;
          lRecord.discard();
        }

        // Install the new one if we can.
        if (dataCallbacks.locked) {
          this.lockedCB = (data) => {
            // TODO: More stuff goes here.
            dataCallbacks.locked(data);
          };

          // Re-add the callback and trigger it.
          lRecord.subscribe(this.lockedCB, true);
        }
      });

      // Do the same process for each of the subsidiary lists.
      const queueRecord = clientObject.client.record.getList(queueLocator);
      queueRecord.whenReady((qRecord) => {
        // Get rid of queue callback.
        if (this.queueCB !== null) {
          qRecord.unsubscribe(this.queueCB);
          this.queueCB = null;
          qRecord.discard();
        }

        // Install the new one if we can.
        if (dataCallbacks.queue) {
          this.queueCB = (data) => {
            // TODO: More stuff goes here.
            dataCallbacks.queue(data);
          };

          // Re-add the callback and trigger it.
          qRecord.subscribe(this.queueCB);
        }
      });

      // Do the same process for each of the subsidiary lists.
      const autoplayRecord = clientObject.client.record
        .getList(autoplayLocator);
      autoplayRecord.whenReady((aRecord) => {
        // Get rid of autoplay callback.
        if (this.autoplayCB !== null) {
          aRecord.unsubscribe(this.autoplayCB);
          this.autoplayCB = null;
          aRecord.discard();
        }

        // Install the new one if we can.
        if (dataCallbacks.autoplay) {
          this.autoplayCB = (data) => {
            // TODO: More stuff goes here.
            dataCallbacks.autoplay(data);
          };

          // Re-add the callback and trigger it.
          aRecord.subscribe(this.autoplayCB);
        }
      });
    }

    // Do the same process for each of the subsidiary lists.
    const suggestionRecord = clientObject.client.record
      .getList(suggestionLocator);
    suggestionRecord.whenReady((gRecord) => {
      // Get rid of suggestion callback.
      if (this.suggestionCB !== null) {
        gRecord.unsubscribe(this.suggestionCB);
        this.suggestionCB = null;
        gRecord.discard();
      }

      // Install the new one if we can.
      if (dataCallbacks.suggestion) {
        this.suggestionCB = (data) => {
          // TODO: More stuff goes here.
          dataCallbacks.suggestion(data);
        };

        // Re-add the callback and trigger it.
        gRecord.subscribe(this.suggestionCB);
      }
    });

    // TODO: Failures?
    callback(null, null);
  });
};

/**
 * Logs the user in. This involves sending the login
 * event, and then waiting for confirmation from an
 * event listener on the login event.
 *
 * @param {string} username - Username logging in.
 * @param {string} UUID - UUID for the given username.
 * @param {function} callback - Node-style callback for result.
 */
SlideClient.prototype.login = function(username, UUID, callback) {
  if (callback === undefined) callback = (error, data) => false;
  let clientObject = this;
  let timeoutTimer;

  // Cannot log in if already logged in.
  if (clientObject.authenticated) {
    callback(Errors.already, null);
    return;
  }

  // Called if login successful.
  const loggedIn = (data) => {
    clearTimeout(timeoutTimer);
    clientObject.client.event.unsubscribe(LOGIN_PREFIX + username, loggedIn);
    clientObject.authenticated = true;
    callback(null, null);
  };

  // Called if login times out.
  const loginTimeout = () => {
    clearTimeout(timeoutTimer);
    callback(Errors.login, null);
  };

  clientObject.username = username;
  clientObject.client.event.subscribe(LOGIN_PREFIX + username, loggedIn);
  timeoutTimer = setTimeout(loginTimeout, LOGIN_TIMEOUT);
  clientObject.client.login({ username: username, UUID: UUID });
};

/**
 * Initializes or reinitializes the logged in user
 * stream with the passed parameters. User must have
 * called login() first, or this function will fail.
 *
 * @param {string} live - Toggles whether the stream is running.
 * @param {string} privateMode - Sets stream visibility to private.
 * @param {string} voting - Sets voting on or off for the stream.
 * @param {string} autopilot - Sets autopilot on or off for the stream.
 * @param {string} limited - Makes list visibility limited for the stream.
 * @param {map<function>} dataCallbacks - A map from properties to callbacks.
 * @param {function} callback - Node-style callback for result.
 */
SlideClient.prototype.stream = function(live, privateMode, voting, autopilot,
  limited, dataCallbacks, callback) {
  if (callback === undefined) callback = (error, data) => false;
  let clientObject = this;
  // Explicitly enforced to avoid bugs.
  if (!clientObject.authenticated)
    callback(Errors.auth, null);
  // Cannot host a stream AND be part of one.
  else if (clientObject.joinedStream !== null)
    callback(Errors.busy, null);
  else {
    const keepAliveCall = {
      username: clientObject.username,
      stream: clientObject.username
    };

    const streamCall = {
      username: clientObject.username,
      stream: clientObject.username,
      live: live,
      private: privateMode,
      voting: voting,
      autopilot: autopilot,
      limited: limited
    };

    // Make the RPC call to [re]initialize a stream and create CBS.
    clientObject.client.rpc.make(EDIT_STREAM_SETTINGS, streamCall,
      (error, data) => {
      if (error) callback(Errors.stream, null);
      else {
        // Start stream keep-alive ping.
        if (!clientObject.hostingStream && live === true) {
          clientObject.hostingStream = true;
          clientObject.streamPing = setInterval(() =>
            clientObject.client.rpc.make(KEEP_STREAM_ALIVE, keepAliveCall,
              (error, data) => true /* TODO: What goes here? */)
          , KEEP_ALIVE_INTERVAL);
        }

        // Disable streaming.
        else if (live === false) {
          clientObject.hostingStream = false;
          clearInterval(clientObject.streamPing);
          clientObject.streamPing = null;
        }

        // Instantiate the new callbacks passed to stream.
        clientObject.streamCallbacks(null, dataCallbacks, (error, data) => {
          if (error) callback(Errors.callbacks, null);
          else callback(null, null);
        });
      }
    });
  }
};

/**
 * Joins a stream and instantiates relevant data callbacks.
 *
 * @param {string} stream - The stream you are trying to join.
 * @param {map<function>} dataCallbacks - A map from properties to callbacks.
 * @param {function} callback - Node-style callback for result.
 */
SlideClient.prototype.join = function(stream, dataCallbacks, callback) {
  if (callback === undefined) callback = (error, data) => false;
  const clientObject = this;
  // Explicitly enforced to avoid bugs.
  if (!clientObject.authenticated)
    callback(Errors.auth, null);
  // Cannot host and join at same time.
  else if (clientObject.hostingStream)
    callback(Errors.busy, null);
  else {
    const registerCall = {
      username: clientObject.username,
      stream: stream,
      password: 'default'
    };

    // Register with the stream and register any callbacks passed to join.
    clientObject.client.rpc.make(REGISTER_WITH_STREAM, registerCall,
      (error, data) => {
      if (error) callback(Errors.permission, null);
      else {
        this.joinedStream = stream;
        clientObject.streamCallbacks(null, dataCallbacks, (error, data) => {
          if (error) callback(Errors.callbacks, null);
          else callback(null, null);
        });
      }
    });
  }
}

// Export the class (in both NodeBack and Promises).
Promise.promisifyAll(SlideClient.prototype);
module.exports = SlideClient
