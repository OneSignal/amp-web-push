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

import {CONFIG_TAG, SERVICE_TAG} from './vars';
import {Layout} from '../../../src/layout';
import {getServiceForDoc} from '../../../src/service';
import {user} from '../../../src/log';
import {parseUrl} from '../../../src/url';


/** @enum {string} */
export const WebPushConfigProperties = {
  HELPER_FRAME_URL: 'helperIframeUrl',
  PERMISSION_DIALOG_URL: 'permissionDialogUrl',
  SERVICE_WORKER_URL: 'serviceWorkerUrl',
};

/**
 * @fileoverview
 * A <amp-web-push-config> element that exposes attributes for publishers to
 * configure the web push service.
 *
 * On buildCallback(), the element starts the web push service.
 */
export class WebPushConfig extends AMP.BaseElement {

  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);
  }

  /** @override */
  isLayoutSupported(layout) {
    return layout == Layout.NODISPLAY;
  }

  /** @override */
  buildCallback() {
    const config = this.parseConfigJson();
    const webPushService = getServiceForDoc(this.getAmpDoc(), SERVICE_TAG);
    webPushService.start(config);
  }

  /**
  * Parses the JSON configuration and returns a JavaScript object. Also
  * validates the input.
  */
  parseConfigJson() {
    const config = {
      helperIframeUrl: null,
      permissionDialogUrl: null,
      serviceWorkerUrl: null,
    };

    for (const requiredProperty in WebPushConfigProperties) {
      const value = WebPushConfigProperties[requiredProperty];
      user().assert(this.element.getAttribute(value),
          `The ${value} attribute is required for <${CONFIG_TAG}>`);
      config[value] = this.element.getAttribute(value);
    }

    if (!this.isValidHelperOrPermissionDialogUrl_(config['helperIframeUrl'])) {
      throw user().createError('Your AMP document\'s configuration JSON ' +
        'must have a valid helperIframeUrl property. It should begin with ' +
        'the https:// protocol and point to the provided lightweight ' +
        'template page provided for AMP messaging.');
    }

    if (!this.isValidHelperOrPermissionDialogUrl_(
        config['permissionDialogUrl'])) {
      throw user().createError('Your AMP document\'s configuration JSON must ' +
        'have a valid permissionDialogUrl property. It should begin with ' +
        'the https:// protocol and point to the provided template page ' +
        'for showing the permission prompt.');
    }

    if (parseUrl(config['serviceWorkerUrl']).protocol !== 'https:') {
      throw user().createError('Your AMP document\'s configuration JSON must ' +
        'have a valid serviceWorkerUrl property. It should begin with the ' +
        'https:// protocol and point to the service worker JavaScript file ' +
        'to be installed.');
    }

    if (parseUrl(config['serviceWorkerUrl']).origin !==
          parseUrl(config['permissionDialogUrl']).origin ||
        parseUrl(config['permissionDialogUrl']).origin !==
        parseUrl(config['helperIframeUrl']).origin) {
      throw user().createError('Your AMP document\'s configuration JSON ' +
        'properties serviceWorkerUrl, permissionDialogUrl, and ' +
        'helperIframeUrl must all share the same origin.');
    }
    return config;
  }

  /** @private */
  isValidHelperOrPermissionDialogUrl_(url) {
    try {
      const parsedUrl = parseUrl(url);
      /*
        The helperIframeUrl must be to a specific lightweight page on the user's
        site for handling AMP postMessage calls without loading push
        vendor-specific SDKs or other resources. It should not be the site root.

        The permissionDialogUrl can load push vendor-specific SDKs, but it
        should still not be the site root and should be a dedicated page for
        subscribing.
      */
      const isNotRootUrl = parsedUrl.pathname.length > 1;

      /*
        Similar to <amp-form> and <amp-iframe>, the helper and subscribe URLs
        must be HTTPS. This is because most AMP caches serve pages over HTTPS,
        and an HTTP iframe URL would not load due to insecure resources being
        blocked on a secure page.
      */
      const isSecureUrl = (parsedUrl.protocol === 'https:');

      return isSecureUrl && isNotRootUrl;
    } catch (e) {
      return false;
    }
  }
}
