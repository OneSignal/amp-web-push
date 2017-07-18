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

import { getMode } from '../../../src/mode';
import {isExperimentOn} from '../../../src/experiments';
import { dev, user } from '../../../src/log';
import { urls } from '../../../src/config';
import { CSS } from '../../../build/amp-web-push-0.1.css';
import IFrame from './iframe';
import WindowMessenger from './window-messenger';
import {installStyles} from '../../../src/style-installer';
import {installStylesForShadowRoot} from '../../../src/shadow-embed';
import { actionServiceForDoc } from '../../../src/services';
import { closestByTag, openWindowDialog } from '../../../src/dom';
import { TAG, WIDGET_TAG, NotificationPermission } from './vars';
import { WebPushWidgetVisibilities } from './amp-web-push-widget';

export class WebPushService {

  /*
    In environments where pop ups aren't supported, the AMP page is redirected
    to a lightweight "permission dialog" page on the canonical origin. After
    permissions are granted, the page is redirected back to the AMP page.

    This describes the URL query parameter to add to the redirect back to the
    AMP page, so we know to resume the subscription process.

    We use the History API after to remove this fragment from the URL without
    affecting the page state.
   */
  static get PERMISSION_POPUP_URL_FRAGMENT() {
    return 'amp-web-push-subscribing=yes'
  }

  static get AMP_VERSION_INITIAL() {
    return 1;
  }

  /**
   * @param {!../../../src/service/ampdoc-impl.AmpDoc} ampdoc
   */
  constructor(ampdoc) {
    this.ampdoc = ampdoc;

    // Enable our AMP extension for development and test environments
    this.enableAmpExperimentForDevelopment_();
    // On all other environments, error if experiment is not enabled
    this.ensureAmpExperimentEnabled_();

    // Install styles.
    if (ampdoc.isSingleDoc()) {
      const root = /** @type {!Document} */ (ampdoc.getRootNode());
      installStyles(root, CSS, () => { }, false, TAG);
    } else {
      const root = /** @type {!ShadowRoot} */ (ampdoc.getRootNode());
      installStylesForShadowRoot(root, CSS, false, TAG);
    }

    /**
     * Resolved when the service is fully initialized.
     * @const @private {Promise}
     */
    this.initializePromise_ = ampdoc.whenReady().then(() => {
      return this.initialize_();
    });
  }

  /**
  * Occurs when the DOM is ready to be parsed.
  */
  initialize_() {
    this.log_("amp-web-push extension starting up.");

    // Exit early if web push isn't supported
    if (!this.environmentSupportsWebPush()) {
      this.log_("Web push is not supported.");
      return;
    }

    // Read amp-web-push configuration
    this.config = this.parseConfigJson(this.getConfigAsText());
    if (!this.config) {
      // An error will already be thrown from the config parsing function
      return;
    }

    // Install action handlers
    actionServiceForDoc(this.ampdoc).installActionHandler(
      this.ampdoc.getElementById(TAG), this.handleAction_.bind(this)
    );

    // Add a ?parentOrigin=... to let the iframe know which origin to accept
    // postMessage() calls from
    this.config.helperIframeUrl.indexOf('?') == -1 ? '?' : '&'

    const helperUrlHasQueryParams =
      this.config.helperIframeUrl.indexOf('?') !== -1;
    const helperUrlQueryParamPrefix = helperUrlHasQueryParams ? '&' : '?';
    const finalIframeUrl =
      `${this.config.helperIframeUrl}${helperUrlQueryParamPrefix}parentOrigin=${window.location.origin}`;

    // Create a hidden iFrame to check subscription state
    this.iframe = new IFrame(this.ampdoc.win.document, finalIframeUrl);

    // Create a postMessage() helper to listen for messages
    this.frameMessenger = new WindowMessenger({
      debug: this.config.debug
    });

    // Load the iFrame asychronously in the background
    this.iframe.load().then(() => {
      this.log_(`Helper frame ${this.config.helperIframeUrl} DOM loaded. ` +
        `Connecting to the frame via postMessage()...`);
      this.frameMessenger.connect(this.iframe.domElement.contentWindow, new
        URL(this.config.helperIframeUrl).origin);
    }).then(() => {
      if (this.isContinuingSubscriptionFromRedirect()) {
        this.resumeSubscribingForPushNotifications();
      } else {
        return this.updateWidgetVisibilities();
      }
    });
  }

