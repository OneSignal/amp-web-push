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
 * The script for the web push notification permission dialog. This script will
 * eventually live on the publisher's origin. It shows the notification prompt
 * and forwards results to the AMP page.
 */
export class AmpWebPushPermissionDialog {
  constructor(options) {
    if (options && options.debug) {
      // Debug enables verbose logging for this page and the window and worker
      // messengers
      this.debug = true;
    }

    // For communication between the AMP page and this permission dialog
    this.ampMessenger = new WindowMessenger({
      debug: this.debug,
    });
  }

  /** @private */
  isCurrentDialogPopup_() {
    return !!window.opener &&
      window.opener !== window;
  }

  /** @private */
  requestNotificationPermission_() {
    return new Promise((resolve, reject) => {
      try {
        Notification.requestPermission(permission => resolve(permission));
      } catch (e) {
        reject(e);
      }
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

  /**
   * Requests notoification permissions and reports the result back to the AMP
   * page.
   *
   * If this dialog was redirected instead of opened as a pop up, the page is
   * redirected back.
   */
  run() {
    if (this.isCurrentDialogPopup_()) {
      this.ampMessenger.connect(opener, '*');

      this.requestNotificationPermission_().then(permission => {
        return this.ampMessenger.send(
            WindowMessenger.Topics.NOTIFICATION_PERMISSION_STATE,
            permission
        );
      }).then(result => {
        const message = result[0];
        if (message && message.closeFrame) {
          window.close();
        }
      });
    } else {
      const queryParams = this.parseQueryString(window.location.search);
      if (!queryParams['return']) {
        throw new Error(
          'Expecting return URL query parameter to redirect back.');
      }
      this.requestNotificationPermission_().then(() => {
        window.location.href =
          this.tryDecodeUriComponent(queryParams['return']);
      });
    }
  }
}
