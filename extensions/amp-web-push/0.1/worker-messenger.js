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
  Used by WorkerMessenger, this helper class abstracts a map of message topic
  strings to callback listeners.
 */
class WorkerMessengerReplyBuffer {
  constructor() {
    this.replies = {};
  }

  addListener(command, callback, onceListenerOnly) {
    const record = {
      callback: callback,
      onceListenerOnly: onceListenerOnly
    };

    if (this.findListenersForMessage(command).length > 0) {
      this.replies[command.toString()].push(record);
    } else {
      this.replies[command.toString()] = [record];
    }
  }

 findListenersForMessage(command) {
    return this.replies[command.toString()] || [];
  }

  deleteListenerRecords(command) {
    this.replies[command.toString()] = null;
  }

  deleteListenerRecord(command, targetRecord) {
    const listenersForCommand = this.replies[command.toString()];
    for (
      let listenerRecordIndex = listenersForCommand.length - 1;
      listenerRecordIndex >= 0;
      listenerRecordIndex--) {
      const listenerRecord = listenersForCommand[listenerRecordIndex];
      if (listenerRecord === targetRecord) {
        listenersForCommand.splice(listenerRecordIndex, 1);
      }
    }
  }
}

 /**
 * A Promise-based PostMessage helper to ease back-and-forth replies between
 * service workers and window frames.
 *
 * This class is included separately a second time, by websites running
 * amp-web-push, as well as by other push vendors, in a remote website's iframe.
 * It should therefore keep external depenencies to a minimum, since this class
 * must be transpiled to ES5 and "duplicated" outside of the AMP SDK bundle.
 */
class WorkerMessenger {

  constructor(options) {
    this.replies = new WorkerMessengerReplyBuffer();
    this.debug = !!options && options.debug;
  }

  log(..._) {
    if (this.debug) {
      // For easy debugging, print out the origin this code is running on
      const logPrefix = `${location.origin}:`
      var allArgs = Array.prototype.concat.apply([logPrefix], arguments);
      console.log.apply(this, allArgs);
    }
  }

  /*
    Sends a postMessage() to the service worker controlling the page.

    Waits until the service worker is controlling the page before sending the
    message.
   */
  unicast(command, payload) {
    var self = this;
    if (!(this.isWorkerControllingPage_())) {
      this.log("[Worker Messenger] The iframe is not controlled by the " +
        "service worker yet. Waiting to unicast...");
    }
    return this.waitUntilWorkerControlsPage().then(function () {
      self.log(`[Worker Messenger] [IFrame -> SW] Unicasting ` +
        `'${command.toString()}' to service worker.`)
      navigator.serviceWorker.controller./*OK*/postMessage({
        command: command,
        payload: payload
      });
    });
  }

  /*
    Listens for messages for the service worker.

    Waits until the service worker is controlling the page before listening for
    messages.
   */
  listen() {
    if (!(this.isWorkerControllingPage_())) {
      this.log("[Worker Messenger] The iframe is not controlled by the " +
        "service worker yet. Waiting to listen...");
    }
    var self = this;
    return this.waitUntilWorkerControlsPage().then(function () {
      self.log("[Worker Messenger] The iframe is now controlled by " +
        "the service worker.");
      navigator.serviceWorker.addEventListener('message',
        self.onPageMessageReceivedFromServiceWorker_.bind(self));
      self.log('[Worker Messenger] IFrame is now listening for messages.');
    });
  }

  /*
    Occurs when the page receives a message from the service worker.

    A map of callbacks is checked to see if anyone is listening to the specific
    message topic. If no one is listening to the message, it is discarded;
    otherwise, the listener callback is executed.
   */
  onPageMessageReceivedFromServiceWorker_(event) {
    const data = event.data;
    const listenerRecords = this.replies.findListenersForMessage(data.command);
    const listenersToRemove = [];
    const listenersToCall = [];

    this.log(`[Worker Messenger] IFrame received message:`, event.data);

    for (let listenerRecord of listenerRecords) {
      if (listenerRecord.onceListenerOnly) {
        listenersToRemove.push(listenerRecord);
      }
      listenersToCall.push(listenerRecord);
    }
    for (let i = listenersToRemove.length - 1; i >= 0; i--) {
      const listenerRecord = listenersToRemove[i];
      this.replies.deleteListenerRecord(data.command, listenerRecord);
    }
    for (let listenerRecord of listenersToCall) {
      listenerRecord.callback.apply(null, [data.payload]);
    }
  }

  /*
    Subscribes a callback to be notified every time a service worker sends a
    message to the window frame with the specific command.
   */
  on(command, callback) {
    this.replies.addListener(command, callback, false);
  }

  /*
    Subscribes a callback to be notified the next time a service worker sends a
    message to the window frame with the specific command.

    The callback is executed once at most.
   */
  once(command, callback) {
    this.replies.addListener(command, callback, true);
  }

  /*
    Unsubscribe a callback from being notified about service worker messages
    with the specified command.
   */
  off(command) {
    this.replies.deleteListenerRecords(command);
  }

  /*
    Service worker postMessage() communication relies on the property
    navigator.serviceWorker.controller to be non-null. The controller property
    references the active service worker controlling the page. Without this
    property, there is no service worker to message.

    The controller property is set when a service worker has successfully
    registered, installed, and activated a worker, and when a page isn't loaded
    in a hard refresh mode bypassing the cache.

    It's possible for a service worker to take a second page load to be fully
    activated.
   */
  isWorkerControllingPage_() {
    return navigator.serviceWorker &&
      navigator.serviceWorker.controller &&
      navigator.serviceWorker.controller.state === "activated";
  }

  /**
   * Returns a Promise that is resolved when the the page controlling the
   * service worker is activated. This Promise never rejects.
   */
  waitUntilWorkerControlsPage() {
    return new Promise(resolve => {
      if (this.isWorkerControllingPage_()) {
        resolve();
      } else {
        navigator.serviceWorker.addEventListener('controllerchange', e => {
          // Service worker has been claimed
          if (this.isWorkerControllingPage_()) {
            resolve();
          } else {
            navigator.serviceWorker.controller.addEventListener(
              'statechange',
              e => {
                if (this.isWorkerControllingPage_()) {
                  // Service worker has been activated
                  resolve();
                }
              });
          }
        });
      }
    });
  }
}
