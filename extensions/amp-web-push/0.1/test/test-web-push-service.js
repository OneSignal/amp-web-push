/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {getMode} from '../../../../src/mode';
import {WindowMessenger} from '../window-messenger';
import {IFrameHost} from '../iframehost';
import {AmpWebPushHelperFrame} from '../helper-frame';
import {WebPushService} from '../web-push-service';
import {WebPushWidgetVisibilities} from '../amp-web-push-widget';
import {TAG, CONFIG_TAG, NotificationPermission} from '../vars';
import {toggleExperiment} from '../../../../src/experiments';
import {WebPushConfigAttributes} from '../amp-web-push-config';
import {
  createIframeWithMessageStub,
  expectPostMessage,
} from '../../../../testing/iframe';
import * as sinon from 'sinon';

describes.realWin('web-push-service', {
  amp: true,
}, env => {
  let win;
  let webPush;
  const webPushConfig = {};
  let iframeWindow = null;
  let sandbox = null;

  function setDefaultConfigParams_() {
    webPushConfig[WebPushConfigAttributes.HELPER_FRAME_URL] =
      `//ads.localhost:9876/test/fixtures/served/iframe-stub.html#`;
    webPushConfig[WebPushConfigAttributes.PERMISSION_DIALOG_URL] =
      `//ads.localhost:9876/test/fixtures/served/iframe-stub.html#`;
    webPushConfig[WebPushConfigAttributes.SERVICE_WORKER_URL] =
      `//ads.localhost:9876/test/fixtures/served/iframe-stub.html#`;
  }

  function setupHelperIframe() {
    webPush.initializeConfig(webPushConfig);
    return webPush.installHelperFrame(webPushConfig).then(() => {
      const helperIframe = getHelperIframe();
      iframeWindow = helperIframe.contentWindow;
      iframeWindow.WindowMessenger = WindowMessenger;
      iframeWindow.AmpWebPushHelperFrame = AmpWebPushHelperFrame;
      iframeWindow.controller = new iframeWindow.AmpWebPushHelperFrame({
        debug: true,
        windowContext: iframeWindow,
      });
      iframeWindow.controller.run(env.win.location.ancestorOrigins[0]);
      return webPush.frameMessenger_.connect(
        iframeWindow,
        '*'
      );
    });
  }

  /**
   * Returns the iframe in this testing AMP iframe that partially matches the
   * URL set in the test config. Partial matches are possible only since query
   * parameters are appended to the iframe URL.
   */
  function getHelperIframe() {
    return env.win.document.querySelector('iframe');
  }

  beforeEach(() => {
    win = env.win;
    setDefaultConfigParams_();
    toggleExperiment(env.win, TAG, true);
    webPush = new WebPushService(env.ampdoc);
    sandbox = sinon.sandbox.create();
  });

  afterEach(() => {
    toggleExperiment(env.win, TAG, false);
    sandbox.restore();
  });

  it('should report supported environment', () => {
    expect(webPush.environmentSupportsWebPush()).to.eq(true);
  });

  it('should not support environment missing Notification API', () => {
    Object.defineProperty(env.win, 'Notification', {
      enumerable: false,
      configurable: false,
      writable: false,
      value: undefined
    });
    expect(webPush.environmentSupportsWebPush()).to.eq(false);
  });

  it('should not support environment missing Service Worker API', () => {
    Object.defineProperty(env.win.navigator, 'serviceWorker', {
      enumerable: false,
      configurable: false,
      writable: false,
      value: undefined
    });
    expect(webPush.environmentSupportsWebPush()).to.eq(false);
  });

  it('should not support environment missing PushManager API', () => {
    Object.defineProperty(env.win, 'PushManager', {
      enumerable: false,
      configurable: false,
      writable: false,
      value: undefined
    });
    expect(webPush.environmentSupportsWebPush()).to.eq(false);
  });

  it('should create helper iframe on document', () => {
    webPush.initializeConfig(webPushConfig);
    return webPush.installHelperFrame(webPushConfig).then(() => {
      expect(getHelperIframe()).to.not.be.null;
    });
  });

  it('should receive real reply from helper iframe for permission status query', () => {
    return setupHelperIframe().then(() => {
      return webPush.queryNotificationPermission();
    }).then(permission => {
      expect(permission).to.eq(NotificationPermission.DEFAULT);
    });
  });

  it('should show blocked widget if permission status query returns blocked', () => {
    let setWidgetVisibilitiesMock = null;
    let spy1 = null;

    return setupHelperIframe().then(() => {
      spy1 = sinon.spy(webPush, "setWidgetVisibilities");

      const queryNotificationPermissionStub = sandbox.stub(webPush, 'queryNotificationPermission', () => Promise.resolve(NotificationPermission.DENIED));

      // We've mocked default notification permissions
      return webPush.updateWidgetVisibilities();
    }).then(() => {
      expect(spy1.withArgs(WebPushWidgetVisibilities.UNSUBSCRIBED, false).calledOnce).to.eq(true);
      expect(spy1.withArgs(WebPushWidgetVisibilities.SUBSCRIBED, false).calledOnce).to.eq(true);
      expect(spy1.withArgs(WebPushWidgetVisibilities.BLOCKED, true).calledOnce).to.eq(true);
    });
  });

  it('should show subscription widget if permission status query returns default', () => {
    let spy = null;

    return setupHelperIframe().then(() => {
      spy = sinon.spy(webPush, "setWidgetVisibilities");

      sandbox.stub(webPush, 'isServiceWorkerActivated', () => Promise.resolve(false));
      sandbox.stub(webPush, 'queryNotificationPermission', () => Promise.resolve(NotificationPermission.DEFAULT));

      // We've mocked default notification permissions
      return webPush.updateWidgetVisibilities();
    }).then(() => {
      expect(spy.withArgs(WebPushWidgetVisibilities.UNSUBSCRIBED, true).calledOnce).to.eq(true);
      expect(spy.withArgs(WebPushWidgetVisibilities.SUBSCRIBED, false).calledOnce).to.eq(true);
      expect(spy.withArgs(WebPushWidgetVisibilities.BLOCKED, false).calledOnce).to.eq(true);
    });
  });

  it('should show unsubscription widget if reachable SW returns subscribed', () => {
    let spy = null;

    return setupHelperIframe().then(() => {
      spy = sinon.spy(webPush, "setWidgetVisibilities");

      sandbox.stub(webPush, 'querySubscriptionStateRemotely', () => Promise.resolve(true));
      sandbox.stub(webPush, 'isServiceWorkerActivated', () => Promise.resolve(true));
      sandbox.stub(webPush, 'queryNotificationPermission', () => Promise.resolve(NotificationPermission.DEFAULT));

      // We've mocked default notification permissions
      return webPush.updateWidgetVisibilities();
    }).then(() => {
      expect(spy.withArgs(WebPushWidgetVisibilities.UNSUBSCRIBED, false).calledOnce).to.eq(true);
      expect(spy.withArgs(WebPushWidgetVisibilities.SUBSCRIBED, true).calledOnce).to.eq(true);
      expect(spy.withArgs(WebPushWidgetVisibilities.BLOCKED, false).calledOnce).to.eq(true);
    });
  });

  it('should show subscription widget if reachable SW returns unsubscribed', () => {
    let spy = null;

    return setupHelperIframe().then(() => {
      spy = sinon.spy(webPush, "setWidgetVisibilities");

      sandbox.stub(webPush, 'querySubscriptionStateRemotely', () => Promise.resolve(false));
      sandbox.stub(webPush, 'isServiceWorkerActivated', () => Promise.resolve(true));
      sandbox.stub(webPush, 'queryNotificationPermission', () => Promise.resolve(NotificationPermission.DEFAULT));

      // We've mocked default notification permissions
      return webPush.updateWidgetVisibilities();
    }).then(() => {
      expect(spy.withArgs(WebPushWidgetVisibilities.UNSUBSCRIBED, true).calledOnce).to.eq(true);
      expect(spy.withArgs(WebPushWidgetVisibilities.SUBSCRIBED, false).calledOnce).to.eq(true);
      expect(spy.withArgs(WebPushWidgetVisibilities.BLOCKED, false).calledOnce).to.eq(true);
    });
  });

  it('should receive real message for service worker registration', () => {
    let helperFrameSwMessageMock = null;

    return setupHelperIframe().then(() => {
      helperFrameSwMessageMock = sandbox.stub(iframeWindow.navigator.serviceWorker, 'register');
      helperFrameSwMessageMock.withArgs(webPushConfig[WebPushConfigAttributes.SERVICE_WORKER_URL], {
        scope: '/'
      }).returns(Promise.resolve(true));

      return webPush.registerServiceWorker();
    }).then(() => {
      expect(helperFrameSwMessageMock).to.be.calledOnce;
    });
  });
});