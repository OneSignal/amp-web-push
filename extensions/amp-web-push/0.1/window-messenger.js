/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import {TAG, MessengerOptions, MessengerTopics} from './vars';
import {getData} from '../../../src/event-helper';
import {parseUrl} from '../../../src/url';
import {dev} from '../../../src/log';

 /**
 * @fileoverview
 * A Promise-based PostMessage helper to ease back-and-forth replies.
 *
 * This class is included separately a second time, by websites running
 * amp-web-push, as well as by other push vendors, in a remote
 * website's iframe. It should therefore keep external depenencies to a minimum,
 * since this class must be transpiled to ES5 and "duplicated" outside of the
 * AMP SDK bundle.
 */
export class WindowMessenger {

  /**
   * Set debug to true to get console logs anytime a message is received,
   * sent, or discarded.
   *
   * @param {MessengerOptions} options
   */
  constructor(options) {
    if (!options) {
      options = {
        debug: false,
        windowContext: window,
      };
    }
    /*
     * A map of randomly generated transient unique message IDs to metadata
     * describing incoming replies and outgoing sends. Just used to internally
     * keep track of replies and sends.
     */
    this.messages = {};
    /**
     * A map of string topic names to callbacks listeners interested in replies
     * to the topic.
     *
     * @type {(Object<string,Array>|null)}
     */
    this.listeners = {};
    this.debug = options.debug;
    this.listening = false;
    this.connecting = false;
    this.connected = false;
    this.channel = null;

    /** @type {MessagePort} */
    this.messagePort = null;

    this.onListenConnectionMessageReceivedProc = null;
    this.onConnectConnectionMessageReceivedProc = null;
    this.onChannelMessageReceivedProc = null;
    this.window_ = options.windowContext || window;
  }