  isContinuingSubscriptionFromRedirect() {
    return location.search.indexOf(
      WebPushService.PERMISSION_POPUP_URL_FRAGMENT) !== -1;
  }

  removePermissionPopupUrlFragmentFromUrl(url) {
    let urlWithoutFragment =
      url.replace(`?${WebPushService.PERMISSION_POPUP_URL_FRAGMENT}`, '');
    urlWithoutFragment =
      urlWithoutFragment.replace(
        `&${WebPushService.PERMISSION_POPUP_URL_FRAGMENT}`, '');
    return urlWithoutFragment;
  }

  /**
   * When developing locally, call this function otherwise we can't run our
   * extension in the example sandbox. Turns off in unit test mode.
   */
  enableAmpExperimentForDevelopment_() {
    if ((getMode().localDev && !getMode.test)) {
      AMP.toggleExperiment(TAG, true);
    }
  }

  log_() {
    // Only prints if the user turned on debug/verbose mode
    if (this.debug) {
      // For easy debugging, print out the origin this code is running on
      const logPrefix = `${location.origin}:`
      var allArgs = Array.prototype.concat.apply([logPrefix], arguments);
      console.log.apply(null, allArgs);
    }
  }

  /**
   * Checks that the user enabled this AMP experiment and allows integration
   * tests to access this class in testing mode.
   */
  ensureAmpExperimentEnabled_() {
    // Allow integration tests to access this class in testing mode.
    /** @const @private {boolean} */
    const isExperimentEnabled = isExperimentOn(this.ampdoc.win, TAG);
    user().assert(isExperimentEnabled, `Experiment "${TAG}" is disabled. ` +
      `Enable it on ${urls.cdn}/experiments.html.`);
  }

  /**
   * Searches for a <script type="application/json"> configuration and returns
   * it as text.
   */
  getConfigAsText() {
    const configJsonNode =
      this.ampdoc.getRootNode().querySelector('script#' + TAG);
    if (!configJsonNode) {
      throw user().createError(`Your AMP document must include a ` +
        `<script id="amp-web-push" type="application/json">.`);
    }
    return configJsonNode.textContent;
  }

  /**
  * Parses the JSON configuration and returns a JavaScript object. Also
  * validates the input.
  */
  parseConfigJson(configJson) {
    if (!configJson || !configJson.trim()) {
      throw user().createError(`Your AMP document's configuration ` +
        `JSON must not be empty.`);
    }
    let config;
    try {
      config = JSON.parse(/** @type {string} */(configJson));
    } catch (e) {
      throw user().createError(`Your AMP document's configuration ` +
        `JSON must be valid JSON. Failed to parse JSON: ` + e);
    }

    if (!config.helperIframeUrl ||
      !this.isValidHelperOrPermissionDialogUrl_(config.helperIframeUrl)) {
      throw user().createError(`Your AMP document's configuration JSON ` +
        `must have a valid helperIframeUrl property. It should begin with ` +
        `the https:// protocol and point to the provided lightweight ` +
        `template page provided for AMP messaging.`);
    }

    if (!config.permissionDialogUrl ||
      !this.isValidHelperOrPermissionDialogUrl_(config.permissionDialogUrl)) {
      throw user().createError(`Your AMP document's configuration JSON must ` +
        `have a valid permissionDialogUrl property. It should begin with ` +
        `the https:// protocol and point to the provided template page ` +
        `for showing the permission prompt.`);
    }

    if (!config.serviceWorkerUrl ||
      new URL(config.serviceWorkerUrl).protocol !== 'https:') {
      throw user().createError(`Your AMP document's configuration JSON must ` +
        `have a valid serviceWorkerUrl property. It should begin with the ` +
        `https:// protocol and point to the service worker JavaScript file ` +
        `to be installed.`);
    }
    return config;
  }

