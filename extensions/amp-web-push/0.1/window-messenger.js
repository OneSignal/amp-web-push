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

 /*
 * A Promise-based PostMessage helper to ease back-and-forth replies.
 *
 * This class is included separately a second time, by websites running
 * amp-web-push, as well as by other push vendors, in a remote
 * website's iframe. It should therefore keep external depenencies to a minimum,
 * since this class must be transpiled to ES5 and "duplicated" outside of the
 * AMP SDK bundle.
 */
import {getData} from '../../../src/event-helper';

export class WindowMessenger {

  /*
   * Set debug to true to get console logs anytime a message is received,
   * sent, or discarded.
   */
  constructor(options) {
    if (!options) {
      options = {};
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
  }

  /*
   * Starts Messenger in "listening" mode. In this mode, we listen as soon as
   * possible and expect a future postMessage() to establish a MessageChannel.
   * The remote frame initiates the connection.
   *
   * Params:
   *   - allowedOrigins: A list of string origins to check against when
   *     receiving connection messages. A message from outside this list of
   *     origins won't be accepted.
   *
   * Returns: A Promise that resolves when another frame successfully
   *   establishes a messaging channel, or rejects on error.
   *
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
        this.onListenConnectionMessageReceived.bind(
            this,
            allowedOrigins,
            resolve,
            reject
        );
      window.addEventListener('message',
        /** @type {(function (Event): (boolean|undefined)|null)} */
        (this.onListenConnectionMessageReceivedProc));
      if (this.debug) {
        console/*OK*/.log('Listening for a connection message...');
      }
    }).then(() => {
      this.send(WindowMessenger.Topics.CONNECT_HANDSHAKE, null);
      this.connected = true;
    });
  }

  /*
   * Determine if a postMessage message came from a trusted origin.
   *
   * Messages can arrive from any origin asking for information, so we want to
   * restrict messages to allowed origins. Messages can arrive from the Google
   * AMP Cache (https://www.google.com/amp), from the site itself
   * (https://your-site.com), and from other sources.
   *
   * The message's source origin just needs to be an entry in our list
   * (normalized).
   */
  isAllowedOrigin(origin, allowedOrigins) {
    const normalizedOrigin = new URL(origin).origin;
    for (let i = 0; i < allowedOrigins.length; i++) {
      const allowedOrigin = allowedOrigins[i];
      // A user might have mistyped the allowed origin, so let's normalize our
      // comparisons first
      if (new URL(allowedOrigin).origin === normalizedOrigin) {
        return true;
      }
    }
    return false;
  }

  onListenConnectionMessageReceived(
    allowedOrigins,
    resolvePromise,
    rejectPromise,
    messageChannelEvent
  ) {
    const message = getData(messageChannelEvent);
    const {origin, ports: messagePorts} = messageChannelEvent;
    if (this.debug) {
      console/*OK*/.log('Window message for listen() connection ' +
        'received:', message);
    }
    if (!this.isAllowedOrigin(origin, allowedOrigins)) {
      console/*OK*/.log(`Discarding connection message from ${origin} ` +
        'because it isn\'t an allowed origin:', message, ' (allowed ' +
        ' origins are)', allowedOrigins);
      return;
    }
    if (!message ||
         message['topic'] !== WindowMessenger.Topics.CONNECT_HANDSHAKE) {
      console/*OK*/.log('Discarding connection message because it did ' +
        'not contain our expected handshake:', message);
      return;
    }

    console/*OK*/.log('Received expected connection handshake ' +
      'message:', message);
    // This was our expected handshake message Remove our message handler so we
    // don't get spammed with cross-domain messages
    window.removeEventListener('message',
        /** @type {(function (Event): (boolean|undefined)|null)} */
        (this.onListenConnectionMessageReceivedProc));
    // Get the message port
    this.messagePort = messagePorts[0];
    this.onChannelMessageReceivedProc =
      this.onChannelMessageReceived.bind(this);
    this.messagePort.addEventListener('message',
        this.onChannelMessageReceivedProc, false);
    this.messagePort.start();
    resolvePromise();
  }

  /**
   * Establishes a message channel with a listening Messenger on another frame.
   * Only call this if listen() has already been called on the remote frame.
   *
   * Params:
   *   - remoteWindowContext: The Window context to postMessage() to.
   *   - expectedRemoteOrigin: The origin the remote frame is required to be
   *     when receiving the message; the remote message is otherwise discarded.
   *
   * @param {!Window} remoteWindowContext
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
        this.onConnectConnectionMessageReceived.bind(
            this,
            this.messagePort,
            expectedRemoteOrigin,
            resolve)
        ;
      this.messagePort.addEventListener('message',
          this.onConnectConnectionMessageReceivedProc);
      this.messagePort.start();
      remoteWindowContext./*OK*/postMessage({
        topic: WindowMessenger.Topics.CONNECT_HANDSHAKE,
      }, expectedRemoteOrigin === '*' ?
                '*' :
                new URL(expectedRemoteOrigin).origin, [this.channel.port2]);
      console/*OK*/.log(`Opening channel to ${expectedRemoteOrigin}...`);
    });
  }

  onConnectConnectionMessageReceived(
    messagePort,
    expectedRemoteOrigin,
    resolvePromise) {
    // This is the remote frame's reply to our initial handshake topic message
    this.connected = true;
    if (this.debug) {
      console/*OK*/.log(`Messenger channel to ${expectedRemoteOrigin} ` +
        'established.');
    }
    // Remove our message handler
    messagePort.removeEventListener('message',
        this.onConnectConnectionMessageReceivedProc);
    // Install a new message handler for receiving normal messages
    this.onChannelMessageReceivedProc =
      this.onChannelMessageReceived.bind(this);
    messagePort.addEventListener('message',
        this.onChannelMessageReceivedProc, false);
    resolvePromise();
  }

  static get Topics() {
    return {
      CONNECT_HANDSHAKE: 'topic-connect-handshake',
      NOTIFICATION_PERMISSION_STATE: 'topic-notification-permission-state',
      SERVICE_WORKER_STATE: 'topic-service-worker-state',
      SERVICE_WORKER_REGISTRATION: 'topic-service-worker-registration',
      SERVICE_WORKER_QUERY: 'topic-service-worker-query',
    };
  }

  /*
   * Occurs when a message is received via MessageChannel.
   * Messages received here are trusted (they aren't postMessaged() over).
   */
  onChannelMessageReceived(event) {
    const message = getData(event);
    if (this.messages[message['id']] && message['isReply']) {
      const existingMessage = this.messages[message['id']];
      delete this.messages[message['id']];
      const promiseResolver = existingMessage.promiseResolver;
        // Set new incoming message data on existing message
      existingMessage.message = message['data'];
      if (this.debug) {
        console/*OK*/.log(`Received reply for topic '${message['topic']}':`,
            message['data']);
      }
      promiseResolver([
        message['data'],
        this.sendReply.bind(this, message['id'], existingMessage['topic']),
      ]);
    } else {
      const listeners = this.listeners[message['topic']];
      if (!listeners) {
        return;
      }
      if (this.debug) {
        console/*OK*/.log('Received new message for ' +
          `topic '${message['topic']}': message['data']`);
      }
      for (let i = 0; i < listeners.length; i++) {
        const listener = listeners[i];
        listener(message['data'],
            this.sendReply.bind(this, message['id'], message['topic']));
      }
    }
  }

  /*
   * Subscribes a callback to be fired anytime a new message is received on the
   * topic. Replies to an existing message fire on the existing message promise
   * chain, not on this method, even if the topic matches.
   */
  on(topic, callback) {
    if (this.listeners[topic]) {
      this.listeners[topic].push(callback);
    } else {
      this.listeners[topic] = [callback];
    }
  }

  /*
   * Removes the mapping subscribing the callback to a new message topic.
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

  // id, and topic is supplied by .bind(..)
  // When sendReply is called by the user, only the 'data' parameter is provided
  sendReply(id, topic, data) {
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

  /*
   * Sends a message with the given topic, and data.
   *
   * Params:
   *  - topic: A string, but this must match the receiving end that expects this
   *    topic string.
   *  - data: Any data that can be serialized using the structured clone
   *    algorithm.
   */
  send(topic, data) {
    const payload = {
      id: crypto.getRandomValues(new Uint8Array(10)).join(''),
      topic,
      data,
    };
    if (this.debug) {
      console/*OK*/.log(`Sending ${topic}:`, data);
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
