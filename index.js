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
const DEREGISTER_FROM_STREAM = 'deregister-from-stream';

// Various intervals.
const LOGIN_TIMEOUT = 3000;
const KEEP_ALIVE_INTERVAL = 15000;
const INACTIVITY_THRESHOLD = 60000;

// Error objects.
const Errors = {
  already: new Error('You are already logged in to Slide.'),
  auth: new Error('You must authenticate a user first.'),
  busy: new Error('You cannot stream and join a stream at the same time.'),
  callbacks: new Error('Could not instantiate client callbacks.'),
  dead: new Error('You are not part of an active stream.'),
  login: new Error('Could not login with supplied credentials.'),
  permission: new Error('Insufficient permissions or re-registration.'),
  stream: new Error('Reinitialization of the stream failed.'),
  unknown: new Error('An unknown server error occurred.')
};

/**
 * A generic Node-style callback.
 *
 * @callback requestCallback
 * @param {Error} error - The operation error if any.
 * @param {Object} data - The operation data if any.
 */

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
  let clientObject = this;
  clientObject.client = null;
  clientObject.serverURI = serverURI;
  clientObject.authenticated = false;
  clientObject.hostingStream = false;
  clientObject.joinedStream = null;
  clientObject.streamPing = null;
  clientObject.streamDeadCB = null;
  clientObject.disconnectCB = null;
  clientObject.username = null;

  // Closes connection and resets client.
  clientObject.reset = function(callback) {
    clientObject.client.close();

    // Wait for the closed connection to register.
    clientObject.client.on('connectionStateChanged', state => {
      if (state === Deepstream.CONSTANTS.CONNECTION_STATE.CLOSED) {
        // Reset client properties.
        clientObject.authenticated = false;
        clientObject.hostingStream = false;
        clientObject.joinedStream = null;
        clientObject.streamPing = null;
        clientObject.streamDeadCB = null;
        clientObject.username = null;

        // Reset data callbacks.
        clientObject.streamDataCB = null;
        clientObject.lockedCB = null;
        clientObject.queueCB = null;
        clientObject.autoplayCB = null;
        clientObject.suggestionCB = null;
        clientObject.trackCBS = {};

        // Call disconnect handler.
        clientObject.disconnectCB();
        callback(null, null);
      }
    });
  };

  // Generic Deepstream error handler (private).
  clientObject.errorHandler = function(error, event, topic) {
    // Connection error case.
    if (event === 'connectionError')
      clientObject.reset((error, data) => null);
    // Handle messages being denied on current stream.
    else if (error === Deepstream.CONSTANTS.EVENT.MESSAGE_DENIED &&
      clientObject.joinedStream !== null && topic === 'R' &&
      event === STREAM_PREFIX + clientObject.joinedStream) {
      // Leave the stream (no permissions)
      // and implicitly fire the dead CB.
      clientObject.leave((error, data) => true);
    } else {
      // Print any unhandled error.
      console.log('Unhandled Error!');
      console.log('Error:', error);
      console.log('Event:', event);
      console.log('Topic:', topic);
    }
  };

  // Data callbacks for view.
  clientObject.streamDataCB = null;
  clientObject.lockedCB = null;
  clientObject.queueCB = null;
  clientObject.autoplayCB = null;
  clientObject.suggestionCB = null;
  clientObject.trackCBS = {};
}

/**
 * Gets the current state of the SlideClient.
 *
 * @param {requestCallback} callback - Node-style callback for result.
 * @returns {Object} Contains authentication data and stream status.
 */
SlideClient.prototype.getState = function(callback) {
  let clientObject = this;
  const state = {
    username: clientObject.username,
    authenticated: clientObject.authenticated,
    hostingStream: clientObject.hostingStream,
    joinedStream: clientObject.joinedStream
  };

  // Compatibility with Promises.
  if (callback !== undefined)
    callback(null, state);
  else return state;
};