  isValidHelperOrPermissionDialogUrl_(url) {
    try {
      const parsedUrl = new URL(url);
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

  /**
   * Wait for bind scan to finish for testing.
   *
   * @return {?Promise}
   * @visibleForTesting
   */
  get initializePromiseForTesting() {
    return this.initializePromise_;
  }

  /*
    Waits until the helper iframe has loaded, and then sends the message to the
    helper iframe and awaits a reply. Errors that are returned are thrown,
    otherwise the message is returned as a Promise.

    This is used by all of our AMP page <-> helper iframe communications.
   */
  queryHelperFrame_(messageTopic, message) {
    return this.iframe.whenReady().then(() => {
      return this.frameMessenger.send(messageTopic, message)
    }).then(([replyPayload, _]) => {
      if (replyPayload.success) {
        return replyPayload.result;
      } else {
        throw new Error(`AMP page helper iframe query topic ${messageTopic} ` +
          `and message ${message} failed with: ${replyPayload.error}`);
      }
    });
  }

  /*
    Passes messages to the service worker through the helper iframe. Messages
    are forwarded directly as-is and service worker replies and received as-is
    without filtering, so that changes in the AMP page and service worker don't
    require code changes in the helper frame (which lives on the canonical
    origin).
   */
  queryServiceWorker_(messageTopic, message, callback) {
    return this.queryHelperFrame_(
      WindowMessenger.Topics.SERVICE_WORKER_QUERY,
      {
        topic: messageTopic,
        payload: message
      }
    );
  }

  queryNotificationPermission_() {
    return this.queryHelperFrame_(
      WindowMessenger.Topics.NOTIFICATION_PERMISSION_STATE,
      null
    );
  }

  queryServiceWorkerState_() {
    return this.queryHelperFrame_(
      WindowMessenger.Topics.SERVICE_WORKER_STATE,
      null
    );
  }

  registerServiceWorker() {
    return this.queryHelperFrame_(
      WindowMessenger.Topics.SERVICE_WORKER_REGISTRATION,
      {
        workerUrl: this.config.serviceWorkerUrl,
        registrationOptions: this.config.serviceWorkerRegistrationOptions ||
        { scope: '/' }
      }
    );
  }

  querySubscriptionStateRemotely_() {
    return this.queryServiceWorker_(
      'amp-web-push-subscription-state',
      null
    );
  }

  subscribeForPushRemotely_() {
    return this.queryServiceWorker_(
      'amp-web-push-subscribe',
      null
    );
  }

  unsubscribeFromPushRemotely_() {
    return this.queryServiceWorker_(
      'amp-web-push-unsubscribe',
      null
    );
  }

  isServiceWorkerActivated_() {
    return this.queryServiceWorkerState_().then(serviceWorkerState => {
      const isControllingFrame = serviceWorkerState.isControllingFrame === true;
      const serviceWorkerHasCorrectUrl =
        serviceWorkerState.url === this.config.serviceWorkerUrl;
      const serviceWorkerActivated = serviceWorkerState.state === 'activated';

      return isControllingFrame &&
        serviceWorkerHasCorrectUrl &&
        serviceWorkerActivated;
    });
  }

  /*
    Sets the visibilities of subscription and unsubscription
    <amp-web-push-widget> elements.

    Element visibilities change throughout the lifetime of the page: they are
    initially invisible as their visibilties are determined, and then they
    either remain hidden or appear. After users subscribe or unsubscribe,
    visibilties change again.
  */
  setWidgetVisibilities(widgetCategoryName, isVisible) {
    const widgetDomElements = this.ampdoc.getRootNode()
      .querySelectorAll(`${WIDGET_TAG}[visibility=${widgetCategoryName}]`);
    const visibilityCssClassName = 'invisible';

    for (const widgetDomElement of widgetDomElements) {
      if (isVisible) {
        widgetDomElement.classList.remove(visibilityCssClassName);
      } else {
        widgetDomElement.classList.add(visibilityCssClassName);
      }
    }
  }

  getSubscriptionStateReplyVersion_(subscriptionStateReply) {
    if (typeof subscriptionStateReply === "boolean") {
      return 1;
    }
  }

  updateWidgetVisibilities() {
    const widgetDomElements = this.ampdoc.getRootNode()
      .querySelectorAll(WIDGET_TAG);

    return this.queryNotificationPermission_().then(notificationPermission => {
      if (notificationPermission === NotificationPermission.DENIED) {
        this.updateWidgetVisibilities_NotificationPermissionsBlocked();
      } else {
        return this.isServiceWorkerActivated_().then(isServiceWorkerActivated => {
          if (isServiceWorkerActivated) {
            this.updateWidgetVisibilities_ServiceWorkerActivated();
          } else {
            this.updateWidgetVisibilities_Unsubscribed();
          }
        });
      }
    });
  }

  updateWidgetVisibilities_NotificationPermissionsBlocked() {
    this.setWidgetVisibilities(WebPushWidgetVisibilities.UNSUBSCRIBED, false);
    this.setWidgetVisibilities(WebPushWidgetVisibilities.SUBSCRIBED, false);
    this.setWidgetVisibilities(WebPushWidgetVisibilities.BLOCKED, true);
  }

  updateWidgetVisibilities_ServiceWorkerActivated() {
    return this.querySubscriptionStateRemotely_().then(reply => {
      /*
        This Promise will never resolve if the service worker does not support
        amp-web-push, and widgets will stay hidden.
       */
      switch (this.getSubscriptionStateReplyVersion_(reply)) {
        case WebPushService.AMP_VERSION_INITIAL:
          const isSubscribed = reply;
          if (isSubscribed) {
            this.setWidgetVisibilities(
              WebPushWidgetVisibilities.UNSUBSCRIBED, false);
            this.setWidgetVisibilities(
              WebPushWidgetVisibilities.SUBSCRIBED, true);
            this.setWidgetVisibilities(
              WebPushWidgetVisibilities.BLOCKED, false);
          } else {
            this.setWidgetVisibilities(
              WebPushWidgetVisibilities.UNSUBSCRIBED, true);
            this.setWidgetVisibilities(
              WebPushWidgetVisibilities.SUBSCRIBED, false);
            this.setWidgetVisibilities(
              WebPushWidgetVisibilities.BLOCKED, false);
          }
          break;
        default:
          /*
            Service worker returned incorrect amp-web-push reply
            (amp-web-push not supported); widgets will stay hidden.
           */
          break;
      }
    });
  }

  updateWidgetVisibilities_Unsubscribed() {
    this.setWidgetVisibilities(WebPushWidgetVisibilities.UNSUBSCRIBED, true);
    this.setWidgetVisibilities(WebPushWidgetVisibilities.SUBSCRIBED, false);
    this.setWidgetVisibilities(WebPushWidgetVisibilities.BLOCKED, false);
  }

  /**
   * @param {!ActionInvocation} invocation
   * @private
   */
  handleAction_(invocation) {
    // Get parent widget this action occurred under
    const widgetDomElement = closestByTag(invocation.source, WIDGET_TAG);
    if (!widgetDomElement) {
      throw user().createError(`A DOM element with attribute ` +
        `'on="tap:${TAG}.${invocation.method}"' must be within a parent ` +
        `element named <${WIDGET_TAG}>.`);
    }

    if (invocation.event) {
      invocation.event.preventDefault();
    }

    invocation.source.disabled = true;
    let actionPromise = Promise.resolve();

    if (invocation.method === 'subscribe') {
      actionPromise =
        this.subscribeForPushNotifications();
    } else if (invocation.method === "unsubscribe") {
      actionPromise =
        this.unsubscribeFromPushNotifications();
    }

    actionPromise.then(() => invocation.source.disabled = false);
  }

  onNotificationPermissionRequestInteractedMessage() {
    return new Promise(resolve => {
      this.popupMessenger.on(
        WindowMessenger.Topics.NOTIFICATION_PERMISSION_STATE,
        (message, replyToFrame) => {
          resolve([message, replyToFrame]);
        });
    });
  }

  static getPopupDimensions() {
    /*
      On mobile, pop ups should show up as a full-screen window. The magic
      numbers below are just reasonable defaults.
    */
    return {
      width: 650,
      height: 560,
      left: 0,
      top: 0
    }
  }

  openPopupOrRedirect_() {
    // Note: Don't wait on promise chains when opening a pop up, otherwise
    // they'll be blocked

    const pageUrlHasQueryParams = location.href.indexOf('?') !== -1;
    const pageUrlQueryParamPrefix = pageUrlHasQueryParams ? '&' : '?';
    // The URL to return to after the permission dialog closes
    const returningPopupUrl = location.href + pageUrlQueryParamPrefix +
      WebPushService.PERMISSION_POPUP_URL_FRAGMENT;

    const permissionDialogUrlHasQueryParams =
      location.href.indexOf('?') !== -1;
    const permissionDialogUrlQueryParamPrefix =
      permissionDialogUrlHasQueryParams ? '&' : '?';
    // The permission dialog URL, containing the return URL above embedded in a
    // query parameter
    const openingPopupUrl =
      `${this.config.permissionDialogUrl}${permissionDialogUrlQueryParamPrefix}return=${encodeURIComponent(returningPopupUrl)}`;

    const popupDimensions = WebPushService.getPopupDimensions();

    const popup = openWindowDialog(
      this.ampdoc.win,
      openingPopupUrl,
      '_blank',
      'scrollbars=yes, width=' +
      popupDimensions.width + ', height=' + popupDimensions.height + ', top=' +
      popupDimensions.top + ', left=' + popupDimensions.left);
  }

  subscribeForPushNotifications() {
    this.registerServiceWorker();
    this.openPopupOrRedirect_();

    this.popupMessenger = new WindowMessenger({
      debug: this.debug
    });
    this.popupMessenger.listen([this.config.permissionDialogUrl]);

    /*
      At this point, the popup most likely opened and we can communicate with it
      via postMessage(). Or, in rare environments like Custom Chrome Tabs, this
      entire page was redirected and our code will resume with our page is
      redirected back.
    */

    return this.onNotificationPermissionRequestInteractedMessage()
      .then(([permission, reply]) => {
        switch (permission) {
          case NotificationPermission.DENIED:
            // User blocked
            reply({ closeFrame: true });
            return this.updateWidgetVisibilities();
            break;
          case NotificationPermission.DEFAULT:
            // User clicked X
            reply({ closeFrame: true });
            return this.updateWidgetVisibilities();
            break;
          case NotificationPermission.GRANTED:
            // User allowed
            reply({ closeFrame: true });
            this.subscribeForPushRemotely_().then(() => {
              return this.updateWidgetVisibilities();
            });
            break;
          default:
            throw new Error("Unexpected permission value:", permission);
            break;
        }
      });
  }

  unsubscribeFromPushNotifications() {
    return this.unsubscribeFromPushRemotely_().then(() => {
      return this.updateWidgetVisibilities();
    });
  }

  resumeSubscribingForPushNotifications() {
    // Remove the ?amp-web-push-subscribing=true from the URL without affecting
    // the page contents using the History API
    window.history.replaceState(
      null,
      '',
      this.removePermissionPopupUrlFragmentFromUrl(window.location.href)
    );

    this.queryNotificationPermission_()
      .then(permission => {
        switch (permission) {
          case NotificationPermission.DENIED:
            // User blocked
            return this.updateWidgetVisibilities();
            break;
          case NotificationPermission.DEFAULT:
            // User clicked X
            return this.updateWidgetVisibilities();
            break;
          case NotificationPermission.GRANTED:
            // User allowed
            this.subscribeForPushRemotely_()
              .then(() => {
                return this.updateWidgetVisibilities();
              });
            break;
          default:
            throw new Error("Unexpected permission value", permission);
            break;
        }
      });
  }

  environmentSupportsWebPush() {
    return this.arePushRelatedApisSupported() && this.isAmpPageHttps();
  }

  /*
   * Returns true if the Notifications, Service Worker, and Push API are
   * supported.
   *
   * This check causes Safari to return false (i.e. W3C-standardized push not
   * supported on Safari). Safari has its own propietary push system, but it
   * doesn't work on mobile, since Apple has not developed iOS push. This means
   * that AMP, a mobile-only feature, won't be supporting Safari until Safari
   * actually develops mobile push support.
   */
  arePushRelatedApisSupported() {
    return window.Notification !== undefined &&
      navigator.serviceWorker !== undefined &&
      window.PushManager !== undefined;
  }

  /*
    Both the AMP page and the helper iframe must be HTTPS.

    It's possible for the AMP page to be HTTP; our extension should not
    initialize in these cases. AMP pages loaded on Google's AMP cache should
    always be HTTPS (e.g. https://www.google.com/amp/site.com/page.amp.html).
    However, an AMP page directly accessed on an HTTP site (e.g.
    http://site.com/page.amp.html) would be HTTP.

    The entire origin chain must be HTTPS to allow communication with the
    service worker, which is done via the navigator.serviceWorker.controller.
    navigator.serviceWorker.controller will return null if the AMP page is HTTP.

    This does not prevent subscriptions to HTTP integrations; the helper iframe
    simply becomes https://customer-subdomain.push-vendor.com

    The helper iframe HTTPS is enforced when checking the configuration.
   */
  isAmpPageHttps() {
    return location.protocol === "https:";
  }
}