  /**
   * Starts Messenger in "listening" mode. In this mode, we listen as soon as
   * possible and expect a future postMessage() to establish a MessageChannel.
   * The remote frame initiates the connection.
   *
   * @param {Array<string>} allowedOrigins A list of string origins to check
   *     against when receiving connection messages. A message from outside this
   *     list of origins won't be accepted.
   * @returns {Promise} A Promise that resolves when another frame successfully
   *      establishes a messaging channel, or rejects on error.
   */
  listen(allowedOrigins) {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        reject(new Error('Already connected.'));
        return;
      }
      if (this.listening) {
        reject(new Error('Already listening for connections.'));
        return;
      }
      if (!Array.isArray(allowedOrigins)) {
        reject(new Error('allowedOrigins should be a string array of ' +
          'allowed origins to accept messages from. Got:', allowedOrigins));
        return;
      }
      this.onListenConnectionMessageReceivedProc =
        this.onListenConnectionMessageReceived_.bind(
            this,
            allowedOrigins,
            resolve,
            reject
        );
      this.window_.addEventListener('message',
        /** @type {(function (Event): (boolean|undefined)|null)} */
        (this.onListenConnectionMessageReceivedProc));
      if (this.debug) {
        dev().fine(TAG, 'Listening for a connection message...');
      }
    }).then(() => {
      this.send(WindowMessenger.Topics.CONNECT_HANDSHAKE, null);
      this.connected = true;
    });
  }

  /**
   * Determine if a postMessage message came from a trusted origin.
   *
   * Messages can arrive from any origin asking for information, so we want to
   * restrict messages to allowed origins. Messages can arrive from the Google
   * AMP Cache (https://www.google.com/amp), from the site itself
   * (https://your-site.com), and from other sources.
   *
   * The message's source origin just needs to be an entry in our list
   * (normalized).
   *
   * @param {string} origin
   * @param {Array<string>} allowedOrigins
   * @returns {boolean}
   * @private
   */
  isAllowedOrigin_(origin, allowedOrigins) {
    const normalizedOrigin = parseUrl(origin).origin;
    for (let i = 0; i < allowedOrigins.length; i++) {
      const allowedOrigin = allowedOrigins[i];
      // A user might have mistyped the allowed origin, so let's normalize our
      // comparisons first
      if (parseUrl(allowedOrigin).origin === normalizedOrigin) {
        return true;
      }
    }
    return false;
  }

  /**
   * Occurs when the messenger receives its step 1 internal connection message.
   *
   * @param {Array<string>} allowedOrigins
   * @param {function()} resolvePromise
   * @param {function()} rejectPromise
   * @param {!Event} messageChannelEvent
   * @private
   */
  onListenConnectionMessageReceived_(
    allowedOrigins,
    resolvePromise,
    rejectPromise,
    messageChannelEvent
  ) {
    const message = getData(messageChannelEvent);
    const {origin, ports: messagePorts} = messageChannelEvent;
    if (this.debug) {
      dev().fine(TAG, 'Window message for listen() connection ' +
        'received:', message);
    }
    if (!this.isAllowedOrigin_(origin, allowedOrigins)) {
      dev().fine(TAG, `Discarding connection message from ${origin} ` +
        'because it isn\'t an allowed origin:', message, ' (allowed ' +
        ' origins are)', allowedOrigins);
      return;
    }
    if (!message ||
         message['topic'] !== WindowMessenger.Topics.CONNECT_HANDSHAKE) {
      dev().fine(TAG, 'Discarding connection message because it did ' +
        'not contain our expected handshake:', message);
      return;
    }

    dev().fine(TAG, 'Received expected connection handshake ' +
      'message:', message);
    // This was our expected handshake message Remove our message handler so we
    // don't get spammed with cross-domain messages
    this.window_.removeEventListener('message',
        /** @type {(function (Event): (boolean|undefined)|null)} */
        (this.onListenConnectionMessageReceivedProc));
    // Get the message port
    this.messagePort = messagePorts[0];
    this.onChannelMessageReceivedProc =
      this.onChannelMessageReceived_.bind(this);
    this.messagePort.addEventListener('message',
        this.onChannelMessageReceivedProc, false);
    this.messagePort.start();
    resolvePromise();
  }

  /**
   * Establishes a message channel with a listening Messenger on another frame.
   * Only call this if listen() has already been called on the remote frame.
   *
   * @param {!Window} remoteWindowContext The Window context to postMessage()
   *     to.
   * @param {string} expectedRemoteOrigin The origin the remote frame is
   *     required to be when receiving the message; the remote message is
   *     otherwise discarded.
   * @return {Promise}
   */
  connect(remoteWindowContext, expectedRemoteOrigin) {
    return new Promise((resolve, reject) => {
      if (!remoteWindowContext) {
        reject(new Error('Provide a valid Window context to connect to.'));
      }
      if (!expectedRemoteOrigin) {
        reject(new Error('Provide an expected origin for the remote Window ' +
        'or provide the wildcard *.'));
      }
      if (this.connected) {
        reject(new Error('Already connected.'));
        return;
      }
      if (this.connecting) {
        reject(new Error('Already connecting.'));
        return;
      }
      this.channel = new MessageChannel();
      this.messagePort = this.channel.port1;
      this.onConnectConnectionMessageReceivedProc =
        this.onConnectConnectionMessageReceived_.bind(
            this,
            this.messagePort,
            expectedRemoteOrigin,
            resolve)
        ;
      this.messagePort.addEventListener('message',
          this.onConnectConnectionMessageReceivedProc);
      this.messagePort.start();
      remoteWindowContext./*OK*/postMessage(
        /** @type {JsonObject} */ ({
          topic: WindowMessenger.Topics.CONNECT_HANDSHAKE,
        }), expectedRemoteOrigin === '*' ?
                '*' :
                parseUrl(expectedRemoteOrigin).origin, [this.channel.port2]);
      dev().fine(TAG, `Opening channel to ${expectedRemoteOrigin}...`);
    });
  }

  /**
   * Occurs when the messenger receives its step 2 internal connection message.
   *
   * @param {!MessagePort} messagePort
   * @param {string} expectedRemoteOrigin
   * @param {function()} resolvePromise
   * @private
   */
  onConnectConnectionMessageReceived_(
    messagePort,
    expectedRemoteOrigin,
    resolvePromise) {
    // This is the remote frame's reply to our initial handshake topic message
    this.connected = true;
    if (this.debug) {
      dev().fine(TAG, `Messenger channel to ${expectedRemoteOrigin} ` +
        'established.');
    }
    // Remove our message handler
    messagePort.removeEventListener('message',
        this.onConnectConnectionMessageReceivedProc);
    // Install a new message handler for receiving normal messages
    this.onChannelMessageReceivedProc =
      this.onChannelMessageReceived_.bind(this);
    messagePort.addEventListener('message',
        this.onChannelMessageReceivedProc, false);
    resolvePromise();
  }

  /**
   * Describes the list of available message topics.
   * @return {!MessengerTopics}
   */
  static get Topics() {
    return {
      CONNECT_HANDSHAKE: 'topic-connect-handshake',
      NOTIFICATION_PERMISSION_STATE: 'topic-notification-permission-state',
      SERVICE_WORKER_STATE: 'topic-service-worker-state',
      SERVICE_WORKER_REGISTRATION: 'topic-service-worker-registration',
      SERVICE_WORKER_QUERY: 'topic-service-worker-query',
    };
  }

  /**
   * Occurs when a message is received via MessageChannel.
   * Messages received here are trusted (they aren't postMessaged() over).
   *
   * @param {!Event} event
   * @private
   */
  onChannelMessageReceived_(event) {
    const message = getData(event);
    if (this.messages[message['id']] && message['isReply']) {
      const existingMessage = this.messages[message['id']];
      delete this.messages[message['id']];
      const promiseResolver = existingMessage.promiseResolver;
        // Set new incoming message data on existing message
      existingMessage.message = message['data'];
      if (this.debug) {
        dev().fine(TAG, `Received reply for topic '${message['topic']}':`,
            message['data']);
      }
      promiseResolver([
        message['data'],
        this.sendReply_.bind(this, message['id'], existingMessage['topic']),
      ]);
    } else {
      const listeners = this.listeners[message['topic']];
      if (!listeners) {
        return;
      }
      if (this.debug) {
        dev().fine(TAG, 'Received new message for ' +
          `topic '${message['topic']}': ${message['data']}`);
      }
      for (let i = 0; i < listeners.length; i++) {
        const listener = listeners[i];
        listener(message['data'],
            this.sendReply_.bind(this, message['id'], message['topic']));
      }
    }
  }

  /**
   * Subscribes a callback to be fired anytime a new message is received on the
   * topic. Replies to an existing message fire on the existing message promise
   * chain, not on this method, even if the topic matches.
   *
   * @param {string} topic
   * @param {function(...?)} callback
   */
  on(topic, callback) {
    if (this.listeners[topic]) {
      this.listeners[topic].push(callback);
    } else {
      this.listeners[topic] = [callback];
    }
  }

  /**
   * Removes the mapping subscribing the callback to a new message topic.
   * @param {string} topic
   * @param {function(...?)} callback
   */
  off(topic, callback) {
    if (callback) {
      const callbackIndex = this.listeners[topic].indexOf(callback);
      if (callbackIndex !== -1) {
        this.listeners[topic].splice(callbackIndex, 1);
      }
    } else {
      // No specific callback provided; remove all listeners for topic
      if (this.listeners[topic]) {
        delete this.listeners[topic];
      }
    }
  }

  /**
   * id, and topic is supplied by .bind(..). When sendReply is called by the
   * user, only the 'data' parameter is provided
   *
   * @param {string} id
   * @param {string} topic
   * @param {JsonObject} data
   * @return {Promise}
   * @private
   */
  sendReply_(id, topic, data) {
    const payload = {
      id,
      topic,
      data,
      isReply: true,
    };
    /*
     postMessage() requires the provided targetOrigin to match the recipient's
     origin, otherwise the message is not sent. Since we just got a message, we
     already know the receipient's origin.
     */
    this.messagePort./*OK*/postMessage(payload);

    return new Promise(resolve => {
      this.messages[payload.id] = {
        message: data,
        topic,
        promiseResolver: resolve,
      };
    });
  }

  /**
   * Sends a message with the given topic, and data.
   *
   * @param {string} topic A string, but this must match the receiving end that
   *    expects this topic string.
   * @param {JsonObject} data Any data that can be serialized using the
   *    structured clone algorithm.
   * @return {Promise}
   */
  send(topic, data) {
    const payload = {
      id: crypto.getRandomValues(new Uint8Array(10)).join(''),
      topic,
      data,
    };
    if (this.debug) {
      dev().fine(TAG, `Sending ${topic}:`, data);
    }
    this.messagePort./*OK*/postMessage(payload);

    return new Promise(resolve => {
      this.messages[payload.id] = {
        message: data,
        topic,
        promiseResolver: resolve,
      };
    });
  }
}