/**
 * Sets view callbacks on the data of a stream.
 *
 * @param {string} stream - The stream in question.
 * @param {Object} dataCallbacks - A map from properties to callbacks.
 * @param {Function} dataCallbacks.streamData - A callback for new stream data.
 * @param {Function} dataCallbacks.locked - A callback for locked list data.
 * @param {Function} dataCallbacks.queue - A callback for queue list data.
 * @param {Function} dataCallbacks.autoplay - A callback for autoplay list data.
 * @param {Function} dataCallbacks.suggestion - A callback for suggestion list data.
 * @param {requestCallback} callback - Node-style callback for result.
 */
SlideClient.prototype.setStreamCallbacks = function(stream, dataCallbacks,
  callback) {
  // In this and all subsequent functions, we use this as a fallback.
  if (callback === undefined) callback = (error, data) => null;
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
    if (clientObject.streamDataCB !== null) {
      sRecord.unsubscribe(clientObject.streamDataCB);
      clientObject.streamDataCB = null;
      sRecord.discard();
    }

    // Install the new one if we can.
    if (dataCallbacks.streamData) {
      clientObject.streamDataCB = (data) => {
        // TODO: More stuff goes here.
        dataCallbacks.streamData(data);
      };

      // Re-add the callback and trigger it.
      sRecord.subscribe(clientObject.streamDataCB, true);
    }

    // Queue, locked, and autoplay are only
    // visible if the stream is not limited.
    if (sRecord.get('limited') === false) {
      // Do the same process for each of the subsidiary lists.
      const lockedRecord = clientObject.client.record.getList(lockedLocator);
      lockedRecord.whenReady((lRecord) => {
        // Get rid of locked callback.
        if (clientObject.lockedCB !== null) {
          lRecord.unsubscribe(clientObject.lockedCB);
          clientObject.lockedCB = null;
          lRecord.discard();
        }

        // Install the new one if we can.
        if (dataCallbacks.locked) {
          clientObject.lockedCB = (data) => {
            // TODO: More stuff goes here.
            dataCallbacks.locked(data);
          };

          // Re-add the callback and trigger it.
          lRecord.subscribe(clientObject.lockedCB, true);
        }
      });

      // Do the same process for each of the subsidiary lists.
      const queueRecord = clientObject.client.record.getList(queueLocator);
      queueRecord.whenReady((qRecord) => {
        // Get rid of queue callback.
        if (clientObject.queueCB !== null) {
          qRecord.unsubscribe(clientObject.queueCB);
          clientObject.queueCB = null;
          qRecord.discard();
        }

        // Install the new one if we can.
        if (dataCallbacks.queue) {
          clientObject.queueCB = (data) => {
            // TODO: More stuff goes here.
            dataCallbacks.queue(data);
          };

          // Re-add the callback and trigger it.
          qRecord.subscribe(clientObject.queueCB);
        }
      });

      // Do the same process for each of the subsidiary lists.
      const autoplayRecord = clientObject.client.record
        .getList(autoplayLocator);
      autoplayRecord.whenReady((aRecord) => {
        // Get rid of autoplay callback.
        if (clientObject.autoplayCB !== null) {
          aRecord.unsubscribe(clientObject.autoplayCB);
          clientObject.autoplayCB = null;
          aRecord.discard();
        }

        // Install the new one if we can.
        if (dataCallbacks.autoplay) {
          clientObject.autoplayCB = (data) => {
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
      if (clientObject.suggestionCB !== null) {
        gRecord.unsubscribe(clientObject.suggestionCB);
        clientObject.suggestionCB = null;
        gRecord.discard();
      }

      // Install the new one if we can.
      if (dataCallbacks.suggestion) {
        clientObject.suggestionCB = (data) => {
          // TODO: More stuff goes here.
          dataCallbacks.suggestion(data);
        };

        // Re-add the callback and trigger it.
        gRecord.subscribe(clientObject.suggestionCB);
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
 * @param {Function} disconnectCB - Called on disconnect from server.
 * @param {requestCallback} callback - Node-style callback for result.
 */
SlideClient.prototype.login = function(username, UUID, disconnectCB,
  callback) {
  if (disconnectCB === undefined) disconnectCB = (error, data) => false;
  if (callback === undefined) callback = (error, data) => null;
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
    clientObject.disconnectCB = disconnectCB;
    callback(null, null);
  };

  // Called if login times out.
  const loginTimeout = () => {
    clearTimeout(timeoutTimer);
    callback(Errors.login, null);
  };

  // Instantiate the quarantined connection to Deepstream.
  clientObject.client = Deepstream(clientObject.serverURI);
  clientObject.client.on('error', clientObject.errorHandler);

  // Authenticate this connection.
  clientObject.username = username;
  clientObject.client.event.subscribe(LOGIN_PREFIX + username, loggedIn);
  timeoutTimer = setTimeout(loginTimeout, LOGIN_TIMEOUT);
  clientObject.client.login({ username: username, UUID: UUID });
};

/**
 * Logs the user out. This function will perform any
 * clean-up that is necessary on joined/hosted streams.
 *
 * @param {requestCallback} callback - Node-style callback for result.
 */
SlideClient.prototype.logout = function(callback) {
  if (callback === undefined) callback = (error, data) => null;
  let clientObject = this;

  // Cannot log out if not already logged in.
  if (clientObject.authenticated === false) {
    callback(Errors.auth, null);
    return;
  }

  // First: Gracefully leave the joined
  // stream or stop hosting the stream.
  new Promise((resolve, reject) => {
    if (clientObject.joinedStream !== null)
      clientObject.leave((error, data) => resolve(data))
    else if (clientObject.hostingStream === true)
      clientObject.stream({ live: false }, {},
        (error, data) => resolve(data));
    else resolve(null);
  })
    .then(() => {
      // Then: Disconnect client.
      return new Promise((resolve, reject) =>
        clientObject.reset((error, data) => resolve(data)));
    })
    // Propagate successful logout.
    .then((data) => callback(null, data));
};

/**
 * Initializes or reinitializes the logged in user
 * stream with the passed parameters. User must have
 * called login() first, or this function will fail.
 *
 * @param {object} settings - Stream settings object (see below for props).
 * @param {string} settings.live - Toggles whether the stream is running.
 * @param {string} settings.privateMode - Sets stream visibility to private.
 * @param {string} settings.voting - Sets voting on or off for the stream.
 * @param {string} settings.autopilot - Sets autopilot on or off.
 * @param {string} settings.limited - Makes list visibility limited.
 * @param {Object} dataCallbacks - A map from properties to callbacks.
 * @param {Function} dataCallbacks.streamData - A callback for new stream data.
 * @param {Function} dataCallbacks.locked - A callback for locked list data.
 * @param {Function} dataCallbacks.queue - A callback for queue list data.
 * @param {Function} dataCallbacks.autoplay - A callback for autoplay list data.
 * @param {Function} dataCallbacks.suggestion - A callback for suggestion list data.
 * @param {requestCallback} callback - Node-style callback for result.
 */
SlideClient.prototype.stream = function(settings, dataCallbacks, callback) {
  if (callback === undefined) callback = (error, data) => null;
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
      live: settings.live !== undefined
        ? settings.live : true,
      private: settings.privateMode !== undefined
        ? settings.privateMode : false,
      voting: settings.voting !== undefined
        ? settings.voting : false,
      autopilot: settings.autopilot !== undefined
        ? settings.autopilot : false,
      limited: settings.limited !== undefined
        ? settings.limited : false
    };

    // Make the RPC call to [re]initialize a stream and create CBS.
    clientObject.client.rpc.make(EDIT_STREAM_SETTINGS, streamCall,
      (error, data) => {
      if (error) callback(Errors.stream, null);
      else {
        // Start stream keep-alive ping.
        if (!clientObject.hostingStream && settings.live === true) {
          clientObject.hostingStream = true;
          clientObject.streamPing = setInterval(() =>
            clientObject.client.rpc.make(KEEP_STREAM_ALIVE, keepAliveCall,
              (error, data) => true /* TODO: What goes here? */),
          KEEP_ALIVE_INTERVAL);
        }

        // Disable streaming.
        else if (settings.live === false) {
          clientObject.hostingStream = false;
          clearInterval(clientObject.streamPing);
          clientObject.streamPing = null;
        }

        // Instantiate the new callbacks passed to stream.
        clientObject.setStreamCallbacks(null, dataCallbacks, (error, data) => {
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
 * @param {Object} dataCallbacks - A map from properties to callbacks.
 * @param {Function} dataCallbacks.streamData - A callback for new stream data.
 * @param {Function} dataCallbacks.locked - A callback for locked list data.
 * @param {Function} dataCallbacks.queue - A callback for queue list data.
 * @param {Function} dataCallbacks.autoplay - A callback for autoplay list data.
 * @param {Function} dataCallbacks.suggestion - A callback for suggestion list data.
 * @param {function} deadCallback - Called when the stream goes dead somehow.
 * @param {requestCallback} callback - Node-style callback for result.
 */
SlideClient.prototype.join = function(stream, dataCallbacks, deadCallback,
  callback) {
  if (callback === undefined) callback = (error, data) => null;
  if (deadCallback === undefined) deadCallback = (error, data) => false;
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
        clientObject.joinedStream = stream;
        // Called on disconnect or loss of permissions.
        clientObject.streamDeadCB = deadCallback;

        // Joiner ping is to check activity status.
        clientObject.streamPing = setInterval(() => {
          let locator = STREAM_PREFIX + stream;
          let streamData = clientObject.client.record.getRecord(locator);
          streamData.whenReady((sRecord) => {
            const now = (new Date).getTime();
            // If the stream has been inactive for long enough of a
            // time, call leave on the stream and fire the dead CB.
            if (now - sRecord.get('timestamp') > INACTIVITY_THRESHOLD ||
              sRecord.get('live') === false) // Explicitly dead stream.
              clientObject.leave((error, data) => true);
          });
        }, KEEP_ALIVE_INTERVAL);

        // Register any callbacks passed to join using setStreamCallbacks().
        clientObject.setStreamCallbacks(null, dataCallbacks, (error, data) => {
          if (error) callback(Errors.callbacks, null);
          else callback(null, null);
        });
      }
    });
  }
}

/**
 * Leaves a stream and uninstantiates relevant data callbacks.
 *
 * @param {requestCallback} callback - Node-style callback for result.
 */
SlideClient.prototype.leave = function(callback) {
  if (callback === undefined) callback = (error, data) => null;
  const clientObject = this;
  // You can only leave a stream if you belong to one.
  if (clientObject.joinedStream === null)
    callback(Errors.dead, null);
  else {
    const deregisterCall = {
      username: clientObject.username,
      stream: clientObject.joinedStream
    };

    // Remove callbacks and then deregister. TODO: Keep an eye
    // on this function, and see if the potential race happens.
    clientObject.setStreamCallbacks(null, {}, (error, data) => {
      clearInterval(clientObject.streamPing); // Stop the ping.
      clientObject.client.rpc.make(DEREGISTER_FROM_STREAM, deregisterCall,
        (error, data) => {
        if (error) callback(Errors.unknown, null);
        else {
          clientObject.streamDeadCB();
          clientObject.joinedStream = null;
          clientObject.streamDeadCB = null;
          callback(null, null);
        }
      });
    });
  }
};

// SlideClient.prototype.createTrack = function(callback)

// Export the class (in both NodeBack and Promises).
Promise.promisifyAll(SlideClient.prototype);
module.exports = SlideClient;