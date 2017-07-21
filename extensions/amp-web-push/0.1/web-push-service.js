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

import {getMode} from '../../../src/mode';
import {isExperimentOn} from '../../../src/experiments';
import {user} from '../../../src/log';
import {urls} from '../../../src/config';
import {CSS} from '../../../build/amp-web-push-0.1.css';
import {IFrame} from './iframe';
import {WindowMessenger} from './window-messenger';
import {installStyles} from '../../../src/style-installer';
import {installStylesForShadowRoot} from '../../../src/shadow-embed';
import {openWindowDialog} from '../../../src/dom';
import {TAG, NotificationPermission} from './vars';
import {WebPushWidgetVisibilities} from './amp-web-push-widget';
import {parseJson} from '../../../src/json';

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
    return 'amp-web-push-subscribing=yes';
  };

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

    /** @private {Object} */
    this.config_ = {
      helperIframeUrl: null,
      permissionDialogUrl: null,
      serviceWorkerUrl: null,
      debug: null,
    };

    /** @private {boolean} */
    this.debug_ = false;

    /** @private {./iframe.IFrame} */
    this.iframe_ = null;

    /** @private {./window-messenger.WindowMessenger} */
    this.frameMessenger_ = null;

    /** @private {./window-messenger.WindowMessenger} */
    this.popupMessenger_ = null;
  }

  /*
  * Occurs when the DOM is ready to be parsed.
  */
  initialize_() {
    this.log_('amp-web-push extension starting up.');

    // Exit early if web push isn't supported
    if (!this.environmentSupportsWebPush()) {
      this.log_('Web push is not supported.');
      return;
    }

    // Read amp-web-push configuration
    this.config_ = this.parseConfigJson(this.getConfigAsText());
    if (!this.config_) {
      // An error will already be thrown from the config parsing function
      return;
    }
    this.debug_ = this.config_.debug;

    // Add a ?parentOrigin=... to let the iframe know which origin to accept
    // postMessage() calls from
    const helperUrlHasQueryParams =
      this.config_.helperIframeUrl.indexOf('?') !== -1;
    const helperUrlQueryParamPrefix = helperUrlHasQueryParams ? '&' : '?';
    const finalIframeUrl =
      `${this.config_.helperIframeUrl}${helperUrlQueryParamPrefix}` +
      `parentOrigin=${window.location.origin }`;

    // Create a hidden iFrame to check subscription state
    this.iframe_ = new IFrame(this.ampdoc.win.document, finalIframeUrl);

    // Create a postMessage() helper to listen for messages
    this.frameMessenger_ = new WindowMessenger({
      debug: this.debug_,
    });

    // Load the iFrame asychronously in the background
    this.iframe_.load().then(() => {
      this.log_(`Helper frame ${this.config_.helperIframeUrl} DOM loaded. ` +
        'Connecting to the frame via postMessage()...');
      this.frameMessenger_.connect(this.iframe_.domElement.contentWindow, new
        URL(this.config_.helperIframeUrl).origin);
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
    if ((getMode().localDev && !getMode().test)) {
      AMP.toggleExperiment(TAG, true);
    }
  }

  log_(text) {
    // Only prints if the user turned on debug/verbose mode
    if (this.debug_) {
      // For easy debugging, print out the origin this code is running on
      console.log.apply(null, [`${location.origin}: ${text}`]);
    }
  }

  /*
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

  /*
   * Searches for a <script type="application/json"> configuration and returns
   * it as text.
   */
  getConfigAsText() {
    const configJsonNode =
      this.ampdoc.getRootNode().querySelector('script#' + TAG);
    if (!configJsonNode) {
      throw user().createError('Your AMP document must include a ' +
        '<script id="amp-web-push" type="application/json">.');
    }
    return configJsonNode.textContent;
  }

  /*
  * Parses the JSON configuration and returns a JavaScript object. Also
  * validates the input.
  */
  parseConfigJson(configJson) {
    if (!configJson || !configJson.trim()) {
      throw user().createError('Your AMP document\'s configuration ' +
        'JSON must not be empty.');
    }
    let config;
    try {
      config = parseJson(/** @type {string} */(configJson));
    } catch (e) {
      throw user().createError('Your AMP document\'s configuration ' +
        'JSON must be valid JSON. Failed to parse JSON: ' + e);
    }

    if (!config['helperIframeUrl'] ||
      !this.isValidHelperOrPermissionDialogUrl_(
          config['helperIframeUrl'])) {
      throw user().createError('Your AMP document\'s configuration JSON ' +
        'must have a valid helperIframeUrl property. It should begin with ' +
        'the https:// protocol and point to the provided lightweight ' +
        'template page provided for AMP messaging.');
    }

    if (!config['permissionDialogUrl'] ||
      !this.isValidHelperOrPermissionDialogUrl_(
          config['permissionDialogUrl'])) {
      throw user().createError('Your AMP document\'s configuration JSON must ' +
        'have a valid permissionDialogUrl property. It should begin with ' +
        'the https:// protocol and point to the provided template page ' +
        'for showing the permission prompt.');
    }

    if (!config['serviceWorkerUrl'] ||
      new URL(config['serviceWorkerUrl']).protocol !== 'https:') {
      throw user().createError('Your AMP document\'s configuration JSON must ' +
        'have a valid serviceWorkerUrl property. It should begin with the ' +
        'https:// protocol and point to the service worker JavaScript file ' +
        'to be installed.');
    }

    if (new URL(config['serviceWorkerUrl']).origin !==
          new URL(config['permissionDialogUrl']).origin ||
        new URL(config['permissionDialogUrl']).origin !==
        new URL(config['helperIframeUrl']).origin) {
      throw user().createError('Your AMP document\'s configuration JSON ' +
        'properties serviceWorkerUrl, permissionDialogUrl, and ' +
        'helperIframeUrl must all share the same origin.');
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

  /*
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
    return this.iframe_.whenReady().then(() => {
      return this.frameMessenger_.send(messageTopic, message);
    }).then(result => {
      const replyPayload = result[0];
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
  queryServiceWorker_(messageTopic, message) {
    return this.queryHelperFrame_(
        WindowMessenger.Topics.SERVICE_WORKER_QUERY,
        {
          topic: messageTopic,
          payload: message,
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
          workerUrl: this.config_.serviceWorkerUrl,
          registrationOptions: this.config_.serviceWorkerRegistrationOptions ||
          {scope: '/'},
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
    const self = this;
    return this.queryServiceWorkerState_().then(
      /** @param {{isControllingFrame:boolean, state:string, url:string}}
          serviceWorkerState */
        function(serviceWorkerState) {
          const isControllingFrame =
            serviceWorkerState.isControllingFrame === true;
          const serviceWorkerHasCorrectUrl =
            serviceWorkerState.url === self.config_.serviceWorkerUrl;
          const serviceWorkerActivated =
          serviceWorkerState.state === 'activated';

          return isControllingFrame &&
          serviceWorkerHasCorrectUrl &&
          serviceWorkerActivated;
        });
  }

  /*
    Sets the visibilities of subscription and unsubscription
    <amp-web-push> elements.

    Element visibilities change throughout the lifetime of the page: they are
    initially invisible as their visibilties are determined, and then they
    either remain hidden or appear. After users subscribe or unsubscribe,
    visibilties change again.
  */
  setWidgetVisibilities(widgetCategoryName, isVisible) {
    const widgetDomElements = this.ampdoc.getRootNode()
      .querySelectorAll(`${TAG}[visibility=${widgetCategoryName}]`);
    const visibilityCssClassName = 'amp-invisible';

    for (let i = 0; i < widgetDomElements.length; i++) {
      const widgetDomElement = widgetDomElements[i];
      if (isVisible) {
        widgetDomElement.classList.remove(visibilityCssClassName);
      } else {
        widgetDomElement.classList.add(visibilityCssClassName);
      }
    }
  }

  getSubscriptionStateReplyVersion_(subscriptionStateReply) {
    if (typeof subscriptionStateReply === 'boolean') {
      return 1;
    }
  }

  updateWidgetVisibilities() {
    return this.queryNotificationPermission_().then(notificationPermission => {
      if (notificationPermission === NotificationPermission.DENIED) {
        this.updateWidgetVisibilitiesNotificationPermissionsBlocked();
      } else {
        return this.isServiceWorkerActivated_().then(
            isServiceWorkerActivated => {
              if (isServiceWorkerActivated) {
                this.updateWidgetVisibilitiesServiceWorkerActivated();
              } else {
                this.updateWidgetVisibilitiesUnsubscribed();
              }
            });
      }
    });
  }

  updateWidgetVisibilitiesNotificationPermissionsBlocked() {
    this.setWidgetVisibilities(WebPushWidgetVisibilities.UNSUBSCRIBED, false);
    this.setWidgetVisibilities(WebPushWidgetVisibilities.SUBSCRIBED, false);
    this.setWidgetVisibilities(WebPushWidgetVisibilities.BLOCKED, true);
  }

  updateWidgetVisibilitiesServiceWorkerActivated() {
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

  updateWidgetVisibilitiesUnsubscribed() {
    this.setWidgetVisibilities(WebPushWidgetVisibilities.UNSUBSCRIBED, true);
    this.setWidgetVisibilities(WebPushWidgetVisibilities.SUBSCRIBED, false);
    this.setWidgetVisibilities(WebPushWidgetVisibilities.BLOCKED, false);
  }

  /**
   * Subscribes the user to web push notifications.
   *
   * This action is exposed from this service and is called from the
   * <amp-web-push> custom element.
   *
   * @public
   */
  subscribe() {
    this.registerServiceWorker();
    this.openPopupOrRedirect_();

    this.popupMessenger_ = new WindowMessenger({
      debug: this.debug_,
    });
    this.popupMessenger_.listen([this.config_.permissionDialogUrl]);

    /*
      At this point, the popup most likely opened and we can communicate with it
      via postMessage(). Or, in rare environments like Custom Chrome Tabs, this
      entire page was redirected and our code will resume with our page is
      redirected back.
    */

    return this.onNotificationPermissionRequestInteractedMessage()
        .then(result => {
          const permission = result[0];
          const reply = result[1];
          switch (permission) {
            case NotificationPermission.DENIED:
            // User blocked
              reply({closeFrame: true});
              return this.updateWidgetVisibilities();
              break;
            case NotificationPermission.DEFAULT:
            // User clicked X
              reply({closeFrame: true});
              return this.updateWidgetVisibilities();
              break;
            case NotificationPermission.GRANTED:
            // User allowed
              reply({closeFrame: true});
              this.subscribeForPushRemotely_().then(() => {
                return this.updateWidgetVisibilities();
              });
              break;
            default:
              throw new Error('Unexpected permission value:', permission);
              break;
          }
        });
  }

  /**
   * Unsubscribes a user from web push notifications.
   *
   * This action is exposed from this service and is called from the
   * <amp-web-push> custom element.
   *
   * @public
   */
  unsubscribe() {
    return this.unsubscribeFromPushRemotely_().then(() => {
      return this.updateWidgetVisibilities();
    });
  }

  onNotificationPermissionRequestInteractedMessage() {
    return new Promise(resolve => {
      this.popupMessenger_.on(
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
      top: 0,
    };
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
      this.config_.permissionDialogUrl.indexOf('?') !== -1;
    const permissionDialogUrlQueryParamPrefix =
      permissionDialogUrlHasQueryParams ? '&' : '?';
    // The permission dialog URL, containing the return URL above embedded in a
    // query parameter
    const openingPopupUrl =
      this.config_.permissionDialogUrl +
      permissionDialogUrlQueryParamPrefix +
      `return=${encodeURIComponent(returningPopupUrl) }`;

    const popupDimensions = WebPushService.getPopupDimensions();

    openWindowDialog(
        this.ampdoc.win,
        openingPopupUrl,
        '_blank',
        'scrollbars=yes, width=' +
      popupDimensions.width + ', height=' + popupDimensions.height + ', top=' +
      popupDimensions.top + ', left=' + popupDimensions.left);
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
              throw new Error('Unexpected permission value', permission);
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
    return location.protocol === 'https:';
  }
}
