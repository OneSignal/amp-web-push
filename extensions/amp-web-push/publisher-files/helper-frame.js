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

class AmpWebPushHelperFrame {
  constructor(options) {
    if (options && options.debug) {
      // Debug enables verbose logging for this page and the window and worker
      // messengers
      this.debug = true;
    }

    // For communication between the AMP page and this helper iframe
    this.ampMessenger = new WindowMessenger({
      debug: this.debug
    });

    // For communication between this helper iframe and the service worker
    this.workerMessenger = new WorkerMessenger({
      debug: this.debug
    });
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
      result: wasSuccessful ? successPayload : undefined
    });
  }

  onAmpPageMessageReceived_NotificationPermissionState(_, replyToFrame) {
    this.replyToFrameWithPayload(
      replyToFrame,
      true,
      null,
      Notification.permission
    );
  }

  onAmpPageMessageReceived_ServiceWorkerState(_, replyToFrame) {
    const serviceWorkerState = {
      /*
        Describes whether navigator.serviceWorker.controller is non-null.

        A page hard-refreshed bypassing the cache will have the
        navigator.serviceWorker.controller property be null even if the service
        worker is successfully registered and activated. In these situations,
        communication with the service worker isn't possible since the
        controller is null.
       */
      isControllingFrame: !!navigator.serviceWorker.controller,
      /*
        The URL to the service worker script.
       */
      url: navigator.serviceWorker.controller ?
        navigator.serviceWorker.controller.scriptURL :
        null,
      /*
        The state of the service worker, one of "installing, waiting,
        activating, activated".
       */
      state: navigator.serviceWorker.controller ?
        navigator.serviceWorker.controller.state :
        null
    };

    this.replyToFrameWithPayload(replyToFrame, true, null, serviceWorkerState);
  }

  onAmpPageMessageReceived_ServiceWorkerRegistration(message, replyToFrame) {
    if (!message || !message.workerUrl || !message.registrationOptions) {
      throw new Error('Expected arguments workerUrl and registrationOptions ' +
      'in message, got:', message);
    }

    navigator.serviceWorker.register(
      message.workerUrl,
      message.registrationOptions
    ).then(registration => {
        this.replyToFrameWithPayload(replyToFrame, true, null, null);
      })
      .catch(error => {
        this.replyToFrameWithPayload(replyToFrame, true, null, error ?
          (error.message || error.toString()) :
          null
        );
      });
  }

  onAmpPageMessageReceived_ServiceWorkerQuery(message, replyToFrame) {
    if (!message || !message.topic) {
      throw new Error('Expected argument topic in message, got:', message);
    }

    // The AMP message is forwarded to the service worker
    this.workerMessenger.once(message.topic, workerReplyPayload => {
      // The service worker's reply is forwarded back to the AMP page
      return this.replyToFrameWithPayload(
        replyToFrame,
        true,
        null,
        workerReplyPayload
      );
    });
    this.workerMessenger.unicast(message.topic, message.payload);
  }

  /**
   * Tries to decode a URI component, falling back to opt_fallback (or an empty
   * string)
   *
   * @param {string} component
   * @param {string=} opt_fallback
   * @return {string}
   */
  tryDecodeUriComponent(component, fallback = '') {
    try {
      return /*OK*/decodeURIComponent(component);
    } catch (e) {
      return fallback;
    }
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
      const name = this.tryDecodeUriComponent(match[1]).trim();
      const value = match[2] ? this.tryDecodeUriComponent(match[2]).trim() : '';
      params[name] = value;
    }
    return params;
  }

  getParentOrigin() {
    const queryParams = this.parseQueryString(window.location.search);
    if (!queryParams['parentOrigin']) {
      throw new Error('Expecting parentOrigin URL query parameter.');
    }
    return queryParams['parentOrigin'];
  }

  run() {
    this.ampMessenger.on(
      WindowMessenger.Topics.NOTIFICATION_PERMISSION_STATE,
      this.onAmpPageMessageReceived_NotificationPermissionState.bind(this)
    );
    this.ampMessenger.on(
      WindowMessenger.Topics.SERVICE_WORKER_STATE,
      this.onAmpPageMessageReceived_ServiceWorkerState.bind(this)
    );
    this.ampMessenger.on(
      WindowMessenger.Topics.SERVICE_WORKER_REGISTRATION,
      this.onAmpPageMessageReceived_ServiceWorkerRegistration.bind(this)
    );
    this.ampMessenger.on(
      WindowMessenger.Topics.SERVICE_WORKER_QUERY,
      this.onAmpPageMessageReceived_ServiceWorkerQuery.bind(this)
    );

    this.workerMessenger.listen();
    this.ampMessenger.listen([this.getParentOrigin()]);
  }
}

new AmpWebPushHelperFrame({
  debug: true
}).run();
