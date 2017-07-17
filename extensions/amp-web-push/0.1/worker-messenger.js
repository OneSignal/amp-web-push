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

  unicast(command, payload) {
    var self = this;
    if (!(this.isWorkerControllingPage())) {
      this.log("[Worker Messenger] The iframe is not controlled by the " +
        "service worker yet. Waiting to unicast...");
    }
    return this.waitUntilWorkerControlsPage().then(function () {
      self.log(`[Worker Messenger] [IFrame -> SW] Unicasting ` +
        `'${command.toString()}' to service worker.`)
      navigator.serviceWorker.controller.postMessage(/*REVIEW*/{
        command: command,
        payload: payload
      });
    });
  }

  listen() {
    if (!(this.isWorkerControllingPage())) {
      this.log("[Worker Messenger] The iframe is not controlled by the " +
        "service worker yet. Waiting to listen...");
    }
    var self = this;
    return this.waitUntilWorkerControlsPage().then(function () {
      self.log("[Worker Messenger] The iframe is now controlled by " +
        "the service worker.");
      navigator.serviceWorker.addEventListener('message',
        self.onPageMessageReceivedFromServiceWorker.bind(self));
      self.log('[Worker Messenger] IFrame is now listening for messages.');
    });
  }

  onPageMessageReceivedFromServiceWorker(event) {
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

  on(command, callback) {
    this.replies.addListener(command, callback, false);
  }

  once(command, callback) {
    this.replies.addListener(command, callback, true);
  }

  off(command) {
    this.replies.deleteListenerRecords(command);
  }

  isWorkerControllingPage() {
    return navigator.serviceWorker &&
      navigator.serviceWorker.controller &&
      navigator.serviceWorker.controller.state === "activated";
  }

  /**
   * For pages, waits until one of our workers is activated.
   *
   * For service workers, waits until the registration is active.
   */
  waitUntilWorkerControlsPage() {
    return new Promise(resolve => {
      if (this.isWorkerControllingPage()) {
        resolve();
      } else {
        navigator.serviceWorker.addEventListener('controllerchange', e => {
          // Service worker has been claimed
          if (this.isWorkerControllingPage()) {
            resolve();
          } else {
            navigator.serviceWorker.controller.addEventListener(
              'statechange',
              e => {
                if (this.isWorkerControllingPage()) {
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
