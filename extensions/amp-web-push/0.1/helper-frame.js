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

import {tryDecodeUriComponent} from '../../../src/url.js';
import {WindowMessenger} from './window-messenger';

 /**
  * @fileoverview
  * Loaded as an invisible iframe on the AMP page, and serving a page on the
  * canonical origin, this iframe enables same-origin access to push
  * subscription, notification permission, and IndexedDb data stored on the
  * canonical origin to query the user's permission state, register service
  * workers, and enable communication with the registered service worker.
  */
export class AmpWebPushHelperFrame {
  constructor(options) {
    if (options && options.debug) {
      // Debug enables verbose logging for this page and the window and worker
      // messengers
      this.debug = true;
    }

    this.window_ = options.windowContext || window;

    // For communication between the AMP page and this helper iframe
    this.ampMessenger = new WindowMessenger({
      debug: this.debug,
      windowContext: this.window_,
    });

    /*
      Describes the messages we allow through from the service worker. Whenever
      the AMP page sends a 'query service worker' message with a topic string,
      we add the topic to the allowed list, and wait for the service worker to
      reply. Once we get a reply, we remove it from the allowed topics.
     */
    this.allowedWorkerMessageTopics = {};
  }

  /*
    Ensures replies to the AMP page messenger have a consistent payload format.
   */
  replyToFrameWithPayload(
    replyToFrameFunction,
    wasSuccessful,
    errorPayload,
    successPayload) {
    replyToFrameFunction({
      success: wasSuccessful,
      error: wasSuccessful ? undefined : errorPayload,
      result: wasSuccessful ? successPayload : undefined,
    });
  }

  onAmpPageMessageReceivedNotificationPermissionState_(_, replyToFrame) {
    this.replyToFrameWithPayload(
        replyToFrame,
        true,
        null,
        Notification.permission
    );
  }

  onAmpPageMessageReceivedServiceWorkerState_(_, replyToFrame) {
    const serviceWorkerState = {
      /*
        Describes whether navigator.serviceWorker.controller is non-null.

        A page hard-refreshed bypassing the cache will have the
        navigator.serviceWorker.controller property be null even if the service
        worker is successfully registered and activated. In these situations,
        communication with the service worker isn't possible since the
        controller is null.
       */
      isControllingFrame: !!this.window_.navigator.serviceWorker.controller,
      /*
        The URL to the service worker script.
       */
      url: this.window_.navigator.serviceWorker.controller ?
        this.window_.navigator.serviceWorker.controller.scriptURL :
        null,
      /*
        The state of the service worker, one of "installing, waiting,
        activating, activated".
       */
      state: this.window_.navigator.serviceWorker.controller ?
        this.window_.navigator.serviceWorker.controller.state :
        null,
    };

    this.replyToFrameWithPayload(replyToFrame, true, null, serviceWorkerState);
  }

  onAmpPageMessageReceivedServiceWorkerRegistration(message, replyToFrame) {
    if (!message || !message.workerUrl || !message.registrationOptions) {
      throw new Error('Expected arguments workerUrl and registrationOptions ' +
      'in message, got:', message);
    }

    this.window_.navigator.serviceWorker.register(
        message.workerUrl,
        message.registrationOptions
    ).then(() => {
      this.replyToFrameWithPayload(replyToFrame, true, null, null);
    })
        .catch(error => {
          this.replyToFrameWithPayload(replyToFrame, true, null, error ?
          (error.message || error.toString()) :
          null
        );
        });
  }

  onAmpPageMessageReceivedServiceWorkerQuery_(message, replyToFrame) {
    if (!message || !message.topic) {
      throw new Error('Expected argument topic in message, got:', message);
    }
    new Promise(resolve => {
      // Allow this message through, just for the next time it's received
      this.allowedWorkerMessageTopics[message.topic] = resolve;

      // The AMP message is forwarded to the service worker
      this.waitUntilWorkerControlsPage().then(() => {
        this.window_.navigator.serviceWorker.controller./*OK*/postMessage({
          command: message.topic,
          payload: message.payload,
        });
      });
    }).then(workerReplyPayload => {
      delete this.allowedWorkerMessageTopics[message.topic];

      // The service worker's reply is forwarded back to the AMP page
      return this.replyToFrameWithPayload(
          replyToFrame,
          true,
          null,
          workerReplyPayload
      );
    });
  }

  /**
   * Parses the query string of an URL. This method returns a simple key/value
   * map. If there are duplicate keys the latest value is returned.
   *
   * This function is implemented in a separate file to avoid a circular
   * dependency.
   *
   * @param {string} queryString
   * @return {!Object<string>}
   */
  parseQueryString(queryString) {
    const params = Object.create(null);
    if (!queryString) {
      return params;
    }

    let match;
    const regex = /(?:^[#?]?|&)([^=&]+)(?:=([^&]*))?/g;
    while ((match = regex.exec(queryString))) {
      const name = tryDecodeUriComponent(match[1]).trim();
      const value = match[2] ? tryDecodeUriComponent(match[2]).trim() : '';
      params[name] = value;
    }
    return params;
  }

  getParentOrigin() {
    const queryParams = this.parseQueryString(this.window_.location.search);
    if (!queryParams['parentOrigin']) {
      throw new Error('Expecting parentOrigin URL query parameter.');
    }
    return queryParams['parentOrigin'];
  }

  onPageMessageReceivedFromServiceWorker_(event) {
    const {command, payload} = event.data;
    const callbackPromiseResolver = this.allowedWorkerMessageTopics[command];

    if (typeof callbackPromiseResolver === 'function') {
      // Resolve the waiting listener with the worker's reply payload
      callbackPromiseResolver(payload);
    }
    // Otherwise, ignore unsolicited messages from the service worker
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
    return this.window_.navigator.serviceWorker &&
      this.window_.navigator.serviceWorker.controller &&
      this.window_.navigator.serviceWorker.controller.state === 'activated';
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
        this.window_.navigator.serviceWorker.addEventListener('controllerchange', () => {
          // Service worker has been claimed
          if (this.isWorkerControllingPage_()) {
            resolve();
          } else {
            this.window_.navigator.serviceWorker.controller.addEventListener(
                'statechange',
                () => {
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

  /**
   * Sets up message listeners for messages from the AMP page and service
   * worker.
   *
   * @param {string|null} allowedOrigin For testing purposes only. Pass in the
   * allowedOrigin since test environments cannot access the parent origin.
   */
  run(allowedOrigin) {
    this.ampMessenger.on(
        WindowMessenger.Topics.NOTIFICATION_PERMISSION_STATE,
        this.onAmpPageMessageReceivedNotificationPermissionState_.bind(this)
    );
    this.ampMessenger.on(
        WindowMessenger.Topics.SERVICE_WORKER_STATE,
        this.onAmpPageMessageReceivedServiceWorkerState_.bind(this)
    );
    this.ampMessenger.on(
        WindowMessenger.Topics.SERVICE_WORKER_REGISTRATION,
        this.onAmpPageMessageReceivedServiceWorkerRegistration.bind(this)
    );
    this.ampMessenger.on(
        WindowMessenger.Topics.SERVICE_WORKER_QUERY,
        this.onAmpPageMessageReceivedServiceWorkerQuery_.bind(this)
    );

    this.waitUntilWorkerControlsPage().then(() => {
      this.window_.navigator.serviceWorker.addEventListener('message',
          this.onPageMessageReceivedFromServiceWorker_.bind(this));
    });
    this.ampMessenger.listen([allowedOrigin || this.getParentOrigin()]);
  }
}
