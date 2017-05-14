/*
 * File: index.js
 * Type: Module Index
 * Exports the SlideClient.
 */

// Useful constants.
const LOGIN = 'login/';
const LOGIN_TIMEOUT = 3000;

// Error objects.
let Errors = {
  login: new Error('Could not login with supplied credentials.')
};

// The SlideClient is basically a nice shim over this.
const Deepstream = require('deepstream.io-client-js');

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
  this.username = null;
}

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
  let clientObject = this;
  let timeoutTimer;

  // Called if login successful.
  const loggedIn = (data) => {
    clearTimeout(timeoutTimer);
    client.event.unsubscribe(LOGIN + username, loggedIn);
    clientObject.authenticated = true;
    callback(null, null);
  };

  // Called if login times out.
  const loginTimeout = () => {
    clearTimeout(timeoutTimer);
    callback(Errors.login, null);
  };

  clientObject.username = username;
  client.event.subscribe('login/' + username, loggedIn);
  timeoutTimer = setTimeout(LOGIN_TIMEOUT, loginTimeout);
  client.login({ username: username, UUID: UUID });
};

// Export the class.
module.exports = SlideClient;
